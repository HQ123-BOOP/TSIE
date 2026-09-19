/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
// virtio-9p 设备层测试：用合成 guest 驱动（按 Linux 9pnet_virtio 的初始化顺序）
// 直驱 MMIO 寄存器 + virtqueue，验证设备识别 / 特性协商 / config tag / 消息往返。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Bus } from '../src/mem/bus.ts';
import { RAM } from '../src/mem/ram.ts';
import type { MemSize } from '../src/mem/types.ts';
import { Virtio9p } from '../src/dev/virtio-9p.ts';

const BASE = 0x10003000n;
const RAM_BASE = 0x80000000n;
const O = (a: bigint) => a - RAM_BASE;
const DESC = 0x80010000n;
const AVAIL = 0x80011000n;
const USED = 0x80012000n;
const REQ = 0x80020000n;
const RSP = 0x80021000n;

const str = (s: string): Buffer => {
  const b = Buffer.from(s, 'utf8');
  const h = Buffer.alloc(2);
  h.writeUInt16LE(b.length);
  return Buffer.concat([h, b]);
};
const u32 = (v: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};
const msg = (type: number, tag: number, body: Buffer): Buffer => {
  const out = Buffer.alloc(7 + body.length);
  out.writeUInt32LE(out.length, 0);
  out[4] = type;
  out.writeUInt16LE(tag, 5);
  body.copy(out, 7);
  return out;
};

async function makeDev(tag = 'hostshare') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tsie-9p-vio-'));
  await fsp.writeFile(path.join(dir, 'host.txt'), 'hello\n');
  const bus = new Bus();
  const ram = new RAM(4 * 1024 * 1024);
  bus.addDevice(RAM_BASE, ram);
  let irqs = 0;
  const dev = new Virtio9p(bus, () => irqs++, dir, tag);
  bus.addDevice(BASE, dev);
  return { bus, ram, dev, dir, irqs: () => irqs };
}

test('virtio-9p：设备识别、特性与 config tag', async () => {
  const { dev, dir } = await makeDev();
  try {
    const r = (off: number, size: MemSize) => Number(dev.read(BigInt(off), size));
    assert.equal(r(0x00, 4), 0x74726976, "magic 应为 'virt'");
    assert.equal(r(0x04, 4), 2, 'MMIO 版本 = 2');
    assert.equal(r(0x08, 4), 9, 'DeviceID = 9（9p）');
    assert.equal(r(0x10, 4) & 1, 1, '低页应含 VIRTIO_9P_MOUNT_TAG(bit0)');
    dev.write(0x14n, 1n, 4); // DeviceFeaturesSel = 1
    assert.equal(r(0x10, 4) & 1, 1, '高页应含 VIRTIO_F_VERSION_1');
    dev.write(0x14n, 0n, 4);
    assert.equal(r(0x34, 4), 64, 'QueueNumMax = 64');
    // config：tag_len[2] + tag[]（struct virtio_9p_config）
    const len = r(0x100, 2);
    let tag = '';
    for (let i = 0; i < len; i++) tag += String.fromCharCode(r(0x102 + i, 1));
    assert.equal(tag, 'hostshare', 'config tag 应与构造参数一致');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('virtio-9p：Tversion 经 virtqueue 往返（used 环 + 中断）', async () => {
  const { ram, dev, dir, irqs } = await makeDev();
  try {
    const w = (off: number, v: number, size: MemSize) => dev.write(BigInt(off), BigInt(v), size);
    // 特性协商 + 状态：ACK | DRIVER | FEATURES_OK
    w(0x20, 1, 4); // GuestFeatures 低页 = MOUNT_TAG
    w(0x24, 1, 4); // GuestFeaturesSel = 1
    w(0x20, 1, 4); // 高页 = VERSION_1
    w(0x24, 0, 4);
    w(0x70, 1 | 2 | 8, 4);
    // 队列 0
    w(0x30, 0, 4); // QueueSel
    w(0x38, 8, 4); // QueueNum
    w(0x80, Number(DESC & 0xffffffffn), 4);
    w(0x84, Number(DESC >> 32n), 4);
    w(0x90, Number(AVAIL & 0xffffffffn), 4);
    w(0x94, Number(AVAIL >> 32n), 4);
    w(0xa0, Number(USED & 0xffffffffn), 4);
    w(0xa4, Number(USED >> 32n), 4);
    w(0x44, 1, 4); // QueueReady
    w(0x70, 1 | 2 | 8 | 4, 4); // DRIVER_OK

    // Tversion(msize=8192, '9P2000.L')
    const tver = msg(100, 0, Buffer.concat([u32(8192), str('9P2000.L')]));
    for (let i = 0; i < tver.length; i++) ram.write(O(REQ) + BigInt(i), BigInt(tver[i]), 1);
    // desc[0] = 请求（设备只读，NEXT），desc[1] = 回复（设备可写）
    ram.write(O(DESC), REQ, 8);
    ram.write(O(DESC) + 8n, BigInt(tver.length), 4);
    ram.write(O(DESC) + 12n, 1n, 2); // flags = NEXT
    ram.write(O(DESC) + 14n, 1n, 2); // next = 1
    ram.write(O(DESC) + 16n, RSP, 8);
    ram.write(O(DESC) + 24n, 4096n, 4);
    ram.write(O(DESC) + 28n, 2n, 2); // flags = WRITE
    ram.write(O(DESC) + 30n, 0n, 2); // next = 0
    // avail: flags[2] + idx[2] + ring[]；ring[0] = 0，idx = 1
    ram.write(O(AVAIL), 0n, 2);
    ram.write(O(AVAIL) + 2n, 1n, 2);
    ram.write(O(AVAIL) + 4n, 0n, 2);

    w(0x50, 0, 4); // QueueNotify = 0

    // 回复是异步的（fs 操作），轮询等 used 环推进
    for (let i = 0; i < 50 && Number(ram.read(O(USED) + 2n, 2)) !== 1; i++) {
      await new Promise((res) => setTimeout(res, 20));
    }
    assert.equal(Number(ram.read(O(USED) + 2n, 2)), 1, 'used.idx 应推进到 1');
    assert.equal(Number(ram.read(O(USED) + 4n, 4)), 0, 'used.ring[0].id = 0');
    const len = Number(ram.read(O(USED) + 8n, 4));
    assert.ok(len > 0, 'used.ring[0].len > 0');
    const buf = Buffer.alloc(len);
    for (let i = 0; i < len; i++) buf[i] = Number(ram.read(O(RSP) + BigInt(i), 1));
    assert.equal(buf[4], 101, 'R 消息应为 Rversion(101)');
    assert.equal(buf.readUInt32LE(7), 8192, 'msize 回显 8192');
    assert.equal(buf.toString('utf8', 13, 13 + buf.readUInt16LE(11)), '9P2000.L');
    assert.ok(irqs() > 0, '必须产生中断（guest 靠它收包）');
    assert.equal(dev.stats().requests, 1);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
