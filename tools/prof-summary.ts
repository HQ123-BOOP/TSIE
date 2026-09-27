// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 TSIE
/**
 * 汇总 V8 CPU profile（`node --cpu-prof` 产出的 .cpuprofile）。
 *
 * 按**自身耗时**（self time）聚合函数，输出 top-N。自身耗时 = 该函数栈顶被采样到的次数，
 * 也就是"真正花在它自己身上的时间"，不含它调用的子函数 —— 找优化点时看的就是这个。
 *
 * 用法:
 *   npx tsx tools/prof-summary.ts <file.cpuprofile> [topN] [--filter 子串]
 *
 * --filter 只保留 url 或函数名含该子串的帧（例如只看 src/ 下的模拟器代码，
 * 排除 node 内部与 tsx）。
 *
 * ⚠️ 采集时注意：`npx tsx src/cli.ts` 会产出**三个** profile（npx 包装、tsx loader、
 * 模拟器本体），得挑最大的那个；想只要一份就用 `node --import tsx src/cli.ts`。
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

interface CallFrame {
  functionName?: string;
  url?: string;
  lineNumber?: number;
}

interface ProfileNode {
  id: number;
  hitCount?: number;
  callFrame: CallFrame;
}

interface Profile {
  nodes?: ProfileNode[];
}

export interface Row {
  key: string;
  hits: number;
}

export interface Summary {
  total: number;
  shown: number;
  rows: Row[];
}

/**
 * 聚合自身耗时。注意 `total` 是**全部**命中数，包含被 --filter 滤掉的那些 ——
 * 所以"匹配 N 次（P%）"里的 P 才是"占整体的比例"，行里的百分比也按 total 算。
 */
export function summarize(prof: Profile, topN = 20, filter?: string): Summary {
  const nodes = prof.nodes ?? [];
  const byId = new Map<number, ProfileNode>(nodes.map((n) => [n.id, n]));

  const selfHits = new Map<number, number>();
  for (const n of nodes) {
    const h = n.hitCount ?? 0;
    if (h) selfHits.set(n.id, (selfHits.get(n.id) ?? 0) + h);
  }
  const total = [...selfHits.values()].reduce((a, b) => a + b, 0);

  const agg = new Map<string, number>();
  for (const [id, hits] of selfHits) {
    const cf = byId.get(id)?.callFrame ?? {};
    const fn = cf.functionName || '(anonymous)';
    const url = cf.url ?? '';
    if (filter && !fn.includes(filter) && !url.includes(filter)) continue;
    // 路径裁短一点，便于阅读（只留文件名）
    const short = url ? basename(url.replace('file:///', '').replace(/\\/g, '/')) : '';
    const line = (cf.lineNumber ?? -1) + 1;
    const key = `${fn}  [${short}:${line}]`;
    agg.set(key, (agg.get(key) ?? 0) + hits);
  }

  const rows = [...agg.entries()]
    .map(([key, hits]) => ({ key, hits }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, topN);

  return { total, shown: [...agg.values()].reduce((a, b) => a + b, 0), rows };
}

function usage(): void {
  process.stderr.write('用法: npx tsx tools/prof-summary.ts <file.cpuprofile> [topN] [--filter 子串]\n');
}

export function main(argv: string[]): number {
  if (argv.length === 0) { usage(); return 2; }

  const path = argv[0]!;
  let topN = 20;
  let filter: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--filter') { filter = argv[++i]; continue; }
    const n = Number.parseInt(argv[i]!, 10);
    if (Number.isFinite(n)) topN = n;
  }

  let prof: Profile;
  try {
    prof = JSON.parse(readFileSync(path, 'utf8')) as Profile;
  } catch (err) {
    process.stderr.write(`错误: 读不了 ${path}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const { total, shown, rows } = summarize(prof, topN, filter);
  if (total === 0) {
    process.stderr.write('profile 里没有采样（运行太短？）\n');
    return 1;
  }

  const head = `总采样 ${total} 次`;
  process.stdout.write(
    filter
      ? `${head}，其中匹配 "${filter}" 的 ${shown} 次（${((100 * shown) / total).toFixed(1)}%）\n`
      : `${head}\n`,
  );
  process.stdout.write(`${'自身耗时'.padStart(9)}  ${'占比'.padStart(7)}  函数\n`);
  for (const r of rows) {
    const pct = ((100 * r.hits) / total).toFixed(2);
    process.stdout.write(`${String(r.hits).padStart(9)}  ${`${pct}%`.padStart(7)}  ${r.key}\n`);
  }
  return 0;
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  process.exit(main(process.argv.slice(2)));
}
