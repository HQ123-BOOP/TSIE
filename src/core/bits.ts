/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
/**
 * 64-bit 位运算工具。
 *
 * 设计取舍：XLEN=64 的数据通路统一使用 `bigint`。
 *  - 优点：语义与硬件完全一致（无 2^53 精度陷阱），代码可读性高。
 *  - 代价：比 `number` 慢。若需要极限性能，可把热点路径改写成 hi/lo 两个
 *    32 位分量（本项目的 TLB / 取值路径已经做了 number 化优化）。
 *
 * 热路径约定：**这里绝不现场构造 BigInt 常量**。
 * 旧版 `sext()` 在函数体内写 `1n << BigInt(bits - 1)`，每次调用要造 3 个 BigInt
 * （还有一次 `BigInt(bits - 1)` 转换）—— profile 里它占 5.59% 自身耗时。
 * 现在 2 的幂、掩码、移位量、对齐掩码全部查下面的预计算表，
 * 每次调用只剩必要的位运算本身。
 */

/** 64 位无符号掩码 */
export const MASK64 = 0xffffffffffffffffn;
/** 低 32 位掩码 */
export const MASK32 = 0xffffffffn;
/** 2^63 */
export const SIGN_BIT64 = 0x8000000000000000n;
/** 2^31 */
export const SIGN_BIT32 = 0x80000000n;

// ---------------------------------------------------------------------------
// 预计算表（模块级常量，热路径只查表）
// ---------------------------------------------------------------------------

/** POW[i] = 2^i，i ∈ [0, 64] */
const POW: readonly bigint[] = (() => {
  const t = new Array<bigint>(65);
  let v = 1n;
  for (let i = 0; i <= 64; i++) {
    t[i] = v;
    v <<= 1n;
  }
  return t;
})();

/** MASK[i] = 2^i - 1（低 i 位全 1），i ∈ [0, 64] */
const MASK: readonly bigint[] = POW.map((p) => p - 1n);

/** BigInt 形式的移位量：BigInt 移位运算符的右操作数必须是 BigInt */
const SHIFT: readonly bigint[] = POW.slice(0, 64).map((_, i) => BigInt(i));

/** 小整数的 BigInt 形式（对齐掩码等），覆盖 0..63 */
const SMALL: readonly bigint[] = (() => {
  const t = new Array<bigint>(64);
  for (let i = 0; i < 64; i++) t[i] = BigInt(i);
  return t;
})();

/** 2^64（s64 的还原基数） */
const WRAP64 = POW[64]!;
/** 2^32（s32 的还原基数） */
const WRAP32 = POW[32]!;

// ---------------------------------------------------------------------------

/** 取低 64 位（无符号截断） */
export function u64(x: bigint): bigint {
  return x & MASK64;
}

/** 解释为有符号 64 位 */
export function s64(x: bigint): bigint {
  const v = x & MASK64;
  return v >= SIGN_BIT64 ? v - WRAP64 : v;
}

/** 取低 32 位 */
export function u32(x: bigint): bigint {
  return x & MASK32;
}

/** 解释为有符号 32 位后符号扩展到 64 位 */
export function s32(x: bigint): bigint {
  const v = x & MASK32;
  return v >= SIGN_BIT32 ? v - WRAP32 : v;
}

/** 按给定位宽做符号扩展 */
export function sext(x: bigint, bits: number): bigint {
  // v - (sign << 1) 即 v - 2^bits，2^bits 与符号位都查表
  const v = x & MASK[bits]!;
  return v & POW[bits - 1]! ? v - POW[bits]! : v;
}

/** 取 [hi:lo] 位（闭区间，从 0 开始） */
export function bits(x: bigint, hi: number, lo: number): bigint {
  return (x >> SHIFT[lo]!) & MASK[hi - lo + 1]!;
}

/** 快速取单比特（返回 0|1 的 number，热路径友好） */
export function bit(x: bigint, i: number): number {
  return x & POW[i]! ? 1 : 0;
}

/** 把 bigint 转成 number（仅当值在安全范围内使用） */
export function toNum(x: bigint): number {
  return Number(x);
}

/** 立即数拼接：I-type */
export function immI(inst: number): bigint {
  return sext(BigInt(inst >> 20), 12);
}

/** 立即数拼接：S-type */
export function immS(inst: number): bigint {
  const hi = (inst >> 25) & 0x7f;
  const lo = (inst >> 7) & 0x1f;
  return sext(BigInt((hi << 5) | lo), 12);
}

/** 立即数拼接：B-type */
export function immB(inst: number): bigint {
  const b12 = (inst >> 31) & 1;
  const b10_5 = (inst >> 25) & 0x3f;
  const b4_1 = (inst >> 8) & 0xf;
  const b11 = (inst >> 7) & 1;
  const v = (b12 << 12) | (b11 << 11) | (b10_5 << 5) | (b4_1 << 1);
  return sext(BigInt(v), 13);
}

/** 立即数拼接：U-type */
export function immU(inst: number): bigint {
  return sext(BigInt(inst & 0xfffff000) >> 0n, 32) & MASK64;
}

/** 立即数拼接：J-type */
export function immJ(inst: number): bigint {
  const b20 = (inst >> 31) & 1;
  const b10_1 = (inst >> 21) & 0x3ff;
  const b11 = (inst >> 20) & 1;
  const b19_12 = (inst >> 12) & 0xff;
  const v = (b20 << 20) | (b19_12 << 12) | (b11 << 11) | (b10_1 << 1);
  return sext(BigInt(v), 21);
}

/** 循环左移（用于 CRC 之类，暂未使用，保留工具） */
export function rol64(x: bigint, n: number): bigint {
  const s = SHIFT[n & 63]!;
  return ((x << s) | (x >> (64n - s))) & MASK64;
}

/** 判断是否是 2 的幂次对齐 */
export function isAligned(x: bigint, size: number): boolean {
  return (x & SMALL[size - 1]!) === 0n;
}

/** 向上对齐到 size（size 必须是 2 的幂） */
export function alignUp(x: bigint, size: bigint): bigint {
  return (x + size - 1n) & ~(size - 1n);
}

/** 向下对齐 */
export function alignDown(x: bigint, size: bigint): bigint {
  return x & ~(size - 1n);
}

/** 十六进制打印（便于调试） */
export function hex(x: bigint, width = 16): string {
  return '0x' + (x & MASK64).toString(16).padStart(width, '0');
}
