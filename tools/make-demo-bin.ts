/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
/** 生成 CLI 冒烟测试用的裸机镜像（M 模式 stub + S 模式 SBI 打印） */
import { writeFileSync } from 'node:fs';
import { csrc, csrs, csrw, ecall, li, mret } from '../tools/encoder.ts';
import { CSR } from '../src/cpu/csr.ts';
import { VIRT_KERNEL } from '../src/machine.ts';

function bytes(words: number[]): Uint8Array {
  const b = new Uint8Array(words.length * 4);
  const dv = new DataView(b.buffer);
  words.forEach((w, i) => dv.setUint32(i * 4, w >>> 0, true));
  return b;
}

const S_ENTRY = VIRT_KERNEL + 0x200n;
const stub = [
  ...li(5, S_ENTRY),
  csrw(CSR.MEPC, 5),
  ...li(6, 0x1800n),
  csrc(CSR.MSTATUS, 6),
  ...li(6, 0x800n),
  csrs(CSR.MSTATUS, 6),
  mret(),
];
const smode: number[] = [];
for (const ch of 'CLI smoke test OK\n') {
  smode.push(...li(17, 1n));
  smode.push(...li(10, BigInt(ch.charCodeAt(0))));
  smode.push(ecall());
}
smode.push(...li(17, 8n));
smode.push(ecall());

// 合并成一个镜像：stub 之后紧跟 S 模式代码（S_ENTRY 对齐到 0x200）
const stubBytes = bytes(stub);
const smodeBytes = bytes(smode);
const img = new Uint8Array(0x200 + smodeBytes.length);
img.set(stubBytes, 0);
img.set(smodeBytes, 0x200);
writeFileSync(new URL('../tmp/hello.bin', import.meta.url), img);
console.log('written', img.length, 'bytes; S_ENTRY =', S_ENTRY.toString(16));
