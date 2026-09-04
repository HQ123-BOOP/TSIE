/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { GoldfishRtc } from '../src/dev/rtc.ts';
import { Machine } from '../src/machine.ts';

test('goldfish-rtc：先读 TIME_HIGH 再读 TIME_LOW（内核 rtc-goldfish.c 的顺序）', () => {
  const rtc = new GoldfishRtc();
  const hi = rtc.read(0x04n, 4);
  const lo = rtc.read(0x00n, 4);
  const ns = (hi << 32n) | lo;
  const ms = Number(ns / 1_000_000n);
  assert.ok(Math.abs(ms - Date.now()) < 5000, `RTC 时间应接近真实墙钟: ${ms} vs ${Date.now()}`);
});

test('goldfish-rtc：先读 TIME_LOW 再读 TIME_HIGH 也一致', () => {
  const rtc = new GoldfishRtc();
  const lo = rtc.read(0x00n, 4);
  const hi = rtc.read(0x04n, 4);
  const ns = (hi << 32n) | lo;
  const ms = Number(ns / 1_000_000n);
  assert.ok(Math.abs(ms - Date.now()) < 5000);
});

test('goldfish-rtc：闹钟寄存器读 0 / 写无副作用', () => {
  const rtc = new GoldfishRtc();
  assert.equal(rtc.read(0x14n, 4), 0n); // ALARM_STATUS
  rtc.write(0x08n, 0xffffffffn, 4); // ALARM_LOW
  rtc.write(0x10n, 1n, 4); // CLEAR_INTERRUPT
  assert.equal(rtc.read(0x14n, 4), 0n);
});

test('goldfish-rtc：Machine DTB 含 goldfish-rtc 节点（0x101000 / IRQ 11）', () => {
  const m = new Machine({ memSize: 16n * 1024n * 1024n });
  const dtb = m.generateDtb('console=ttyS0');
  const s = Buffer.from(dtb).toString('latin1');
  assert.ok(s.includes('rtc@101000'), 'DTB 应包含 rtc@101000 节点');
  assert.ok(s.includes('google,goldfish-rtc'), 'compatible 应为 google,goldfish-rtc');
});
