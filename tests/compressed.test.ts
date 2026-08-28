import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  c_add,
  c_addi,
  c_addi16sp,
  c_addi4spn,
  c_addiw,
  c_and,
  c_andi,
  c_beqz,
  c_bnez,
  c_ebreak,
  c_jalr,
  c_jr,
  c_ld,
  c_ldsp,
  c_li,
  c_lui,
  c_lw,
  c_lwsp,
  c_mv,
  c_nop,
  c_or,
  c_sd,
  c_sdsp,
  c_slli,
  c_srai,
  c_srli,
  c_sub,
  c_sw,
  c_swsp,
  c_xor,
  addi,
  li,
  ld,
} from '../tools/encoder.ts';
import { TEST_BASE, halt, makeCpu, pcOf, peek, runToPc } from './harness.ts';

const U = (v: bigint | number) => BigInt.asUintN(64, BigInt(v));

test('C.LI / C.ADDI / C.ADDIW / C.LUI / C.NOP', () => {
  const h = makeCpu([
    c_nop(),
    c_li(1, 5),
    c_addi(1, 3),
    c_li(2, -1),
    c_addiw(2, 2),
    c_lui(3, -1), // nzimm = -1 → 0x3f000 符号扩展 = -4096
    ...halt(),
  ]);
  h.run(100);
  assert.equal(h.x(1), 8n);
  assert.equal(h.x(2), U(1n)); // -1 + 2
  assert.equal(h.x(3), U(-4096n));
});

test('C.MV / C.ADD / C.SUB / C.XOR / C.OR / C.AND（压缩寄存器寻址）', () => {
  const h = makeCpu([
    c_li(8, 10), // s0 = x8
    c_li(9, 3), // s1 = x9
    c_mv(10, 8), // a0 = s0
    c_add(10, 9), // a0 += s1 = 13
    c_mv(11, 10), // a1 = a0
    c_sub(11, 9), // a1 = a1 - s1 = 10
    c_mv(8, 10),
    c_mv(9, 11),
    c_and(8, 9),
    c_or(8, 9),
    c_xor(8, 9),
    ...halt(),
  ]);
  h.run(100);
  assert.equal(h.x(8), U(0n), 'x^y^y^y 结果为 0');
  assert.equal(h.x(11), 10n);
});

test('C.SLLI / C.SRLI / C.SRAI / C.ANDI', () => {
  const h = makeCpu([
    c_li(8, 1),
    c_slli(8, 10), // 1 << 10
    c_srli(8, 2), // >> 2
    c_li(9, -16),
    c_srai(9, 2), // 算术右移
    c_andi(8, 0x0f),
    ...halt(),
  ]);
  h.run(100);
  assert.equal(h.x(8), 0x40n & 0x0fn);
  assert.equal(h.x(9), U(-4n));
});

test('C.LD / C.SD / C.LW / C.SW 栈相对访存', () => {
  const h = makeCpu([
    ...li(2, TEST_BASE + 0x200000n), // sp
    ...li(1, 0x1122334455667788n),
    c_mv(8, 1), // s0 = x1
    c_sd(8, 9, 8), // 把 s1(x9) 存到 s0+8（s1 此时为 0）
    c_ld(10, 8, 8), // 读回
    c_sw(8, 9, 16),
    c_lw(11, 8, 16),
    ...halt(),
  ]);
  h.run(200);
  assert.equal(h.x(10), 0n);
  assert.equal(h.x(11), 0n);
  assert.equal(peek(h.ram, TEST_BASE + 0x200000n + 8n), 0n);
});

test('C.LDSP / C.SDSP / C.LWSP / C.SWSP', () => {
  const h = makeCpu([
    ...li(2, TEST_BASE + 0x300000n), // sp
    ...li(1, 0xdeadbeefcafebaben),
    c_sdsp(1, 8), // 存到 sp+8
    c_ldsp(3, 8), // 读回
    c_swsp(1, 32), // 存低 32 位到 sp+32
    c_lwsp(4, 32),
    ...halt(),
  ]);
  h.run(200);
  assert.equal(h.x(3), 0xdeadbeefcafebaben);
  assert.equal(h.x(4), U(0xffffffffcafebaben));
  assert.equal(peek(h.ram, TEST_BASE + 0x300000n + 8n), 0xdeadbeefcafebaben);
});

test('C.J / C.JR / C.JALR / C.BEQZ / C.BNEZ', () => {
  const sub = TEST_BASE + 0x100n; // 子程序放在远离主程序处
  const program = [
    c_li(8, 0), // s0 = 0
    c_li(9, 3), // s1 = 3（循环计数）
    // loop:
    c_addi(8, 1), // s0++
    c_addi(9, -1), // s1--
    c_bnez(9, -4), // s1 != 0 → 回到 s0++
    c_beqz(9, 4), // s1 == 0 → 跳 4 字节（跳过下一条）
    c_li(10, 99), // 不应执行
    c_li(11, 30), // 执行（C.LI 立即数为 6 位有符号）
    ...li(12, sub),
    c_jalr(12), // 调用子程序，x1 = 返回地址
    ...halt(),
  ];
  const h = makeCpu(program);
  h.ram.writeProgram(sub - TEST_BASE, [c_li(14, 7), c_jr(1)]);
  h.run(500);
  assert.equal(h.x(8), 3n, '循环执行 3 次');
  assert.equal(h.x(9), 0n);
  assert.equal(h.x(10), 0n, 'C.BEQZ 应跳过');
  assert.equal(h.x(11), 30n);
  assert.equal(h.x(14), 7n, '子程序应被执行并由 C.JR 返回');
  assert.equal(h.cpu.halted, true);
});

test('C.ADDI4SPN / C.ADDI16SP', () => {
  const h = makeCpu([
    ...li(2, TEST_BASE + 0x400000n),
    c_addi4spn(8, 16), // s0 = sp + 16
    c_addi16sp(32), // sp += 32
    c_mv(9, 8),
    c_addi16sp(-32),
    ...halt(),
  ]);
  h.run(200);
  assert.equal(h.x(8), U(TEST_BASE + 0x400000n + 16n));
  assert.equal(h.x(9), U(TEST_BASE + 0x400000n + 16n));
  assert.equal(h.x(2), U(TEST_BASE + 0x400000n));
});

test('C.EBREAK 触发断点异常', () => {
  const h = makeCpu([c_nop(), c_ebreak(), ...halt()]);
  h.cpu.step();
  h.cpu.step();
  assert.equal(h.cpu.x[0], 0n);
  // 断点异常会写入 mcause=3，之后跳到 mtvec(0)
  assert.equal(h.cpu.pc, 0n);
});

test('压缩指令与 32 位指令混合执行', () => {
  const h = makeCpu([
    c_li(1, 7),
    addi(2, 1, 1), // 32 位指令
    c_addi(2, 2),
    c_mv(3, 2),
    ...li(4, 0x80100000n),
    c_mv(8, 4), // 压缩指令只能访问 x8-x15
    c_mv(9, 3),
    c_sd(8, 9, 0), // 用压缩指令做 64 位存储
    ld(5, 8, 0), // 用 32 位指令读回
    ...halt(),
  ]);
  h.run(300);
  assert.equal(h.x(3), 10n);
  assert.equal(h.x(5), 10n);
  assert.equal(peek(h.ram, TEST_BASE + 0x100000n), 10n);
  assert.equal(h.cpu.halted, true);
});

test('C.ADDI4SPN 的 nzimm=0 属于非法指令', () => {
  const h = makeCpu([c_addi4spn(8, 0), ...halt()]);
  h.cpu.step();
  // 非法指令会陷入 M 模式（mtvec=0）
  assert.equal(h.cpu.pc, 0n);
});

test('IALIGN=16：2-mod-4 地址上的 32 位指令合法', () => {
  // C 指令后紧跟 32 位指令，地址为 2-mod-4，不应产生指令地址非对齐异常
  const h = makeCpu([c_li(1, 7), addi(2, 1, 1), ...halt()]);
  h.run(300);
  assert.equal(h.cpu.halted, true);
  assert.equal(h.cpu.csr.read(0x342) ?? 0n, 0n, '不应产生任何异常');
  assert.equal(h.x(2), 8n);
});

test('JALR 清除目标地址 bit0（RVC IALIGN=16 语义）', () => {
  // jalr ra, 0(x1)：目标地址 bit0=1 时会被清零，落点为 2 字节对齐地址
  const target = (TEST_BASE + 0x500n) | 1n;
  const setup = li(1, target);
  const h = makeCpu([...setup, 0x000080e7]); // jalr ra, 0(x1)
  runToPc(h, pcOf(setup.length));
  h.cpu.step();
  assert.equal(h.cpu.pc, TEST_BASE + 0x500n, 'JALR 应清除 bit0');
  assert.equal(h.cpu.csr.read(0x342) ?? 0n, 0n, '不应产生异常');
});
