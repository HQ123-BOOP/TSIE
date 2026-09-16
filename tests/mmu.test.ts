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
  TEST_RAM_SIZE,
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

test('Sv39：内核半地址（0xffff_ffc0_...）TLB 键不跨 ASID 碰撞', () => {
  // 回归：曾把 TLB 键压成 Number/位拼接，内核地址 vpn(vaddr>>12) 有 52 位、
  // 高位恒 1，导致 asid 不同键相同 → 上下文切换后命中陈旧表项 →
  // Debian 13 内核异常风暴卡死在 handle_exception。
  const h = makeCpu([...halt()]);
  const pt = setupSv39(h);
  const KVA = 0xffffffff80100000n; // 内核半地址（Linux 常驻段）
  pt.map(KVA, 0x2000000n, PTE_R | PTE_W | PTE_X | PTE_A | PTE_D, 0);
  enablePaging(h, pt, 8n);
  // ASID 0：建立映射并命中
  assert.equal(h.cpu.mmu.translate(KVA, AccessType.Load), 0x2000000n);
  assert.equal(h.cpu.mmu.translate(KVA, AccessType.Load), 0x2000000n, 'TLB 命中');
  // 换 ASID 1（同页表）：绝不能命中 ASID 0 的陈旧表项
  h.cpu.csr.writeRaw(CSR.SATP, pt.satp(8n, 1n));
  h.cpu.syncMmu();
  assert.equal(h.cpu.mmu.translate(KVA, AccessType.Load), 0x2000000n, 'ASID 1 miss 后重走页表');
  // 按地址 sfence 对内核半地址必须生效（曾因键反解错误永不失效）
  h.cpu.mmu.translate(KVA, AccessType.Load);
  h.cpu.mmu.flushBy(KVA, undefined);
  h.cpu.mmu.stats.tlbHit = 0;
  h.cpu.mmu.translate(KVA, AccessType.Load);
  assert.equal(h.cpu.mmu.stats.tlbHit, 0, '按地址 sfence 后应重新走页表');
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

// ---- 虚拟页快路径（Number 键 fast page cache）----

/** 给裸 CPU 挂上 fastRam（Machine 里同样做；测试里手动注入） */
function attachFastRam(h: ReturnType<typeof makeCpu>): void {
  h.cpu.mmu.fastRam = {
    base: Number(TEST_BASE),
    end: Number(TEST_BASE + BigInt(TEST_RAM_SIZE)),
    data: h.ram.data,
    view: h.ram.view,
  };
}

test('快路径：load/store 走虚拟页缓存且数据真实落 RAM', () => {
  const h = makeCpu([...halt()]);
  attachFastRam(h);
  const pt = setupSv39(h);
  pt.map(0x1000000n, TEST_BASE, PTE_R | PTE_W | PTE_X | PTE_A | PTE_D, 0);
  enablePaging(h, pt);
  // 第一笔走 walk（同时填充快缓存）
  assert.equal(h.cpu.mmu.load(0x1000100n, 8), 0n);
  h.cpu.mmu.store(0x1000100n, 0x1122334455667788n, 8);
  // 第二笔必须命中快路径：值可读回，且真实写入 RAM
  assert.equal(h.cpu.mmu.load(0x1000100n, 8), 0x1122334455667788n);
  assert.equal(h.ram.view.getBigUint64(0x100, true), 0x1122334455667788n, '落 RAM');
  assert.equal(h.cpu.mmu.load(0x1000104n, 4), 0x11223344n, '不同 size 同页命中（LE 高半）');
  // walks 只应为 1（后续全命中，快路径不增加 walks）
  assert.equal(h.cpu.mmu.stats.walks, 1, '快路径不应再走页表');
});

test('快路径：U 态访问无 U 位页必须拒绝（安全回归）', () => {
  const h = makeCpu([...halt()]);
  attachFastRam(h);
  const pt = setupSv39(h);
  // S 页（无 U）与 U 页各一（映射到干净区域，避开 offset 0 的程序段）
  pt.map(0x1000000n, TEST_BASE + 0x100000n, PTE_R | PTE_W | PTE_A | PTE_D, 0);
  pt.map(0x1001000n, TEST_BASE + 0x101000n, PTE_R | PTE_W | PTE_U | PTE_A | PTE_D, 0);
  enablePaging(h, pt);
  h.ram.view.setUint32(0x101000, 0xdeadbeef, true);
  // 先在 S 态访问 S 页填快缓存；U 页在 SUM=0 下必须拒绝
  assert.equal(h.cpu.mmu.load(0x1000000n, 4), 0n);
  assert.equal(h.cpu.mmu.load(0x1001000n, 4), null, 'S 态 SUM=0 读 U 页拒绝');
  // 切到 U 态（触发权限位重算）
  h.cpu.priv = Priv.U;
  syncMmu(h);
  // U 页允许；S 页必须拒绝——快路径不得放行
  assert.equal(h.cpu.mmu.load(0x1001000n, 4), 0xdeadbeefn, 'U 态读 U 页');
  assert.equal(h.cpu.mmu.load(0x1000000n, 4), null, 'U 态读 S 页必须 fault');
  assert.equal(h.cpu.mmu.faultCause, Exc.LoadPageFault);
  assert.equal(h.cpu.mmu.store(0x1000000n, 1n, 4), false, 'U 态写 S 页必须失败');
});

test('快路径：SUM/MPRV 语义与 translate 一致', () => {
  const h = makeCpu([...halt()]);
  attachFastRam(h);
  const pt = setupSv39(h);
  pt.map(0x1000000n, TEST_BASE + 0x100000n, PTE_R | PTE_W | PTE_U | PTE_A | PTE_D, 0);
  enablePaging(h, pt);
  // S 态 SUM=0：translate 与快路径 load 都必须拒绝 U 页
  assert.equal(h.cpu.mmu.load(0x1000000n, 4), null);
  h.cpu.csr.writeRaw(CSR.MSTATUS, SR_SUM);
  syncMmu(h);
  assert.equal(h.cpu.mmu.load(0x1000000n, 4), 0n, 'SUM=1 后 S 态可读 U 页');
  // MPRV=1 且 MPP=U（无 SUM 概念，U 态规则）：仍允许 U 页
  h.cpu.csr.writeRaw(CSR.MSTATUS, SR_MPRV | SR_SUM);
  syncMmu(h);
  assert.equal(h.cpu.mmu.load(0x1000000n, 4), 0n, 'MPRV(MPP=U) 读 U 页');
});

test('快路径：D=0 页先写触发置 D，随后进快路径', () => {
  const h = makeCpu([...halt()]);
  attachFastRam(h);
  const pt = setupSv39(h);
  pt.map(0x1000000n, TEST_BASE + 0x100000n, PTE_R | PTE_W | PTE_A, 0); // 无 D
  enablePaging(h, pt);
  // 先读一次：walk 填快缓存（prot 无 D）
  assert.equal(h.cpu.mmu.load(0x1000000n, 4), 0n);
  // 写：快路径因 D=0 放行去慢路径 → walk 回写 D → 成功
  assert.equal(h.cpu.mmu.store(0x1000000n, 0x42n, 4), true);
  assert.notEqual(pt.leafPte(0x1000000n, 0) & PTE_D, 0n, 'PTE D 位应被回写');
  assert.equal(h.cpu.mmu.load(0x1000000n, 4), 0x42n, '写后读回');
});

test('快路径：sfence 按地址失效后重新走页表', () => {
  const h = makeCpu([...halt()]);
  attachFastRam(h);
  const pt = setupSv39(h);
  pt.map(0x1000000n, TEST_BASE + 0x100000n, PTE_R | PTE_W | PTE_A | PTE_D, 0);
  enablePaging(h, pt);
  assert.equal(h.cpu.mmu.load(0x1000000n, 4), 0n);
  // 重映射到另一干净物理页并 sfence
  pt.map(0x1000000n, TEST_BASE + 0x200000n, PTE_R | PTE_W | PTE_A | PTE_D, 0);
  h.cpu.mmu.flushBy(0x1000000n, undefined);
  assert.equal(h.cpu.mmu.load(0x1000000n, 4), 0n, '新映射读回 0');
  h.ram.view.setUint32(0x200000, 0xcafebabe, true);
  assert.equal(h.cpu.mmu.load(0x1000000n, 4), 0xcafebaben, '读到新物理页的值');
});

// ----------------------------------------------------------------------
// 回归：MXR 对**取指**同样有效。
//
// RISC-V 规范 §4.3.1 规定取指在两种情况下允许：页可执行(X)，**或** MXR=1 且页可读(R)。
// 早先 checkPerm 的取指分支硬要求 X 位、完全忽略 MXR，是个真 bug：
// OpenBSD/riscv64 的内核映射用 R+W / X=0 的页配 mstatus.MXR=1 取指，
// 于是 EFI→内核交接跳进 0x84200000（实机 PTE=0x210800e7，R=1 W=1 X=0）时，
// 我们抛 EXCEPT_RISCV_INST_ACCESS_PAGE_FAULT(cause 12)，内核根本没机会跑。
// 加载方向的 MXR 本来就有（见上面的用例），只有取指漏了 ——
// U-Boot 那条路径不开分页，所以这个洞一直没暴露。
// ----------------------------------------------------------------------
test('MXR：允许从可读页取指（规范 §4.3.1，OpenBSD 内核映射依赖它）', () => {
  const h = makeCpu([...halt()]);
  const pt = setupSv39(h);
  // 只可读、不可执行 —— 正是 OpenBSD 内核代码段的映射方式
  pt.map(0x1000000n, 0x1000000n, PTE_R | PTE_A | PTE_D, 0);
  enablePaging(h, pt);

  // MXR=0：不可执行 → 取指页故障
  assert.equal(
    h.cpu.mmu.translate(0x1000000n, AccessType.Instruction),
    null,
    'MXR=0 时不可从只读页取指',
  );
  assert.equal(h.cpu.mmu.faultCause, Exc.InstPageFault, '应为取指页故障(cause 12)');

  // MXR=1：可读即可取指
  h.cpu.csr.writeRaw(CSR.MSTATUS, SR_MXR);
  syncMmu(h);
  assert.equal(
    h.cpu.mmu.translate(0x1000000n, AccessType.Instruction),
    0x1000000n,
    'MXR=1 时应可从只读页取指',
  );
});

test('MXR：取指仍拒绝既不可读也不可执行的页', () => {
  const h = makeCpu([...halt()]);
  const pt = setupSv39(h);
  // 只可写（W=1,R=0 在 RISC-V 里是非法组合，所以用纯 RW 之外的合法页：仅 A/D 无权限位）
  pt.map(0x2000000n, 0x2000000n, PTE_A | PTE_D, 0); // 无 R/W/X → 非法页表项
  enablePaging(h, pt);
  h.cpu.csr.writeRaw(CSR.MSTATUS, SR_MXR);
  syncMmu(h);
  assert.equal(
    h.cpu.mmu.translate(0x2000000n, AccessType.Instruction),
    null,
    'MXR 不能让非法页变得可取指',
  );
});

test('MXR：可写但不可执行的超级页在 MXR=1 下可以取指（OpenBSD 内核 RW 段）', () => {
  const h = makeCpu([...halt()]);
  const pt = setupSv39(h);
  // 实机 OpenBSD 页表就是 0xe7 = V|R|W|A|D（X=0），2MB 超级页。
  // 地址取测试 RAM 范围内（TEST_BASE=0x80000000, 4MB）的 2MB 对齐页，
  // 否则 fetch16 会因物理地址无 RAM 支撑而报 access fault —— 那是测试环境问题，不是被测行为。
  const A = 0x80200000n;
  pt.map(A, A, PTE_R | PTE_W | PTE_A | PTE_D, 1); // 2MB 超级页
  enablePaging(h, pt);
  h.cpu.csr.writeRaw(CSR.MSTATUS, SR_MXR);
  syncMmu(h);
  assert.equal(
    h.cpu.mmu.translate(A, AccessType.Instruction),
    A,
    'R+W / X=0 的超级页在 MXR=1 下应可取指（实机 0x84200000 的 PTE 正是 0x210800e7）',
  );
  // 同页的数据访问当然也允许
  assert.equal(h.cpu.mmu.translate(A, AccessType.Load), A);
  // 取指路径本身也要认这条规则（不只是 translate）
  assert.notEqual(h.cpu.mmu.fetch16(A), null, 'fetch16 也应成功');

  // MXR=0 时同一页必须拒绝取指（否则就是把权限检查改宽了）
  h.cpu.csr.writeRaw(CSR.MSTATUS, 0n);
  syncMmu(h);
  assert.equal(h.cpu.mmu.fetch16(A), null, 'MXR=0 时不可从 RW 页取指');
  assert.equal(h.cpu.mmu.faultCause, Exc.InstPageFault, '应为取指页故障');
});
