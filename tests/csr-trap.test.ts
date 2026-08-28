import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  csrr,
  csrrci,
  csrrs,
  csrrsi,
  csrrw,
  csrrwi,
  ecall,
  ebreak,
  mret,
  sret,
  wfi,
  sfenceVma,
  addi,
  li,
  sd,
  lw,
} from '../tools/encoder.ts';
import { CSR, Exc, Irq, Priv, SR_MIE, SR_MPIE, SR_MPP, SR_SIE } from '../src/cpu/csr.ts';
import {
  PTE_A,
  PTE_D,
  PTE_R,
  PTE_W,
  PTE_X,
  Sv39Mapper,
  TEST_BASE,
  halt,
  makeCpu,
  pcOf,
  runToPc,
} from './harness.ts';

const U = (v: bigint | number) => BigInt.asUintN(64, BigInt(v));

test('CSRRW / CSRRS / CSRRC 与立即数形式', () => {
  const h = makeCpu([
    ...li(1, 0x1234n),
    csrrw(2, CSR.MSCRATCH, 1), // 写入并返回旧值 0
    csrr(3, CSR.MSCRATCH), // 读回
    csrrsi(4, CSR.MSCRATCH, 0xf), // 置位
    csrrci(5, CSR.MSCRATCH, 3), // 清位
    csrrwi(6, CSR.MSCRATCH, 0), // 清零
    csrrs(7, CSR.MSCRATCH, 0), // rs1=x0：只读不写
    ...halt(),
  ]);
  h.run(300);
  assert.equal(h.x(2), 0n);
  assert.equal(h.x(3), 0x1234n);
  assert.equal(h.x(4), 0x1234n);
  assert.equal(h.x(5), 0x123fn);
  assert.equal(h.cpu.csr.read(CSR.MSCRATCH), 0n, 'CSRRWI 清零后被写入 0');
  assert.equal(h.x(6), 0x123cn);
  assert.equal(h.x(7), 0n);
});

test('写只读 CSR 触发非法指令异常', () => {
  const setup = [...li(1, 1n)];
  const h = makeCpu([...setup, csrrw(0, CSR.MHARTID, 1), ...halt()]);
  runToPc(h, pcOf(setup.length));
  h.cpu.step();
  assert.equal(h.cpu.csr.read(CSR.MCAUSE), BigInt(Exc.IllegalInstruction));
  assert.equal(h.cpu.csr.read(CSR.MTVAL), 0n);
});

test('读取不存在的 CSR 触发非法指令异常', () => {
  const h = makeCpu([csrr(1, 0xfff), ...halt()]);
  h.cpu.step();
  assert.equal(h.cpu.csr.read(CSR.MCAUSE), BigInt(Exc.IllegalInstruction));
});

test('低特权级访问高特权级 CSR 触发非法指令异常', () => {
  const h = makeCpu([csrr(1, CSR.MSTATUS), ...halt()]);
  h.cpu.priv = Priv.U;
  h.cpu.step();
  assert.equal(h.cpu.csr.read(CSR.MCAUSE), BigInt(Exc.IllegalInstruction));
});

test('ECALL（M 模式）：写入 mepc / mcause / mstatus.MPP', () => {
  const h = makeCpu([addi(1, 0, 1), ecall(), addi(2, 0, 2), ...halt()]);
  h.cpu.csr.writeRaw(CSR.MTVEC, TEST_BASE + 0x4000n);
  h.cpu.step(); // addi
  h.cpu.step(); // ecall
  assert.equal(h.cpu.csr.read(CSR.MCAUSE), BigInt(Exc.EnvCallFromM));
  assert.equal(h.cpu.csr.read(CSR.MEPC), U(TEST_BASE + 4n));
  assert.equal(h.cpu.priv, Priv.M);
  assert.equal((h.cpu.csr.read(CSR.MSTATUS) ?? 0n) & SR_MPP, 3n << 11n);
  assert.equal(h.cpu.pc, U(TEST_BASE + 0x4000n));
});

test('异常委派：medeleg 决定陷入 S 模式', () => {
  const h = makeCpu([addi(1, 0, 1), ecall(), ...halt()]);
  h.cpu.priv = Priv.S;
  h.cpu.csr.writeRaw(CSR.STVEC, TEST_BASE + 0x5000n);
  h.cpu.csr.writeRaw(CSR.MEDELEG, 1n << BigInt(Exc.EnvCallFromS));
  h.cpu.step();
  h.cpu.step();
  assert.equal(h.cpu.csr.read(CSR.SCAUSE), BigInt(Exc.EnvCallFromS));
  assert.equal(h.cpu.csr.read(CSR.SEPC), U(TEST_BASE + 4n));
  assert.equal(h.cpu.priv, Priv.S);
  assert.equal(h.cpu.pc, U(TEST_BASE + 0x5000n));
});

test('MRET：恢复特权级与中断使能', () => {
  const h = makeCpu([mret(), ...halt()]);
  h.cpu.csr.writeRaw(CSR.MEPC, TEST_BASE + 0x1234n);
  // MPP = S(1)，MPIE = 1
  h.cpu.csr.writeRaw(CSR.MSTATUS, (1n << 11n) | SR_MPIE);
  h.cpu.step();
  assert.equal(h.cpu.priv, Priv.S);
  assert.equal(h.cpu.pc, U(TEST_BASE + 0x1234n));
  assert.notEqual((h.cpu.csr.read(CSR.MSTATUS) ?? 0n) & SR_MIE, 0n, 'MIE 应恢复为 MPIE');
  assert.equal((h.cpu.csr.read(CSR.MSTATUS) ?? 0n) & SR_MPIE, 0n);
});

test('SRET：回到 U 模式并恢复 SIE', () => {
  const h = makeCpu([sret(), ...halt()]);
  h.cpu.priv = Priv.S;
  h.cpu.csr.writeRaw(CSR.SEPC, TEST_BASE + 0x2000n);
  h.cpu.csr.writeRaw(CSR.MSTATUS, SR_SIE | (1n << 5n)); // SPIE = 1，SPP = U
  h.cpu.step();
  assert.equal(h.cpu.priv, Priv.U);
  assert.equal(h.cpu.pc, U(TEST_BASE + 0x2000n));
  assert.notEqual((h.cpu.csr.read(CSR.MSTATUS) ?? 0n) & SR_SIE, 0n);
});

test('S 模式执行 MRET 属于非法指令', () => {
  const h = makeCpu([mret(), ...halt()]);
  h.cpu.priv = Priv.S;
  h.cpu.step();
  assert.equal(h.cpu.csr.read(CSR.MCAUSE), BigInt(Exc.IllegalInstruction));
});

test('WFI 进入等待状态', () => {
  const h = makeCpu([wfi(), addi(1, 0, 1), ...halt()]);
  h.cpu.step();
  assert.equal(h.cpu.wfi, true);
  h.cpu.step(); // 仍在等待，不执行后续指令
  assert.equal(h.cpu.x[1], 0n);
});

test('EBREAK：断点异常', () => {
  const h = makeCpu([ebreak(), ...halt()]);
  h.cpu.step();
  assert.equal(h.cpu.csr.read(CSR.MCAUSE), BigInt(Exc.Breakpoint));
  assert.equal(h.cpu.csr.read(CSR.MEPC), U(TEST_BASE));
});

test('SFENCE.VMA 清空 TLB', () => {
  const h = makeCpu([sfenceVma(0, 0), ...halt()]);
  h.cpu.mmu.priv = Priv.S;
  h.cpu.mmu.satp = (8n << 60n);
  h.run(10);
  assert.equal(h.cpu.halted, true);
  assert.equal(h.cpu.csr.read(CSR.MCAUSE), 0n, '不应产生异常');
});

test('M 模式定时器中断', () => {
  const h = makeCpu([addi(1, 0, 1), ...halt()]);
  h.cpu.csr.writeRaw(CSR.MTVEC, TEST_BASE + 0x6000n);
  h.cpu.csr.writeRaw(CSR.MIE, 1n << BigInt(Irq.MTimer));
  h.cpu.csr.writeRaw(CSR.MSTATUS, SR_MIE | (3n << 11n));
  h.cpu.setIrqLines(1n << BigInt(Irq.MTimer));
  h.cpu.step();
  assert.equal(h.cpu.csr.read(CSR.MCAUSE), BigInt(Irq.MTimer) | 0x8000000000000000n);
  assert.equal(h.cpu.priv, Priv.M);
  assert.equal(h.cpu.pc, U(TEST_BASE + 0x6000n));
  assert.equal(h.cpu.wfi, false);
});

test('中断委派：S 模式外部中断', () => {
  const h = makeCpu([addi(1, 0, 1), ...halt()]);
  h.cpu.priv = Priv.S;
  h.cpu.csr.writeRaw(CSR.STVEC, TEST_BASE + 0x7000n);
  h.cpu.csr.writeRaw(CSR.MIDELEG, 1n << BigInt(Irq.SExternal));
  h.cpu.csr.writeRaw(CSR.MIE, 1n << BigInt(Irq.SExternal));
  h.cpu.csr.writeRaw(CSR.MSTATUS, SR_SIE);
  h.cpu.setIrqLines(1n << BigInt(Irq.SExternal));
  h.cpu.step();
  assert.equal(h.cpu.csr.read(CSR.SCAUSE), BigInt(Irq.SExternal) | 0x8000000000000000n);
  assert.equal(h.cpu.priv, Priv.S);
  assert.equal(h.cpu.pc, U(TEST_BASE + 0x7000n));
});

test('向量化中断入口（mtvec.MODE=1）', () => {
  const h = makeCpu([addi(1, 0, 1), ...halt()]);
  h.cpu.csr.writeRaw(CSR.MTVEC, (TEST_BASE + 0x8000n) | 1n);
  h.cpu.csr.writeRaw(CSR.MIE, 1n << BigInt(Irq.MExternal));
  h.cpu.csr.writeRaw(CSR.MSTATUS, SR_MIE | (3n << 11n));
  h.cpu.setIrqLines(1n << BigInt(Irq.MExternal));
  h.cpu.step();
  assert.equal(h.cpu.pc, U(TEST_BASE + 0x8000n + BigInt(Irq.MExternal) * 4n));
});

test('中断被屏蔽时不触发（MIE=0）', () => {
  const h = makeCpu([addi(1, 0, 1), addi(2, 0, 2), ...halt()]);
  h.cpu.csr.writeRaw(CSR.MTVEC, TEST_BASE + 0x6000n);
  h.cpu.csr.writeRaw(CSR.MIE, 1n << BigInt(Irq.MTimer));
  h.cpu.csr.writeRaw(CSR.MSTATUS, 3n << 11n); // MIE = 0
  h.cpu.setIrqLines(1n << BigInt(Irq.MTimer));
  h.cpu.step();
  assert.equal(h.cpu.pc, U(TEST_BASE + 4n), 'MIE=0 时不应陷入');
  assert.equal(h.cpu.csr.read(CSR.MCAUSE), 0n);
});

test('页故障：未映射地址触发 load page fault', () => {
  const setup = li(1, 0x90000000n);
  const h = makeCpu([...setup, lw(2, 1, 0), ...halt()]);
  // 只恒等映射代码所在的 2MB 区域，数据地址保持未映射
  const pt = new Sv39Mapper(h, TEST_BASE + 0x300000n, TEST_BASE + 0x301000n);
  pt.map(TEST_BASE, TEST_BASE, PTE_R | PTE_W | PTE_X | PTE_A | PTE_D, 1);
  runToPc(h, pcOf(setup.length)); // M 模式（不翻译）下准备好地址
  h.cpu.priv = Priv.S;
  h.cpu.csr.writeRaw(CSR.SATP, pt.satp());
  h.cpu.step();
  assert.equal(h.cpu.csr.read(CSR.MCAUSE), BigInt(Exc.LoadPageFault));
  assert.equal(h.cpu.csr.read(CSR.MTVAL), U(0x90000000n));
});

test('页故障：写入只读页触发 store page fault', () => {
  const setup = [...li(1, 0x1000000n), ...li(2, 0x1234n)];
  const h = makeCpu([...setup, sd(1, 2, 0), ...halt()]);
  const pt = new Sv39Mapper(h, TEST_BASE + 0x300000n, TEST_BASE + 0x301000n);
  pt.map(TEST_BASE, TEST_BASE, PTE_R | PTE_W | PTE_X | PTE_A | PTE_D, 1);
  pt.map(0x1000000n, 0x1000000n, PTE_R | PTE_X | PTE_A, 1); // 只读、可执行
  runToPc(h, pcOf(setup.length));
  h.cpu.priv = Priv.S;
  h.cpu.csr.writeRaw(CSR.SATP, pt.satp());
  h.cpu.step();
  assert.equal(h.cpu.csr.read(CSR.MCAUSE), BigInt(Exc.StorePageFault));
  assert.equal(h.cpu.csr.read(CSR.MTVAL), U(0x1000000n));
});
