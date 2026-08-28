/**
 * 64-bit 位运算工具。
 *
 * 设计取舍：XLEN=64 的数据通路统一使用 `bigint`。
 *  - 优点：语义与硬件完全一致（无 2^53 精度陷阱），代码可读性高。
 *  - 代价：比 `number` 慢。若需要极限性能，可把热点路径改写成 hi/lo 两个
 *    32 位分量（本项目的 TLB / 取值路径已经做了 number 化优化）。
 */

/** 64 位无符号掩码 */
export const MASK64 = 0xffffffffffffffffn;
/** 低 32 位掩码 */
export const MASK32 = 0xffffffffn;
/** 2^63 */
export const SIGN_BIT64 = 0x8000000000000000n;
/** 2^31 */
export const SIGN_BIT32 = 0x80000000n;

/** 取低 64 位（无符号截断） */
export function u64(x: bigint): bigint {
  return x & MASK64;
}

/** 解释为有符号 64 位 */
export function s64(x: bigint): bigint {
  const v = x & MASK64;
  return v >= SIGN_BIT64 ? v - 0x10000000000000000n : v;
}

/** 取低 32 位 */
export function u32(x: bigint): bigint {
  return x & MASK32;
}

/** 解释为有符号 32 位后符号扩展到 64 位 */
export function s32(x: bigint): bigint {
  const v = x & MASK32;
  return v >= SIGN_BIT32 ? v - 0x100000000n : v;
}

/** 按给定位宽做符号扩展 */
export function sext(x: bigint, bits: number): bigint {
  const sign = 1n << BigInt(bits - 1);
  const v = x & ((1n << BigInt(bits)) - 1n);
  return v & sign ? v - (sign << 1n) : v;
}

/** 取 [hi:lo] 位（闭区间，从 0 开始） */
export function bits(x: bigint, hi: number, lo: number): bigint {
  return (x >> BigInt(lo)) & ((1n << BigInt(hi - lo + 1)) - 1n);
}

/** 快速取单比特（返回 0|1 的 number，热路径友好） */
export function bit(x: bigint, i: number): number {
  return Number((x >> BigInt(i)) & 1n);
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
  const s = BigInt(n & 63);
  return ((x << s) | (x >> (64n - s))) & MASK64;
}

/** 判断是否是 2 的幂次对齐 */
export function isAligned(x: bigint, size: number): boolean {
  return (x & BigInt(size - 1)) === 0n;
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
