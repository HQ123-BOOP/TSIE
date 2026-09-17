/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
// virtio-pci 设备层测试：用合成 guest 驱动走完整的 PCI 初始化顺序
// （ECAM 枚举 → BAR 定容与分配 → 读能力链 → 经 common cfg 协商特性/建队列 → 发命令），
// 再校验 virtio-gpu 的响应与主中断状态。目的是把「PCI 传输」与「设备逻辑」解耦验一遍，
// 不必等到跑一整个 UEFI。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../src/mem/bus.ts';
import { RAM } from '../src/mem/ram.ts';
import { Machine, VIRT_PCIE_ECAM, VIRT_PCIE_MMIO, VIRT_PCIE_PIO } from '../src/machine.ts';

const RAM_BASE = 0x80000000n;
const O = (a: bigint) => a - RAM_BASE;

// --- PCI 配置空间 ---
const CFG_VENDOR = 0x00;
const CFG_COMMAND = 0x04;
const CFG_REVISION = 0x08;
const CFG_CLASS = 0x09;
const CFG_HEADER_TYPE = 0x0e;
const CFG_BAR0 = 0x10;
const CFG_SUBSYS = 0x2c;
const CFG_CAP_PTR = 0x34;

// --- common cfg（§4.1.4.3）---
const C_DEV_FEAT_SEL = 0x00;
const C_DEV_FEAT = 0x04;
const C_DRV_FEAT_SEL = 0x08;
const C_DRV_FEAT = 0x0c;
const C_DEV_STATUS = 0x14;
const C_QUEUE_SEL = 0x16;
const C_QUEUE_SIZE = 0x18;
const C_QUEUE_ENABLE = 0x1c;
const C_QUEUE_NOTIFY_OFF = 0x1e;
const C_QUEUE_DESC = 0x20;
const C_QUEUE_DRIVER = 0x28;
const C_QUEUE_DEVICE = 0x30;

const OFF_COMMON = 0x0000;
const OFF_ISR = 0x1000;
const OFF_DEVICE = 0x2000;
const OFF_NOTIFY = 0x3000;
const BAR0_ADDR = 0x40000000n;

const RING_NUM = 8;
const Q = [
  { desc: 0x80010000n, avail: 0x80011000n, used: 0x80012000n },
  { desc: 0x80013000n, avail: 0x80014000n, used: 0x80015000n },
];
const REQ = 0x80020000n;
const RSP = 0x80021000n;

type Size = 1 | 2 | 4 | 8;

function makeEnv(pci: { gpu?: boolean } = {}) {
  const m = new Machine({
    memSize: 64n * 1024n * 1024n,
    gpu: { width: 1024, height: 768 },
    pci,
  });
  return m;
}

/** ECAM 地址 = (bus<<20)|(dev<<15)|(fn<<12)|reg */
const ecam = (dev: number, fn: number, reg: number) => VIRT_PCIE_ECAM + BigInt((dev << 15) | (fn << 12) | reg);

function cfgRead(m: Machine, dev: number, fn: number, reg: number, size: Size): number {
  return Number(m.bus.read(ecam(dev, fn, reg), size));
}
function cfgWrite(m: Machine, dev: number, fn: number, reg: number, v: number, size: Size): void {
  m.bus.write(ecam(dev, fn, reg), BigInt(v), size);
}
/** 经 BAR0 访问设备（绕开配置空间） */
function barRead(m: Machine, off: number, size: Size): number {
  return Number(m.bus.read(BAR0_ADDR + BigInt(off), size));
}
function barWrite(m: Machine, off: number, v: number, size: Size): void {
  m.bus.write(BAR0_ADDR + BigInt(off), BigInt(v), size);
}

test('PCI：ECAM 枚举出 virtio-gpu 显示设备，空槽位读回全 1', () => {
  const m = makeEnv();
  assert.equal(cfgRead(m, 0, 0, CFG_VENDOR, 2), 0x1af4, 'vendor = Red Hat / virtio');
  assert.equal(cfgRead(m, 0, 0, CFG_VENDOR + 2, 2), 0x1050, 'device = 0x1040 + 16（virtio-gpu）');
  // 类码：基类必须是 0x03 —— UEFI 的 IsPciDisplay 只看这一位，
  // 而它决定了 PlatformBootManagerBeforeConsole() 会不会主动 connect 显示设备。
  assert.equal(cfgRead(m, 0, 0, CFG_CLASS + 2, 1), 0x03, 'base class = Display');
  assert.equal(cfgRead(m, 0, 0, CFG_CLASS + 1, 1), 0x80, 'sub class = Other');
  assert.equal(cfgRead(m, 0, 0, CFG_CLASS, 1), 0x00, 'progIf = 0');
  assert.equal(cfgRead(m, 0, 0, CFG_HEADER_TYPE, 1), 0x00, 'header type = 普通设备');
  assert.equal(cfgRead(m, 0, 0, CFG_SUBSYS + 2, 2), 16, '子系统 ID = virtio device id');
  assert.equal(cfgRead(m, 0, 0, CFG_CAP_PTR, 1), 0x40, '能力链从 0x40 开始');
  assert.equal(cfgRead(m, 0, 0, CFG_COMMAND, 2), 0, '命令寄存器初值为 0（等驱动打开）');
  assert.equal(cfgRead(m, 0, 0, CFG_REVISION, 1), 0x01, 'revision');

  // 没挂功能的槽位：PCI 惯例是读回全 1
  assert.equal(cfgRead(m, 5, 0, CFG_VENDOR, 2), 0xffff, '空槽位 vendor');
  assert.equal(cfgRead(m, 5, 0, CFG_VENDOR + 2, 2), 0xffff, '空槽位 device');
});

test('PCI：BAR0 定容（写全 1 读回掩码）与地址分配后立即路由', () => {
  const m = makeEnv();
  assert.equal(cfgRead(m, 0, 0, CFG_BAR0, 4), 0, '未分配时 BAR0 = 0');

  cfgWrite(m, 0, 0, CFG_BAR0, 0xffffffff, 4);
  const mask = cfgRead(m, 0, 0, CFG_BAR0, 4) >>> 0;
  assert.equal(mask, 0xffffc00f, '16KiB BAR 的掩码 + 低 4 位内存 BAR 标志（bit0=0）');

  cfgWrite(m, 0, 0, CFG_BAR0, Number(BAR0_ADDR), 4);
  assert.equal(cfgRead(m, 0, 0, CFG_BAR0, 4) >>> 0, Number(BAR0_ADDR), '地址回读一致');
  // 分配之后该窗口必须已经能访问到设备：device cfg 里 num_scanouts = 1
  assert.equal(barRead(m, OFF_DEVICE + 0x08, 4), 1, 'BAR 落定后 device cfg 立即可读');
  // 未分配前的窗口不该被路由
  assert.equal(cfgRead(m, 1, 0, CFG_VENDOR, 2), 0xffff, '设备 1 空槽位');
});

test('PCI：能力链给出 common/notify/ISR/device 四段结构', () => {
  const m = makeEnv();
  const seen: Array<{ type: number; bar: number; off: number; len: number }> = [];
  let p = cfgRead(m, 0, 0, CFG_CAP_PTR, 1);
  let guard = 0;
  while (p !== 0 && guard++ < 16) {
    assert.equal(cfgRead(m, 0, 0, p, 1), 0x09, 'PCI_CAP_ID_VNDR');
    const next = cfgRead(m, 0, 0, p + 1, 1);
    const len = cfgRead(m, 0, 0, p + 2, 1);
    const type = cfgRead(m, 0, 0, p + 3, 1);
    const bar = cfgRead(m, 0, 0, p + 4, 1);
    const off = cfgRead(m, 0, 0, p + 6, 4) >>> 0;
    const length = cfgRead(m, 0, 0, p + 10, 4) >>> 0;
    seen.push({ type, bar, off, len: length });
    assert.equal(len, type === 2 ? 20 : 16, 'notify 能力多带 4 字节乘数');
    p = next;
  }
  assert.deepEqual(
    seen.map((c) => [c.type, c.off]),
    [
      [1, OFF_COMMON],
      [2, OFF_NOTIFY],
      [3, OFF_ISR],
      [4, OFF_DEVICE],
    ],
    '四个能力依次为 common(1)/notify(2)/ISR(3)/device(4)，且偏移正确',
  );
  assert.ok(
    seen.every((c) => c.bar === 0),
    '四段结构都在 BAR0',
  );
  assert.equal(seen[3].len, 16, 'device cfg 长度 = virtio-gpu 的 config 空间大小');
});

/** 按 virtio 1.0 的现代流程协商特性并启用队列 */
function initDriver(m: Machine): void {
  const w = (off: number, v: number, size: Size) => barWrite(m, off, v, size);
  // 先把 BAR0 定容并分配到 MMIO 窗口 —— 之后所有 common/ISF/device/notify 访问都走这里
  cfgWrite(m, 0, 0, CFG_BAR0, 0xffffffff, 4);
  cfgWrite(m, 0, 0, CFG_BAR0, Number(BAR0_ADDR), 4);
  w(OFF_COMMON + C_DEV_STATUS, 0, 1); // 复位
  assert.equal(barRead(m, OFF_COMMON + C_DEV_STATUS, 1), 0, '复位后 device_status = 0');

  w(OFF_COMMON + C_DEV_STATUS, 1, 1); // ACKNOWLEDGE
  w(OFF_COMMON + C_DEV_STATUS, 1 | 2, 1); // DRIVER
  w(OFF_COMMON + C_DEV_FEAT_SEL, 1, 4);
  assert.equal(barRead(m, OFF_COMMON + C_DEV_FEAT, 4) >>> 0, 1, '高 32 位特性含 VIRTIO_F_VERSION_1');
  w(OFF_COMMON + C_DRV_FEAT_SEL, 1, 4);
  w(OFF_COMMON + C_DRV_FEAT, 1, 4);
  w(OFF_COMMON + C_DEV_STATUS, 1 | 2 | 8, 1); // FEATURES_OK
  assert.equal(barRead(m, OFF_COMMON + C_DEV_STATUS, 1), 1 | 2 | 8, 'FEATURES_OK 必须保持置位');

  for (let i = 0; i < Q.length; i++) {
    w(OFF_COMMON + C_QUEUE_SEL, i, 2);
    assert.equal(barRead(m, OFF_COMMON + C_QUEUE_NOTIFY_OFF, 2), i, 'queue_notify_off 应为队列下标');
    w(OFF_COMMON + C_QUEUE_SIZE, RING_NUM, 2);
    m.bus.write(BAR0_ADDR + BigInt(OFF_COMMON + C_QUEUE_DESC), Q[i].desc, 8);
    m.bus.write(BAR0_ADDR + BigInt(OFF_COMMON + C_QUEUE_DRIVER), Q[i].avail, 8);
    m.bus.write(BAR0_ADDR + BigInt(OFF_COMMON + C_QUEUE_DEVICE), Q[i].used, 8);
    w(OFF_COMMON + C_QUEUE_ENABLE, 1, 2);
  }
  w(OFF_COMMON + C_DEV_STATUS, 1 | 2 | 8 | 4, 1); // DRIVER_OK
}

test('PCI：经 common cfg 建队列、发 GET_DISPLAY_INFO 并收回响应', () => {
  const m = makeEnv();
  initDriver(m);

  // 铺一条「请求 → 响应缓冲」的描述符链
  const ram = m.ram;
  const rw = (off: bigint, v: bigint, size: Size) => ram.write(O(off), v, size);
  const req = new Uint8Array(24);
  new DataView(req.buffer).setUint32(0, 0x0100, true); // GET_DISPLAY_INFO
  ram.writeBytes(O(REQ), req);
  rw(Q[0].desc, REQ, 8);
  rw(Q[0].desc + 8n, BigInt(req.length), 4);
  rw(Q[0].desc + 12n, 1n, 2); // NEXT
  rw(Q[0].desc + 14n, 1n, 2);
  rw(Q[0].desc + 16n, RSP, 8);
  rw(Q[0].desc + 24n, 4096n, 4);
  rw(Q[0].desc + 28n, 2n, 2); // WRITE

  rw(Q[0].avail, 0n, 2);
  rw(Q[0].avail + 4n, 0n, 2);
  rw(Q[0].avail + 2n, 1n, 2);

  // notify：地址 = notify 基址 + queue_notify_off × 2
  barWrite(m, OFF_NOTIFY + 0 * 2, 0, 2);

  const usedIdx = Number(ram.read(O(Q[0].used) + 2n, 2));
  assert.equal(usedIdx, 1, '设备必须把请求回写到 used 环');
  const len = Number(ram.read(O(Q[0].used) + 8n, 4));
  const resp = ram.data.slice(Number(O(RSP)), Number(O(RSP)) + len);
  const dv = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
  assert.equal(dv.getUint32(0, true), 0x1101, 'GET_DISPLAY_INFO → RESP_OK_DISPLAY_INFO');
  assert.equal(dv.getUint32(24 + 8, true), 1024, '扫描输出宽度');
  assert.equal(dv.getUint32(24 + 12, true), 768, '扫描输出高度');

  // ISF：命令完成后 bit0 置位，读一次即应答
  assert.equal(barRead(m, OFF_ISR, 4) & 1, 1, 'ISR 应报有中断待处理');
  assert.equal(barRead(m, OFF_ISR, 4) & 1, 0, '读 ISF 即应答，第二次读到 0');
});

test('DTB：/soc 下出现 pci-host-ecam-generic 节点且属性满足 EDK2 的契约', () => {
  const m = makeEnv();
  const dtb = m.generateDtb('');
  const pci = findNode(dtb, '/soc/pci@30000000');
  assert.ok(pci, '必须有 /soc/pci@30000000 节点');
  assert.equal(propStr(dtb, pci!, 'compatible'), 'pci-host-ecam-generic');
  assert.equal(propStr(dtb, pci!, 'device_type'), 'pci');
  assert.deepEqual(propU32s(dtb, pci!, '#address-cells'), [3]);
  assert.deepEqual(propU32s(dtb, pci!, '#size-cells'), [2]);
  assert.deepEqual(propU32s(dtb, pci!, '#interrupt-cells'), [1]);
  assert.ok(hasProp(dtb, pci!, 'dma-coherent'), 'dma-coherent 必须存在（空属性）');
  // reg 必须恰好 16 字节：FdtPciPcdProducerLib 只在 RegSize == 2*sizeof(UINT64) 时认
  const reg = propBytes(dtb, pci!, 'reg');
  assert.equal(reg.length, 16, 'reg = 2×UINT64（ECAM 基址 + 长度）');
  assert.equal(Number(new DataView(reg.buffer, reg.byteOffset).getBigUint64(0, false)), Number(VIRT_PCIE_ECAM));
  // ranges：先 I/O 后 32 位 MMIO，每条 7 个 cell = 28 字节
  const ranges = propU32s(dtb, pci!, 'ranges')!;
  // 每条 7 个 cell：type(1) + 子地址(2) + 父地址(2) + 长度(2)
  assert.equal(ranges.length, 14, '两条 range');
  assert.equal(ranges[0], 0x01000000, '第一条是 I/O 空间');
  assert.equal(ranges[4], Number(VIRT_PCIE_PIO), 'I/O 父地址 = PIO 窗口（EDK2 据此算 PcdPciIoTranslation）');
  assert.equal(ranges[6], 0x00010000, 'I/O 窗口 64KiB');
  assert.equal(ranges[7], 0x02000000, '第二条是 32 位 MMIO');
  assert.equal(ranges[11], Number(VIRT_PCIE_MMIO), 'MMIO 父地址 = 1GiB 窗口');
  assert.equal(ranges[13], 0x40000000, 'MMIO 窗口大小 = 1GiB');
  // interrupt-map：4 设备 × 4 pin，每条 6 个 cell；设备 0 的 INTA → PLIC 源 32
  const imap = propU32s(dtb, pci!, 'interrupt-map')!;
  assert.equal(imap.length, 4 * 4 * 6, 'interrupt-map 条目数');
  assert.deepEqual(imap.slice(0, 6), [0, 0, 0, 1, 2, 32], '设备 0 INTA → PLIC 源 32');
  assert.deepEqual(propU32s(dtb, pci!, 'interrupt-map-mask'), [0x1800, 0, 0, 0x7]);

  // 显卡挂在 PCI 上时不应再有 virtio_mmio 的 GPU 节点（0x10004000）
  assert.equal(findNode(dtb, '/soc/virtio_mmio@10004000'), undefined, 'PCI 模式下不应有 MMIO 显卡节点');
});

// ---------------------------------------------------------------------------
// 极简 FDT 结构块遍历（只够本测试用：按路径找节点、按名字取属性）
// ---------------------------------------------------------------------------

function walk(dtb: Uint8Array, cb: (path: string, kind: 'begin' | 'end' | 'prop', p?: Prop) => void): void {
  const dv = new DataView(dtb.buffer, dtb.byteOffset, dtb.byteLength);
  const offStruct = dv.getUint32(8, false);
  const offStrings = dv.getUint32(12, false);
  const strAt = (o: number) => {
    let s = '';
    for (let i = offStrings + o; i < dtb.length && dtb[i] !== 0; i++) s += String.fromCharCode(dtb[i]!);
    return s;
  };
  const stack: string[] = [];
  let p = offStruct;
  while (p < dtb.length) {
    const tok = dv.getUint32(p, false);
    p += 4;
    if (tok === 1) {
      let name = '';
      while (dtb[p + name.length] !== 0) name += String.fromCharCode(dtb[p + name.length]);
      p += name.length + 1;
      p = (p + 3) & ~3;
      stack.push(name);
      cb('/' + stack.filter(Boolean).join('/'), 'begin');
    } else if (tok === 2) {
      cb('/' + stack.filter(Boolean).join('/'), 'end');
      stack.pop();
    } else if (tok === 3) {
      const len = dv.getUint32(p, false);
      const nameOff = dv.getUint32(p + 4, false);
      const value = dtb.subarray(p + 8, p + 8 + len);
      cb('/' + stack.filter(Boolean).join('/'), 'prop', { name: strAt(nameOff), value });
      p += 8 + ((len + 3) & ~3);
    } else if (tok === 4) {
      p += 4;
    } else if (tok === 9) {
      break;
    } else {
      break;
    }
  }
}

interface Prop {
  name: string;
  value: Uint8Array;
}

function findNode(dtb: Uint8Array, want: string): string | undefined {
  let hit: string | undefined;
  walk(dtb, (path, kind) => {
    if (kind === 'begin' && path === want) hit = path;
  });
  return hit;
}

function collectProps(dtb: Uint8Array, node: string): Prop[] {
  const out: Prop[] = [];
  let inside = false;
  walk(dtb, (path, kind, prop) => {
    if (kind === 'begin') inside = path === node;
    else if (kind === 'end') inside = false;
    else if (kind === 'prop' && inside && prop) out.push(prop);
  });
  return out;
}

const prop = (dtb: Uint8Array, node: string, name: string): Prop | undefined =>
  collectProps(dtb, node).find((p) => p.name === name);

const hasProp = (dtb: Uint8Array, node: string, name: string): boolean => prop(dtb, node, name) !== undefined;

function propBytes(dtb: Uint8Array, node: string, name: string): Uint8Array {
  const p = prop(dtb, node, name);
  assert.ok(p, `属性 ${name} 应存在`);
  return p!.value;
}

function propStr(dtb: Uint8Array, node: string, name: string): string {
  const v = propBytes(dtb, node, name);
  let s = '';
  for (const b of v) {
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

function propU32s(dtb: Uint8Array, node: string, name: string): number[] | undefined {
  const p = prop(dtb, node, name);
  if (!p) return undefined;
  const out: number[] = [];
  for (let i = 0; i + 4 <= p.value.length; i += 4) {
    out.push(new DataView(p.value.buffer, p.value.byteOffset + i, 4).getUint32(0, false));
  }
  return out;
}
