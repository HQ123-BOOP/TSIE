import { MASK64, SIGN_BIT64 } from '../core/bits.ts';

/** 浮点异常标志（fcsr 低 5 位） */
export const FFLAG = { NX: 0x01, UF: 0x02, OF: 0x04, DZ: 0x08, NV: 0x10 } as const;

/** 舍入模式 */
export const RM = { RNE: 0, RTZ: 1, RDN: 2, RUP: 3, RMM: 4, DYN: 7 } as const;

const buf = new ArrayBuffer(8);
const dv = new DataView(buf);
const f32v = new Float32Array(buf);
const f64v = new Float64Array(buf);
const u32v = new Uint32Array(buf);
const u64v = new BigUint64Array(buf);

const F32_QUIET_NAN = 0x7fc00000;
const F64_QUIET_NAN = 0x7ff8000000000000n;
const F32_MIN_NORMAL = 1.1754943508222875e-38;
const F64_MIN_NORMAL = 2.2250738585072014e-308;

/** 32 位浮点结果装箱为 64 位寄存器值（高位全 1） */
export function f32Box(v: number): bigint {
  f32v[0] = v;
  return BigInt(u32v[0]) | 0xffffffff00000000n;
}

/** 从寄存器值读取 32 位浮点；非装箱 NaN 视为 canonical NaN */
export function unboxF32(bits: bigint): number {
  if (((bits >> 32n) & 0xffffffffn) !== 0xffffffffn) {
    u32v[0] = F32_QUIET_NAN;
    return f32v[0];
  }
  u32v[0] = Number(bits & 0xffffffffn);
  return f32v[0];
}

export function bitsToF64(bits: bigint): number {
  u64v[0] = bits & MASK64;
  return f64v[0];
}

export function f64Box(v: number): bigint {
  f64v[0] = v;
  return u64v[0];
}

function bits64(v: number): bigint {
  f64v[0] = v;
  return u64v[0];
}

function nextUp(x: number): number {
  if (Number.isNaN(x) || !Number.isFinite(x)) return x;
  const b = bits64(x);
  return bitsToF64((b & SIGN_BIT64) === 0n ? b + 1n : b - 1n);
}

function nextDown(x: number): number {
  if (Number.isNaN(x) || !Number.isFinite(x)) return x;
  const b = bits64(x);
  return bitsToF64((b & SIGN_BIT64) === 0n ? b - 1n : b + 1n);
}

/**
 * 按 RISC-V 舍入模式把双精度中间结果舍入到目标精度。
 * 返回的 number 已是目标精度可表示的值。
 */
export function roundResult(v: number, single: boolean, rm: number): number {
  if (Number.isNaN(v) || !Number.isFinite(v)) return v;
  let r = single ? Math.fround(v) : v;

  if (r === v) return r;
  switch (rm) {
    case RM.RNE:
      return r;
    case RM.RTZ:
      return Math.abs(r) > Math.abs(v) ? (single ? Math.fround(nextDown(r)) : nextDown(r)) : r;
    case RM.RDN:
      return r > v ? (single ? Math.fround(nextDown(r)) : nextDown(r)) : r;
    case RM.RUP:
      return r < v ? (single ? Math.fround(nextUp(r)) : nextUp(r)) : r;
    case RM.RMM: {
      // 向零截断，然后比较两侧距离，平局时取远离零的一侧
      const toward = single ? Math.fround(Math.trunc(v)) : Math.trunc(v);
      const away = single ? Math.fround(v > 0 ? nextUp(toward) : nextDown(toward)) : v > 0 ? nextUp(toward) : nextDown(toward);
      const dToward = Math.abs(v - toward);
      const dAway = Math.abs(away - v);
      return dAway < dToward ? away : toward;
    }
    default:
      return r;
  }
}

export interface FpFlags {
  flags: number;
}

/** 根据运算结果与操作数推断需要置起的异常标志 */
export function flagsForResult(
  exact: number,
  result: number,
  single: boolean,
  flags: number,
): number {
  let f = flags;
  if (Number.isNaN(exact) || !Number.isFinite(exact)) return f & 0x1f;
  if (!Number.isFinite(result)) {
    f |= FFLAG.OF | FFLAG.NX;
  } else if (result !== exact) {
    f |= FFLAG.NX;
    const minNormal = single ? F32_MIN_NORMAL : F64_MIN_NORMAL;
    if (result !== 0 && Math.abs(result) < minNormal) f |= FFLAG.UF;
  }
  return f & 0x1f;
}

/**
 * FCLASS 指令：从原始位模式分类，返回 10 位掩码。
 * 位序（RISC-V 规范）：
 *   0 -∞  1 负规格数  2 负非规格数  3 -0  4 +0  5 正非规格数  6 正规格数  7 +∞  8 sNaN  9 qNaN
 */
export function fclassOfBits(bits: bigint, single: boolean): number {
  const raw = single ? bits & 0xffffffffn : bits & MASK64;
  const signPos = single ? 31n : 63n;
  const expBits = single ? 8 : 11;
  const mantBits = single ? 23n : 52n;
  const sign = (raw >> signPos) & 1n;
  const exp = (raw >> mantBits) & ((1n << BigInt(expBits)) - 1n);
  const mant = raw & ((1n << mantBits) - 1n);
  const expAll = (1n << BigInt(expBits)) - 1n;

  if (exp === expAll) {
    if (mant === 0n) return sign ? 0x001 : 0x080; // ±∞
    // 尾数最高位为 1 → quiet NaN
    return (mant >> (mantBits - 1n)) & 1n ? 0x200 : 0x100;
  }
  if (exp === 0n) {
    if (mant === 0n) return sign ? 0x008 : 0x010; // ±0
    return sign ? 0x004 : 0x020; // 非规格数
  }
  return sign ? 0x002 : 0x040; // 规格数
}

/** 浮点比较（FEQ / FLT / FLE），处理 NaN */
export function fcmpFlags(a: number, b: number): number {
  return Number.isNaN(a) || Number.isNaN(b) ? FFLAG.NV : 0;
}

/** FMIN / FMAX：按 RISC-V 规则的 NaN 传播 */
export function fminMax(isMax: boolean, a: number, b: number): number {
  if (Number.isNaN(a) && Number.isNaN(b)) return NaN;
  if (Number.isNaN(a)) return b;
  if (Number.isNaN(b)) return a;
  if (a === 0 && b === 0) {
    const as = Object.is(a, -0);
    const bs = Object.is(b, -0);
    if (as !== bs) return isMax ? (as ? b : a) : as ? a : b;
    return a;
  }
  return isMax ? Math.max(a, b) : Math.min(a, b);
}

/** 生成 canonical NaN */
export function canonicalNaN(single: boolean): bigint {
  return single ? f32Box(NaN) : F64_QUIET_NAN;
}

/** 从寄存器位模式构造 float（用于 FSGNJ 等直接操作位模式的指令） */
export function rawF32(bits: bigint): number {
  u32v[0] = Number(bits & 0xffffffffn);
  return f32v[0];
}

export { dv };
