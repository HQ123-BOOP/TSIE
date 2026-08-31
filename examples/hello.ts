/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
/**
 * 示例：用 Machine API 跑一个"Hello, RISC-V 64!"裸机程序。
 *
 * 程序先在 M 模式完成初始化，然后通过 mret 切到 S 模式，
 * 用内建 SBI 的 console_putchar 打印字符串，最后调用 SBI shutdown 正常退出。
 *
 * 运行：npm run demo
 */
import {
  csrc,
  csrs,
  csrw,
  ecall,
  li,
  mret,
  sw,
} from '../tools/encoder.ts';
import { CSR } from '../src/cpu/csr.ts';
import { Machine, VIRT_KERNEL, VIRT_TEST } from '../src/machine.ts';

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

/** S 模式：通过 SBI 打印，然后关机 */
const smode: number[] = [];
for (const ch of 'Hello, RISC-V 64! (TS emulator)\n') {
  smode.push(...li(17, 1n)); // a7 = legacy console_putchar
  smode.push(...li(10, BigInt(ch.charCodeAt(0))));
  smode.push(ecall());
}
smode.push(...li(17, 8n)); // a7 = legacy shutdown
smode.push(ecall());

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
