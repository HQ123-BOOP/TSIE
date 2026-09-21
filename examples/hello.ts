/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
/**
 * 示例：用 Machine API 跑一个"Hello, RISC-V 64!"裸机程序。
 *
 * 程序先在 M 模式完成初始化，然后通过 mret 切到 S 模式，
 * 把字符逐个写进 NS16550 UART0 的 THR 寄存器，最后写 SiFive Test 正常退出。
 *
 * 注意：本示例**不走 SBI**。模拟器曾内建一个 SBI v0.2 固件，但已在
 * `refactor(sbi): remove built-in SBI firmware` 中移除 —— 现在要执行 SBI 调用
 * 必须自己挂外部 OpenSBI（`--bios`）。这个 demo 早先靠内建 SBI 的
 * console_putchar / shutdown，于是那次移除之后它就悄悄坏掉了：ECALL 陷入 M 模式
 * 后无人处理，既没有输出也不退出。现在改成直接驱动 UART，不依赖任何固件，
 * 只演示 Machine API 本身。
 *
 * 运行：npm run demo
 */
import {
  csrc,
  csrs,
  csrw,
  li,
  mret,
  sb,
  sw,
} from '../tools/encoder.ts';
import { CSR } from '../src/cpu/csr.ts';
import { Machine, VIRT_KERNEL, VIRT_TEST, VIRT_UART0 } from '../src/machine.ts';

const S_ENTRY = VIRT_KERNEL + 0x200n;

function bytes(words: number[]): Uint8Array {
  const b = new Uint8Array(words.length * 4);
  const dv = new DataView(b.buffer);
  words.forEach((w, i) => dv.setUint32(i * 4, w >>> 0, true));
  return b;
}

/** M 模式入口：设置 mepc/MPP 后 mret 进入 S 模式 */
const mstub = [
  ...li(5, S_ENTRY),
  csrw(CSR.MEPC, 5),
  ...li(6, 0x1800n), // MPP 掩码
  csrc(CSR.MSTATUS, 6),
  ...li(6, 0x800n), // MPP = S
  csrs(CSR.MSTATUS, 6),
  mret(),
];

/** S 模式：逐字符写 UART0 的 THR（偏移 0），然后写 SiFive Test 退出 */
const smode: number[] = [];
smode.push(...li(5, VIRT_UART0));
for (const ch of 'Hello, RISC-V 64! (TS emulator)\n') {
  smode.push(...li(6, BigInt(ch.charCodeAt(0))));
  smode.push(sb(5, 6, 0));
}
smode.push(...li(5, VIRT_TEST));
smode.push(...li(6, 0x5555n)); // 0x5555 = 正常退出
smode.push(sw(5, 6, 0));

const machine = new Machine({
  memSize: 8n * 1024n * 1024n,
  kernel: bytes(mstub),
});
machine.bus.writeBytes(S_ENTRY, bytes(smode));

const stats = machine.run({ maxInstructions: 100000 });

process.stderr.write(
  `\n[${stats.instructions} 条指令, ${stats.seconds.toFixed(3)}s, ${(stats.ips / 1e6).toFixed(2)} MIPS]\n` +
    `[退出原因: ${machine.exitReason}, 退出码: ${machine.exitCode}]\n`,
);
process.exitCode = machine.exitCode ?? 0;
