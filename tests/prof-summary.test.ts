// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 TSIE
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { main, summarize } from '../tools/prof-summary.ts';

/** 造一份最小可用的 cpuprofile：nodes + hitCount 就是"自身耗时"的全部输入 */
function profile(nodes: Array<[string, string, number, number]>): unknown {
  return {
    nodes: nodes.map(([fn, url, line, hits], i) => ({
      id: i + 1,
      hitCount: hits,
      callFrame: { functionName: fn, url, lineNumber: line },
    })),
  };
}

test('summarize 按自身耗时降序，并算出占总采样的比例', () => {
  const prof = profile([
    ['step', 'file:///C:/TS-Linux/src/cpu/cpu.ts', 0, 300],
    ['execute', 'file:///C:/TS-Linux/src/cpu/cpu.ts', 1, 100],
    ['readFileUtf8', 'node:internal/fs', 0, 100],
  ]);
  const r = summarize(prof as never, 10);
  assert.equal(r.total, 500);
  assert.deepEqual(r.rows.map((x) => x.hits), [300, 100, 100]);
  assert.equal(r.rows[0]?.key, 'step  [cpu.ts:1]');
  assert.equal(r.rows[1]?.key, 'execute  [cpu.ts:2]', 'lineNumber 是 0 基，显示要 +1');
});

test('summarize 的 total 是全部采样，filter 只影响行列与 shown', () => {
  const prof = profile([
    ['step', 'file:///C:/TS-Linux/src/cpu/cpu.ts', 0, 300],
    ['readFileUtf8', 'node:internal/fs', 0, 200],
  ]);
  const r = summarize(prof as never, 10, 'src/');
  assert.equal(r.total, 500, 'total 不受 filter 影响，否则百分比会失真');
  assert.equal(r.shown, 300);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0]?.key, 'step  [cpu.ts:1]');
});

test('summarize 的 filter 也匹配函数名，且 topN 生效', () => {
  const prof = profile([
    ['step', 'file:///C:/TS-Linux/src/cpu/cpu.ts', 0, 300],
    ['stepHelper', 'file:///C:/TS-Linux/src/cpu/cpu.ts', 0, 200],
    ['other', 'file:///C:/TS-Linux/src/mmu.ts', 0, 100],
  ]);
  const r = summarize(prof as never, 1, 'step');
  assert.equal(r.shown, 500);
  assert.equal(r.rows.length, 1, 'topN=1 只留一行');
  assert.equal(r.rows[0]?.hits, 300);
});

test('summarize 把没有 functionName 的帧记成 (anonymous)', () => {
  const prof = { nodes: [{ id: 1, hitCount: 5, callFrame: { url: 'file:///x/y.ts', lineNumber: 0 } }] };
  const r = summarize(prof as never, 5);
  assert.equal(r.rows[0]?.key, '(anonymous)  [y.ts:1]');
});

test('main：无参数返回用法错误码，没有采样返回 1，正常返回 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsie-prof-'));
  try {
    assert.equal(main([]), 2);

    const empty = join(dir, 'empty.cpuprofile');
    writeFileSync(empty, JSON.stringify({ nodes: [] }));
    assert.equal(main([empty]), 1, '没有采样时要报错而不是打印一张空表');

    const good = join(dir, 'good.cpuprofile');
    writeFileSync(good, JSON.stringify(profile([['step', 'file:///a/b.ts', 0, 42]])));
    assert.equal(main([good, '5', '--filter', 'b.ts']), 0);

    assert.equal(main([join(dir, 'nope.cpuprofile')]), 1, '文件不存在要报错而不是崩栈');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
