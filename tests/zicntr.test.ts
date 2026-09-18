/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
// Zicntr：cycle / time / instret 三个基础计数器 + counteren 门控。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addi, csrr, csrw, li } from '../tools/encoder.ts';
import { CSR, Exc, Priv } from '../src/cpu/csr.ts';
import { halt, makeCpu } from './harness.ts';

test('rdcycle / rdtime / rdinstret 随执行递增', () => {
  const h = makeCpu([
    csrr(1, CSR.CYCLE), // 0: 采样
    csrr(2, CSR.TIME),
    csrr(3, CSR.INSTRET),
    addi(4, 0, 1), // 3 条指令
    addi(4, 0, 2),
    addi(4, 0, 3),
    csrr(5, CSR.CYCLE),
    csrr(6, CSR.TIME),
    csrr(7, CSR.INSTRET),
    ...halt(),
  ]);
  h.run(12);
  assert.ok(h.x(5) > h.x(1), 'cycle 应递增');
  assert.ok(h.x(6) > h.x(2), 'time 应递增');
  assert.ok(h.x(7) > h.x(3), 'instret 应递增');
  // 两次采样之间恰好执行 6 条指令（3 条 addi + 3 条 csrr）
  assert.equal(h.x(7) - h.x(3), 6n);
});

test('time 取自外部时间源（CLINT mtime）', () => {
  const h = makeCpu([csrr(1, CSR.TIME), ...halt()]);
  h.cpu.timeSource = () => 0xdead_beefn;
  h.run(2);
  assert.equal(h.x(1), 0xdead_beefn);
});

test('mcycle / minstret 可软件清零，不影响只读别名读数来源', () => {
  const h = makeCpu([
    ...li(1, 0n),
    csrw(CSR.MCYCLE, 1),
    csrw(CSR.MINSTRET, 1),
    csrr(2, CSR.MCYCLE),
    csrr(3, CSR.MINSTRET),
    ...halt(),
  ]);
  h.run(20);
  assert.equal(h.x(2), 0n);
  assert.equal(h.x(3), 0n);
  // 只读的 cycle/instret 独立于 mcycle/minstret，仍在走
  assert.ok((h.cpu.csr.read(CSR.INSTRET) ?? 0n) > 0n);
});

test('counteren 门控：mcounteren 清位后 S 态读 cycle 触发非法指令', () => {
  const h = makeCpu([csrr(1, CSR.CYCLE), ...halt()]);
  h.cpu.csr.writeRaw(CSR.MCOUNTEREN, 0n);
  h.cpu.priv = Priv.S;
  h.cpu.step();
  assert.equal(h.cpu.csr.read(CSR.MCAUSE), BigInt(Exc.IllegalInstruction));
  assert.equal(h.cpu.priv, Priv.M, '陷阱应升级到 M 态');
});

test('counteren 门控：U 态还需 scounteren 对应位', () => {
  // mcounteren 开、scounteren 关 → U 态读 cycle 非法
  const h = makeCpu([csrr(1, CSR.CYCLE), ...halt()]);
  h.cpu.csr.writeRaw(CSR.MCOUNTEREN, 0x7n);
  h.cpu.csr.writeRaw(CSR.SCOUNTEREN, 0n);
  h.cpu.priv = Priv.U;
  h.cpu.step();
  assert.equal(h.cpu.csr.read(CSR.MCAUSE), BigInt(Exc.IllegalInstruction));

  // 两个 counteren 都开 → U 态读通
  const h2 = makeCpu([csrr(1, CSR.CYCLE), csrr(2, CSR.INSTRET), ...halt()]);
  h2.cpu.csr.writeRaw(CSR.MCOUNTEREN, 0x7n);
  h2.cpu.csr.writeRaw(CSR.SCOUNTEREN, 0x7n);
  h2.cpu.priv = Priv.U;
  h2.run(3);
  assert.equal(h2.cpu.csr.read(CSR.MCAUSE), 0n);
  assert.ok(h2.x(1) > 0n);
  assert.equal(h2.x(2), 2n);
});

test('复位后默认开放 cycle/time/instret 给 S/U 态', () => {
  const h = makeCpu([csrr(1, CSR.CYCLE), csrr(2, CSR.TIME), csrr(3, CSR.INSTRET), ...halt()]);
  h.cpu.priv = Priv.U;
  h.run(4);
  assert.equal(h.cpu.csr.read(CSR.MCAUSE), 0n);
  assert.equal(h.x(3), 3n);
});

test('计数器进位护栏：跨 2^52 阈值后低位回绕、总数精确（number+BigInt 高低位）', () => {
  const FOLD = 2 ** 52;
  const h = makeCpu([addi(4, 0, 1), addi(4, 0, 2), addi(4, 0, 3), addi(4, 0, 4), ...halt()]);
  // 播种到阈值下 1：下一步的 ++ 会触顶，再下一步进位
  h.cpu.mcycle = FOLD - 1;
  h.cpu.instret = FOLD - 1;
  const seed = BigInt(FOLD - 1);
  const steps = 4;
  h.run(steps);

  // 低位必须已回绕到阈值以下（证明进位发生了，而不是 double 冻结在 2^52）
  assert.ok(h.cpu.mcycle < FOLD, `mcycle 低位应已回绕，实际 ${h.cpu.mcycle}`);
  assert.ok(h.cpu.instret < FOLD, `instret 低位应已回绕，实际 ${h.cpu.instret}`);
  // 合并总数必须精确等于 seed + steps —— 进位不丢不重
  assert.equal(h.cpu.mcycleTotal(), seed + BigInt(steps));
  assert.equal(h.cpu.instretTotal(), seed + BigInt(steps));
  // 对外 CSR 读数走同一合并路径，也应跨过 2^52
  assert.ok(h.cpu.csr.read(CSR.CYCLE)! > seed, 'rdcycle 读数应含已进位的高位');
});
