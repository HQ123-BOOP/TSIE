/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  faddd,
  fadds,
  fcvtld,
  fcvtsd,
  fcvtsw,
  fcvtws,
  fcvtds,
  fdivd,
  fdivs,
  feqd,
  feqs,
  fclassd,
  fld,
  flw,
  fled,
  fmadds,
  fmaxs,
  fmins,
  fmuld,
  fmuls,
  fmvxd,
  fmvwx,
  fsd,
  fsw,
  fsgnjns,
  fsgnjs,
  fsgnjxs,
  fsqrtd,
  fsqrts,
  fsubd,
  fsubs,
  addi,
  li,
  lw,
  sw,
} from '../tools/encoder.ts';
import { CSR } from '../src/cpu/csr.ts';
import { bitsToF64, f32Box, f64Box } from '../src/cpu/fpu.ts';
import { TEST_BASE, halt, makeCpu, peek, pcOf, runToPc } from './harness.ts';

const DATA = TEST_BASE + 0x100000n;

/** 写入双精度位模式（FLD 使用） */
function putDouble(h: ReturnType<typeof makeCpu>, slot: number, value: number): void {
  h.ram.write(DATA - TEST_BASE + BigInt(slot * 8), f64Box(value), 8);
}

/** 写入 NaN-boxed 单精度位模式（FLW / 单精度运算使用） */
function putFloat(h: ReturnType<typeof makeCpu>, slot: number, value: number): void {
  h.ram.write(DATA - TEST_BASE + BigInt(slot * 8), f32Box(value), 8);
}

test('FADD / FSUB / FMUL / FDIV / FSQRT（双精度）', () => {
  const h = makeCpu([
    ...li(1, DATA),
    fld(2, 1, 0), // 3.5
    fld(3, 1, 8), // 1.25
    faddd(4, 2, 3),
    fsubd(5, 2, 3),
    fmuld(6, 2, 3),
    fdivd(7, 2, 3),
    fsqrtd(8, 3),
    ...halt(),
  ]);
  putDouble(h, 0, 3.5);
  putDouble(h, 1, 1.25);
  h.run(400);
  assert.equal(bitsToF64(h.cpu.f[4]), 4.75);
  assert.equal(bitsToF64(h.cpu.f[5]), 2.25);
  assert.equal(bitsToF64(h.cpu.f[6]), 4.375);
  assert.equal(bitsToF64(h.cpu.f[7]), 2.8);
  assert.ok(Math.abs(bitsToF64(h.cpu.f[8]) - Math.sqrt(1.25)) < 1e-12);
  assert.equal(h.cpu.halted, true);
});

test('单精度运算结果会被 NaN-boxed', () => {
  const h = makeCpu([
    ...li(1, DATA),
    flw(2, 1, 0), // 3.5f
    flw(3, 1, 8), // 1.25f
    fadds(4, 2, 3),
    fsubs(5, 2, 3),
    fmuls(6, 2, 3),
    fdivs(7, 2, 3),
    fsqrts(8, 3),
    ...halt(),
  ]);
  putFloat(h, 0, 3.5);
  putFloat(h, 1, 1.25);
  h.run(400);
  assert.equal(h.cpu.f[4], f32Box(4.75));
  assert.equal(h.cpu.f[5], f32Box(2.25));
  assert.equal(h.cpu.f[6], f32Box(4.375));
  assert.equal(h.cpu.f[7], f32Box(2.8));
  assert.equal(h.cpu.f[8], f32Box(Math.fround(Math.sqrt(1.25))));
  for (const i of [4, 5, 6, 7, 8]) {
    assert.equal(h.cpu.f[i] >> 32n, 0xffffffffn, `f${i} 高 32 位必须全 1`);
  }
});

test('FMADD / FMIN / FMAX / 比较指令', () => {
  const h = makeCpu([
    ...li(1, DATA),
    flw(2, 1, 0), // 2
    flw(3, 1, 8), // 3
    flw(4, 1, 16), // 4
    fld(11, 1, 24), // 2.0（双精度）
    fld(12, 1, 32), // 3.0
    fmadds(5, 2, 3, 4), // 2*3+4 = 10
    fmins(6, 2, 3),
    fmaxs(7, 2, 3),
    feqs(8, 2, 2), // 相等 → 1
    feqd(9, 11, 11),
    fled(10, 11, 12), // 2 <= 3 → 1
    fled(13, 12, 11), // 3 <= 2 → 0
    ...halt(),
  ]);
  putFloat(h, 0, 2);
  putFloat(h, 1, 3);
  putFloat(h, 2, 4);
  putDouble(h, 3, 2);
  putDouble(h, 4, 3);
  h.run(400);
  assert.equal(h.cpu.f[5], f32Box(10));
  assert.equal(h.cpu.f[6], f32Box(2));
  assert.equal(h.cpu.f[7], f32Box(3));
  assert.equal(h.cpu.x[8], 1n);
  assert.equal(h.cpu.x[9], 1n);
  assert.equal(h.cpu.x[10], 1n);
  assert.equal(h.cpu.x[13], 0n);
});

test('FSGNJ / FSGNJN / FSGNJX 位操作', () => {
  const h = makeCpu([
    ...li(1, DATA),
    flw(2, 1, 0), // +1.5
    flw(3, 1, 8), // -1.5
    fsgnjs(4, 2, 3), // 取 rs2 符号 → -1.5
    fsgnjns(5, 2, 3), // 取反 → +1.5
    fsgnjxs(6, 2, 3), // 异或 → -1.5
    fsgnjxs(7, 2, 2), // 同号 → +1.5
    ...halt(),
  ]);
  putFloat(h, 0, 1.5);
  putFloat(h, 1, -1.5);
  h.run(400);
  assert.equal(h.cpu.f[4], f32Box(-1.5));
  assert.equal(h.cpu.f[5], f32Box(1.5));
  assert.equal(h.cpu.f[6], f32Box(-1.5));
  assert.equal(h.cpu.f[7], f32Box(1.5));
});

test('FCVT：浮点与整数互转', () => {
  const h = makeCpu([
    ...li(1, DATA),
    flw(2, 1, 0), // 3.75f
    fld(12, 1, 8), // 3.75（双精度）
    fcvtws(3, 2), // 4
    fcvtld(4, 12), // RNE：3.75 → 4
    ...li(5, -1234n),
    fcvtsw(6, 5), // -1234.0f
    fcvtws(7, 6), // 往返
    fcvtsd(8, 6), // S → D（仍是 NaN-boxed 的 f32 值）
    fcvtds(9, 8),
    ...halt(),
  ]);
  putFloat(h, 0, 3.75);
  putDouble(h, 1, 3.75);
  h.run(400);
  assert.equal(h.cpu.x[3], 4n);
  assert.equal(h.cpu.x[4], 4n, 'RNE 舍入：3.75 → 4');
  assert.equal(h.cpu.f[6], f32Box(-1234));
  assert.equal(h.cpu.x[7], BigInt.asUintN(64, -1234n));
  assert.equal(h.cpu.f[9], f32Box(-1234));
});

test('FCVT 溢出与 NaN：饱和到最大幅度', () => {
  const h = makeCpu([
    ...li(1, DATA),
    flw(2, 1, 0), // +Inf
    fld(3, 1, 8), // NaN
    fcvtws(4, 2), // 0x7fffffff
    fcvtld(5, 3), // 0x7fffffffffffffff
    ...halt(),
  ]);
  putFloat(h, 0, Infinity);
  putDouble(h, 1, NaN);
  h.run(400);
  assert.equal(h.cpu.x[4], 0x7fffffffn);
  assert.equal(h.cpu.x[5], 0x7fffffffffffffffn);
  assert.notEqual(Number(h.cpu.csr.read(CSR.FCSR) ?? 0n) & 0x1f, 0, '应置起 NV 标志');
});

test('FCLASS 分类位图', () => {
  const h = makeCpu([
    ...li(1, DATA),
    fld(2, 1, 0), // +0
    fld(3, 1, 8), // -1.5
    fld(4, 1, 16), // +Inf
    fclassd(5, 2),
    fclassd(6, 3),
    fclassd(7, 4),
    ...halt(),
  ]);
  putDouble(h, 0, 0);
  putDouble(h, 1, -1.5);
  putDouble(h, 2, Infinity);
  h.run(400);
  assert.equal(h.cpu.x[5], 0x10n); // +0
  assert.equal(h.cpu.x[6], 0x02n); // 负规格数
  assert.equal(h.cpu.x[7], 0x80n); // +∞
});

test('FMV.W.X / FMV.X.D 与浮点访存', () => {
  const h = makeCpu([
    ...li(1, DATA),
    ...li(2, 0x40490fdbn), // float π 的位模式
    fmvwx(3, 2), // 位模式搬入浮点寄存器（NaN-boxed）
    fsw(1, 3, 0), // 存低 32 位到内存
    lw(4, 1, 0), // 读回（符号扩展）
    fmvxd(5, 3), // 整寄存器搬回整数寄存器
    addi(6, 0, 0),
    sw(1, 6, 8),
    fsd(1, 3, 16), // 存 64 位
    ...halt(),
  ]);
  h.run(400);
  assert.equal(h.cpu.f[3], 0xffffffff40490fdbn);
  assert.equal(h.cpu.x[4], 0x40490fdbn); // 最高位为 0，符号扩展后不变
  assert.equal(h.cpu.x[5], 0xffffffff40490fdbn);
  assert.equal(peek(h.ram, DATA) & 0xffffffffn, 0x40490fdbn);
  assert.equal(peek(h.ram, DATA + 16n), 0xffffffff40490fdbn);
});

test('FLW 未装箱数据时视为 canonical NaN', () => {
  const h = makeCpu([...li(1, DATA), fld(2, 1, 0), fadds(3, 2, 2), ...halt()]);
  h.ram.write(DATA - TEST_BASE, 0x000000003f800000n, 8); // 高位不是全 1
  h.run(400);
  assert.equal(h.cpu.f[2], 0x000000003f800000n, '原始位模式保留');
  assert.equal(h.cpu.f[3], f32Box(NaN), '运算时按 NaN 处理');
});

test('mstatus.FS=0 时浮点指令触发非法指令异常', () => {
  const setup = li(1, DATA);
  const h = makeCpu([...setup, fld(2, 1, 0), ...halt()]);
  putDouble(h, 0, 1.5);
  h.cpu.csr.writeRaw(CSR.MSTATUS, 0x1800n); // FS = 0
  runToPc(h, pcOf(setup.length));
  h.cpu.step();
  assert.equal(h.cpu.csr.read(CSR.MCAUSE), 2n); // illegal instruction
});
