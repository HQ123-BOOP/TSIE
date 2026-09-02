/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../src/mem/bus.ts';
import { RAM } from '../src/mem/ram.ts';
import { VirtioNet } from '../src/dev/virtio-net.ts';
import { LoopbackBackend, type EthFrame, type NetBackend } from '../src/dev/net.ts';

const BASE = 0x10000000n;
const RAM_BASE = 0x80000000n;
const O = (a: bigint) => a - RAM_BASE;

/** 一个记录帧的后端（TX 验证用），可手动回注帧 */
class SinkBackend implements NetBackend {
  sent: EthFrame[] = [];
  private cb: ((f: EthFrame) => void) | undefined;
  send(frame: EthFrame): void {
    this.sent.push(new Uint8Array(frame));
  }
  onFrame(cb: (f: EthFrame) => void): void {
    this.cb = cb;
  }
  inject(frame: EthFrame): void {
    this.cb?.(frame);
  }
  close(): void {}
}

function makeNet(backend: NetBackend = new SinkBackend()) {
  const bus = new Bus();
  const ram = new RAM(4 * 1024 * 1024);
  bus.addDevice(RAM_BASE, ram);
  let irqCount = 0;
  const dev = new VirtioNet(bus, backend, () => irqCount++);
  bus.addDevice(BASE, dev);
  return { bus, ram, dev, backend, irqs: () => irqCount };
}

/** 按 guest 驱动初始化顺序配置一个队列（queueSel 参数化：RX=0 / TX=1） */
function setupQueue(
  ram: RAM,
  dev: VirtioNet,
  queueSel: number,
  layout: { desc: bigint; avail: bigint; used: bigint },
  num = 8,
) {
  dev.write(0x30n, BigInt(queueSel), 4); // QueueSel
  dev.write(0x38n, BigInt(num), 4); // QueueNum
  dev.write(0x80n, layout.desc & 0xffffffffn, 4);
  dev.write(0x84n, layout.desc >> 32n, 4);
  dev.write(0x90n, layout.avail & 0xffffffffn, 4);
  dev.write(0x94n, layout.avail >> 32n, 4);
  dev.write(0xa0n, layout.used & 0xffffffffn, 4);
  dev.write(0xa4n, layout.used >> 32n, 4);
  dev.write(0x44n, 1n, 4); // QueueReady
  dev.write(0x70n, 0x4n, 4); // Status = DRIVER_OK（简化）
}

test('virtio-net：设备识别与 config 空间', () => {
  const { dev } = makeNet();
  assert.equal(Number(dev.read(0x00n, 4)), 0x74726976, "magic 应为 'virt'");
  assert.equal(Number(dev.read(0x04n, 4)), 2, 'MMIO 版本 = 2');
  assert.equal(Number(dev.read(0x08n, 4)), 1, 'DeviceID = 1（网络）');
  // 特性：低页应有 F_MAC(bit5)；高页必须含 VIRTIO_F_VERSION_1(bit32)
  assert.equal(Number(dev.read(0x10n, 4)) & (1 << 5), 1 << 5, '低页应含 F_MAC');
  dev.write(0x14n, 1n, 4); // DeviceFeaturesSel = 1
  assert.equal(Number(dev.read(0x10n, 4)) & 0x1, 0x1, '高页应含 VERSION_1');
  dev.write(0x14n, 0n, 4);
  assert.equal(Number(dev.read(0x34n, 4)), 64, 'QueueNumMax = 64');
  // config：MAC 6 字节（packed，无对齐）
  const mac = [0x52, 0x54, 0x00, 0x12, 0x34, 0x56];
  for (let i = 0; i < 6; i++) assert.equal(Number(dev.read(0x100n + BigInt(i), 1)), mac[i], `mac[${i}]`);
  assert.equal(Number(dev.read(0x108n, 2)), 0, '未 offer STATUS，config 偏移 6+ 应为 0');
});

test('virtio-net：RX 注入——头 12B 全零 + 帧落 desc，used.len = 12+帧长', () => {
  const { ram, dev, irqs } = makeNet();
  const DESC = 0x80010000n;
  const AVAIL = 0x80011000n;
  const USED = 0x80012000n;
  const BUF = 0x80020000n;
  setupQueue(ram, dev, 0, { desc: DESC, avail: AVAIL, used: USED });

  // 驱动挂 1 个空缓冲：desc[0] 可写 len=12+1522；avail ring[0]=0, idx=1
  ram.write(O(DESC), BUF, 8);
  ram.write(O(DESC) + 8n, 1534n, 4);
  ram.write(O(DESC) + 12n, 2n, 2); // flags=WRITE
  ram.write(O(AVAIL), 0n, 2);
  ram.write(O(AVAIL) + 2n, 1n, 2);
  ram.write(O(AVAIL) + 4n, 0n, 2);

  const frame = new Uint8Array(64);
  for (let i = 0; i < frame.length; i++) frame[i] = i;
  dev.injectRx(frame);

  // 头 12 字节全零
  for (let i = 0; i < 12; i++) assert.equal(ram.read(O(BUF) + BigInt(i), 1), 0n, `hdr[${i}]=0`);
  // 帧紧随其后
  assert.equal(ram.read(O(BUF) + 12n, 4), 0x03020100n, '帧前 4 字节');
  assert.equal(ram.read(O(BUF) + 12n + 60n, 1), 60n, '帧尾字节');
  // used 环：idx=1、ring[0].id=0、len=12+64
  assert.equal(ram.read(O(USED) + 2n, 2), 1n, 'used idx');
  assert.equal(ram.read(O(USED) + 4n, 4), 0n, 'used id');
  assert.equal(ram.read(O(USED) + 8n, 4), 76n, 'used len = 12+64');
  assert.ok(irqs() > 0, 'RX 必须产生中断（NAPI 依赖）');
  assert.equal(dev.stats().rx, 1);
});

test('virtio-net：RX 无缓冲时排队，缓冲就位后泵出', () => {
  const { ram, dev } = makeNet();
  const DESC = 0x80010000n;
  const AVAIL = 0x80011000n;
  const USED = 0x80012000n;
  const BUF = 0x80020000n;
  setupQueue(ram, dev, 0, { desc: DESC, avail: AVAIL, used: USED });

  // 队列 ready 但驱动还没挂缓冲 → 进设备 FIFO
  const frame = new Uint8Array([1, 2, 3, 4]);
  dev.injectRx(frame);
  assert.equal(dev.stats().rx, 0, '无缓冲不投递');
  assert.equal(dev.stats().rxDropped, 0, '应排队而非丢弃');

  // 驱动挂上缓冲（avail idx: 0→1）
  ram.write(O(DESC), BUF, 8);
  ram.write(O(DESC) + 8n, 1534n, 4);
  ram.write(O(DESC) + 12n, 2n, 2);
  ram.write(O(AVAIL), 0n, 2);
  ram.write(O(AVAIL) + 2n, 1n, 2);
  ram.write(O(AVAIL) + 4n, 0n, 2);

  // 下一批请求到达（设备侧处理 avail 时泵 FIFO）
  ram.write(O(AVAIL) + 2n, 1n, 2);
  dev.write(0x50n, 0n, 4); // QueueNotify RX
  assert.equal(dev.stats().rx, 1, '缓冲就位后应投递排队帧');
});

test('virtio-net：TX——跳过 12B 头取帧，used.len=0，帧到后端', () => {
  const backend = new SinkBackend();
  const { ram, dev, irqs } = makeNet(backend);
  const DESC = 0x80010000n;
  const AVAIL = 0x80011000n;
  const USED = 0x80012000n;
  const HDR = 0x80020000n;
  const PAYLOAD = 0x80021000n;
  setupQueue(ram, dev, 1, { desc: DESC, avail: AVAIL, used: USED }); // TX 队

  // 驱动 can_push：头与帧可能同 desc——这里用二段式（头 desc + 帧 desc）验证
  ram.write(O(DESC), HDR, 8);
  ram.write(O(DESC) + 8n, 12n, 4);
  ram.write(O(DESC) + 12n, 1n, 2); // NEXT
  ram.write(O(DESC) + 14n, 1n, 2); // next=1
  ram.write(O(DESC) + 16n, PAYLOAD, 8);
  ram.write(O(DESC) + 24n, 14n, 4); // 帧长 14（含无 FCS）
  ram.write(O(DESC) + 28n, 0n, 2); // flags=0（设备读）

  // TX 头 12 字节（未协商 offload，全零也行——设备应忽略内容）
  for (let i = 0; i < 12; i++) ram.write(O(HDR) + BigInt(i), 0n, 1);
  // 帧数据
  const frame = new Uint8Array(14);
  for (let i = 0; i < frame.length; i++) {
    frame[i] = 0xa0 + i;
    ram.write(O(PAYLOAD) + BigInt(i), BigInt(frame[i]), 1);
  }

  ram.write(O(AVAIL), 0n, 2);
  ram.write(O(AVAIL) + 2n, 1n, 2);
  ram.write(O(AVAIL) + 4n, 0n, 2);

  dev.write(0x50n, 1n, 4); // QueueNotify TX（队列 1）

  assert.equal(backend.sent.length, 1, '后端应收到一帧');
  assert.deepEqual([...backend.sent[0]!], [...frame], '帧内容一致（不含头）');
  assert.equal(ram.read(O(USED) + 2n, 2), 1n, 'used idx');
  assert.equal(ram.read(O(USED) + 8n, 4), 0n, 'used len = 0');
  assert.ok(irqs() > 0, 'TX 完成必须中断（sq 满停队列后靠它唤醒）');
  assert.equal(dev.stats().tx, 1);
});

test('virtio-net：TX 头帧同 desc（can_push 布局）', () => {
  const backend = new SinkBackend();
  const { ram, dev } = makeNet(backend);
  const DESC = 0x80010000n;
  const AVAIL = 0x80011000n;
  const USED = 0x80012000n;
  const BUF = 0x80020000n;
  setupQueue(ram, dev, 1, { desc: DESC, avail: AVAIL, used: USED });

  // 单 desc：12B 头 + 帧连续
  const frame = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  ram.write(O(DESC), BUF, 8);
  ram.write(O(DESC) + 8n, BigInt(12 + frame.length), 4);
  ram.write(O(DESC) + 12n, 0n, 2);
  for (let i = 0; i < 12; i++) ram.write(O(BUF) + BigInt(i), 0n, 1);
  frame.forEach((b, i) => ram.write(O(BUF) + 12n + BigInt(i), BigInt(b), 1));

  ram.write(O(AVAIL), 0n, 2);
  ram.write(O(AVAIL) + 2n, 1n, 2);
  ram.write(O(AVAIL) + 4n, 0n, 2);
  dev.write(0x50n, 1n, 4);

  assert.equal(backend.sent.length, 1);
  assert.deepEqual([...backend.sent[0]!], [...frame], '单 desc 布局也能取帧');
});

test('virtio-net：Loopback 后端 TX 帧回注 RX', () => {
  const loop = new LoopbackBackend();
  const { ram, dev } = makeNet(loop);
  const DESC = 0x80010000n;
  const AVAIL = 0x80011000n;
  const USED = 0x80012000n;
  const BUF = 0x80020000n;
  // 配好两个队列
  setupQueue(ram, dev, 0, { desc: DESC, avail: 0x80013000n, used: 0x80014000n });
  setupQueue(ram, dev, 1, { desc: DESC + 0x100n, avail: 0x80015000n, used: 0x80016000n });
  const RX_AVAIL = 0x80013000n;

  // RX 空缓冲就位
  ram.write(O(DESC), BUF, 8);
  ram.write(O(DESC) + 8n, 1534n, 4);
  ram.write(O(DESC) + 12n, 2n, 2);
  ram.write(O(RX_AVAIL), 0n, 2);
  ram.write(O(RX_AVAIL) + 2n, 1n, 2);
  ram.write(O(RX_AVAIL) + 4n, 0n, 2);

  // TX 帧（单 desc 布局）
  const TX_DESC = 0x80010100n;
  const TX_AVAIL = 0x80015000n;
  const TX_USED = 0x80016000n;
  const TX_BUF = 0x80030000n;
  const frame = new Uint8Array(20);
  for (let i = 0; i < frame.length; i++) frame[i] = i + 1;
  ram.write(O(TX_DESC), TX_BUF, 8);
  ram.write(O(TX_DESC) + 8n, BigInt(12 + frame.length), 4);
  ram.write(O(TX_DESC) + 12n, 0n, 2);
  for (let i = 0; i < 12; i++) ram.write(O(TX_BUF) + BigInt(i), 0n, 1);
  frame.forEach((b, i) => ram.write(O(TX_BUF) + 12n + BigInt(i), BigInt(b), 1));
  ram.write(O(TX_AVAIL), 0n, 2);
  ram.write(O(TX_AVAIL) + 2n, 1n, 2);
  ram.write(O(TX_AVAIL) + 4n, 0n, 2);

  dev.write(0x50n, 1n, 4); // TX kick → loopback → 立即回注 RX

  assert.equal(dev.stats().tx, 1);
  assert.equal(dev.stats().rx, 1, 'loopback 应把 TX 帧送回 RX');
  assert.equal(ram.read(O(TX_USED) + 2n, 2), 1n, 'TX used 推进');
  // RX desc 内存里应有 12B 头 + 帧
  assert.equal(ram.read(O(BUF) + 12n, 1), 1n, '帧首字节');
  assert.equal(ram.read(O(BUF) + 12n + 19n, 1), 20n, '帧尾字节');
});

test('virtio-net：reset 后队列失效，注入帧进 FIFO 不投递', () => {
  const { ram, dev } = makeNet();
  setupQueue(ram, dev, 0, { desc: 0x80010000n, avail: 0x80011000n, used: 0x80012000n });
  dev.write(0x70n, 0n, 4); // Status = 0 → reset
  assert.equal(Number(dev.read(0x44n, 4)), 0, 'QueueReady 应清零');
  dev.injectRx(new Uint8Array([1]));
  assert.equal(dev.stats().rx, 0, 'reset 后不投递');
  assert.equal(dev.stats().rxDropped, 0, '先进 FIFO');
});

test('virtio-net：超大帧（> desc 容量）丢弃计 rx 后不入 used', () => {
  const { ram, dev } = makeNet();
  const DESC = 0x80010000n;
  const AVAIL = 0x80011000n;
  const USED = 0x80012000n;
  const BUF = 0x80020000n;
  setupQueue(ram, dev, 0, { desc: DESC, avail: AVAIL, used: USED });
  ram.write(O(DESC), BUF, 8);
  ram.write(O(DESC) + 8n, 100n, 4); // 缓冲只容 12+88
  ram.write(O(DESC) + 12n, 2n, 2);
  ram.write(O(AVAIL), 0n, 2);
  ram.write(O(AVAIL) + 2n, 1n, 2);
  ram.write(O(AVAIL) + 4n, 0n, 2);

  dev.injectRx(new Uint8Array(200)); // 超出 12+88
  assert.equal(dev.stats().rxDropped, 1, '超缓冲帧丢弃计数');
  assert.equal(ram.read(O(USED) + 2n, 2), 0n, '不入 used 环（驱动回收缓冲）');
});
