/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
// Zba/Zbb/Zbs 位运算扩展：逐指令语义测试（经 makeCpu 全流程执行）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { halt } from './harness.ts';
import {
  andn,
  bclr,
  bext,
  binv,
  bset,
  bseti,
  bexti,
  bclri,
  binvi,
  clz,
  clzw,
  cpop,
  cpopw,
  ctz,
  ctzw,
  li,
  max_,
  maxu,
  min_,
  minu,
  orn,
  orcb,
  rev8,
  rol,
  rolw,
  ror,
  rorw,
  roriw,
  slliuw,
  sexth,
  sextb,
  sh1add,
  sh2add,
  sh3add,
  sh1adduw,
  sh2adduw,
  sh3adduw,
  adduw,
  zexth,
  xnor,
} from '../tools/encoder.ts';
import { makeCpu } from './harness.ts';

/** 设置 x5/x6 后执行一条指令，断言 rd 结果 */
function exec1(instr: number | number[], a: bigint, b: bigint, rd = 7): bigint {
  const prog = [...li(5, a), ...li(6, b), ...(Array.isArray(instr) ? instr : [instr]), ...halt()];
  const h = makeCpu(prog);
  h.run(20);
  return h.cpu.x[rd];
}

test('Zbb：andn/orn/xnor', () => {
  const a = 0xf0f0f0f0f0f0f0f0n, b = 0x0f0f00ff00ff00ffn;
  assert.equal(exec1(andn(7, 5, 6), a, b), a & ~b & 0xffffffffffffffffn);
  assert.equal(exec1(orn(7, 5, 6), a, b), a | ~b & 0xffffffffffffffffn);
  assert.equal(exec1(xnor(7, 5, 6), 0xffn, 0x0fn), ~(0xffn ^ 0x0fn) & 0xffffffffffffffffn);
});

test('Zbb：clz/ctz/cpop（含 0 的 64 位边界）', () => {
  assert.equal(exec1(clz(7, 5), 1n, 0n), 63n);
  assert.equal(exec1(clz(7, 5), 0n, 0n), 64n);
  assert.equal(exec1(ctz(7, 5), 1n << 40n, 0n), 40n);
  assert.equal(exec1(ctz(7, 5), 0n, 0n), 64n);
  assert.equal(exec1(cpop(7, 5), 0x0101010101010101n, 0n), 8n);
  assert.equal(exec1(cpop(7, 5), 0n, 0n), 0n);
});

test('Zbb：min/max/minu/maxu 有符号与无符号', () => {
  const neg = 0xffffffffffffff00n, pos = 0x10n;
  assert.equal(exec1(min_(7, 5, 6), neg, pos), neg); // 有符号：负 < 正
  assert.equal(exec1(max_(7, 5, 6), neg, pos), pos);
  assert.equal(exec1(minu(7, 5, 6), neg, pos), pos); // 无符号：大数 > 小数
  assert.equal(exec1(maxu(7, 5, 6), neg, pos), neg);
});

test('Zbb：sext.b/sext.h 符号扩展', () => {
  assert.equal(exec1(sextb(7, 5), 0x80n, 0n), 0xffffffffffffff80n);
  assert.equal(exec1(sextb(7, 5), 0x7fn, 0n), 0x7fn);
  assert.equal(exec1(sexth(7, 5), 0x8000n, 0n), 0xffffffffffff8000n);
  assert.equal(exec1(sexth(7, 5), 0x7fffn, 0n), 0x7fffn);
});

test('Zbb：rol/ror（含 n=0 与 n≥64 取模）', () => {
  const v = 0xabcd1234567890efn;
  assert.equal(exec1(rol(7, 5, 6), v, 0n), v);
  assert.equal(exec1(rol(7, 5, 6), v, 4n), ((v << 4n) | (v >> 60n)) & 0xffffffffffffffffn);
  assert.equal(exec1(ror(7, 5, 6), v, 4n), ((v >> 4n) | (v << 60n)) & 0xffffffffffffffffn);
  // shamt 只取低 6 位：rol 68 ≡ rol 4
  assert.equal(exec1(rol(7, 5, 6), v, 68n), exec1(rol(7, 5, 6), v, 4n));
});

test('Zbs：bset/bclr/binv/bext 与立即数形态', () => {
  const v = 0xf0n;
  assert.equal(exec1(bset(7, 5, 6), v, 0n), 0xf1n);
  assert.equal(exec1(bset(7, 5, 6), v, 4n), 0xf0n); // 已置位不变
  assert.equal(exec1(bclr(7, 5, 6), v, 4n), 0xe0n);
  assert.equal(exec1(binv(7, 5, 6), v, 4n), 0xe0n);
  assert.equal(exec1(bext(7, 5, 6), v, 4n), 1n);
  assert.equal(exec1(bext(7, 5, 6), v, 0n), 0n);
  // 立即数形态：shamt 取 imm[5:0]
  assert.equal(exec1(bseti(7, 5, 1), v, 0n), 0xf2n);
  assert.equal(exec1(bclri(7, 5, 4), v, 0n), 0xe0n);
  assert.equal(exec1(binvi(7, 5, 7), v, 0n), 0xf0n ^ 0x80n);
  assert.equal(exec1(bexti(7, 5, 7), v, 0n), 1n);
});

test('Zba：sh1add/sh2add/sh3add', () => {
  assert.equal(exec1(sh1add(7, 5, 6), 0x100n, 0x23n), 0x223n);
  assert.equal(exec1(sh2add(7, 5, 6), 0x100n, 0x23n), 0x423n);
  assert.equal(exec1(sh3add(7, 5, 6), 0x100n, 0x23n), 0x823n);
});

test('Zba：adduw/slliuw/zexth（*.uw 结果 64 位宽，不符号扩展）', () => {
  const big = 0xffffffff00000000n; // 高位字
  // add.uw：只取 rs1 低 32 位（零扩展）+ rs2，64 位结果
  assert.equal(exec1(adduw(7, 5, 6), big, 0x10n), 0x10n);
  assert.equal(exec1(adduw(7, 5, 6), 0x10n, 0x20n), 0x30n);
  // slli.uw：同样只移低 32 位，结果不截断不符号扩展
  assert.equal(exec1(slliuw(7, 5, 4), 0x80000001n, 0n), 0x800000010n); // *.uw 结果不截断
  // zext.h：取低 16 位
  assert.equal(exec1(zexth(7, 5), 0x123456789abcdefn, 0n), 0xcdefn);
});

test('Zba：sh1add.uw 等 *.uw 变体', () => {
  const big = 0xffffffff00000100n;
  assert.equal(exec1(sh1adduw(7, 5, 6), big, 0x5n), 0x205n);
  assert.equal(exec1(sh2adduw(7, 5, 6), big, 0x5n), 0x405n);
  assert.equal(exec1(sh3adduw(7, 5, 6), big, 0x5n), 0x805n);
});

test('Zbb 字半宽：clzw/ctzw/cpopw', () => {
  assert.equal(exec1(clzw(7, 5), 1n, 0n), 31n);
  assert.equal(exec1(clzw(7, 5), 0n, 0n), 32n);
  assert.equal(exec1(ctzw(7, 5), 1n << 20n, 0n), 20n);
  assert.equal(exec1(ctzw(7, 5), 0n, 0n), 32n);
  assert.equal(exec1(cpopw(7, 5), 0x00000000ffffffffn, 0n), 32n); // 只看低 32 位
  assert.equal(exec1(cpopw(7, 5), 0xffffffff00000000n, 0n), 0n);
});

test('Zbb 字半宽：rolw/rorw/roriw（*W 符号扩展）', () => {
  const v = 0x80000001n;
  // rolw 1 位：低 32 位循环 → 0x00000003
  assert.equal(exec1(rolw(7, 5, 6), v, 1n), 3n);
  // rorw 1 位：0xC0000000 → 符号扩展为负
  const r = exec1(rorw(7, 5, 6), v, 1n);
  assert.equal(r, 0xffffffffc0000000n);
  assert.equal(exec1(roriw(7, 5, 0), v, 0n), 0xffffffff80000001n);
  // shamt 只取低 5 位
  assert.equal(exec1(rolw(7, 5, 6), v, 33n), exec1(rolw(7, 5, 6), v, 1n));
});

test('misa 应上报 B 位（bit1）', () => {
  const h = makeCpu([...halt()]);
  // misa 只读 CSR：经 csr.read 读出
  const misa = h.cpu.csr.read(0x301 as never);
  assert.equal((misa! & 0x2n) !== 0n, true, 'misa.B 应置位');
  assert.equal((misa! & 0x1n) !== 0n, true, 'misa.A 保持');
});

test('Zbb：orc.b（非零字节展开为 0xff）', () => {
  // 0x00 → 0x00；每个非零字节 → 0xff
  assert.equal(exec1(orcb(7, 5), 0x0102030405060708n, 0n), 0xffffffffffffffffn);
  assert.equal(exec1(orcb(7, 5), 0x00ff00ee00120034n, 0n), 0x00ff00ff00ff00ffn);
  assert.equal(exec1(orcb(7, 5), 0n, 0n), 0n);
  // 边界：0x80（最高位字节）
  assert.equal(exec1(orcb(7, 5), 0x8000000000000000n, 0n), 0xff00000000000000n);
});

test('Zbb：rev8（64 位字节序反转）', () => {
  assert.equal(exec1(rev8(7, 5), 0x0123456789abcdefn, 0n), 0xefcdab8967452301n);
  assert.equal(exec1(rev8(7, 5), 0x00000000000000ffn, 0n), 0xff00000000000000n);
  assert.equal(exec1(rev8(7, 5), 0n, 0n), 0n);
  // 与 RV32 rev8.w 不同：RV64 是完整 8 字节反转
  assert.equal(exec1(rev8(7, 5), 0x1122334455667788n, 0n), 0x8877665544332211n);
});
