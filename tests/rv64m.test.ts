/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  div,
  divu,
  divuw,
  divw,
  mul,
  mulh,
  mulhsu,
  mulhu,
  mulw,
  rem,
  remu,
  remuw,
  remw,
  li,
} from '../tools/encoder.ts';
import { halt, makeCpu } from './harness.ts';

const U = (v: bigint | number) => BigInt.asUintN(64, BigInt(v));

test('MUL / MULH / MULHU / MULHSU', () => {
  const h = makeCpu([
    ...li(1, 0x100000000n), // 2^32
    ...li(2, 0x100000000n),
    mul(3, 1, 2), // 低 64 位 = 0
    mulh(4, 1, 2), // 有符号高位 = 1
    mulhu(5, 1, 2), // 无符号高位 = 1
    ...li(6, -1n),
    ...li(7, -1n),
    mul(8, 6, 7), // (-1)*(-1) = 1
    mulh(9, 6, 7), // 0
    mulhu(10, 6, 7), // 0xfffffffe
    mulhsu(11, 6, 7), // -1 * (2^64-1) → 高位 = -1
    ...halt(),
  ]);
  h.run(200);
  assert.equal(h.x(3), 0n);
  assert.equal(h.x(4), 1n);
  assert.equal(h.x(5), 1n);
  assert.equal(h.x(8), 1n);
  assert.equal(h.x(9), 0n);
  assert.equal(h.x(10), 0xfffffffffffffffen);
  assert.equal(h.x(11), U(-1n));
  assert.equal(h.cpu.halted, true);
});

test('DIV / REM 向零截断', () => {
  const h = makeCpu([
    ...li(1, -7n),
    ...li(2, 2n),
    div(3, 1, 2), // -3
    rem(4, 1, 2), // -1
    divu(5, 1, 2), // 无符号：(2^64-7)/2
    remu(6, 1, 2), // (2^64-7) % 2 = 1
    ...halt(),
  ]);
  h.run(200);
  assert.equal(h.x(3), U(-3n));
  assert.equal(h.x(4), U(-1n));
  assert.equal(h.x(5), ((1n << 64n) - 7n) / 2n);
  assert.equal(h.x(6), 1n);
});

test('除零与溢出', () => {
  const h = makeCpu([
    ...li(1, 7n),
    ...li(2, 0n),
    div(3, 1, 2), // -1
    divu(4, 1, 2), // 2^64-1
    rem(5, 1, 2), // 7
    remu(6, 1, 2), // 7
    ...li(7, -9223372036854775808n), // INT64_MIN
    ...li(8, -1n),
    div(9, 7, 8), // 溢出：仍为 INT64_MIN
    rem(10, 7, 8), // 0
    ...halt(),
  ]);
  h.run(300);
  assert.equal(h.x(3), U(-1n));
  assert.equal(h.x(4), (1n << 64n) - 1n);
  assert.equal(h.x(5), 7n);
  assert.equal(h.x(6), 7n);
  assert.equal(h.x(9), 1n << 63n);
  assert.equal(h.x(10), 0n);
});

test('MULW / DIVW / REMW / DIVUW / REMUW', () => {
  const h = makeCpu([
    ...li(1, 0x100000001n),
    ...li(2, 3n),
    mulw(3, 1, 2), // (1 * 3) 低 32 位 = 3
    ...li(4, -7n),
    ...li(5, 2n),
    divw(6, 4, 5), // -3 符号扩展
    remw(7, 4, 5), // -1
    divuw(8, 4, 5), // 无符号 32 位：(2^32-7)/2
    remuw(9, 4, 5),
    ...halt(),
  ]);
  h.run(300);
  assert.equal(h.x(3), 3n);
  assert.equal(h.x(6), U(-3n));
  assert.equal(h.x(7), U(-1n));
  assert.equal(h.x(8), BigInt(((0xffffffff - 7 + 1) >>> 1) | 0) & 0xffffffffn);
  assert.equal(h.x(9), 1n);
});
