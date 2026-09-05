/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
// UART 接收溢出队列回归：FIFO(64B) 满后溢出到内部队列，guest 读取时
// 回流——任意长度输入零丢失（曾因超 64 字节静默丢尾，导致注入的长
// 命令从未执行）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { Uart } from '../src/dev/uart.ts';

/** 从串口读 n 个字节 */
function readAll(uart: Uart, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) {
    assert.notEqual(BigInt(uart.lsr) & 1n, 0n, `第 ${i} 字节前 LSR.DR 应置位`);
    s += String.fromCharCode(Number(uart.read(0n, 1)));
  }
  return s;
}

test('uart：超 64 字节的输入完整保留（曾静默丢尾）', () => {
  const uart = new Uart();
  const cmd = 'wget -O /tmp/t.html http://www.baidu.com && head -c 300 /tmp/t.html\n'; // 69 字节
  assert.ok(cmd.length > 64, '用例本身应超过 FIFO 容量');
  uart.pushString(cmd);
  assert.equal(readAll(uart, cmd.length), cmd, '69 字节输入应一字不差读回');
  // 排空后 DR 应清零
  assert.equal(BigInt(uart.lsr) & 1n, 0n, '排空后 LSR.DR 应清零');
});

test('uart：300 字节长输入顺序保持', () => {
  const uart = new Uart();
  const data = Array.from({ length: 300 }, (_, i) => String.fromCharCode(32 + (i % 95))).join('');
  uart.pushString(data);
  assert.equal(readAll(uart, 300), data);
});

test('uart：FCR FIFO 复位同时清空溢出队列', () => {
  const uart = new Uart();
  uart.pushString('x'.repeat(100)); // 64 进 FIFO + 36 进溢出队列
  uart.write(2n, 0x07n); // FCR：使能并复位 FIFO
  uart.pushString('ok\n');
  assert.equal(readAll(uart, 3), 'ok\n', '复位后应只收到复位之后的输入');
  assert.equal(BigInt(uart.lsr) & 1n, 0n);
});

test('uart：中断线在读空后撤销、回流期间保持', () => {
  let irq = false;
  const uart = new Uart({ irq: (l) => (irq = l) });
  uart.write(1n, 0x01n); // IER：使能接收中断
  uart.pushString('y'.repeat(100));
  assert.equal(irq, true, '有数据时应挂中断');
  // 读若干字节（FIFO 回流，队列仍有积压）
  for (let i = 0; i < 50; i++) uart.read(0n, 1);
  assert.equal(irq, true, '队列未排空前中断应保持');
  readAll(uart, 50); // 读完全部
  assert.equal(irq, false, '全部读完后中断应撤销');
});
