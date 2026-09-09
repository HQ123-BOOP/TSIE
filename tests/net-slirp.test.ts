/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
// SlirpBackend 单测：测试脚本扮演 guest 协议栈，直接用帧驱动后端。
// 覆盖：ARP 代理应答 / ICMP echo / UDP 转发（含校验和）/ TCP 全往返+FIN / RST。
import * as dgram from 'node:dgram';
import * as net from 'node:net';
import assert from 'node:assert/strict';
import test from 'node:test';
import { SlirpBackend } from '../src/dev/net-slirp.ts';
import type { EthFrame } from '../src/dev/net.ts';

const GUEST_MAC = '52:54:00:12:34:56';
const GW_MAC = '52:54:00:12:34:02';
const GUEST_IP = '10.0.0.1';
const GW_IP = '10.0.0.2';

function parseMac(s: string): Buffer {
  return Buffer.from(s.split(':').map((x) => parseInt(x, 16)));
}
function parseIp(s: string): Buffer {
  return Buffer.from(s.split('.').map((x) => parseInt(x, 10)));
}
function ipStr(b: Uint8Array): string {
  return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
}
function u16(a: Uint8Array, o: number): number {
  return (a[o] << 8) | a[o + 1];
}
function u32(a: Uint8Array, o: number): number {
  return ((a[o] << 24) | (a[o + 1] << 16) | (a[o + 2] << 8) | a[o + 3]) >>> 0;
}
function putU16(a: Uint8Array, o: number, v: number): void {
  a[o] = (v >> 8) & 0xff;
  a[o + 1] = v & 0xff;
}
function putU32(a: Uint8Array, o: number, v: number): void {
  a[o] = (v >>> 24) & 0xff;
  a[o + 1] = (v >>> 16) & 0xff;
  a[o + 2] = (v >>> 8) & 0xff;
  a[o + 3] = v & 0xff;
}
function checksum(data: Uint8Array, start: number, len: number): number {
  let sum = 0;
  for (let i = start; i < start + len - 1; i += 2) sum += (data[i] << 8) | data[i + 1];
  if (len & 1) sum += data[start + len - 1] << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
}
function l4Checksum(l4: Uint8Array, srcIp: Buffer, dstIp: Buffer, proto: number): number {
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

// ---------- guest 协议栈模拟 ----------

class Guest {
  frames: Buffer[] = [];
  backend: SlirpBackend;

  constructor(backend: SlirpBackend) {
    this.backend = backend;
    backend.onFrame((f) => this.frames.push(Buffer.from(f)));
  }

  send(frame: Buffer): void {
    this.backend.send(frame);
  }

  private eth(dst: string, ethType: number, payload: Buffer): Buffer {
    const f = Buffer.alloc(14 + payload.length);
    parseMac(dst).copy(f, 0);
    parseMac(GUEST_MAC).copy(f, 6);
    putU16(f, 12, ethType);
    payload.copy(f, 14);
    return f;
  }

  arpRequest(targetIp: string): void {
    const p = Buffer.alloc(28);
    putU16(p, 0, 1);
    putU16(p, 2, 0x0800);
    p[4] = 6;
    p[5] = 4;
    putU16(p, 6, 1);
    parseMac(GUEST_MAC).copy(p, 8);
    parseIp(GUEST_IP).copy(p, 14);
    Buffer.alloc(6).copy(p, 18);
    parseIp(targetIp).copy(p, 24);
    this.send(this.eth('ff:ff:ff:ff:ff:ff', 0x0806, p));
  }

  private ipPacket(srcIp: string, dstIp: string, proto: number, l4: Buffer): Buffer {
    const ip = Buffer.alloc(20 + l4.length);
    ip[0] = 0x45;
    putU16(ip, 2, ip.length);
    ip[8] = 64;
    ip[9] = proto;
    parseIp(srcIp).copy(ip, 12);
    parseIp(dstIp).copy(ip, 16);
    putU16(ip, 10, checksum(ip, 0, 20));
    l4.copy(ip, 20);
    return this.eth(GW_MAC, 0x0800, ip);
  }

  icmpEcho(dstIp: string, id: number, seq: number, data: Buffer): void {
    const icmp = Buffer.alloc(8 + data.length);
    icmp[0] = 8; // request
    putU16(icmp, 4, id);
    putU16(icmp, 6, seq);
    data.copy(icmp, 8);
    putU16(icmp, 2, checksum(icmp, 0, icmp.length));
    this.send(this.ipPacket(GUEST_IP, dstIp, 1, icmp));
  }

  udp(srcPort: number, dstIp: string, dstPort: number, data: Buffer): void {
    const udp = Buffer.alloc(8 + data.length);
    putU16(udp, 0, srcPort);
    putU16(udp, 2, dstPort);
    putU16(udp, 4, udp.length);
    data.copy(udp, 8);
    putU16(udp, 6, l4Checksum(udp, parseIp(GUEST_IP), parseIp(dstIp), 17));
    this.send(this.ipPacket(GUEST_IP, dstIp, 17, udp));
  }

  tcp(dstIp: string, dstPort: number, seq: number, ack: number, flags: number, win = 65535, payload?: Buffer): void {
    const tcp = Buffer.alloc(20 + (payload?.length ?? 0));
    putU16(tcp, 0, 40000);
    putU16(tcp, 2, dstPort);
    putU32(tcp, 4, seq);
    putU32(tcp, 8, ack);
    tcp[12] = 5 << 4;
    tcp[13] = flags;
    putU16(tcp, 14, win);
    if (payload) payload.copy(tcp, 20);
    putU16(tcp, 16, l4Checksum(tcp, parseIp(GUEST_IP), parseIp(dstIp), 6));
    this.send(this.ipPacket(GUEST_IP, dstIp, 6, tcp));
  }

  /** 按 IPv4 解析收到的帧 */
  parseIpFrame(f: Buffer): { proto: number; srcIp: string; dstIp: string; l4: Buffer } | undefined {
    if (f.length < 34 || u16(f, 12) !== 0x0800) return undefined;
    return { proto: f[14 + 9], srcIp: ipStr(f.subarray(26, 30)), dstIp: ipStr(f.subarray(30, 34)), l4: f.subarray(34) };
  }

  waitFor(pred: (f: Buffer) => boolean, ms = 4000): Promise<Buffer> {
    const hit = this.frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        const hit = this.frames.find(pred);
        if (hit) {
          clearInterval(timer);
          resolve(hit);
        } else if (Date.now() - t0 > ms) {
          clearInterval(timer);
          reject(new Error(`waitFor 超时（已收 ${this.frames.length} 帧）`));
        }
      }, 10);
    });
  }
}

const TCP_FIN = 0x01, TCP_SYN = 0x02, TCP_RST = 0x04, TCP_PSH = 0x08, TCP_ACK = 0x10;

// ---------- 测试 ----------

test('slirp：ARP 代理应答——请求任何 IP 都回网关 MAC', () => {
  const b = new SlirpBackend();
  const g = new Guest(b);
  g.arpRequest(GW_IP);
  const f = g.frames.find((x) => u16(x, 12) === 0x0806);
  assert.ok(f, '应有 ARP reply');
  assert.equal(u16(f, 14 + 6), 2, 'op=reply');
  assert.equal(f.subarray(14 + 8, 14 + 14).toString('hex'), GW_MAC.split(':').join(''), 'sha=网关 MAC');
  assert.equal(ipStr(f.subarray(14 + 14, 14 + 18)), GW_IP, 'spa=被请求 IP');
  b.close();
});

test('slirp：ICMP echo 到网关应答（校验和正确）', () => {
  const b = new SlirpBackend();
  const g = new Guest(b);
  g.icmpEcho(GW_IP, 0x1234, 7, Buffer.from('ping-data'));
  const f = g.frames.find((x) => u16(x, 12) === 0x0800);
  assert.ok(f, '应有 ICMP reply');
  const l4 = f.subarray(34);
  assert.equal(l4[0], 0, 'type=echo reply');
  assert.equal((l4[4] << 8) | l4[5], 0x1234, 'id 保持');
  // 验证方法：把校验和字段含在内重算，补数和应为 0
  assert.equal(checksum(l4, 0, l4.length), 0, 'ICMP 校验和有效');
  assert.equal(l4.subarray(8).toString(), 'ping-data');
  b.close();
});

test('slirp：UDP 双向转发（Host dgram 服务器回显）', async () => {
  const server = dgram.createSocket('udp4');
  const serverPort = await new Promise<number>((resolve) => {
    server.on('message', (msg, rinfo) => server.send(Buffer.concat([Buffer.from('echo:'), msg]), rinfo.port, rinfo.address));
    server.bind(0, '127.0.0.1', () => resolve(server.address().port));
  });

  const b = new SlirpBackend();
  const g = new Guest(b);
  g.udp(5353, '127.0.0.1', serverPort, Buffer.from('hello-udp'));

  const f = await g.waitFor((x) => {
    if (u16(x, 12) !== 0x0800) return false;
    const ip = g.parseIpFrame(x);
    return ip?.proto === 17 && ip.srcIp === '127.0.0.1';
  });
  const l4 = f.subarray(34);
  // 校验和必须正确（含字段重算 = 0；伪头方向：src=127.0.0.1 dst=guest）
  assert.equal(l4Checksum(l4, parseIp('127.0.0.1'), parseIp(GUEST_IP), 17), 0, 'UDP 校验和有效');
  assert.equal(u16(l4, 0), serverPort, '源端口=服务器');
  assert.equal(u16(l4, 2), 5353, '目的端口=guest');
  assert.equal(l4.subarray(8).toString(), 'echo:hello-udp', '数据原样回环');

  b.close();
  server.close();
});

test('slirp：TCP 全往返（握手/数据回显/FIN 挥手）+ RST（连接拒绝）', async () => {
  const seen: string[] = [];
  let clientEnded = false;
  const server = net.createServer((sock) => {
    seen.push('conn');
    sock.on('data', (d) => {
      seen.push(`data:${d.toString()}`);
      sock.write(Buffer.concat([Buffer.from('reply:'), d]));
    });
    sock.on('end', () => {
      clientEnded = true;
      seen.push('end');
      sock.end();
    });
  });
  const serverPort = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));

  const b = new SlirpBackend();
  const g = new Guest(b);
  const DIP = '127.0.0.1';

  // 握手
  g.tcp(DIP, serverPort, 1000, 0, TCP_SYN);
  const synAck = await g.waitFor((x) => {
    const ip = g.parseIpFrame(x);
    if (ip?.proto !== 6) return false;
    const l4 = ip.l4;
    return u16(l4, 0) === serverPort && (l4[13] & (TCP_SYN | TCP_ACK)) === (TCP_SYN | TCP_ACK);
  });
  const isn = u32(synAck.subarray(34), 4);
  assert.equal(u32(synAck.subarray(34), 8), 1001, "SYN-ACK 必须确认 guest 的 SYN (ack=guestIsn+1)");
  assert.equal(ipStr(synAck.subarray(26, 30)), DIP);

  const mySeq = 1001;
  const ackOf = (theirNext: number) => g.tcp(DIP, serverPort, mySeq + (sentBytes), theirNext, TCP_ACK);
  let sentBytes = 0;
  ackOf((isn + 1) >>> 0);

  // 数据往返
  const payload = Buffer.from('hello-tcp');
  sentBytes += payload.length;
  g.tcp(DIP, serverPort, mySeq, (isn + 1) >>> 0, TCP_PSH | TCP_ACK, 65535, payload);

  const dataSeg = await g.waitFor((x) => {
    const ip = g.parseIpFrame(x);
    if (ip?.proto !== 6) return false;
    const l4 = ip.l4;
    return (l4[13] & TCP_PSH) !== 0 && l4.length > 20;
  });
  const tcpFrom = dataSeg.subarray(34);
  const theirSeq = u32(tcpFrom, 4);
  const echoed = tcpFrom.subarray(20);
  assert.equal(echoed.toString(), 'reply:hello-tcp', '服务器应答经 slirp 回到 guest');
  // TCP 校验和有效（含字段重算 = 0）
  assert.equal(l4Checksum(tcpFrom, parseIp(DIP), parseIp(GUEST_IP), 6), 0, 'TCP 校验和有效');
  // ACK 数据
  g.tcp(DIP, serverPort, mySeq + sentBytes, (theirSeq + echoed.length) >>> 0, TCP_ACK);

  // guest 主动关闭：FIN → 期待 ACK+FIN
  sentBytes += 0;
  g.tcp(DIP, serverPort, mySeq + sentBytes, (theirSeq + echoed.length) >>> 0, TCP_FIN | TCP_ACK);
  await g.waitFor((x) => {
    const ip = g.parseIpFrame(x);
    if (ip?.proto !== 6) return false;
    const l4 = ip.l4;
    return (l4[13] & TCP_FIN) !== 0;
  });

  // 服务器侧确认
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(seen.includes('conn') && seen.includes('data:hello-tcp') && clientEnded, `服务器事件: ${seen.join(',')}`);

  // RST：连一个没人听的端口
  g.tcp(DIP, 1, 5000, 0, TCP_SYN);
  await g.waitFor((x) => {
    const ip = g.parseIpFrame(x);
    if (ip?.proto !== 6) return false;
    const l4 = ip.l4;
    return (l4[13] & TCP_RST) !== 0;
  }, 6000);

  b.close();
  server.close();
});

test('slirp：发往网关 53 端口的 DNS 查询转发到上游，回包源地址伪装成网关', async () => {
  // 上游 DNS：本地 dgram 服务器，把查询原样回给发件人
  const upstream = dgram.createSocket('udp4');
  const upPort = await new Promise<number>((resolve) => {
    upstream.on('message', (msg, rinfo) =>
      upstream.send(Buffer.concat([Buffer.from('dns:'), msg]), rinfo.port, rinfo.address));
    upstream.bind(0, '127.0.0.1', () => resolve(upstream.address().port));
  });

  const b = new SlirpBackend({ dns: `127.0.0.1:${upPort}` });
  const g = new Guest(b);
  // guest 把网关当 DNS 服务器：10.0.0.2:53
  g.udp(49152, GW_IP, 53, Buffer.from('query'));

  const f = await g.waitFor((x) => {
    if (u16(x, 12) !== 0x0800) return false;
    const ip = g.parseIpFrame(x);
    return ip?.proto === 17 && ip.srcIp === GW_IP; // 必须是网关发回，否则解析器丢弃
  });
  const ip = g.parseIpFrame(f)!;
  assert.equal(ip.srcIp, GW_IP, '源 IP 伪装成网关');
  const l4 = f.subarray(34);
  assert.equal(l4.subarray(8).toString(), 'dns:query', '上游应答原样回传');
  assert.equal(l4Checksum(l4, parseIp(GW_IP), parseIp(GUEST_IP), 17), 0, '伪头按网关 IP 校验');

  b.close();
  upstream.close();
});
