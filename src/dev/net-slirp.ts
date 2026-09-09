/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import * as dgram from 'node:dgram';
import * as net from 'node:net';
import * as nodeDns from 'node:dns';
import type { EthFrame, NetBackend } from './net.ts';

/**
 * SlirpBackend：纯用户态迷你 TCP/IP 栈（QEMU user-net / slirp 同思路）。
 * guest 把本后端当网关（10.0.0.2），我们把 guest 的 IP 流量翻译成
 * Host 的真实 socket 连接——零驱动、零权限，Node 能跑就能联网。
 *
 * 虚拟网络：
 *   guest  10.0.0.1 (MAC 52:54:00:12:34:56)
 *   网关   10.0.0.2 (MAC 52:54:00:12:34:02) —— 本后端冒充
 *
 * 支持：
 *   - ARP 应答（代理 ARP：对任何请求都回网关 MAC）
 *   - ICMP echo（仅目标=网关；外部 ping 无原始 socket 权限不代理，同 QEMU slirp）
 *   - UDP 端点转发（DNS 走这里自动通）
 *   - TCP 连接翻译器（guest 侧自维护序号，Host 侧真实 socket 对接）
 *
 * ⚠ 收帧依赖事件循环：须搭配 runInteractive 使用（同 ProxyBackend）。
 * 传输层（dgram/net）目前是 Node 实现，已集中在文件底部，浏览器版
 * 只需替换 Transport 即可。
 */

export interface SlirpOptions {
  /** guest 的 IP（缺省 10.0.0.1） */
  guestIp?: string;
  /** guest 的 MAC（缺省 52:54:00:12:34:56，与 virtio-net 默认一致） */
  guestMac?: string;
  /** 虚拟网关 IP（缺省 10.0.0.2） */
  gwIp?: string;
  /** 虚拟网关 MAC（缺省 52:54:00:12:34:02） */
  gwMac?: string;
  /**
   * 发往网关 53 端口的 DNS 查询转发到哪个上游（缺省取宿主机 DNS，失败退
   * 223.5.5.5）。QEMU slirp 同样在网关地址上做 DNS 拦截——否则 guest 把
   * 网关当 DNS 服务器时，查询会被原样发到 10.0.0.2:53 而无人应答。
   */
  dns?: string;
  /** 调试日志（stderr） */
  debug?: boolean;
}

// ---------- 小工具 ----------

const seqGt = (a: number, b: number): boolean => {
  const d = (a - b) >>> 0;
  return d > 0 && d < 0x80000000;
};

function parseMac(s: string): Uint8Array {
  return Uint8Array.from(s.split(':').map((x) => parseInt(x, 16)));
}

function parseIp(s: string): Uint8Array {
  return Uint8Array.from(s.split('.').map((x) => parseInt(x, 10)));
}

function ipStr(b: Uint8Array): string {
  return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
}

function checksum(data: Uint8Array, start: number, len: number): number {
  let sum = 0;
  for (let i = start; i < start + len - 1; i += 2) sum += (data[i] << 8) | data[i + 1];
  if (len & 1) sum += data[start + len - 1] << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
}

function u16(arr: Uint8Array, o: number): number {
  return (arr[o] << 8) | arr[o + 1];
}

function putU16(arr: Uint8Array, o: number, v: number): void {
  arr[o] = (v >> 8) & 0xff;
  arr[o + 1] = v & 0xff;
}

function putU32(arr: Uint8Array, o: number, v: number): void {
  arr[o] = (v >>> 24) & 0xff;
  arr[o + 1] = (v >>> 16) & 0xff;
  arr[o + 2] = (v >>> 8) & 0xff;
  arr[o + 3] = v & 0xff;
}

const TCP_FIN = 0x01;
const TCP_SYN = 0x02;
const TCP_RST = 0x04;
const TCP_PSH = 0x08;
const TCP_ACK = 0x10;

const MSS = 1460;
const UDP_IDLE_MS = 30_000;
const MAX_UDP_FLOWS = 256;
const RETRANSMIT_MS = 300;

/**
 * 取宿主机的 DNS：只挑 IPv4——转发走的是 udp4 socket，IPv6 地址（Windows
 * 上 getServers() 常把 2400:3200::1 之类排在前面）根本发不出去。
 */
function pickHostDns(): string | undefined {
  try {
    return nodeDns.getServers().find((s) => net.isIPv4(s));
  } catch {
    return undefined;
  }
}

// ---------- SlirpBackend ----------

export class SlirpBackend implements NetBackend {
  private readonly opts: Required<SlirpOptions>;
  private readonly guestMacB: Uint8Array;
  private readonly gwMacB: Uint8Array;
  private readonly guestIpB: Uint8Array;
  private readonly gwIpB: Uint8Array;
  private sink: ((frame: EthFrame) => void) | undefined;
  private closed = false;
  private ipId = 1;

  private readonly udpFlows = new Map<string, UdpFlow>();
  private readonly tcpConns = new Map<string, TcpConn>();
  private readonly reap = setInterval(() => this.reapIdle(), 15_000);

  constructor(opts: SlirpOptions = {}) {
    this.opts = {
      guestIp: opts.guestIp ?? '10.0.0.1',
      guestMac: opts.guestMac ?? '52:54:00:12:34:56',
      gwIp: opts.gwIp ?? '10.0.0.2',
      gwMac: opts.gwMac ?? '52:54:00:12:34:02',
      dns: opts.dns ?? (pickHostDns() ?? '223.5.5.5'),
      debug: opts.debug,
    } as Required<SlirpOptions>;
    this.guestMacB = parseMac(this.opts.guestMac);
    this.gwMacB = parseMac(this.opts.gwMac);
    this.guestIpB = parseIp(this.opts.guestIp);
    this.gwIpB = parseIp(this.opts.gwIp);
    // 上游 DNS 支持 "ip" 或 "ip:port"（后者便于单测指向本地服务器）
    const [h, p] = this.opts.dns.split(':');
    this.dnsHost = h;
    this.dnsPort = p !== undefined && /^\d+$/.test(p) ? Number(p) : 53;
  }

  /**
   * 发往网关 53 端口的 DNS 查询转发到哪个上游（缺省取宿主机 DNS，失败退
   * 223.5.5.5）。QEMU slirp 同样在网关地址上做 DNS 拦截——否则 guest 把
   * 网关当 DNS 服务器时，查询会被原样发到 10.0.0.2:53 而无人应答。
   */
  private dnsHost: string;
  private dnsPort: number;

  /** 当前生效的上游 DNS（ip 或 ip:port），便于测试与排障 */
  get dnsUpstream(): string {
    return this.dnsPort === 53 ? this.dnsHost : `${this.dnsHost}:${this.dnsPort}`;
  }

  private debug(...args: unknown[]): void {
    if (this.opts.debug) console.error('[slirp]', ...args);
  }

  /** guest → slirp：一帧以太网 */
  send(frame: EthFrame): void {
    if (this.closed || frame.length < 14) return;
    const ethType = u16(frame, 12);
    const payload = frame.subarray(14);
    if (ethType === 0x0806) return this.handleArp(payload);
    if (ethType === 0x0800) return this.handleIpv4(payload);
  }

  onFrame(cb: (frame: EthFrame) => void): void {
    this.sink = cb;
  }

  close(): void {
    this.closed = true;
    clearInterval(this.reap);
    for (const f of this.udpFlows.values()) f.sock.close();
    this.udpFlows.clear();
    for (const c of this.tcpConns.values()) c.destroy();
    this.tcpConns.clear();
    this.sink = undefined;
  }

  // ---------- 帧发射 ----------

  private emit(dstMac: Uint8Array, srcMac: Uint8Array, ethType: number, payload: Uint8Array): void {
    if (this.closed || !this.sink) return;
    const frame = new Uint8Array(14 + payload.length);
    frame.set(dstMac, 0);
    frame.set(srcMac, 6);
    putU16(frame, 12, ethType);
    frame.set(payload, 14);
    this.sink(frame);
  }

  /** 发一个 IPv4 包给 guest（自动填以太网头） */
  private emitIp(srcIp: Uint8Array, dstIp: Uint8Array, proto: number, l4: Uint8Array): void {
    const ip = new Uint8Array(20 + l4.length);
    ip[0] = 0x45;
    putU16(ip, 2, ip.length);
    putU16(ip, 4, this.ipId++ & 0xffff);
    putU16(ip, 6, 0x4000); // DF
    ip[8] = 64;
    ip[9] = proto;
    ip.set(srcIp, 12);
    ip.set(dstIp, 16);
    putU16(ip, 10, checksum(ip, 0, 20));
    ip.set(l4, 20);
    this.emit(this.guestMacB, this.gwMacB, 0x0800, ip);
  }

  // ---------- ARP：代理应答 ----------

  private handleArp(p: Uint8Array): void {
    if (p.length < 28 || u16(p, 6) !== 1) return; // 只处理 request
    const spa = p.subarray(14, 18); // 发送方 IP
    const tpa = p.subarray(24, 28); // 请求的 IP
    this.debug(`ARP who-has ${ipStr(tpa)} tell ${ipStr(spa)}`);
    const reply = new Uint8Array(28);
    putU16(reply, 0, 1); // htype
    putU16(reply, 2, 0x0800); // ptype
    reply[4] = 6;
    reply[5] = 4;
    putU16(reply, 6, 2); // reply
    reply.set(this.gwMacB, 8); // sha = 网关 MAC
    reply.set(tpa, 14); // spa = 被请求的 IP（代理 ARP：任何 IP 都认）
    reply.set(this.guestMacB, 18); // tha
    reply.set(parseIp(this.opts.guestIp), 22); // tpa
    this.emit(this.guestMacB, this.gwMacB, 0x0806, reply);
  }

  // ---------- IPv4 分发 ----------

  private handleIpv4(p: Uint8Array): void {
    if (p.length < 20) return;
    const ihl = (p[0] & 0x0f) * 4;
    if (p.length < ihl) return;
    const proto = p[9];
    const srcIp = p.subarray(12, 16);
    const dstIp = p.subarray(16, 20);
    const l4 = p.subarray(ihl);
    if (proto === 1) return this.handleIcmp(srcIp, dstIp, l4);
    if (proto === 17) return this.handleUdp(srcIp, dstIp, l4);
    if (proto === 6) return this.handleTcp(srcIp, dstIp, l4);
  }

  // ---------- ICMP：网关 echo 应答 ----------

  private handleIcmp(srcIp: Uint8Array, dstIp: Uint8Array, p: Uint8Array): void {
    if (p.length < 8 || p[0] !== 8) return; // 只要 echo request
    if (ipStr(dstIp) !== this.opts.gwIp) return; // 外部 IP 不代理（同 QEMU slirp）
    const reply = new Uint8Array(p.length);
    reply.set(p);
    reply[0] = 0; // echo reply
    putU16(reply, 2, 0);
    putU16(reply, 2, checksum(reply, 0, reply.length));
    this.debug(`ICMP echo ${ipStr(srcIp)} -> 网关应答`);
    this.emitIp(dstIp, srcIp, 1, reply);
  }

  // ---------- UDP 转发 ----------

  private handleUdp(srcIp: Uint8Array, dstIp: Uint8Array, p: Uint8Array): void {
    if (p.length < 8) return;
    const srcPort = u16(p, 0);
    const dstPort = u16(p, 2);
    const data = p.subarray(8);
    let upHost = ipStr(dstIp);
    let upPort = dstPort;
    const isDnsToGw = dstPort === 53 && upHost === this.opts.gwIp;
    if (isDnsToGw) {
      upHost = this.dnsHost;
      upPort = this.dnsPort;
    }
    const key = `${ipStr(srcIp)}:${srcPort}:${upHost}:${upPort}`;
    let flow = this.udpFlows.get(key);
    if (!flow) {
      if (this.udpFlows.size >= MAX_UDP_FLOWS) {
        const oldest = [...this.udpFlows.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (oldest) this.closeUdpFlow(oldest[0]);
      }
      const sock = dgram.createSocket('udp4');
      flow = { sock, srcIp: Uint8Array.from(srcIp), srcPort, lastUsed: Date.now(), spoof: isDnsToGw };
      this.udpFlows.set(key, flow);
      sock.on('message', (msg, rinfo) => {
        this.udpBack(flow!, msg, rinfo.address, rinfo.port);
      });
      sock.on('error', () => this.closeUdpFlow(key));
      sock.bind(0);
      this.debug(`UDP 流新增 ${key} (共 ${this.udpFlows.size})`);
    }
    flow.lastUsed = Date.now();
    sockSend(flow.sock, data, upHost, upPort);
  }

  private udpBack(flow: UdpFlow, data: Buffer, remoteIp: string, remotePort: number): void {
    const total = 8 + data.length;
    const udp = new Uint8Array(total);
    // 回到 guest 的包：源端口=远端，目的端口=guest
    putU16(udp, 0, remotePort);
    putU16(udp, 2, flow.srcPort);
    putU16(udp, 4, total);
    udp.set(data, 8);
    // DNS 拦截流：源地址伪装成网关，让 guest 解析器认账
    const srcIpB = flow.spoof ? this.gwIpB : parseIp(remoteIp);
    // 注意：伪头必须用字节形式的 IP——传字符串会让校验和按 ASCII 码累加
    putU16(udp, 6, udpChecksum(udp, srcIpB, this.guestIpB));
    this.emitIp(srcIpB, flow.srcIp, 17, udp);
  }

  private closeUdpFlow(key: string): void {
    const f = this.udpFlows.get(key);
    if (!f) return;
    try { f.sock.close(); } catch { /* 已关 */ }
    this.udpFlows.delete(key);
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const [k, f] of this.udpFlows) {
      if (now - f.lastUsed > UDP_IDLE_MS) this.closeUdpFlow(k);
    }
  }

  // ---------- TCP 翻译器 ----------

  private handleTcp(srcIp: Uint8Array, dstIp: Uint8Array, p: Uint8Array): void {
    if (p.length < 20) return;
    const srcPort = u16(p, 0);
    const dstPort = u16(p, 2);
    const seq = u32(p, 4);
    const ack = u32(p, 8);
    const offset = (p[12] >> 4) * 4;
    const flags = p[13];
    const window = u16(p, 14);
    const payload = p.subarray(offset, Math.max(offset, p.length));
    const key = `${ipStr(srcIp)}:${srcPort}-${ipStr(dstIp)}:${dstPort}`;

    let conn = this.tcpConns.get(key);
    if (!conn) {
      if (!(flags & TCP_SYN)) return; // 无连接的非 SYN 包，忽略
      if (this.tcpConns.size >= 64) return;
      conn = new TcpConn(this, srcIp, srcPort, dstIp, dstPort, seq);
      this.tcpConns.set(key, conn);
      conn.synAck(); // 连接已注册，现在发 SYN-ACK（回调同步回包也安全）
      this.debug(`TCP 新连接 ${key} (共 ${this.tcpConns.size})`);
    } else if (flags & TCP_SYN && !(flags & TCP_ACK)) {
      conn.retransmitSynAck(); // 重传的 SYN
      return;
    }
    conn.guestIn(seq, ack, flags, window, payload);
  }

  /** 由 TcpConn 调用：把一段 TCP 报文装帧发给 guest */
  tcpEmit(conn: TcpConn, flags: number, seq: number, ack: number, payload?: Uint8Array, withMss = false): void {
    const hdr = withMss ? 24 : 20;
    const total = hdr + (payload?.length ?? 0);
    const tcp = new Uint8Array(total);
    putU16(tcp, 0, conn.dstPort);
    putU16(tcp, 2, conn.srcPort);
    putU32(tcp, 4, seq);
    putU32(tcp, 8, ack);
    tcp[12] = (hdr / 4) << 4;
    tcp[13] = flags;
    // SYN-ACK 阶段 peerWindow 还没学到来报文，通告 65535
    const win = conn.established ? Math.min(65535, Math.max(0, conn.peerWindow)) : 65535;
    putU16(tcp, 14, win);
    if (withMss) {
      tcp[20] = 2; tcp[21] = 4; putU16(tcp, 22, MSS); // MSS option
    }
    if (payload) tcp.set(payload, hdr);
    putU16(tcp, 16, tcpChecksum(tcp, conn.dstIp, this.guestIpB));
    this.emitIp(conn.dstIp, conn.srcIp, 6, tcp);
  }

  tcpClosed(conn: TcpConn): void {
    this.tcpConns.delete(`${ipStr(conn.srcIp)}:${conn.srcPort}-${ipStr(conn.dstIp)}:${conn.dstPort}`);
  }
}

interface UdpFlow {
  sock: dgram.Socket;
  srcIp: Uint8Array;
  srcPort: number;
  lastUsed: number;
  /** true 表示这是被拦截的 DNS 流：回包源地址要伪装成网关 */
  spoof: boolean;
}

function sockSend(sock: dgram.Socket, data: Uint8Array, host: string, port: number): void {
  sock.send(Buffer.from(data.buffer, data.byteOffset, data.byteLength), port, host);
}

// ---------- TCP 连接状态机 ----------

class TcpConn {
  // guest 侧序号（我们扮演远端服务端）
  rcvNxt: number; // 期待 guest 的下一个 seq
  sndIsn: number; // 我们的初始序号
  sndNxt: number; // 已发送到的位置
  sndUna: number; // 最早未确认
  peerWindow = 0;
  established = false;
  connected = false;
  hostFin = false;
  guestFin = false;
  sentFin = false;
  closed = false;

  private sock: net.Socket | undefined;
  private pending: Buffer = Buffer.alloc(0); // host 数据，等窗口
  private sentSegs: { seq: number; data: Uint8Array }[] = [];
  private retrans = setInterval(() => this.retransmit(), RETRANSMIT_MS);

  readonly backend: SlirpBackend;
  readonly srcIp: Uint8Array; // guest IP
  readonly srcPort: number;
  readonly dstIp: Uint8Array; // 远端 IP
  readonly dstPort: number;

  constructor(
    backend: SlirpBackend,
    srcIp: Uint8Array,
    srcPort: number,
    dstIp: Uint8Array,
    dstPort: number,
    guestIsn: number,
  ) {
    this.backend = backend;
    this.srcIp = srcIp;
    this.srcPort = srcPort;
    this.dstIp = dstIp;
    this.dstPort = dstPort;
    this.sndIsn = (Math.random() * 0x7fffffff) | 0;
    this.sndNxt = this.sndIsn;
    this.sndUna = this.sndIsn;
    this.rcvNxt = (guestIsn + 1) >>> 0; // SYN 消耗一个序号
    // 注意：SYN-ACK 必须等连接注册进 tcpConns 之后再发（handleTcp 里调
    // start()）——否则 onFrame 回调同步回包时会因查不到连接而静默丢帧。
    // Host 侧真实连接立即发起；guest 数据进 pending，'connect' 之后才
    // 真正写 socket——实测 connect 前队列的 write 在 connect 后可能丢失。
    const sock = net.connect({ host: ipStr(dstIp), port: dstPort });
    this.sock = sock;
    sock.on('connect', () => {
      this.backend.debug(`host connected ${ipStr(dstIp)}:${dstPort}`);
      this.pump();
    });
    sock.on('data', (d: Buffer) => {
      this.backend.debug(`host data ${d.length}B from ${ipStr(dstIp)}:${dstPort}`);
      this.pending = Buffer.concat([this.pending, d]);
      this.pump();
    });
    sock.on('end', () => {
      this.hostFin = true;
      this.pump();
    });
    sock.on('error', (e: Error) => {
      this.backend.debug(`TCP host error ${e.message}`);
      this.rst();
    });
    sock.on('close', () => {
      this.sock = undefined;
    });
  }

  private synAck(): void {
    // SYN-ACK 必须确认 guest 的 SYN（ack = guestIsn+1 = rcvNxt）——
    // 真内核会丢弃 ack=0 的 SYN-ACK（单测的假 guest 不校验，曾漏过）
    this.backend.tcpEmit(this, TCP_SYN | TCP_ACK, this.sndIsn, this.rcvNxt, undefined, true);
    this.sndNxt = (this.sndIsn + 1) >>> 0; // SYN 消耗一个序号
  }

  retransmitSynAck(): void {
    if (!this.established) this.synAck();
  }

  /** guest 段进入 */
  guestIn(seq: number, ack: number, flags: number, window: number, payload: Uint8Array): void {
    this.backend.debug(`guestIn seq=${seq} ack=${ack} flags=0x${flags.toString(16)} len=${payload.length} established=${this.established} rcvNxt=${this.rcvNxt} sndUna=${this.sndUna} sndNxt=${this.sndNxt}`);
    if (this.closed) return;
    if (flags & TCP_RST) return this.destroy();
    this.peerWindow = window;

    if (flags & TCP_ACK) {
      // 推进 sndUna（丢弃已确认段）
      if (seqGt(ack, this.sndUna) && !seqGt(ack, this.sndNxt)) {
        this.sndUna = ack;
        this.sentSegs = this.sentSegs.filter((s) => seqGt((s.seq + s.data.length) >>> 0, this.sndUna));
      }
      if (!this.established && !seqGt(this.sndIsn, ack)) {
        this.established = true; // guest 确认了我们的 SYN
      }
    }

    if (flags & TCP_FIN) {
      this.guestFin = true;
      this.rcvNxt = (seq + payload.length + 1) >>> 0;
      // ACK guest 的 FIN
      this.backend.tcpEmit(this, TCP_ACK, this.sndNxt, this.rcvNxt);
      this.sock?.end();
      return;
    }

    if (payload.length > 0) {
      if (seq === this.rcvNxt) {
        this.rcvNxt = (seq + payload.length) >>> 0;
        // guest → host：直接写真实 socket（guest→host 方向）
        if (this.sock && this.established) this.sock.write(Buffer.from(payload));
        // 立即 ACK
        this.backend.tcpEmit(this, TCP_ACK, this.sndNxt, this.rcvNxt);
        this.pump();
      } else if (!seqGt(seq, this.rcvNxt)) {
        // 重传/重复数据：重发 ACK
        this.backend.tcpEmit(this, TCP_ACK, this.sndNxt, this.rcvNxt);
      }
      // 序号超前的段（乱序）暂不缓存，等 guest 重传
    } else if (flags & TCP_ACK) {
      this.pump();
    }
  }

  /** 把 host 数据按窗口发往 guest */
  private pump(): void {
    if (this.closed || !this.established) return;
    let window = Math.min(this.peerWindow, 65535);
    if (window === 0) return; // 等 guest 的窗口更新 ACK

    while (this.pending.length > 0 && window - (this.sndNxt - this.sndUna) > 0) {
      const len = Math.min(MSS, this.pending.length, window - (this.sndNxt - this.sndUna));
      const seg = new Uint8Array(this.pending.subarray(0, len));
      this.sendSegment(seg);
      this.pending = this.pending.subarray(len);
    }

    if (this.hostFin && this.pending.length === 0 && !this.sentFin) {
      this.sentFin = true;
      this.sendSegment(new Uint8Array(0), TCP_FIN | TCP_ACK);
    }
  }

  private sendSegment(data: Uint8Array, flags = TCP_ACK | TCP_PSH): void {
    const seq = this.sndNxt;
    // 先推进 sndNxt 再发射：emit 会同步触发 onFrame（测试/探针会立刻
    // 回 ACK），若后推进，ACK 会因“超过 sndNxt”被误拒导致 sndUna 卡死。
    this.sndNxt = (this.sndNxt + data.length + (flags & TCP_FIN ? 1 : 0)) >>> 0;
    if (data.length) this.sentSegs.push({ seq, data });
    this.backend.tcpEmit(this, flags, seq, this.rcvNxt, data.length ? data : undefined);
  }

  /** 超时重传：从 sndUna 起把未确认段重发（go-back-N） */
  private retransmit(): void {
    if (this.closed) return;
    for (const s of this.sentSegs) {
      if (seqGt((s.seq + s.data.length) >>> 0, this.sndUna)) {
        this.backend.tcpEmit(this, TCP_ACK | TCP_PSH, s.seq, this.rcvNxt, s.data);
      }
    }
    if (this.sentFin && this.sentSegs.length === 0) {
      // FIN 未被确认：重发 FIN
      this.backend.tcpEmit(this, TCP_FIN | TCP_ACK, (this.sndNxt - 1) >>> 0, this.rcvNxt);
    }
  }

  /** 异常：给 guest 发 RST 并销毁 */
  private rst(): void {
    if (this.closed) return;
    this.backend.tcpEmit(this, TCP_RST | TCP_ACK, this.sndNxt, this.rcvNxt);
    this.destroy();
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.retrans);
    this.sock?.destroy();
    this.backend.tcpClosed(this);
  }
}

// ---------- TCP/UDP 校验和（带伪头） ----------

function l4Checksum(l4: Uint8Array, srcIp: Uint8Array, dstIp: Uint8Array, proto: number): number {
  let sum = 0;
  for (let i = 0; i < 4; i += 2) sum += (srcIp[i] << 8) | srcIp[i + 1];
  for (let i = 0; i < 4; i += 2) sum += (dstIp[i] << 8) | dstIp[i + 1];
  sum += proto;
  sum += l4.length;
  for (let i = 0; i < l4.length - 1; i += 2) sum += (l4[i] << 8) | l4[i + 1];
  if (l4.length & 1) sum += l4[l4.length - 1] << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
}

function udpChecksum(l4: Uint8Array, srcIp: Uint8Array, dstIp: Uint8Array): number {
  const c = l4Checksum(l4, srcIp, dstIp, 17);
  return c === 0 ? 0xffff : c;
}

// tcpChecksum 由 SlirpBackend.tcpEmit 经 l4Checksum 使用
export function tcpChecksum(l4: Uint8Array, srcIp: Uint8Array, dstIp: Uint8Array): number {
  return l4Checksum(l4, srcIp, dstIp, 6);
}

function u32(arr: Uint8Array, o: number): number {
  return ((arr[o] << 24) | (arr[o + 1] << 16) | (arr[o + 2] << 8) | arr[o + 3]) >>> 0;
}
