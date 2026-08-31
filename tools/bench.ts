/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
/**
 * 性能基准：跑一段整数/访存密集的裸机循环，报告模拟速度（MIPS）。
 *
 * 运行：npm run bench
 */
import { addi, blt, li, lw, sd, sw } from './encoder.ts';
import { Machine, VIRT_KERNEL, VIRT_TEST } from '../src/machine.ts';

function bytes(words: number[]): Uint8Array {
  const b = new Uint8Array(words.length * 4);
  const dv = new DataView(b.buffer);
  words.forEach((w, i) => dv.setUint32(i * 4, w >>> 0, true));
  return b;
}

const ITER = 200000;

// 循环体：内存读、加法、内存写、计数、分支（5 条指令/迭代）
const program = bytes([
  ...li(1, VIRT_KERNEL + 0x100000n), // x1 = 数据区地址
  ...li(2, BigInt(ITER)), // x2 = 迭代次数
  ...li(3, 0x1234567n), // x3 = 常量（避免被优化掉）
  // loop:（此处相对 blt 偏移 -20 字节）
  lw(4, 1, 0), // 读内存
  addi(4, 4, 1), // 加法
  sd(1, 4, 0), // 写内存
  addi(2, 2, -1), // 计数
  blt(0, 2, -20), // 0 < x2 → 循环
  ...li(5, VIRT_TEST),
  ...li(6, 0x5555n),
  sw(5, 6, 0), // sifive_test：正常退出
]);

const machine = new Machine({ memSize: 16n * 1024n * 1024n, kernel: program });
const stats = machine.run({ maxInstructions: 100_000_000 });

if (!machine.cpu.halted) {
  process.stderr.write('基准程序未正常结束！\n');
  process.stderr.write(machine.dumpState() + '\n');
  process.exitCode = 1;
}

const mips = stats.instructions / stats.seconds / 1e6;
process.stdout.write(
  `\n基准结果：${stats.instructions} 条指令 / ${stats.seconds.toFixed(3)} s = ${mips.toFixed(2)} MIPS\n` +
    `（BigInt 数据通路、解释执行；TLB 命中 ${machine.cpu.mmu.stats.tlbHit} / 未命中 ${machine.cpu.mmu.stats.tlbMiss}）\n`,
);
