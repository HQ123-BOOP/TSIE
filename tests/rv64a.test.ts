/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  amoadd_d,
  amoaddw,
  amomaxw,
  amoswapd,
  ld,
  lr_d,
  sc_d,
  sd,
  li,
} from '../tools/encoder.ts';
import { CSR, Exc } from '../src/cpu/csr.ts';
import { TEST_BASE, halt, makeCpu, pcOf, peek, runToPc } from './harness.ts';

const U = (v: bigint | number) => BigInt.asUintN(64, BigInt(v));

test('LR.D / SC.D 成功与失败', () => {
  const data = TEST_BASE + 0x100000n;
  const h = makeCpu([
    ...li(1, data),
    ...li(2, 0x1122334455667788n),
    sd(1, 2, 0),
    lr_d(3, 1), // 读回并建立保留集
    ...li(4, 0xaabbn),
    sc_d(5, 1, 4), // 应成功，返回 0
    sc_d(6, 1, 4), // 保留集已失效，返回 1
    ...halt(),
  ]);
  h.run(300);
  assert.equal(h.x(3), 0x1122334455667788n);
  assert.equal(h.x(5), 0n, '第一次 SC 应成功');
  assert.equal(h.x(6), 1n, '第二次 SC 应失败');
  assert.equal(peek(h.ram, data), 0xaabbn);
});

test('AMOADD.D / AMOSWAP.D / AMOMAX.W', () => {
  const data = TEST_BASE + 0x100000n;
  const h = makeCpu([
    ...li(1, data),
    ...li(2, 100n),
    sd(1, 2, 0),
    ...li(3, 5n),
    amoadd_d(4, 1, 3), // 返回旧值 100，内存变为 105
    ...li(5, 0n),
    amoswapd(6, 1, 5), // 返回 105，内存变为 0
    ...li(7, 0x7fffffffn),
    amomaxw(8, 1, 7), // 32 位有符号最大值比较
    ld(9, 1, 0),
    ...halt(),
  ]);
  h.run(400);
  assert.equal(h.x(4), 100n);
  assert.equal(h.x(6), 105n);
  assert.equal(h.x(8), 0n);
  assert.equal(h.x(9), 0x7fffffffn, 'AMOMAX.W 结果应按 32 位符号扩展');
});

test('AMOADD.W 按字操作并符号扩展', () => {
  const data = TEST_BASE + 0x100000n;
  const h = makeCpu([
    ...li(1, data),
    ...li(2, -1n),
    sd(1, 2, 0),
    ...li(3, 2n),
    amoaddw(4, 1, 3), // 低 32 位：-1 + 2 = 1
    ...halt(),
  ]);
  h.run(300);
  assert.equal(h.x(4), U(-1n), '返回旧值的 32 位符号扩展');
  assert.equal(peek(h.ram, data) & 0xffffffffn, 1n);
});

test('非对齐 AMO 触发 store-address-misaligned', () => {
  const setup = [...li(1, TEST_BASE + 0x100004n), ...li(2, 1n)];
  const h = makeCpu([...setup, amoadd_d(3, 1, 2), ...halt()]);
  runToPc(h, pcOf(setup.length)); // 停在 AMO 指令
  h.cpu.step();
  assert.equal(h.cpu.csr.read(CSR.MCAUSE), BigInt(Exc.StoreAddrMisaligned));
  assert.equal(h.cpu.csr.read(CSR.MTVAL), U(TEST_BASE + 0x100004n));
});

test('非对齐访存：trap 模式抛异常，slow 模式正常读写', () => {
  const addr = TEST_BASE + 0x100001n;
  const setup = [...li(1, addr), ...li(2, 0x4142n)];
  const trap = makeCpu([...setup, sd(1, 2, 0), ...halt()]);
  runToPc(trap, pcOf(setup.length));
  trap.cpu.step();
  assert.equal(trap.cpu.csr.read(CSR.MCAUSE), BigInt(Exc.StoreAddrMisaligned));

  const slow = makeCpu([...li(1, addr), ...li(2, 0x4142n), sd(1, 2, 0), ...halt()], {
    misaligned: 'slow',
  });
  slow.run(300);
  assert.equal(slow.cpu.halted, true);
  // 小端：0x42 在 addr，0x41 在 addr+1
  assert.equal(slow.ram.read(addr - TEST_BASE, 1), 0x42n);
  assert.equal(slow.ram.read(addr - TEST_BASE + 1n, 1), 0x41n);
});
