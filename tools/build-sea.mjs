#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 TSIE
/**
 * 把 CLI 打成**不依赖 Node 的独立可执行文件**（Node 官方的 SEA：Single Executable Application）。
 *
 * 用法:
 *   node tools/build-sea.mjs [--out <路径>]
 *
 * 四步：esbuild 打成单文件 CJS → 生成 SEA blob → 复制当前 node 可执行文件 →
 * 用 postject 把 blob 注进去，最后跑一次 `--help` 冒烟。
 *
 * 几个必须知道的约束（都实测过）
 * ------------------------------
 * * **SEA 只把内嵌脚本当 CommonJS 跑**，所以打包必须 `--format=cjs`（Node 24.21 与 26.10
 *   都如此，ESM 入口会被 `embedderRunCjs` 拒掉）。这也是 `src/cli.ts` 结尾不用顶层 await
 *   的原因 —— esbuild 无法把顶层 await 降级成 CJS。
 * * **不能交叉编译**：blob 与平台无关，但要注入**目标平台的 node 可执行文件**，
 *   所以 Windows 的包只能在 Windows 上做、Linux 的包只能在 Linux 上做。
 * * 注入会破坏 node 自带的代码签名（postject 会警告 "The signature seems corrupted"）。
 *   自己分发的话需要重新签名，否则 Windows SmartScreen / macOS Gatekeeper 会拦。
 * * 产物约 90 MB（内嵌整个 Node 运行时）。
 * * 输出落在 `tmp/sea/` 而**不是** `dist/`：`package.json` 的 main/bin 指向 dist/，
 *   于是 `npm pack` 会强制包含整个 dist/ —— 90 MB 的二进制会被塞进 npm 包。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { inject } from 'postject';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'tmp', 'sea');
const IS_WINDOWS = process.platform === 'win32';
/** Node SEA 约定的哨兵，postject 靠它在二进制里找注入点 */
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function fail(msg) {
  process.stderr.write(`错误: ${msg}\n`);
  process.exit(1);
}

function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) fail(`${label} 起不来: ${r.error.message}`);
  if (r.status !== 0) {
    fail(`${label} 失败（退出码 ${r.status}）:\n${(r.stderr ?? '').toString().slice(0, 800)}`);
  }
  return r;
}

async function main() {
  const args = process.argv.slice(2);
  const outArg = args.indexOf('--out');
  // 默认落在 tmp/sea/（gitignored）。**默认不能是相对的裸文件名** —— 那会 resolve 到
  // 当前工作目录，在仓库根跑一次就在根上留一个 90 MB 的 tsie.exe（实测踩过）。
  const defaultName = join(OUT_DIR, IS_WINDOWS ? 'tsie.exe' : 'tsie');
  const outFile = resolve(outArg >= 0 ? (args[outArg + 1] ?? '') : defaultName);
  if (outArg >= 0 && !args[outArg + 1]) fail('--out 后面要给路径');

  mkdirSync(OUT_DIR, { recursive: true });
  const bundle = join(OUT_DIR, 'tsie.cjs');
  const cfg = join(OUT_DIR, 'sea-config.json');
  const blob = join(OUT_DIR, 'sea-prep.blob');

  // ⚠️ 先清掉中间产物，否则这个脚本能"假通过"：
  //    最初 version 忘了 await esbuild 的 build()，紧随其后的 statSync 检查到的是
  //    **上一次留下的陈旧 bundle**，本地一路绿灯，CI 上（全新环境没有那个文件）
  //    当场 ENOENT。清理 + await 两样都要有。
  for (const f of [bundle, cfg, blob, outFile]) rmSync(f, { force: true });

  // ① 单文件 CJS（必须 await —— esbuild 的 build() 是异步的）
  process.stdout.write('==> esbuild 打成单文件（CJS）...\n');
  await build({
    entryPoints: [join(ROOT, 'src', 'cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: `node${process.versions.node.split('.')[0]}`,
    outfile: bundle,
    logLevel: 'warning',
  });
  if (!statSync(bundle).size) fail('esbuild 产出了空文件');

  // ② SEA blob
  process.stdout.write('==> 生成 SEA blob...\n');
  writeFileSync(cfg, JSON.stringify({
    main: bundle,
    output: blob,
    disableExperimentalSEAWarning: true,
  }, null, 2));
  run(process.execPath, ['--experimental-sea-config', cfg], '生成 SEA blob');

  // ③ 复制当前 node，再把 blob 注进去。
  //    用 process.execPath 而不是 PATH 里的 node：blob 是它生成的，版本天然一致。
  process.stdout.write('==> 注入（postject）...\n');
  copyFileSync(process.execPath, outFile);
  try {
    await inject(outFile, 'NODE_SEA_BLOB', readFileSync(blob), { sentinelFuse: SENTINEL_FUSE });
  } catch (err) {
    process.stderr.write(`错误: 注入失败: ${err?.message ?? err}\n`);
    if (IS_WINDOWS) {
      process.stderr.write(
        '提示：Windows 上 node.exe 带代码签名，注入前可能要先去掉签名：\n' +
        '  signtool remove /s <node.exe 的副本>\n',
      );
    }
    process.exit(1);
  }

  if (!IS_WINDOWS) spawnSync('chmod', ['+x', outFile]);

  // ④ 冒烟：打出来的东西必须真能跑
  const help = run(outFile, ['--help'], '冒烟测试（--help）');
  const firstLine = help.stdout.toString().split('\n').find((l) => l.trim() !== '') ?? '';

  const mb = (statSync(outFile).size / 1048576).toFixed(1);
  process.stdout.write(
    `\n✅ ${outFile}\n` +
    `   ${mb} MB，内嵌 Node ${process.versions.node}（${process.platform}-${process.arch}）\n` +
    `   冒烟输出首行: ${firstLine.trim()}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`错误: ${err?.stack ?? err}\n`);
  process.exit(1);
});
