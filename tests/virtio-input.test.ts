/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
// virtio-input 设备层测试：用合成 guest 驱动验证设备识别、选择式 config、
// 以及**设备→guest 方向的 eventq**（驱动挂空缓冲、设备填事件再 pushUsed）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../src/mem/bus.ts';
import { RAM } from '../src/mem/ram.ts';
import { VirtioInput, keyCodeFromBrowser, keyCodeFromChar, EV_KEY, EV_SYN } from '../src/dev/virtio-input.ts';
import { Machine, VIRT_VIRTIO_INPUT } from '../src/machine.ts';

const RAM_BASE = 0x80000000n;
const BASE = 0x10005000n;
const O = (a: bigint) => a - RAM_BASE;

// --- MMIO 寄存器 ---
const FEATURES = 0x20;
const FEATURES_SEL = 0x24;
const STATUS = 0x70;
const QUEUE_SEL = 0x30;
const QUEUE_NUM = 0x38;
const QUEUE_READY = 0x44;
const QUEUE_NOTIFY = 0x50;
const QUEUE_DESC_LOW = 0x80;
const QUEUE_DRIVER_LOW = 0x90;
const QUEUE_DEVICE_LOW = 0xa0;
const INTERRUPT_STATUS = 0x60;
const INTERRUPT_ACK = 0x64;
const CONFIG = 0x100;

const RING_NUM = 8;
/** 事件缓冲基址：每个 16 字节足够放一个 virtio_input_event */
const EVBUF = 0x80020000n;
const EVBUF_STRIDE = 16n;

type Size = 1 | 2 | 4 | 8;
const w = (dev: VirtioInput, off: number, v: number, size: Size = 4) =>
  dev.write(BigInt(off), BigInt(v), size);
const r = (dev: VirtioInput, off: number, size: Size = 4) => Number(dev.read(BigInt(off), size));
const rw = (ram: RAM, off: bigint, v: bigint, size: Size) => ram.write(O(off), v, size);
const mem16 = (ram: RAM, off: bigint) => Number(ram.read(O(off), 2));

function makeEnv() {
  const bus = new Bus();
  const ram = new RAM(8 * 1024 * 1024);
  bus.addDevice(RAM_BASE, ram);
  let irqs = 0;
  const dev = new VirtioInput(bus, () => {
    irqs++;
  });
  bus.addDevice(BASE, dev);
  return { bus, ram, dev, irqs: () => irqs };
}

/** 特性协商 + 两条队列就绪（virtio 1.0 现代流程） */
function initDriver(dev: VirtioInput): void {
  w(dev, FEATURES_SEL, 1);
  w(dev, FEATURES, 1); // VIRTIO_F_VERSION_1（高 32 位）
  w(dev, FEATURES_SEL, 0);
  w(dev, STATUS, 1 | 2 | 8); // ACK | DRIVER | FEATURES_OK
}

/**
 * 设定队列 i 的三环地址并置 ready。
 * desc/avail/used 三块内存由调用方（测试）自行清零即可。
 */
function setQueue(dev: VirtioInput, i: number, desc: bigint, avail: bigint, used: bigint): void {
  w(dev, QUEUE_SEL, i);
  w(dev, QUEUE_NUM, RING_NUM);
  w(dev, QUEUE_DESC_LOW, Number(desc & 0xffffffffn));
  w(dev, QUEUE_DESC_LOW + 4, Number(desc >> 32n));
  w(dev, QUEUE_DRIVER_LOW, Number(avail & 0xffffffffn));
  w(dev, QUEUE_DRIVER_LOW + 4, Number(avail >> 32n));
  w(dev, QUEUE_DEVICE_LOW, Number(used & 0xffffffffn));
  w(dev, QUEUE_DEVICE_LOW + 4, Number(used >> 32n));
  w(dev, QUEUE_READY, 1);
}

const Q0_DESC = 0x80010000n;
const Q0_AVAIL = 0x80011000n;
const Q0_USED = 0x80012000n;
const Q1_DESC = 0x80013000n;
const Q1_AVAIL = 0x80014000n;
const Q1_USED = 0x80015000n;

/** 起一个 eventq（队列 0）可用的设备 */
function makeReadyEnv() {
  const env = makeEnv();
  initDriver(env.dev);
  setQueue(env.dev, 0, Q0_DESC, Q0_AVAIL, Q0_USED);
  setQueue(env.dev, 1, Q1_DESC, Q1_AVAIL, Q1_USED);
  w(env.dev, STATUS, 1 | 2 | 8 | 4); // DRIVER_OK
  return env;
}

/** 驱动往 eventq 挂第 slot 个空缓冲（desc[slot] → 缓冲；avail 环 +1；notify） */
function postEventBuffer(ram: RAM, dev: VirtioInput, slot: number, bufLen = 64n): void {
  const d = Q0_DESC + BigInt(slot * 16);
  rw(ram, d, EVBUF + BigInt(slot) * EVBUF_STRIDE, 8); // addr
  rw(ram, d + 8n, bufLen, 4); // len
  rw(ram, d + 12n, 0n, 2); // flags：设备可写
  rw(ram, d + 14n, 0n, 2);
  rw(ram, Q0_AVAIL + BigInt(4 + slot * 2), BigInt(slot), 2); // head = desc[slot]
  rw(ram, Q0_AVAIL + 2n, BigInt(slot + 1), 2); // avail.idx
  w(dev, QUEUE_NOTIFY, 0);
}

const evOf = (ram: RAM, addr: bigint) => {
  const b = ram.data.slice(Number(O(addr)), Number(O(addr)) + 8);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { type: dv.getUint16(0, true), code: dv.getUint16(2, true), value: dv.getUint32(4, true) };
};

test('virtio-input：设备识别与选择式 config', () => {
  const { dev } = makeEnv();
  assert.equal(r(dev, 0x00), 0x74726976, "magic 'virt'");
  assert.equal(r(dev, 0x08), 18, 'DeviceID = 18（input）');
  assert.equal(r(dev, 0x34), 64, 'QueueNumMax = 64');

  // ID_NAME：写 select=1 后读 size 与字符串
  w(dev, CONFIG + 0, 1, 1);
  const nameLen = r(dev, CONFIG + 2, 1);
  assert.ok(nameLen > 0, 'ID_NAME 的 size 必须非 0');
  let name = '';
  for (let i = 0; i < nameLen - 1; i++) name += String.fromCharCode(r(dev, CONFIG + 8 + i, 1));
  assert.equal(name, 'TSIE Virtio Keyboard');

  // EV_BITS(EV_SYN)：size = 1，bit0（SYN_REPORT）置位
  w(dev, CONFIG + 0, 0x11, 1);
  w(dev, CONFIG + 1, EV_SYN, 1);
  assert.equal(r(dev, CONFIG + 2, 1), 1, 'EV_SYN 位图 1 字节');
  assert.equal(r(dev, CONFIG + 8, 1) & 0x01, 0x01, 'SYN_REPORT 必须置位');

  // EV_BITS(EV_KEY)：覆盖到 KEY_MAX(0x2ff) → 96 字节，且 KeyA(30) 置位
  w(dev, CONFIG + 1, EV_KEY, 1);
  assert.equal(r(dev, CONFIG + 2, 1), 96, 'EV_KEY 位图 96 字节');
  assert.equal(r(dev, CONFIG + 8 + (30 >> 3), 1) & (1 << (30 & 7)), 1 << (30 & 7), 'code 30（KeyA）置位');

  // 未提供的子配置：size = 0（驱动视为不存在）
  w(dev, CONFIG + 0, 0x99, 1);
  assert.equal(r(dev, CONFIG + 2, 1), 0, '未知 select → size 0');
});

test('virtio-input：设备→guest 的 eventq（驱动挂空缓冲、设备填事件）', () => {
  const { dev, ram, irqs } = makeReadyEnv();
  postEventBuffer(ram, dev, 0);
  postEventBuffer(ram, dev, 1);

  const before = irqs();
  dev.sendKey(30, true); // KEY_A 按下：EV_KEY + EV_SYN 两个事件

  assert.deepEqual(evOf(ram, EVBUF), { type: EV_KEY, code: 30, value: 1 }, '缓冲 0 = EV_KEY/30/1');
  assert.deepEqual(
    evOf(ram, EVBUF + EVBUF_STRIDE),
    { type: EV_SYN, code: 0, value: 0 },
    '缓冲 1 = EV_SYN',
  );

  assert.equal(mem16(ram, Q0_USED + 2n), 2, '两个缓冲都应回 used');
  assert.equal(Number(ram.read(O(Q0_USED) + 8n, 4)), 8, 'used.len = sizeof(virtio_input_event)');
  assert.ok(irqs() > before, '设备必须拉中断（驱动在中断里读 eventq）');
  assert.equal(r(dev, INTERRUPT_STATUS), 1, 'INT_VRING 置位');
  w(dev, INTERRUPT_ACK, 1);
  assert.equal(r(dev, INTERRUPT_STATUS), 0, '应答后撤下');
});

test('virtio-input：没有空缓冲时事件被丢弃，不推进 used', () => {
  const { dev, ram } = makeReadyEnv();
  dev.sendKey(30, true); // 一个缓冲都没挂
  assert.equal(mem16(ram, Q0_USED + 2n), 0, 'used 不应推进');
  const st = dev.stats();
  assert.equal(st.events, 0);
  assert.equal(st.dropped, 2, 'EV_KEY 与 EV_SYN 各丢一次');
});

test('virtio-input：statusq 上的驱动事件被回收（pushUsed）', () => {
  const { dev, ram } = makeReadyEnv();
  const d = Q1_DESC;
  rw(ram, d, 0x80030000n, 8);
  rw(ram, d + 8n, 8n, 4);
  rw(ram, Q1_AVAIL + 4n, 0n, 2);
  rw(ram, Q1_AVAIL + 2n, 1n, 2);
  w(dev, QUEUE_NOTIFY, 1);
  assert.equal(mem16(ram, Q1_USED + 2n), 1, 'statusq 必须回 used，否则驱动缓冲泄漏');
});

test('virtio-input：浏览器键码与字符映射', () => {
  assert.equal(keyCodeFromBrowser('KeyA'), 30);
  assert.equal(keyCodeFromBrowser('Enter'), 28);
  assert.equal(keyCodeFromBrowser('ArrowUp'), 103);
  assert.equal(keyCodeFromBrowser('ShiftLeft'), 42);
  assert.equal(keyCodeFromBrowser('F12'), 88);
  assert.equal(keyCodeFromBrowser('UnknownKey'), undefined);

  assert.deepEqual(keyCodeFromChar('a'), [30, false]);
  assert.deepEqual(keyCodeFromChar('A'), [30, true]);
  assert.deepEqual(keyCodeFromChar('1'), [2, false]);
  assert.deepEqual(keyCodeFromChar('\r'), [28, false]);
  assert.deepEqual(keyCodeFromChar('/'), [53, false]);
  assert.equal(keyCodeFromChar('中'), undefined);
});

test('virtio-input：sendText 大写会带 Shift，且每个键位成对上报', () => {
  const { dev, ram } = makeReadyEnv();
  for (let i = 0; i < 8; i++) postEventBuffer(ram, dev, i);
  dev.sendText('A');
  // 'A' = Shift 按下/抬起 + A 按下/抬起 → 4 次 sendKey，每次 2 个事件（EV_KEY + EV_SYN）
  assert.equal(mem16(ram, Q0_USED + 2n), 8, "'A' 应产生 8 个事件");
  assert.deepEqual(evOf(ram, EVBUF), { type: EV_KEY, code: 42, value: 1 }, '先按左 Shift');
  assert.deepEqual(
    evOf(ram, EVBUF + EVBUF_STRIDE * 2n),
    { type: EV_KEY, code: 30, value: 1 },
    '再按 A',
  );
});

test('virtio-input：挂到机器后 DTB 出现对应 virtio_mmio 节点', () => {
  const m = new Machine({ memSize: 32n * 1024n * 1024n, input: {} });
  assert.ok(m.input, '机器上应有 virtio-input');
  assert.equal(VIRT_VIRTIO_INPUT, 0x10005000n, 'input 设备地址常量');
  const dtb = m.generateDtb('');
  const needle = 'virtio_mmio@10005000';
  let found = false;
  for (let i = 0; i + needle.length <= dtb.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (dtb[i + j] !== needle.charCodeAt(j)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      found = true;
      break;
    }
  }
  assert.ok(found, 'DTB 里应有 virtio_mmio@10005000 节点');
});
