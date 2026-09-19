/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
// 实验：验证 README "路线1" 的核心假设 —— 64 位值用 **hi/lo 两个 32 位 number**
// 表示，相对 bigint 到底快多少？
//
// 做法：把热路径最常见的几种 64 位运算分别写成两份（bigint 版 / hi-lo 版），
// 跑同样的次数对比耗时。目的是**在投入大重构之前**先知道收益量级与代价
// （hi/lo 的代码复杂度明显更高，尤其移位和乘法）。
//
// 用法：npx tsx tools/bench-hilo.ts

const MASK64 = (1n << 64n) - 1n;
const N = 3_000_000; // 每种运算的迭代次数

// ---------------------------------------------------------------------------
// bigint 版（当前实现）
// ---------------------------------------------------------------------------
function bAdd(a: bigint, b: bigint): bigint {
  return (a + b) & MASK64;
}
function bSub(a: bigint, b: bigint): bigint {
  return (a - b) & MASK64;
}
function bSext32(x: bigint): bigint {
  const sign = 1n << 31n;
  const v = x & ((1n << 32n) - 1n);
  return v & sign ? v - (sign << 1n) : v;
}
function bShl(a: bigint, n: number): bigint {
  return (a << BigInt(n)) & MASK64;
}
function bShr(a: bigint, n: number): bigint {
  return (a >> BigInt(n)) & MASK64;
}
// 模块级常量：不能放在函数里每次重建 BigInt（我第一版就这么写，把这一项人为做慢了 20 倍）
const SIGN64 = 1n << 63n;
const WRAP64 = 1n << 64n;
function bCmpSigned(a: bigint, b: bigint): boolean {
  const sa = a & SIGN64 ? a - WRAP64 : a;
  const sb = b & SIGN64 ? b - WRAP64 : b;
  return sa < sb;
}
function bMulLo(a: bigint, b: bigint): bigint {
  return (a * b) & MASK64;
}

// ---------------------------------------------------------------------------
// hi/lo 版（路线1 提议的表示：两个 32 位 number，均按无符号看待）
// ---------------------------------------------------------------------------
function hAdd(ah: number, al: number, bh: number, bl: number): [number, number] {
  const l = al + bl;
  const carry = l > 0xffffffff ? 1 : 0;
  return [(ah + bh + carry) >>> 0, l >>> 0];
}
function hSub(ah: number, al: number, bh: number, bl: number): [number, number] {
  const l = al - bl;
  const borrow = l < 0 ? 1 : 0;
  return [(ah - bh - borrow) >>> 0, l >>> 0];
}
function hSext32(_ah: number, al: number): [number, number] {
  // 只看低 32 位：符号取自 al 的 bit31，高位整体置 0 或全 1
  return [(al & 0x80000000) !== 0 ? 0xffffffff : 0, al >>> 0];
}
function hShl(ah: number, al: number, n: number): [number, number] {
  // n 取 1..31；n===0 直接返回，n>=32 另走一支（这里只测常见的小移位）
  const lo = (al << n) >>> 0;
  const hi = (((ah << n) >>> 0) | (al >>> (32 - n))) >>> 0;
  return [hi, lo];
}
function hShr(ah: number, al: number, n: number): [number, number] {
  const hi = ah >>> n;
  const lo = ((al >>> n) | (ah << (32 - n))) >>> 0;
  return [hi, lo];
}
function hCmpSigned(ah: number, al: number, bh: number, bl: number): boolean {
  // 高 32 位按有符号比（|0 得到 32 位有符号），相等再比低位
  const sa = ah | 0;
  const sb = bh | 0;
  return sa !== sb ? sa < sb : al >>> 0 < bl >>> 0;
}
function hMulLo(ah: number, al: number, bh: number, bl: number): [number, number] {
  // 拆成 16 位半字做 32 位乘，避免中间值超过 2^53 丢精度
  const a0 = al & 0xffff;
  const a1 = al >>> 16;
  const b0 = bl & 0xffff;
  const b1 = bl >>> 16;
  // 只算低 64 位：高 32 位里来自 ah/bh 的那些项会溢出到 64 位以上，对低 64 位无贡献
  let lo = a0 * b0;
  let mid = a1 * b0 + a0 * b1; // < 2^33，精度安全
  lo = lo + ((mid & 0xffff) << 16);
  const carry = lo > 0xffffffff ? 1 : 0;
  const hi = (((mid >>> 16) + (a1 * b1) + (ah * bl >>> 0) + (al * bh >>> 0)) + carry) >>> 0;
  return [hi, lo >>> 0];
}

// ---------------------------------------------------------------------------
// 计时
// ---------------------------------------------------------------------------
interface Row {
  name: string;
  bigint: number;
  hilo: number;
}
const rows: Row[] = [];

/**
 * 计时。**必须让输入随迭代变化**：若用编译期常量，V8 会把 hi/lo 那一侧
 * 常量折叠掉（我第一版 cmp 测出 122x 就是这个原因），数字毫无意义。
 * 两边都从数组按 `i & 7` 取一次输入，代价对称且可忽略。
 */
function time(name: string, runBig: (i: number) => void, runHi: (i: number) => void): void {
  for (let i = 0; i < 200_000; i++) {
    runBig(i);
    runHi(i);
  }
  let t = performance.now();
  for (let i = 0; i < N; i++) runBig(i);
  const tb = performance.now() - t;
  t = performance.now();
  for (let i = 0; i < N; i++) runHi(i);
  const th = performance.now() - t;
  rows.push({ name, bigint: tb, hilo: th });
}

const A = 0x12345678_9abcdeffn;
const B = 0x00ff00ff_11223344n;
const AH = 0x12345678;
const AL = 0x9abcdeff;
const BH = 0x00ff00ff;
const BL = 0x11223344;
const SH = 7;

// 输入池：8 个不同取值，按 i&7 轮换，杜绝常量折叠
const BIGN: bigint[] = [];
const HH: number[] = [];
const LL: number[] = [];
for (let k = 0; k < 8; k++) {
  BIGN.push((A ^ BigInt(k * 0x01010101_01010101)) & MASK64);
  HH.push((AH ^ (k * 0x01010101)) >>> 0);
  LL.push((AL ^ (k * 0x10101010)) >>> 0);
}
let sinkB = 0n;
let sinkH = 0;

time('add', (i) => { sinkB ^= bAdd(BIGN[i & 7]!, B); }, (i) => { const [h, l] = hAdd(HH[i & 7]!, LL[i & 7]!, BH, BL); sinkH ^= h ^ l; });
time('sub', (i) => { sinkB ^= bSub(BIGN[i & 7]!, B); }, (i) => { const [h, l] = hSub(HH[i & 7]!, LL[i & 7]!, BH, BL); sinkH ^= h ^ l; });
time('sext32', (i) => { sinkB ^= bSext32(BIGN[i & 7]!); }, (i) => { const [h, l] = hSext32(HH[i & 7]!, LL[i & 7]!); sinkH ^= h ^ l; });
time('shl', (i) => { sinkB ^= bShl(BIGN[i & 7]!, SH); }, (i) => { const [h, l] = hShl(HH[i & 7]!, LL[i & 7]!, SH); sinkH ^= h ^ l; });
time('shr', (i) => { sinkB ^= bShr(BIGN[i & 7]!, SH); }, (i) => { const [h, l] = hShr(HH[i & 7]!, LL[i & 7]!, SH); sinkH ^= h ^ l; });
time('cmp(signed)', (i) => { if (bCmpSigned(BIGN[i & 7]!, B)) sinkB++; }, (i) => { if (hCmpSigned(HH[i & 7]!, LL[i & 7]!, BH, BL)) sinkH++; });
time('mul(low64)', (i) => { sinkB ^= bMulLo(BIGN[i & 7]!, B); }, (i) => { const [h, l] = hMulLo(HH[i & 7]!, LL[i & 7]!, BH, BL); sinkH ^= h ^ l; });

// 混合负载：更接近真实解释器里"一条指令"要做的几件事
time(
  '混合（add+sub+sext+shl+cmp）',
  (i) => {
    let x = BIGN[i & 7]!;
    x = bAdd(x, B);
    x = bSub(x, A);
    x = bSext32(x);
    x = bShl(x, SH);
    if (bCmpSigned(x, B)) sinkB++;
    sinkB ^= x;
  },
  (i) => {
    let h = HH[i & 7]!;
    let l = LL[i & 7]!;
    [h, l] = hAdd(h, l, BH, BL);
    [h, l] = hSub(h, l, AH, AL);
    [h, l] = hSext32(h, l);
    [h, l] = hShl(h, l, SH);
    if (hCmpSigned(h, l, BH, BL)) sinkH++;
    sinkH ^= h ^ l;
  },
);

console.log(`每种运算 ${N.toLocaleString()} 次，单位 ms（越小越好）\n`);
console.log(`${'运算'.padEnd(26)}${'bigint'.padStart(10)}${'hi/lo'.padStart(10)}${'倍率'.padStart(10)}`);
let totB = 0;
let totH = 0;
for (const r of rows) {
  if (!r.name.startsWith('混合')) {
    totB += r.bigint;
    totH += r.hilo;
  }
  console.log(
    `${r.name.padEnd(26)}${r.bigint.toFixed(0).padStart(10)}${r.hilo.toFixed(0).padStart(10)}` +
      `${(r.bigint / Math.max(0.0001, r.hilo)).toFixed(2).padStart(9)}x`,
  );
}
console.log('—'.repeat(56));
console.log(
  `${'单项合计（不含混合）'.padEnd(24)}${totB.toFixed(0).padStart(10)}${totH.toFixed(0).padStart(10)}` +
    `${(totB / Math.max(0.0001, totH)).toFixed(2).padStart(9)}x`,
);
console.log(`\n（防优化校验 sink: ${sinkB & 0xffn} / ${sinkH & 0xff}）`);
console.log('\n注：这只量化**算术本身**。真实收益还要扣掉 hi/lo 带来的额外开销：');
console.log('  · 取值/存值要拆装两个分量（寄存器数组要变成两条或对象池）');
console.log('  · 与 MMU/总线交互时要重新合成 64 位地址（那里仍是 bigint）');
console.log('  · 乘法/除法代码显著变长（上面 mul 就是例子）');
process.exit(0);
