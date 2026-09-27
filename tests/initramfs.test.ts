// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 TSIE
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CPIO_HEADER,
  S_IFCHR,
  S_IFDIR,
  S_IFLNK,
  S_IFREG,
  buildAlpine,
  buildCpio,
  buildMini,
  main,
  parseCpio,
  parseTar,
  verifyCpio,
  type CpioEntry,
  type TarEntry,
} from '../tools/initramfs.ts';

// ------------------------------------------------------------ 合成 tar 的工具

const BLOCK = 512;

function octal(v: number, len: number): string {
  return v.toString(8).padStart(len - 1, '0') + '\0';
}

function tarHeader(opts: {
  name: string; mode?: number; size?: number; type?: string; link?: string;
  mtime?: number; rmaj?: number; rmin?: number; prefix?: string;
}): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(opts.name, 0, 100, 'utf8');
  h.write(octal(opts.mode ?? 0o644, 8), 100, 8, 'latin1');
  h.write(octal(0, 8), 108, 8, 'latin1');           // uid
  h.write(octal(0, 8), 116, 8, 'latin1');           // gid
  h.write(octal(opts.size ?? 0, 12), 124, 12, 'latin1');
  h.write(octal(opts.mtime ?? 1700000000, 12), 136, 12, 'latin1');
  h.write('        ', 148, 8, 'latin1');            // 校验和先填空格
  h.write(opts.type ?? '0', 156, 1, 'latin1');
  if (opts.link) h.write(opts.link, 157, 100, 'utf8');
  h.write('ustar\0', 257, 6, 'latin1');
  h.write('00', 263, 2, 'latin1');
  h.write(octal(opts.rmaj ?? 0, 8), 329, 8, 'latin1');
  h.write(octal(opts.rmin ?? 0, 8), 337, 8, 'latin1');
  if (opts.prefix) h.write(opts.prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  return h;
}

function tarWithData(hdr: Buffer, data: Buffer): Buffer {
  const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
  return Buffer.concat([hdr, data, Buffer.alloc(pad)]);
}

function file(name: string, content: string, mode = 0o644, mtime?: number): Buffer {
  const data = Buffer.from(content, 'utf8');
  return tarWithData(tarHeader({ name, mode, size: data.length, mtime }), data);
}

/** 一个够典型的小 tar：目录、可执行文件、符号链接、GNU 长名、前缀字段 */
function sampleTar(): Buffer {
  const longName = `usr/lib/very/deeply/nested/${'x'.repeat(80)}/module.bin`;
  const gnuLong = tarWithData(tarHeader({ name: '././@LongLink', type: 'L', size: longName.length + 1 }), Buffer.from(longName + '\0', 'utf8'));
  return Buffer.concat([
    tarHeader({ name: './', mode: 0o755, type: '5' }),
    tarHeader({ name: './bin/', mode: 0o755, type: '5' }),
    file('./bin/busybox', 'ELF-ish payload', 0o755),
    file('./lib/ld-musl-riscv64.so.1', 'musl-ish', 0o755),
    tarWithData(tarHeader({ name: './bin/sh', mode: 0o777, type: '2', link: '/bin/busybox' }), Buffer.alloc(0)),
    gnuLong,
    file(longName, 'deep', 0o644),
    file('README', 'hi', 0o644, 1700000123),
    tarHeader({ name: './dev/console', mode: 0o600, type: '3', rmaj: 5, rmin: 1 }),
    tarHeader({ name: './prefixed.txt', mode: 0o644, prefix: 'var/log' }),
    Buffer.alloc(BLOCK * 2),   // 全零块 = 归档结束
  ]);
}

// ------------------------------------------------------------------- tar 解析

test('parseTar 保留归档里的权限位、类型与链接目标', () => {
  const entries = parseTar(sampleTar());
  const by = new Map(entries.map((e) => [e.name, e]));
  assert.equal(by.get('bin')?.kind, 'dir');
  assert.equal(by.get('bin')?.name, 'bin');            // "./bin/" 规范化成 "bin"
  assert.equal(by.get('bin/busybox')?.kind, 'file');
  assert.equal(by.get('bin/busybox')?.perm, 0o755);    // 关键：执行位来自归档，不是磁盘
  assert.equal(by.get('bin/busybox')?.data.toString(), 'ELF-ish payload');
  assert.equal(by.get('bin/sh')?.kind, 'symlink');
  assert.equal(by.get('bin/sh')?.linkname, '/bin/busybox');
  assert.equal(by.get('dev/console')?.kind, 'char');
  assert.equal(by.get('dev/console')?.rmaj, 5);
  assert.equal(by.get('dev/console')?.rmin, 1);
  assert.equal(by.get('var/log/prefixed.txt')?.kind, 'file');
  assert.equal(by.get('README')?.mtime, 1700000123);
});

test('parseTar 处理 GNU 长文件名（typeflag L）', () => {
  const longName = `usr/lib/very/deeply/nested/${'x'.repeat(80)}/module.bin`;
  const entries = parseTar(sampleTar());
  assert.ok(longName.length > 100, '测试用的名字要真的超过 100 字节');
  assert.ok(entries.some((e) => e.name === longName), '长名条目应当按全名还原');
});

test('parseTar 用校验和识别截断/损坏的归档', () => {
  const good = sampleTar();
  const bad = Buffer.from(good);
  bad[600] = bad[600]! ^ 0xff;   // 翻掉数据区一个字节
  assert.throws(() => parseTar(bad), /校验和不符/);
});

test('parseTar 拒绝不完整的 tar（尾部被截断）', () => {
  // 截在 busybox 数据的补齐填充中间：数据本身放得下，缺的是补齐到整块的填充
  const truncated = sampleTar().subarray(0, BLOCK * 3 + 100);
  assert.throws(() => parseTar(truncated), /截断/);
});

// ------------------------------------------------------------------ cpio 布局

function entry(name: string, mode: number, data = Buffer.alloc(0)): CpioEntry {
  return { name, mode, data, nlink: 1, mtime: 1700000000, rmaj: 0, rmin: 0 };
}

test('cpio 条目符合内核要求的头长度、NUL 结尾与 4 字节对齐', () => {
  // 名字长度刻意取到会触发填充的值：110 + 名字长 必须回到 4 的倍数
  for (const name of ['a', 'ab', 'abc', 'abcd', 'abcde', 'bin/busybox']) {
    const raw = buildCpio([entry(name, S_IFREG | 0o755, Buffer.from('xy'))]);
    assert.equal(raw.subarray(0, 6).toString('latin1'), '070701');
    assert.equal(raw.subarray(0, CPIO_HEADER).length, CPIO_HEADER);
    const namesize = Number.parseInt(raw.subarray(6 + 11 * 8, 6 + 12 * 8).toString('latin1'), 16);
    assert.equal(namesize, name.length + 1, 'namesize 含结尾 NUL');
    assert.equal(raw[CPIO_HEADER + name.length], 0, '名字必须以 NUL 结尾');
    const dataAt = CPIO_HEADER + namesize + ((4 - ((CPIO_HEADER + namesize) % 4)) % 4);
    assert.equal(dataAt % 4, 0, '数据起始必须 4 字节对齐');
    assert.deepEqual(parseCpio(raw)[0]?.data, Buffer.from('xy'));
  }
});

test('cpio 往返：模式位、符号链接数据、TRAILER 都能读回', () => {
  const entries: CpioEntry[] = [
    entry('.', S_IFDIR | 0o755),
    entry('bin', S_IFDIR | 0o755),
    entry('bin/busybox', S_IFREG | 0o755, Buffer.from('busybox')),
    entry('bin/sh', S_IFLNK | 0o777, Buffer.from('/bin/busybox\0', 'utf8')),
    entry('dev/console', S_IFCHR | 0o600),
  ];
  const back = parseCpio(buildCpio(entries));
  assert.deepEqual(back.map((e) => e.name), [...entries.map((e) => e.name), 'TRAILER!!!']);
  assert.equal(back[2]?.mode, S_IFREG | 0o755);
  assert.equal(back[3]?.mode, S_IFLNK | 0o777);
  assert.equal(back[3]?.data.toString(), '/bin/busybox\0');
  assert.equal(back[4]?.mode, S_IFCHR | 0o600);
});

// ------------------------------------------------------------------ 完整打包

test('buildAlpine 保住执行位与符号链接，并补上 . / init / 设备节点', () => {
  const tar: TarEntry[] = parseTar(sampleTar());
  const r = buildAlpine(tar);
  const by = new Map(parseCpio(r.buf).map((e) => [e.name, e]));
  assert.equal(by.get('.')?.mode, S_IFDIR | 0o755);
  assert.equal(by.get('bin/busybox')?.mode, S_IFREG | 0o755, 'busybox 必须可执行');
  assert.equal(by.get('bin/sh')?.mode, S_IFLNK | 0o777);
  assert.equal(by.get('bin/sh')?.data.toString(), '/bin/busybox\0');
  assert.equal(by.get('init')?.mode, S_IFREG | 0o755);
  assert.equal(by.get('dev/console')?.mode, S_IFCHR | 0o600);
  assert.equal(by.get('dev/console')?.rmaj, 5);
  assert.equal(r.tarExecCount, 2, '归档里两个可执行文件：busybox 与 musl 加载器');
  assert.equal(r.execCount, 3, '再加脚本自带的 init');
  assert.equal(r.symlinkCount, 1);
  assert.equal(r.hasShell, true);
});

test('buildAlpine 让父目录先于子项出现（复刻 os.walk 的顺序）', () => {
  const names = parseCpio(buildAlpine(parseTar(sampleTar())).buf).map((e) => e.name);
  assert.equal(names[0], '.');
  for (const n of names) {
    const i = n.lastIndexOf('/');
    if (i < 0 || n === 'TRAILER!!!') continue;
    const parent = n.slice(0, i);
    assert.ok(names.indexOf(parent) < names.indexOf(n), `${parent} 应当排在 ${n} 前面`);
  }
});

test('buildMini 只取最小集，并自己生成 applet 符号链接', () => {
  const r = buildMini(parseTar(sampleTar()));
  const names = parseCpio(r.buf).map((e) => e.name);
  assert.ok(names.includes('bin/busybox'));
  assert.ok(names.includes('bin/sh'), 'applet 链接由脚本生成，不依赖归档里有没有');
  assert.ok(!names.includes('README'), '其余文件一律不带');
  assert.ok(names.includes('init'));
  assert.equal(r.symlinkCount, 28);
});

// --------------------------------------------------------------------- CLI

test('verifyCpio 报告条目数、可执行文件数与符号链接数', () => {
  const r = verifyCpio(buildAlpine(parseTar(sampleTar())).buf);
  assert.equal(r.names[r.names.length - 1], 'TRAILER!!!');
  assert.equal(r.exec, 3, '符号链接不能被算成可执行文件（S_IFMT 掩码）');
  assert.equal(r.symlinks, 1);
  assert.ok(r.count > 5);
});

test('verifyCpio 拒绝没有 TRAILER 的归档', () => {
  const noTrailer = buildCpio([entry('.', S_IFDIR | 0o755)]).subarray(0, 200);
  assert.throws(() => verifyCpio(noTrailer), /magic|TRAILER|NUL/);
});

test('main 在参数不足时返回用法错误码而不是崩溃', () => {
  assert.equal(main([]), 2);
  assert.equal(main(['alpine']), 2);
  assert.equal(main(['nonsense', 'a', 'b']), 2);
});
