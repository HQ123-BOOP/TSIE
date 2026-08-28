/** 生成一个纯 S 模式的 SBI 调用内核（配合 OpenSBI fw_jump 使用） */
import { mkdirSync, writeFileSync } from 'node:fs';
import { ecall, li } from './encoder.ts';

function bytes(words: number[]): Uint8Array {
  const b = new Uint8Array(words.length * 4);
  const dv = new DataView(b.buffer);
  words.forEach((w, i) => dv.setUint32(i * 4, w >>> 0, true));
  return b;
}

const code: number[] = [];
for (const ch of 'Hello from S-mode via OpenSBI!\n') {
  code.push(...li(17, 1n)); // a7 = legacy console_putchar
  code.push(...li(10, BigInt(ch.charCodeAt(0))));
  code.push(ecall());
}
code.push(...li(17, 8n)); // a7 = legacy shutdown
code.push(ecall());

mkdirSync(new URL('../tmp/', import.meta.url), { recursive: true });
writeFileSync(new URL('../tmp/hello-sbi.bin', import.meta.url), bytes(code));
console.log('written tmp/hello-sbi.bin');
