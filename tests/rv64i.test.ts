/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  add,
  addi,
  addiw,
  and_,
  andi,
  auipc,
  beq,
  bge,
  bgeu,
  blt,
  bltu,
  bne,
  jal,
  jalr,
  lb,
  lbu,
  ld,
  lh,
  lhu,
  lui,
  lw,
  lwu,
  or_,
  ori,
  sb,
  sd,
  sh,
  sll,
  slli,
  slt,
  slti,
  sltiu,
  sltu,
  sra,
  srai,
  srli,
  srlw,
  subw,
  sw,
  xor_,
  xori,
  li,
} from '../tools/encoder.ts';
import { TEST_BASE, halt, makeCpu, peek } from './harness.ts';

const U = (v: bigint | number) => BigInt.asUintN(64, BigInt(v));

test('LUI / AUIPC', () => {
  const h = makeCpu([lui(1, 0x12345000), auipc(2, 0x1000)]);
  h.run(2);
  assert.equal(h.x(1), U(0x12345000));
  // AUIPC：第 2 条指令的 pc 为 base+4，结果 = pc + 0x1000
  assert.equal(h.x(2), U(TEST_BASE + 4n + 0x1000n));
});

test('ADDI / ADDIW 符号扩展', () => {
  const h = makeCpu([addi(1, 0, -1), addi(2, 1, 5), addiw(3, 1, 0)]);
  h.run(3);
  assert.equal(h.x(1), U(-1n));
  assert.equal(h.x(2), 4n);
  assert.equal(h.x(3), U(-1n));
});

test('ADDW / SUBW / SRLW 只保留低 32 位并符号扩展', () => {
  const h = makeCpu([
    addi(1, 0, 1),
    slli(1, 1, 40), // x1 = 2^40
    addiw(2, 1, 1), // (2^40 + 1) 低 32 位 = 1
    subw(3, 0, 1), // 0 - 2^40 → 低 32 位为 0
    srlw(4, 1, 8),
  ]);
  h.run(5);
  assert.equal(h.x(1), 1n << 40n);
  assert.equal(h.x(2), 1n);
  assert.equal(h.x(3), 0n);
  assert.equal(h.x(4), (1n << 40n >> 8n) & 0xffffffffn);
});

test('移位指令', () => {
  const h = makeCpu([
    addi(1, 0, 1),
    slli(2, 1, 63), // 0x8000_0000_0000_0000
    srli(3, 2, 63), // 1
    addi(4, 0, -1),
    srai(5, 4, 8), // 仍为 -1
    addi(8, 0, 63),
    sra(6, 2, 8), // 算术右移 63 位 → -1
    sll(7, 1, 1),
  ]);
  h.run(8);
  assert.equal(h.x(2), 1n << 63n);
  assert.equal(h.x(3), 1n);
  assert.equal(h.x(5), U(-1n));
  assert.equal(h.x(6), U(-1n));
  assert.equal(h.x(7), 2n);
});

test('SLT / SLTU / SLTI / SLTIU', () => {
  const h = makeCpu([
    addi(1, 0, -1),
    addi(2, 0, 1),
    slt(3, 1, 2), // -1 < 1 → 1
    sltu(4, 1, 2), // 0xffff... > 1 → 0
    slti(5, 1, -1), // -1 < -1 → 0
    sltiu(6, 1, 1), // 0xffff... < 1 → 0
  ]);
  h.run(6);
  assert.equal(h.x(3), 1n);
  assert.equal(h.x(4), 0n);
  assert.equal(h.x(5), 0n);
  assert.equal(h.x(6), 0n);
});

test('逻辑运算', () => {
  const h = makeCpu([
    addi(1, 0, 0xf0),
    addi(2, 0, 0x3c),
    and_(3, 1, 2),
    or_(4, 1, 2),
    xor_(5, 1, 2),
    andi(6, 1, -1),
    ori(7, 1, 0x0f),
    xori(8, 1, -1),
  ]);
  h.run(8);
  assert.equal(h.x(3), 0x30n);
  assert.equal(h.x(4), 0xfcn);
  assert.equal(h.x(5), 0xccn);
  assert.equal(h.x(6), 0xf0n);
  assert.equal(h.x(7), 0xffn);
  assert.equal(h.x(8), U(~0xf0n));
});

test('分支与循环：1..10 求和', () => {
  const program = [
    addi(1, 0, 0), // i = 0
    addi(2, 0, 10), // n = 10
    addi(3, 0, 0), // sum = 0
    // loop:
    addi(1, 1, 1), // i++
    add(3, 3, 1), // sum += i
    blt(1, 2, -8), // if (i < n) goto loop
    ...halt(),
  ];
  const h = makeCpu(program);
  h.run(1000);
  assert.equal(h.x(3), 55n);
  assert.equal(h.cpu.halted, true);
  assert.equal(h.steps, 3 + 30 + 2); // 初始化 3 + 迭代 10×3 + 停机 2
});

test('分支：BNE / BEQ / BGE / BGEU / BLTU', () => {
  const h = makeCpu([
    addi(1, 0, 5),
    addi(2, 0, 5),
    beq(1, 2, 8), // 跳到下下条
    addi(3, 0, 1), // 不应执行
    bne(1, 2, 8), // 不跳
    addi(4, 0, 1), // 执行
    bge(1, 2, 8),
    addi(5, 0, 1),
    addi(6, 0, 1),
    bgeu(1, 2, 8),
    addi(7, 0, 1),
    bltu(1, 2, 8), // 5 < 5 false → 不跳
    addi(8, 0, 1),
  ]);
  h.run(20);
  assert.equal(h.x(3), 0n, 'BEQ 跳转后不应执行');
  assert.equal(h.x(4), 1n);
  assert.equal(h.x(5), 0n, 'BGE 相等应跳转');
  assert.equal(h.x(6), 1n);
  assert.equal(h.x(7), 0n, 'BGEU 相等应跳转');
  assert.equal(h.x(8), 1n, 'BLTU 相等不跳转');
});

test('JAL / JALR 链接与目标', () => {
  const h = makeCpu([
    jal(1, 8), // 跳到 pc+8（第 3 条）
    addi(2, 0, 1), // 被跳过
    addi(3, 0, 2),
    jalr(5, 1, 4), // 目标 = x1 + 4 = 第 3 条
  ]);
  h.run(3);
  assert.equal(h.x(1), U(TEST_BASE + 4n));
  assert.equal(h.x(2), 0n);
  assert.equal(h.x(3), 2n);
  assert.equal(h.x(5), U(TEST_BASE + 16n)); // jalr 的返回地址
  assert.equal(h.cpu.pc, U(TEST_BASE + 8n));
});

test('加载 / 存储：SD-LD / SW-LW / SH-LH / SB-LB', () => {
  const data = 0x80100000n;
  const h = makeCpu([
    ...li(1, data),
    ...li(2, 0x1122334455667788n),
    sd(1, 2, 0),
    ld(3, 1, 0),
    sw(1, 2, 8),
    lw(4, 1, 8),
    lwu(5, 1, 8),
    sh(1, 2, 16),
    lh(6, 1, 16),
    lhu(7, 1, 16),
    sb(1, 2, 24),
    lb(8, 1, 24),
    lbu(9, 1, 24),
  ]);
  h.run(60);
  assert.equal(h.x(3), 0x1122334455667788n);
  assert.equal(h.x(4), 0x55667788n); // 正数：符号扩展后不变
  assert.equal(h.x(5), 0x55667788n); // 零扩展
  assert.equal(h.x(6), 0x7788n);
  assert.equal(h.x(7), 0x7788n);
  assert.equal(h.x(8), U(-0x78n)); // 0x88 按字节符号扩展 → -120
  assert.equal(h.x(9), 0x88n); // 零扩展
  assert.equal(peek(h.ram, data), 0x1122334455667788n);
});

test('负数加载的符号扩展', () => {
  const data = 0x80100000n;
  const h = makeCpu([
    ...li(1, data),
    addi(2, 0, -1),
    sw(1, 2, 0),
    lw(3, 1, 0),
    sb(1, 2, 8),
    lb(4, 1, 8),
    lbu(5, 1, 8),
    sh(1, 2, 16),
    lh(6, 1, 16),
  ]);
  h.run(60);
  assert.equal(h.x(3), U(-1n));
  assert.equal(h.x(4), U(-1n));
  assert.equal(h.x(5), 0xffn);
  assert.equal(h.x(6), U(-1n));
});

test('li() 可构造 64 位常量', () => {
  const value = 0xfedcba9876543210n;
  const h = makeCpu([...li(1, value, 30), ...li(2, 0x8000000000000000n, 30)]);
  h.run(40);
  assert.equal(h.x(1), value);
  assert.equal(h.x(2), 1n << 63n);
});

test('x0 恒为 0', () => {
  const h = makeCpu([addi(0, 0, 123), addi(1, 0, 5), add(0, 1, 1)]);
  h.run(3);
  assert.equal(h.x(0), 0n);
});
