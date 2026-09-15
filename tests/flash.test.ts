/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
// CFI NOR 闪存测试。
// 重点覆盖 EDK2 VirtNorFlashDeviceLib 实际会走的那几条路径：
// 读阵列、读状态（bit7/bit23 都要置位）、字编程、块擦除、缓冲编程、读器件 ID（判块锁）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CfiFlash } from '../src/dev/flash.ts';
import { Machine, VIRT_FLASH, FLASH_SIZE } from '../src/machine.ts';

const SIZE = 0x100000; // 1MiB 足够测
const SECTOR = 0x40000; // 256KiB

function make(data?: Uint8Array): CfiFlash {
  return new CfiFlash({ size: SIZE, sectorSize: SECTOR, data });
}

/** 32 位写（EDK2 用 MmioWrite32 发命令） */
const w32 = (f: CfiFlash, off: number, v: number) => f.write(BigInt(off), BigInt(v >>> 0), 4);
const r32 = (f: CfiFlash, off: number) => Number(f.read(BigInt(off), 4) & 0xffffffffn);
const r8 = (f: CfiFlash, off: number) => Number(f.read(BigInt(off), 1) & 0xffn);

test('CFI flash：初始为擦除态，预置内容逐字节可读', () => {
  const init = new Uint8Array(SIZE).fill(0xff);
  init[0] = 0x11;
  init[1] = 0x22;
  init[0x1234] = 0xab;
  const f = make(init);
  assert.equal(r8(f, 0), 0x11, '预置字节 0');
  assert.equal(r8(f, 1), 0x22, '预置字节 1');
  assert.equal(r8(f, 0x1234), 0xab, '预置字节 0x1234');
  assert.equal(r8(f, 0x2000), 0xff, '未写入处应为擦除态');

  const bare = make();
  assert.equal(r8(bare, 0), 0xff, '无预置数据时整片为 0xff');
  assert.equal(r8(bare, SIZE - 1), 0xff, '末尾也是 0xff');
});

test('CFI flash：读状态寄存器，bit7 与 bit23 必须同时置位（EDK2 的轮询条件）', () => {
  const f = make();
  w32(f, 0, 0x70); // 读状态寄存器命令
  const sr32 = r32(f, 0);
  assert.equal(sr32, 0x80808080, '32 位读应逐字节复制状态 0x80');
  // EDK2: (SR & (BIT7<<16 | BIT7)) == (BIT7<<16 | BIT7)
  assert.equal(sr32 & 0x00800080, 0x00800080, 'EDK2 的就绪判定必须通过');

  const g = make();
  w32(g, 0, 0x70);
  assert.equal(r8(g, 0), 0x80, '8 位读应为 0x80');
});

test('CFI flash：字编程（0x40 + 数据）按 NOR 语义只能把 1 变 0', () => {
  const f = make(); // 全 0xff
  w32(f, 0x100, 0x40); // 编程 setup
  w32(f, 0x100, 0xdeadbeef); // 数据
  assert.equal(r32(f, 0x100), 0xdeadbeef, '数据应写入');

  // 再往同一处写，只能清零不能置位
  w32(f, 0x100, 0x40);
  w32(f, 0x100, 0xffffffff);
  assert.equal(r32(f, 0x100), 0xdeadbeef, '再写全 1 不应改变已有 0 位');

  w32(f, 0x100, 0x40);
  w32(f, 0x100, 0x00000000);
  assert.equal(r32(f, 0x100), 0x00000000, '写 0 应清零');

  // 编程后应回到可读阵列
  assert.equal(r8(f, 0x101), 0x00, '回到读阵列后可直接读');
});

test('CFI flash：块擦除（0x20 + 0xd0）只清掉所在扇区', () => {
  const init = new Uint8Array(SIZE).fill(0xff);
  init[0x10] = 0xaa; // 扇区 0
  init[SECTOR + 0x20] = 0xbb; // 扇区 1
  const f = make(init);

  w32(f, 0x10, 0x20); // 擦除 setup（块内任意地址）
  w32(f, 0x10, 0xd0); // confirm
  assert.equal(r8(f, 0x10), 0xff, '扇区 0 应被擦除');
  assert.equal(r8(f, SECTOR + 0x20), 0xbb, '扇区 1 不该受影响');

  // 擦除兜底：未确认时也不该崩，且后续可继续用
  w32(f, SECTOR + 0x20, 0x20);
  w32(f, SECTOR + 0x20, 0xd0);
  assert.equal(r8(f, SECTOR + 0x20), 0xff, '扇区 1 应被擦除');
});

test('CFI flash：缓冲编程（0xe8 + 字数 + 数据 + 0xd0）', () => {
  const f = make();
  w32(f, 0x400, 0xe8); // 缓冲编程 setup
  w32(f, 0x400, 3); // 传 Count-1 = 3 → 4 个字
  w32(f, 0x400, 0x11111111);
  w32(f, 0x404, 0x22222222);
  w32(f, 0x408, 0x33333333);
  w32(f, 0x40c, 0x44444444);
  w32(f, 0x400, 0xd0); // confirm
  assert.equal(r32(f, 0x400), 0x11111111, '第 1 字');
  assert.equal(r32(f, 0x404), 0x22222222, '第 2 字');
  assert.equal(r32(f, 0x408), 0x33333333, '第 3 字');
  assert.equal(r32(f, 0x40c), 0x44444444, '第 4 字');

  // confirm 之后必须回到读阵列（否则 EDK2 读回的是状态字）
  assert.equal(r32(f, 0x400), 0x11111111, 'confirm 后应可正常读数据');
});

test('CFI flash：读器件 ID —— EDK2 用它判块锁，bit0 必须为 0', () => {
  const f = make();
  // EDK2 的 NorFlashBlockIsLocked：向 (addr,2) 发 0x90，再读回，看 bit0
  w32(f, 0x8, 0x90);
  const lockStatus = r32(f, 0x8);
  assert.equal(lockStatus & 0x1, 0, '必须读作"未锁"，否则 EDK2 拒绝写 VARS');

  // 换一个偏移（boff=1）读器件 ID，也应满足 bit0=0
  const g = make();
  w32(g, 0x4, 0x90);
  assert.equal(r32(g, 0x4) & 0x1, 0, '器件 ID 的 bit0 也必须为 0');

  // boff=0 厂商 ID，同样 bit0=0
  const h = make();
  w32(h, 0, 0x90);
  assert.equal(r32(h, 0) & 0x1, 0, '厂商 ID 的 bit0 也必须为 0');
});

test('CFI flash：清状态与回读阵列', () => {
  const f = make();
  w32(f, 0, 0x70);
  assert.equal(r32(f, 0), 0x80808080, '就绪位初始置位');
  w32(f, 0, 0x50); // 清状态
  w32(f, 0, 0x70);
  assert.equal(r32(f, 0), 0x00000000, '清状态后应读 0');

  // 清状态后做一次编程，就绪位应回来（EDK2 清完状态才做下一次操作的轮询）
  w32(f, 0x200, 0x40);
  w32(f, 0x200, 0x55aa55aa);
  w32(f, 0, 0x70);
  assert.equal(r32(f, 0), 0x80808080, '操作后就绪位应重新置位');

  // 0xff 回读阵列：读到的应是数据而非状态
  w32(f, 0, 0xff);
  assert.equal(r32(f, 0x200), 0x55aa55aa, '0xff 后应退化为读阵列');
});

test('CFI flash：多字节访问按宽度整笔读写（不能把宽写当成多条命令）', () => {
  const f = make();
  // 32 位写命令：低字节是命令，其余字节不应被当成第二条命令
  w32(f, 0, 0x70);
  assert.equal(r32(f, 0), 0x80808080, '宽命令写应只算一条命令');

  // 64 位读
  const f2 = make();
  f2.write(0x1000n, 0x40n, 4);
  f2.write(0x1000n, 0x1122334455667788n, 8);
  assert.equal(f2.read(0x1000n, 8) & 0xffffffffffffffffn, 0x1122334455667788n, '64 位数据写');
});

test('CFI flash：访问越界不崩，读回擦除态', () => {
  const f = make();
  assert.equal(r8(f, SIZE + 10), 0xff, '越界读应返回擦除态');
  f.write(BigInt(SIZE + 10), 0x40n, 4); // 越界命令不应抛
  f.write(BigInt(SIZE + 10), 0x1234n, 4);
  assert.equal(f.statusRegister & 0x80, 0x80, '设备仍应视为就绪');
});

test('CFI flash：挂到 virt 机器后占用 0x20000000 起两个 32MiB bank', () => {
  assert.equal(VIRT_FLASH, 0x20000000n, 'flash 基址应与 QEMU virt 一致');
  assert.equal(FLASH_SIZE, 0x2000000n, '每 bank 32MiB（EDK2 硬要求）');

  assert.equal(Number(FLASH_SIZE) / 1048576, 32, '32 MiB');
});

test('CFI flash：挂载后 DTB 出现 cfi-flash 节点，reg 为两个 bank', () => {
  const dtbText = (m: Machine) => new TextDecoder('latin1').decode(m.generateDtb('console=ttyS0'));

  const withFlash = new Machine({ memSize: 64n * 1024n * 1024n, flash: {} });
  assert.ok(withFlash.flashCode, 'CODE 设备应已挂载');
  assert.ok(withFlash.flashVars, 'VARS 设备应已挂载');
  assert.ok(withFlash.bus.devices().includes(withFlash.flashCode!), 'CODE 应在总线上');
  assert.ok(withFlash.bus.devices().includes(withFlash.flashVars!), 'VARS 应在总线上');

  const text = dtbText(withFlash);
  assert.ok(text.includes('cfi-flash'), 'DTB 应含 compatible="cfi-flash"');
  assert.ok(text.includes('flash@20000000'), 'DTB 应含 flash 节点');
  assert.ok(text.includes('bank-width'), 'DTB 应含 bank-width（EDK2/QEMU 会读）');

  // reg 在 DTB 里是**二进制**（每个 cell 大端 4 字节），不会以文本出现，
  // 所以按字节精确校验两个 bank：<base_hi base_lo size_hi size_lo>
  const cells = (...v: number[]) => v.map((x) => String.fromCharCode((x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff)).join('');
  const wantReg =
    cells(0, 0x20000000, 0, 0x02000000) + // CODE @0x20000000, 32MiB
    cells(0, 0x22000000, 0, 0x02000000); //  VARS @0x22000000, 32MiB
  assert.ok(text.includes(wantReg), 'reg 应含两个 32MiB bank（CODE 0x20000000 / VARS 0x22000000）');

  // 不启用时不该出现（否则 guest 会去找不存在的 flash）
  const plain = new Machine({ memSize: 64n * 1024n * 1024n });
  assert.equal(plain.flashCode, undefined);
  assert.ok(!dtbText(plain).includes('cfi-flash'), '未启用时 DTB 不应含 cfi-flash');
});

test('CFI flash：通过总线读写走的是同一份阵列', () => {
  const init = new Uint8Array(0x1000);
  init.fill(0xff);
  init[0x40] = 0x5a;
  const m = new Machine({ memSize: 64n * 1024n * 1024n, flash: { code: init } });
  assert.equal(Number(m.bus.read(VIRT_FLASH + 0x40n, 1)), 0x5a, '总线读应命中预置内容');
  assert.equal(Number(m.bus.read(VIRT_FLASH + FLASH_SIZE + 0x40n, 1)), 0xff, 'VARS 未被预置');
});
