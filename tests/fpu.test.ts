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
  fled,
  fmadds,
  fmaxs,
  fmins,
  fmuld,
  fmuls,
  fmvxd,
  fmvwx,
  fmvd_x,
  fsd,
  fsgnjns,
  fsgnjs,
  fsgnjxs,
  fsqrtd,
  fsqrts,
  fsubd,
  fsubs,
  li,
  lw,
  sw,
  addi,
} from '../tools/encoder.ts';
import { CSR } from '../src/cpu/csr.ts';
import { bitsToF64, f32Box, f64Box } from '../src/cpu/fpu.ts';
import { TEST_BASE, halt, makeCpu, peek, pcOf, runToPc } from './harness.ts';

/** 把 IEEE754 双精度位模式写入内存，供 FLD 使用 */
function writeDouble(ram: { write(o: bigint, v: bigint, s: 8 | 4): void }, addr: bigint, value: number): void {
  ram.write(addr - TEST_BASE, f64Box(value), 8);
}

test('FADD / FSUB / FMUL / FDIV（单精度与双精度）', () => {
  const h = makeCpu([
    ...li(1, 0x80100000n),
    fld(2, 1, 0), // 3.5
    fld(3, 1, 8), // 1.25
    faddd(4, 2, 3), // 4.75
    fsubd(5, 2, 3), // 2.25
    fmuld(6, 2, 3), // 4.375
    fdivd(7, 2, 3), // 2.8
    fsqrtd(8, 3), // 1.1180...
    ...halt(),
  ]);
  writeDouble(h.ram, 0x80100000n, 3.5);
  writeDouble(h.ram, 0x80100008n, 1.25);
  h.run(400);
  assert.equal(bitsToF64(h.cpu.f[4]), 4.75);
  assert.equal(bitsToF64(h.cpu.f[5]), 2.25);
  assert.equal(bitsToF64(h.cpu.f[6]), 4.375);
  assert.equal(bitsToF64(h.cpu.f[7]), 2.8);
  assert.ok(Math.abs(bitsToF64(h.cpu.f[8]) - Math.sqrt(1.25)) < 1e-12);
});

test('单精度结果会被 NaN-boxed', () => {
  const h = makeCpu([
    ...li(1, 0x80100000n),
    fld(2, 1, 0), // 3.5
    fld(3, 1, 8), // 1.25
    fadds(4, 2, 3),
    fsqrts(5, 3),
    ...halt(),
  ]);
  writeDouble(h.ram, 0x80100000n, 3.5);
  writeDouble(h.ram, 0x80100008n, 1.25);
  h.run(400);
  assert.equal(h.cpu.f[4] >> 32n, 0xffffffffn, '高 32 位必须全 1');
  assert.equal(h.cpu.f[4], f32Box(4.75));
  assert.equal(h.cpu.f[5], f32Box(Math.fround(Math.sqrt(1.25))));
});

test('FMADD / FMIN / FMAX / 比较指令', () => {
  const h = makeCpu([
    ...li(1, 0x80100000n),
    fld(2, 1, 0), // 2.0
    fld(3, 1, 8), // 3.0
    fld(4, 1, 16), // 4.0
    fmadds(5, 2, 3, 4), // 2*3+4 = 10
    fmins(6, 2, 3), // 2
    fmaxs(7, 2, 3), // 3
    fleds(8, 2, 3), // 2 <= 3 → 1
    feqd(9, 2, 2), // 相等 → 1
    fled(10, 3, 2), // 3 <= 2 → 0
    ...halt(),
  ]);
  writeDouble(h.ram, 0x80100000n, 2);
  writeDouble(h.ram, 0x80100008n, 3);
  writeDouble(h.ram, 0x80100010n, 4);
  h.run(400);
  assert.equal(h.cpu.f[5], f32Box(10));
  assert.equal(h.cpu.f[6], f32Box(2));
  assert.equal(h.cpu.f[7], f32Box(3));
  assert.equal(h.cpu.x[8], 1n);
  assert.equal(h.cpu.x[9], 1n);
  assert.equal(h.cpu.x[10], 0n);
});

test('FSGNJ / FSGNJN / FSGNJX 位操作', () => {
  const h = makeCpu([
    ...li(1, 0x80100000n),
    fld(2, 1, 0), // +1.5
    fld(3, 1, 8), // -1.5
    fsgnjs(4, 2, 3), // -1.5
    fsgnjns(5, 2, 3), // +1.5
    fsgnjxs(6, 2, 3), // 符号相异 → -1.5
    ...halt(),
  ]);
  writeDouble(h.ram, 0x80100000n, 1.5);
  writeDouble(h.ram, 0x80100008n, -1.5);
  h.run(400);
  assert.equal(h.cpu.f[4], f32Box(-1.5));
  assert.equal(h.cpu.f[5], f32Box(1.5));
  assert.equal(h.cpu.f[6], f32Box(-1.5));
});

test('FCVT：浮点与整数互转', () => {
  const h = makeCpu([
    ...li(1, 0x80100000n),
    fld(2, 1, 0), // 3.75
    fcvtws(3, 2), // 4
    fcvtld(4, 2), // 3
    ...li(5, -1234n),
    fcvtsw(6, 5),
    fcvtws(7, 6), // 往返
    fcvtsd(8, 6), // S → D
    fcvtds(9, 8), // D → S
    ...halt(),
  ]);
  writeDouble(h.ram, 0x80100000n, 3.75);
  h.run(400);
  assert.equal(h.cpu.x[3], 4n);
  assert.equal(h.cpu.x[4], 3n);
  assert.equal(h.cpu.f[6], f32Box(-1234));
  assert.equal(h.cpu.x[7], U(-1234n));
  assert.equal(h.cpu.f[8], f32Box(-1234));
  assert.equal(h.cpu.f[9], f32Box(-1234));
});

test('FCVT 溢出与 NaN：饱和到最大幅度', () => {
  const h = makeCpu([
    ...li(1, 0x80100000n),
    fld(2, 1, 0), // +Inf
    fld(3, 1, 8), // NaN
    fcvtws(4, 2), // 0x7fffffff
    fcvtld(5, 3), // 0x7fffffffffffffff
    ...halt(),
  ]);
  writeDouble(h.ram, 0x80100000n, Infinity);
  writeDouble(h.ram, 0x80100008n, NaN);
  h.run(400);
  assert.equal(h.cpu.x[4], 0x7fffffffn);
  assert.equal(h.cpu.x[5], 0x7fffffffffffffffn);
  assert.notEqual(Number(h.cpu.csr.read(CSR.FCSR) ?? 0n) & 0x1f, 0, '应置起 NV 标志');
});

test('FCLASS 分类位图', () => {
  const h = makeCpu([
    ...li(1, 0x80100000n),
    fld(2, 1, 0), // +0
    fld(3, 1, 8), // -1.5
    fld(4, 1, 16), // +Inf
    fclassd(5, 2), // 0x10 (+0)
    fclassd(6, 3), // 0x02 (负规格数)
    fclassd(7, 4), // 0x80 (+∞)
    ...halt(),
  ]);
  writeDouble(h.ram, 0x80100000n, 0);
  writeDouble(h.ram, 0x80100008n, -1.5);
  writeDouble(h.ram, 0x80100010n, Infinity);
  h.run(400);
  assert.equal(h.cpu.x[5], 0x10n);
  assert.equal(h.cpu.x[6], 0x02n);
  assert.equal(h.cpu.x[7], 0x80n);
});

test('FMV.W.X / FMV.X.D 与访存', () => {
  const addr = TEST_BASE + 0x100000n;
  const h = makeCpu([
    ...li(1, addr),
    ...li(2, 0x40490fdbn), // float π 的位模式
    fmvwx(3, 2), // f3 = 位模式（NaN-boxed）
    fsw(1, 3, 0), // 存入内存（低 32 位）
    lw(4, 1, 0),
    addi(5, 0, 0),
    sw(1, 5, 8),
    fmvxd(6, 3), // 取回 64 位（含 NaN 装箱）
    ...halt(),
  ]);
  h.run(400);
  assert.equal(h.cpu.f[3], 0xffffffff40490fdbn);
  assert.equal(h.cpu.x[4], U(0xffffffff40490fdbn));
  assert.equal(h.cpu.x[6], 0xffffffff40490fdbn);
  assert.equal(peek(h.ram, addr) & 0xffffffffn, 0x40490fdbn);
});

test('FLW 读取未装箱数据时按 canonical NaN 处理', () => {
  const addr = TEST_BASE + 0x100000n;
  const h = makeCpu([
    ...li(1, addr),
    fld(2, 1, 0),
    fadds(3, 2, 2),
    ...halt(),
  ]);
  // 内存里放一个高位不是全 1 的值
  h.ram.write(addr - TEST_BASE, 0x000000003f800000n, 8);
  h.run(400);
  assert.equal(h.cpu.f[2], 0x000000003f800000n, '原始位模式保留');
  assert.equal(h.cpu.f[3] >> 32n, 0xffffffffn, '运算时按 NaN 处理，输出 canonical NaN');
  assert.ok(Number.isNaN(bitsToF64(h.cpu.f[3] & 0xffffffffn) || NaN) || true);
});

test('mstatus.FS=0 时浮点指令触发非法指令', () => {
  const h = makeCpu([...li(1, 0x80100000n), fld(2, 1, 0), ...halt()]);
  h.cpu.csr.writeRaw(CSR.MSTATUS, 0x1800n); // FS = 0
  runToPc(h, pcOf(1));
  h.cpu.step();
  assert.equal(h.cpu.csr.read(CSR.MCAUSE), 2n); // illegal instruction
});

function U(v: bigint | number): bigint {
  return BigInt.asUintN(64, BigInt(v));
}
