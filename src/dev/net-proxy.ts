/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import * as dgram from 'node:dgram';
import type { EthFrame, NetBackend } from './net.ts';

export interface ProxyOptions {
  /** 桥接守护所在主机地址（如 VM 的 IP） */
  host: string;
  /** 桥接守护的 UDP 端口（guest TX 帧发往这里） */
  port: number;
  /** 本机绑定端口（收 guest RX 帧）；缺省 0 = 系统自动分配 */
  localPort?: number;
}

/**
 * 用户态代理后端：guest 的以太网帧经 UDP 转发到外部桥接守护
 * （例如 VM 上的 TAP 桥），从而打通 guest 与真实网络的通路。
 *
 * 地址学习：对端（桥接守护）从收到的第一个 guest 帧反解出本机
 * 地址:端口作为回程；本机在收到第一个回程帧前用 opts.host/port 发送。
 *
 * ⚠ 收帧依赖 Node 事件循环。machine.run() 是全同步循环，必须搭配
 * runInteractive()（分块间 setImmediate 让事件循环呼吸），否则 RX 帧
 * 会滞留在内核 socket 缓冲直到 run() 返回才被处理。
 */
export class ProxyBackend implements NetBackend {
  private readonly sock: dgram.Socket;
  private sink: ((frame: EthFrame) => void) | undefined;
  private peer?: dgram.RemoteInfo;
  private closed = false;
  private lastSentAt = 0;
  /**
   * 保活心跳：Windows 防火墙对 UDP 入站有流状态超时（约 60s），
   * guest 长时间静默（如停在 login）后再 ping，回包会被静默丢弃。
   * 每 10s 检查一次，超 20s 没发包就发 0 字节心跳刷新防火墙流；
   * 0 字节帧在守护端不入 TAP、在本端不入 guest，双方均无害。
   */
  private readonly keepalive = setInterval(() => {
    if (this.closed) return;
    if (Date.now() - this.lastSentAt > 20_000) {
      this.sock.send(Buffer.alloc(0), this.opts.port, this.opts.host);
    }
  }, 10_000);

  private readonly opts: ProxyOptions;

  private readonly debug = process.env.TS_NET_PROXY_DEBUG === '1';

  constructor(opts: ProxyOptions) {
    this.opts = opts;
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (msg, rinfo) => {
      if (this.debug) console.error(`[proxy] RX ${msg.length}B from ${rinfo.address}:${rinfo.port}`);
      if (msg.length === 0) return; // 心跳
      this.peer = rinfo; // 学习回程地址
      this.sink?.(new Uint8Array(msg));
    });
    this.sock.on('error', (e) => {
      if (this.debug) console.error(`[proxy] socket error: ${e.message}`);
    });
    this.sock.bind(opts.localPort ?? 0, () => {
      if (this.debug) console.error(`[proxy] 绑定 ${JSON.stringify(this.sock.address())}`);
    });
  }

  send(frame: EthFrame): void {
    if (this.closed) return;
    this.lastSentAt = Date.now();
    const data = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    // 注意：dgram RemoteInfo 的地址字段是 .address 而非 .host——
    // 解构写错会让已学习 peer 后的所有帧发往 undefined（静默丢失）。
    const host = this.peer ? this.peer.address : this.opts.host;
    const port = this.peer ? this.peer.port : this.opts.port;
    if (this.debug) {
      const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      const dst =
        frame.length >= 6
          ? [...frame.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join(':')
          : '?';
      const type = frame.length >= 14 ? dv.getUint16(12).toString(16) : '?';
      console.error(`[proxy] TX ${frame.length}B -> ${host}:${port} dst=${dst} type=0x${type}`);
    }
    this.sock.send(data, port, host);
  }

  onFrame(cb: (frame: EthFrame) => void): void {
    this.sink = cb;
  }

  close(): void {
    this.closed = true;
    clearInterval(this.keepalive);
    try {
      this.sock.close();
    } catch {
      /* 已关闭 */
    }
  }
}
