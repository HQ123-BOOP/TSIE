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

  constructor(private readonly opts: ProxyOptions) {
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (msg, rinfo) => {
      this.peer = rinfo; // 学习回程地址
      this.sink?.(new Uint8Array(msg));
    });
    this.sock.on('error', () => {
      /* 端口冲突等：保持静默，guest 表现为无 RX */
    });
    this.sock.bind(opts.localPort ?? 0);
  }

  send(frame: EthFrame): void {
    if (this.closed) return;
    const data = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    const { host, port } = this.peer ?? this.opts;
    this.sock.send(data, port, host);
  }

  onFrame(cb: (frame: EthFrame) => void): void {
    this.sink = cb;
  }

  close(): void {
    this.closed = true;
    try {
      this.sock.close();
    } catch {
      /* 已关闭 */
    }
  }
}
