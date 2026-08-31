/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccessType } from '../src/mem/types.ts';
import { CSR, Exc, Priv, SR_SUM, SR_MXR, SR_MPRV } from '../src/cpu/csr.ts';
import { PAGE_SIZE } from '../src/cpu/mmu.ts';
import { li, lw, sd, sfenceVma } from '../tools/encoder.ts';
import {
  PTE_A,
  PTE_D,
  PTE_R,
  PTE_U,
  PTE_V,
  PTE_W,
  PTE_X,
  Sv39Mapper,
  TEST_BASE,
  halt,
  makeCpu,
} from './harness.ts';

const ROOT = TEST_BASE + 0x300000n;
const POOL = TEST_BASE + 0x301000n;
const U = (v: bigint | number) => BigInt.asUintN(64, BigInt(v));

function setupSv39(h: ReturnType<typeof makeCpu>): Sv39Mapper {
  return new Sv39Mapper(h, ROOT, POOL);
}

/** 切换到 S 模式并启用分页（M 模式默认不做地址翻译） */
function enablePaging(h: ReturnType<typeof makeCpu>, pt: Sv39Mapper, mode = 8n): void {
  h.cpu.priv = Priv.S;
  h.cpu.csr.writeRaw(CSR.SATP, pt.satp(mode));
  h.cpu.syncMmu();
}

test('Sv39：4KB 页恒等映射与地址翻译', () => {
  const h = makeCpu([...halt()]);
  const pt = setupSv39(h);
  pt.map(0x1000000n, 0x1000000n, PTE_R | PTE_W | PTE_X | PTE_A | PTE_D, 0);
  enablePaging(h, pt);
  assert.equal(h.cpu.mmu.translate(0x1000000n, AccessType.Load), 0x1000000n);
  assert.equal(h.cpu.mmu.translate(0x1000fffn, AccessType.Load), 0x1000fffn);
  // 未映射页 → 页故障
  assert.equal(h.cpu.mmu.translate(0x1001000n, AccessType.Load), null);
  assert.equal(h.cpu.mmu.faultCause, Exc.LoadPageFault);
});

test('Sv39：2MB / 1GB 超级页', () => {
  const h = makeCpu([...halt()]);
  const pt = setupSv39(h);
  pt.map(0x2000000n, 0x2000000n, PTE_R | PTE_W | PTE_X | PTE_A | PTE_D, 1); // 2MB
  pt.map(0x40000000n, 0x40000000n, PTE_R | PTE_W | PTE_X | PTE_A | PTE_D, 2); // 1GB
  enablePaging(h, pt);
  const mmu = h.cpu.mmu;
  assert.equal(mmu.translate(0x2000000n, AccessType.Load), 0x2000000n);
  assert.equal(mmu.translate(0x21fffffn, AccessType.Load), 0x21fffffn, '2MB 页内偏移正确');
  assert.equal(mmu.translate(0x2200000n, AccessType.Load), null);
  assert.equal(mmu.translate(0x7fffffffn, AccessType.Load), 0x7fffffffn, '1GB 页覆盖到区域末尾');
  assert.equal(mmu.translate(0x80000000n, AccessType.Load), null);
});

test('Sv39：非规范地址直接报页故障', () => {
  const h = makeCpu([...halt()]);
  const pt = setupSv39(h);
  pt.map(0x1000000n, 0x1000000n, PTE_R | PTE_W | PTE_X | PTE_A | PTE_D, 0);
  enablePaging(h, pt);
  const nonCanonical = 0x0000010000000000n; // 位 38 以上未正确符号扩展
  assert.equal(h.cpu.mmu.translate(nonCanonical, AccessType.Load), null);
  assert.equal(h.cpu.mmu.faultCause, Exc.LoadPageFault);
});

test('A/D 位由硬件自动更新', () => {
  const h = makeCpu([...halt()]);
  const pt = setupSv39(h);
  pt.map(0x1000000n, 0x1000000n, PTE_R | PTE_W, 0); // 初始没有 A/D
  enablePaging(h, pt);
  assert.equal(pt.leafPte(0x1000000n, 0) & PTE_A, 0n);
  assert.equal(h.cpu.mmu.translate(0x1000000n, AccessType.Load), 0x1000000n);
  assert.notEqual(pt.leafPte(0x1000000n, 0) & PTE_A, 0n, '读访问应置 A 位');
  assert.equal(pt.leafPte(0x1000000n, 0) & PTE_D, 0n, '读访问不应置 D 位');
  h.cpu.mmu.translate(0x1000000n, AccessType.Store);
  assert.notEqual(pt.leafPte(0x1000000n, 0) & PTE_D, 0n, '写访问应置 D 位');
});

test('U 位与 SUM：S 模式访问用户页需要 SUM', () => {
  const h = makeCpu([...halt()]);
  const pt = setupSv39(h);
  pt.map(0x1000000n, 0x1000000n, PTE_R | PTE_W | PTE_U | PTE_A | PTE_D, 0);
  enablePaging(h, pt);
  // S 模式、SUM=0 → 拒绝访问用户页
  assert.equal(h.cpu.mmu.translate(0x1000000n, AccessType.Load), null);
  // 置 SUM 后允许
  h.cpu.csr.writeRaw(CSR.MSTATUS, SR_SUM);
  syncMmu(h);
  assert.equal(h.cpu.mmu.translate(0x1000000n, AccessType.Load), 0x1000000n);
  // U 模式访问无 U 位的页 → 拒绝
  pt.map(0x1001000n, 0x1001000n, PTE_R | PTE_W | PTE_A | PTE_D, 0);
  h.cpu.priv = Priv.U;
  syncMmu(h);
  assert.equal(h.cpu.mmu.translate(0x1001000n, AccessType.Load), null);
  assert.equal(h.cpu.mmu.translate(0x1000000n, AccessType.Load), 0x1000000n);
});

test('MXR：允许从可执行页读取数据', () => {
  const h = makeCpu([...halt()]);
  const pt = setupSv39(h);
  pt.map(0x1000000n, 0x1000000n, PTE_X | PTE_A, 0); // 只可执行
  enablePaging(h, pt);
  assert.equal(h.cpu.mmu.translate(0x1000000n, AccessType.Instruction), 0x1000000n);
  assert.equal(h.cpu.mmu.translate(0x1000000n, AccessType.Load), null, '默认不允许读可执行页');
  h.cpu.csr.writeRaw(CSR.MSTATUS, SR_MXR);
  syncMmu(h);
  assert.equal(h.cpu.mmu.translate(0x1000000n, AccessType.Load), 0x1000000n, 'MXR=1 时可读');
});

test('MPRV：按 MPP 指定的特权级进行翻译', () => {
  const h = makeCpu([...halt()]);
  const pt = setupSv39(h);
  pt.map(0x1000000n, 0x1000000n, PTE_R | PTE_W | PTE_U | PTE_A | PTE_D, 0);
  h.cpu.priv = Priv.M;
  setSatp(h, pt.satp());
  // MPRV=0：M 模式不翻译
  syncMmu(h);
  assert.equal(h.cpu.mmu.translate(0x1000000n, AccessType.Load), 0x1000000n);
  // MPRV=1 且 MPP=U：按 U 模式翻译（页有 U 位，允许）
  h.cpu.csr.writeRaw(CSR.MSTATUS, SR_MPRV);
  syncMmu(h);
  assert.equal(h.cpu.mmu.translate(0x1000000n, AccessType.Load), 0x1000000n);
  // MPRV=1 且 MPP=S，SUM=0：S 模式不能访问 U 页
  h.cpu.csr.writeRaw(CSR.MSTATUS, SR_MPRV | (1n << 11n));
  syncMmu(h);
  assert.equal(h.cpu.mmu.translate(0x1000000n, AccessType.Load), null);
});

test('TLB 命中与 sfence.vma 失效', () => {
  const h = makeCpu([...halt()]);
  const pt = setupSv39(h);
  pt.map(0x1000000n, 0x1000000n, PTE_R | PTE_W | PTE_A | PTE_D, 0);
  enablePaging(h, pt);
  const mmu = h.cpu.mmu;
  mmu.flush();
  assert.equal(mmu.translate(0x1000000n, AccessType.Load), 0x1000000n); // 走页表
  const misses = mmu.stats.walks;
  assert.equal(mmu.translate(0x1000000n, AccessType.Load), 0x1000000n); // 命中 TLB
  assert.equal(mmu.stats.walks, misses, '第二次访问应命中 TLB，不再走页表');
  // 修改页表后必须 sfence 才生效
  pt.map(0x1000000n, 0x2000000n, PTE_R | PTE_W | PTE_A | PTE_D, 0);
  assert.equal(mmu.translate(0x1000000n, AccessType.Load), 0x1000000n, 'TLB 仍返回旧映射');
  mmu.flushBy(0x1000000n);
  assert.equal(mmu.translate(0x1000000n, AccessType.Load), 0x2000000n, 'sfence 后生效');
});

// 回归测试：SFENCE.VMA 的 funct12 低 5 位是 rs2（ASID 寄存器），
// 早期实现用完整 12 位 funct12 匹配 case 0x120，导致只有 rs2=0 的
// `sfence.vma` 能识别，而内核 execve 搬移栈页表时发出的
// `sfence.vma addr, asid`（rs2≠0 → funct12=0x120|rs2）被误判为非法指令，
// 真实表现是启动到 Run /init 后立刻 Oops：
//   epc=__flush_tlb_range  badaddr=0x13030073  cause=2
test('sfence.vma 的全部 rs1/rs2 组合都必须被识别（不得判为非法指令）', () => {
  for (const [rs1, rs2] of [[0, 0], [6, 0], [0, 16], [6, 16], [31, 31]] as const) {
    const h = makeCpu([sfenceVma(rs1, rs2), ...halt()]);
    h.cpu.priv = Priv.S; // SFENCE.VMA 需要 S 模式及以上
    h.cpu.syncMmu();
    h.run(1);
    assert.equal(
      h.cpu.csr.read(CSR.MCAUSE),
      0n,
      `sfence.vma x${rs1}, x${rs2} 被误判为非法指令（mcause 应为 0）`,
    );
    assert.equal(h.cpu.priv, Priv.S, `sfence.vma x${rs1}, x${rs2} 不应触发陷入而切到 M 模式`);
  }
});

test('sfence.vma 带 ASID 时只刷该 ASID 的 TLB 条目', () => {
  const h = makeCpu([...halt()]);
  const pt = setupSv39(h);
  pt.map(0x1000000n, 0x1000000n, PTE_R | PTE_W | PTE_A | PTE_D, 0);
  enablePaging(h, pt);
  const mmu = h.cpu.mmu;
  mmu.flush();
  assert.equal(mmu.translate(0x1000000n, AccessType.Load), 0x1000000n);
  // 改页表，然后用「不匹配的 ASID」刷 —— 旧映射应保留
  pt.map(0x1000000n, 0x2000000n, PTE_R | PTE_W | PTE_A | PTE_D, 0);
  mmu.flushBy(0x1000000n, 0xbeef);
  assert.equal(mmu.translate(0x1000000n, AccessType.Load), 0x1000000n, '不匹配的 ASID 不应刷掉条目');
  // 用当前 ASID（0）刷 —— 新映射生效
  mmu.flushBy(0x1000000n, 0);
  assert.equal(mmu.translate(0x1000000n, AccessType.Load), 0x2000000n, '匹配的 ASID 应刷掉条目');
});

test('satp 写入会清空 TLB', () => {
  const h = makeCpu([...halt()]);
  const pt = setupSv39(h);
  pt.map(0x1000000n, 0x1000000n, PTE_R | PTE_W | PTE_A | PTE_D, 0);
  enablePaging(h, pt);
  assert.equal(h.cpu.mmu.translate(0x1000000n, AccessType.Load), 0x1000000n);
  pt.map(0x1000000n, 0x4000000n, PTE_R | PTE_W | PTE_A | PTE_D, 0);
  setSatp(h, pt.satp()); // 写 satp → 应自动刷 TLB
  assert.equal(h.cpu.mmu.translate(0x1000000n, AccessType.Load), 0x4000000n);
});

test('Sv48：四级页表翻译', () => {
  const h = makeCpu([...halt()]);
  const pt = new Sv39Mapper(h, ROOT, POOL, 3); // Sv48：四级页表
  pt.map(0x1000000n, 0x1000000n, PTE_R | PTE_W | PTE_X | PTE_A | PTE_D, 0);
  // Sv48 的高半区规范地址
  const highVa = 0xffff800000000000n;
  pt.map(highVa, 0x5000000n, PTE_R | PTE_W | PTE_X | PTE_A | PTE_D, 0);
  enablePaging(h, pt, 9n);
  assert.equal(h.cpu.mmu.translate(0x1000000n, AccessType.Load), 0x1000000n);
  assert.equal(h.cpu.mmu.translate(highVa, AccessType.Load), 0x5000000n);
});

test('端到端：开启分页后执行代码并访问数据', () => {
  // 代码位于 TEST_BASE，数据区映射到 VA 0x1000000 → PA 0x80200000
  const h = makeCpu([
    ...li(1, 0x1000000n),
    ...li(2, 0xfeedfacecafebeefn),
    sd(1, 2, 0),
    lw(3, 1, 0),
    ...halt(),
  ]);
  const pt = new Sv39Mapper(h, ROOT, POOL);
  pt.map(TEST_BASE, TEST_BASE, PTE_R | PTE_W | PTE_X | PTE_A | PTE_D, 1); // 2MB 代码区
  pt.map(0x1000000n, TEST_BASE + 0x200000n, PTE_R | PTE_W | PTE_A | PTE_D, 0);
  pt.map(0x100000n, 0x100000n, PTE_R | PTE_W | PTE_A | PTE_D, 0); // 停机设备
  h.cpu.priv = Priv.S;
  h.cpu.csr.writeRaw(CSR.SATP, pt.satp());
  h.run(400);
  assert.equal(h.cpu.halted, true, `程序应正常结束（mcause=${h.cpu.csr.read(CSR.MCAUSE)}）`);
  assert.equal(h.cpu.x[3], U(0xffffffffcafebeefn));
  // 物理内存中应能看到写入的值
  assert.equal(h.ram.read(0x200000n, 8), 0xfeedfacecafebeefn);
});

test('端到端：执行 SFENCE.VMA 指令刷新 TLB', () => {
  const program = [
    ...li(1, 0x1000000n),
    lw(2, 1, 0),
    sfenceVma(0, 0),
    lw(3, 1, 0),
    ...halt(),
  ];
  const h = makeCpu(program);
  const pt = new Sv39Mapper(h, ROOT, POOL);
  pt.map(TEST_BASE, TEST_BASE, PTE_R | PTE_W | PTE_X | PTE_A | PTE_D, 1);
  pt.map(0x1000000n, TEST_BASE + 0x200000n, PTE_R | PTE_W | PTE_A | PTE_D, 0);
  pt.map(0x100000n, 0x100000n, PTE_R | PTE_W | PTE_A | PTE_D, 0); // 停机设备
  h.cpu.priv = Priv.S;
  h.cpu.csr.writeRaw(CSR.SATP, pt.satp());
  h.run(400);
  assert.equal(h.cpu.halted, true);
  assert.equal(h.cpu.x[2], 0n);
  assert.equal(h.cpu.x[3], 0n);
  assert.ok(h.cpu.mmu.stats.walks >= 2, 'sfence 之后应重新遍历页表');
});

test('页大小常量与页表项布局', () => {
  assert.equal(PAGE_SIZE, 0x1000n);
  const h = makeCpu([...halt()]);
  const pt = new Sv39Mapper(h, ROOT, POOL);
  pt.map(0x1000000n, 0x80000000n, PTE_R | PTE_W | PTE_A | PTE_D, 0);
  const pte = pt.leafPte(0x1000000n, 0);
  assert.equal(pte & 0xffn, PTE_V | PTE_R | PTE_W | PTE_A | PTE_D);
  assert.equal(((pte >> 10n) & 0xfffffffffffn) << 12n, 0x80000000n, 'PPN 位于 bit10');
});

/** 写 satp 并同步 MMU 状态（模拟 step() 中的同步动作） */
function setSatp(h: ReturnType<typeof makeCpu>, satp: bigint): void {
  h.cpu.csr.writeRaw(CSR.SATP, satp);
  syncMmu(h);
}

function syncMmu(h: ReturnType<typeof makeCpu>): void {
  h.cpu.syncMmu();
}
