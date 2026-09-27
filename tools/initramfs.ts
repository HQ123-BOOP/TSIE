// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 TSIE
/**
 * 把 Alpine minirootfs 打成内核能用的 cpio-newc initramfs。
 *
 * 为什么是"归档直接转归档"
 * ------------------------
 * 之前的做法是：先把 minirootfs 解压到磁盘，再遍历磁盘目录打 cpio。落到磁盘这一步在
 * Windows 上有两个致命问题，为此专门写了 extract_archive.py 与 .modes.json 侧车文件：
 *
 *  1. **符号链接建不出来**（需要提权）。Alpine 的可执行文件几乎全是指向 /bin/busybox
 *     的符号链接，实测 tar 解完是 0 链接 / 106 文件且提前中止 —— initramfs 里没有 /bin/sh，
 *     根本起不到 shell。
 *  2. **Windows 文件系统不保存 Unix 权限位**，lstat 一律返回 0666，执行位全丢。内核
 *     execve 返回 EACCES(-13)，症状是 "Failed to execute /init (error -13)" +
 *     "Kernel panic - not syncing: No working init found."。
 *
 * 但这两个问题**只在"经过磁盘"时存在**。本工具直接从 tar 头里读 mode / linkname，
 * 内存里组装 cpio，一次都不落盘：链接数量和权限位天然就是归档里的真值，
 * 既不需要提权，也不需要侧车文件。
 *
 * cpio newc 关键点（对照 Linux init/initramfs.c）
 * ----------------------------------------------
 *  header 固定 110 字节，字段顺序:
 *    magic(6) ino mode uid gid nlink mtime filesize devmaj devmin rdevmaj rdevmin namesize check
 *    —— 每个字段 8 位小写十六进制，注意 uid/gid 在 nlink 之前。
 *  c_namesize 含结尾 NUL，name 必须以 \0 结束（否则内核报 "name without nulterm"）。
 *  name 之后的填充量按 (110 + len(name+\0)) 对齐到 4 —— 内核 N_ALIGN(len)=(((len+1)&~3)+2)，
 *    其中 +2 正是补偿 header 110%4=2（否则条目起始偏移非 4 对齐，内核报 "broken padding"）。
 *  data 之后再对齐到 4（110+name+pad 已 4 对齐，故按 len(data) 补零即可）。
 *
 * 用法:
 *   npx tsx tools/initramfs.ts alpine <minirootfs.tar.gz> <out.cpio.gz>   完整 Alpine
 *   npx tsx tools/initramfs.ts mini   <minirootfs.tar.gz> <out.cpio>      最小集、不压缩
 *   npx tsx tools/initramfs.ts verify <initramfs.cpio[.gz]>               结构校验
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync, zstdDecompressSync } from 'node:zlib';

const BLOCK = 512;
export const CPIO_HEADER = 110;

// ------------------------------------------------------------------ tar 解析

export type EntryKind = 'file' | 'dir' | 'symlink' | 'char' | 'block' | 'fifo';

export interface TarEntry {
  /** 去掉前导 "./" 与结尾 "/" 的规范路径（cpio 里要的就是这个形式） */
  name: string;
  /** 归档里记录的权限位 —— Windows 磁盘上拿不到的那个东西 */
  perm: number;
  mtime: number;
  kind: EntryKind;
  data: Buffer;
  linkname: string;
  rmaj: number;
  rmin: number;
}

function cstr(buf: Buffer): string {
  const end = buf.indexOf(0);
  return buf.subarray(0, end < 0 ? buf.length : end).toString('utf8');
}

function octalAt(hdr: Buffer, off: number, len: number): number {
  const raw = hdr.subarray(off, off + len).toString('latin1').replace(/\0/g, ' ').trim();
  if (raw === '') return 0;
  const v = Number.parseInt(raw, 8);
  return Number.isFinite(v) ? v : 0;
}

/** 规范成 cpio 里的名字：去前导 "./"、折叠中间的 "./"、去结尾 "/"、反斜杠转正斜杠 */
export function normalizeName(raw: string): string {
  let n = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  n = n.replace(/\/\.\//g, '/').replace(/\/\.$/, '');
  while (n.endsWith('/')) n = n.slice(0, -1);
  return n === '.' ? '' : n;
}

/** tar 头校验和：把 chksum 字段当空格，其余字节求和。不符说明归档损坏或被截断。 */
function verifyChecksum(hdr: Buffer, off: number): void {
  const stored = octalAt(hdr, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : hdr[i]!;
  if (sum !== stored) {
    throw new Error(`tar 校验和不符（偏移 ${off}，期望 ${stored} 得到 ${sum}）—— 归档可能被截断`);
  }
}

/** 解析 PAX 扩展头的 "长度 键=值\n" 记录 */
function parsePax(data: Buffer): Map<string, string> {
  const rec = new Map<string, string>();
  let p = 0;
  while (p < data.length) {
    const sp = data.indexOf(0x20, p);
    if (sp < 0) break;
    const len = Number.parseInt(data.subarray(p, sp).toString('latin1'), 10);
    if (!Number.isFinite(len) || len <= 0 || p + len > data.length) break;
    const line = data.subarray(sp + 1, p + len).toString('utf8').replace(/\n$/, '');
    const eq = line.indexOf('=');
    if (eq > 0) rec.set(line.slice(0, eq), line.slice(eq + 1));
    p += len;
  }
  return rec;
}

/**
 * 解析（可能被 gunzip 过的）tar。支持 ustar 前缀、GNU 长名（'L'/'K'）与 PAX（'x'）。
 * 只保留普通文件 / 目录 / 符号链接 / 设备节点 / FIFO —— cpio 能表达的那些。
 */
export function parseTar(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  const byName = new Map<string, TarEntry>();
  let off = 0;
  let pendingName: string | null = null;
  let pendingLink: string | null = null;
  let pendingPax: Map<string, string> | null = null;

  while (off < buf.length) {
    // 尾部残留不足一个块的字节 = 归档被截断（tar 的数据永远整块对齐）
    const remaining = buf.length - off;
    if (remaining < BLOCK) {
      if (buf.subarray(off).some((b) => b !== 0)) {
        throw new Error(`tar 尾部残留 ${remaining} 字节不完整数据 —— 归档被截断`);
      }
      break;
    }
    const hdr = buf.subarray(off, off + BLOCK);
    if (hdr.every((b) => b === 0)) break; // 归档以全零块收尾
    verifyChecksum(hdr, off);

    const size = octalAt(hdr, 124, 12);
    if (off + BLOCK + size > buf.length) {
      throw new Error(
        `tar 条目数据越界（声明 ${size} 字节，文件只剩 ${buf.length - off - BLOCK}）—— 归档被截断`,
      );
    }
    const type = String.fromCharCode(hdr[156] === 0 ? 0x30 : hdr[156]!);
    const body = buf.subarray(off + BLOCK, off + BLOCK + size);
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    // 数据本身放得下、但补齐到整块的填充被切掉了，同样是截断
    if (off > buf.length) {
      throw new Error(`tar 条目补齐后越界（需要到 ${off} 字节，文件只有 ${buf.length}）—— 归档被截断`);
    }

    if (type === 'x' || type === 'g') {
      if (type === 'x') pendingPax = parsePax(body); // 'g' 全局头本项目用不到
      continue;
    }
    if (type === 'L') { pendingName = cstr(body); continue; } // GNU 长文件名
    if (type === 'K') { pendingLink = cstr(body); continue; } // GNU 长链接名

    // ⚠️ 名字字段是 NUL 填充的，必须截到第一个 NUL 为止 —— 直接 toString() 会
    // 把后面几十个 \0 一起带进路径，层级树就建不起来了（实测踩过）。
    let name = pendingName ?? cstr(hdr.subarray(0, 100));
    const prefix = cstr(hdr.subarray(345, 500));
    if (pendingName === null && prefix !== '') name = `${prefix}/${name}`;
    pendingName = null;

    let linkname = pendingLink ?? cstr(hdr.subarray(157, 257));
    pendingLink = null;

    if (pendingPax) {
      const p = pendingPax.get('path');
      if (p !== undefined) name = p;
      const l = pendingPax.get('linkpath');
      if (l !== undefined) linkname = l;
      pendingPax = null;
    }

    const norm = normalizeName(name);
    if (norm === '') continue; // 归档根目录自己，由调用方决定怎么写

    const perm = octalAt(hdr, 100, 8) & 0o7777;
    const mtime = octalAt(hdr, 136, 12);
    const rmaj = octalAt(hdr, 329, 8);
    const rmin = octalAt(hdr, 337, 8);

    let entry: TarEntry;
    switch (type) {
      case '2':
        entry = { name: norm, perm, mtime, kind: 'symlink', data: Buffer.alloc(0), linkname, rmaj: 0, rmin: 0 };
        break;
      case '5':
        entry = { name: norm, perm, mtime, kind: 'dir', data: Buffer.alloc(0), linkname: '', rmaj: 0, rmin: 0 };
        break;
      case '3':
      case '4':
        entry = {
          name: norm, perm, mtime, kind: type === '3' ? 'char' : 'block',
          data: Buffer.alloc(0), linkname: '', rmaj, rmin,
        };
        break;
      case '6':
        entry = { name: norm, perm, mtime, kind: 'fifo', data: Buffer.alloc(0), linkname: '', rmaj: 0, rmin: 0 };
        break;
      case '1': {
        // 硬链接：cpio 里按普通文件发全量数据（与旧脚本解压后走磁盘的行为一致）
        const target = byName.get(normalizeName(linkname));
        entry = {
          name: norm, perm, mtime, kind: 'file',
          data: target?.data ?? Buffer.alloc(0), linkname: '', rmaj: 0, rmin: 0,
        };
        break;
      }
      default:
        entry = { name: norm, perm, mtime, kind: 'file', data: Buffer.from(body), linkname: '', rmaj: 0, rmin: 0 };
    }
    out.push(entry);
    byName.set(norm, entry);
  }
  return out;
}

// ---------------------------------------------------------------- cpio 组装

export interface CpioEntry {
  name: string;
  /** 含文件类型位的完整 mode */
  mode: number;
  data: Buffer;
  nlink: number;
  mtime: number;
  rmaj: number;
  rmin: number;
}

export const S_IFMT = 0o170000;
export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
export const S_IFLNK = 0o120000;
export const S_IFCHR = 0o020000;
export const S_IFIFO = 0o010000;

function hex8(v: number): string {
  return (v >>> 0).toString(16).padStart(8, '0');
}

export function cpioRecord(ino: number, e: CpioEntry): Buffer {
  const nameBytes = Buffer.concat([Buffer.from(e.name, 'utf8'), Buffer.from([0])]);
  const hdr =
    '070701' +
    [ino, e.mode, 0, 0, e.nlink, e.mtime, e.data.length, 0, 0, e.rmaj, e.rmin, nameBytes.length, 0]
      .map(hex8)
      .join('');
  const head = Buffer.from(hdr, 'latin1');
  if (head.length !== CPIO_HEADER) throw new Error(`cpio 头长度错误: ${head.length}`);
  const namePad = (4 - ((CPIO_HEADER + nameBytes.length) % 4)) % 4;
  const dataPad = (4 - (e.data.length % 4)) % 4;
  return Buffer.concat([
    head, nameBytes, Buffer.alloc(namePad), e.data, Buffer.alloc(dataPad),
  ]);
}

export function buildCpio(entries: CpioEntry[]): Buffer {
  const parts: Buffer[] = [];
  entries.forEach((e, i) => parts.push(cpioRecord(i + 1, e)));
  parts.push(cpioRecord(entries.length + 1, {
    name: 'TRAILER!!!', mode: 0, data: Buffer.alloc(0), nlink: 1, mtime: 0, rmaj: 0, rmin: 0,
  }));
  return Buffer.concat(parts);
}

/** 解析 cpio-newc，供 verify 与测试使用 */
export function parseCpio(buf: Buffer): CpioEntry[] {
  const out: CpioEntry[] = [];
  let off = 0;
  while (off + CPIO_HEADER <= buf.length) {
    if (buf.subarray(off, off + 6).toString('latin1') !== '070701') {
      throw new Error(`cpio magic 错误 @${off}: ${buf.subarray(off, off + 6).toString('latin1')}`);
    }
    const fld = (i: number): number =>
      Number.parseInt(buf.subarray(off + 6 + i * 8, off + 6 + i * 8 + 8).toString('latin1'), 16);
    const mode = fld(1);
    const nlink = fld(4);
    const mtime = fld(5);
    const filesize = fld(6);
    const rmaj = fld(9);
    const rmin = fld(10);
    const namesize = fld(11);
    const nameBytes = buf.subarray(off + CPIO_HEADER, off + CPIO_HEADER + namesize);
    if (nameBytes.length < namesize || nameBytes[namesize - 1] !== 0) {
      throw new Error(`cpio 名字缺少 NUL 结尾 @${off}`);
    }
    const name = nameBytes.subarray(0, namesize - 1).toString('utf8');
    const dataAt = off + CPIO_HEADER + namesize + ((4 - ((CPIO_HEADER + namesize) % 4)) % 4);
    const data = buf.subarray(dataAt, dataAt + filesize);
    out.push({ name, mode, data: Buffer.from(data), nlink, mtime, rmaj, rmin });
    off = dataAt + ((filesize + 3) & ~3);
    if (name === 'TRAILER!!!') break;
  }
  return out;
}

// -------------------------------------------------------------- 两种打包策略

/**
 * 复刻 `os.walk` 的发射顺序：每层先本层文件、再逐个进子目录，深度优先。
 *
 * ⚠️ 目录不能只看"归档里有没有目录条目"：tar 允许省掉目录条目，只写文件。若只沿着
 * 显式目录条目递归，这些文件会被**静默丢掉**（实测：一个没有 `lib/` 条目的归档，
 * 里面的 `lib/ld-musl-riscv64.so.1` 直接消失）。所以还要按名字把隐含的目录补出来 ——
 * 它们没有条目可发（内核会自己建父目录），但必须递归进去。
 */
function walkOrder(entries: TarEntry[]): TarEntry[] {
  const parentOf = (n: string): string => {
    const i = n.lastIndexOf('/');
    return i < 0 ? '' : n.slice(0, i);
  };
  const children = new Map<string, TarEntry[]>();
  const implied = new Set<string>();
  for (const e of entries) {
    const p = parentOf(e.name);
    const list = children.get(p);
    if (list) list.push(e); else children.set(p, [e]);
    for (let d = p; d !== ''; d = parentOf(d)) implied.add(d);
  }
  for (const e of entries) if (e.kind === 'dir') implied.delete(e.name);

  const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const out: TarEntry[] = [];
  const visit = (dir: string): void => {
    const kids = children.get(dir) ?? [];
    for (const f of kids.filter((k) => k.kind !== 'dir').sort((a, b) => byName(a.name, b.name))) out.push(f);
    const subdirs = new Set(kids.filter((k) => k.kind === 'dir').map((k) => k.name));
    for (const d of implied) if (parentOf(d) === dir) subdirs.add(d);
    for (const d of [...subdirs].sort(byName)) {
      const explicit = kids.find((k) => k.kind === 'dir' && k.name === d);
      if (explicit) out.push(explicit);
      visit(d);
    }
  };
  visit('');
  return out;
}

function toCpio(e: TarEntry): CpioEntry {
  switch (e.kind) {
    case 'dir':
      return { name: e.name, mode: S_IFDIR | e.perm, data: Buffer.alloc(0), nlink: 2, mtime: e.mtime, rmaj: 0, rmin: 0 };
    case 'symlink': {
      // cpio 里符号链接的"数据"就是目标路径，且必须 NUL 结尾
      const target = Buffer.concat([Buffer.from(e.linkname, 'utf8'), Buffer.from([0])]);
      return { name: e.name, mode: S_IFLNK | (e.perm || 0o777), data: target, nlink: 1, mtime: e.mtime, rmaj: 0, rmin: 0 };
    }
    case 'char':
    case 'block':
      return {
        name: e.name, mode: (e.kind === 'char' ? S_IFCHR : 0o060000) | e.perm, data: Buffer.alloc(0),
        nlink: 1, mtime: e.mtime, rmaj: e.rmaj, rmin: e.rmin,
      };
    case 'fifo':
      return { name: e.name, mode: S_IFIFO | e.perm, data: Buffer.alloc(0), nlink: 1, mtime: e.mtime, rmaj: 0, rmin: 0 };
    default:
      return { name: e.name, mode: S_IFREG | e.perm, data: e.data, nlink: 1, mtime: e.mtime, rmaj: 0, rmin: 0 };
  }
}

const INIT_SH = Buffer.from(
  '#!/bin/sh\n' +
  'mount -t proc none /proc 2>/dev/null\n' +
  'mount -t sysfs none /sys 2>/dev/null\n' +
  'mkdir -p /dev 2>/dev/null\n' +
  'echo ""\n' +
  'echo "[ts-riscv64] Alpine initramfs alive"\n' +
  'echo "kernel: $(uname -a 2>/dev/null || echo unknown)"\n' +
  'echo "---------------------------------------------"\n' +
  'exec /bin/sh\n',
  'utf8',
);

const FULL_DEV_NODES: Array<[string, number, number, number]> = [
  ['dev/console', 5, 1, 0o600],
  ['dev/null', 1, 3, 0o666],
  ['dev/zero', 1, 5, 0o666],
  ['dev/ttyS0', 4, 64, 0o600],
];

const MINI_INIT_SH = Buffer.from(
  '#!/bin/sh\n' +
  'mount -t proc none /proc 2>/dev/null\n' +
  'mount -t sysfs none /sys 2>/dev/null\n' +
  'mount -t devtmpfs none /dev 2>/dev/null\n' +
  'echo ""\n' +
  'echo "==============================================="\n' +
  'echo " ts-riscv64: Linux userspace is ALIVE"\n' +
  'echo "==============================================="\n' +
  'echo "uname: $(uname -a 2>/dev/null)"\n' +
  'echo "-----------------------------------------------"\n' +
  'exec /bin/sh\n',
  'utf8',
);

const MINI_APPLETS = [
  'sh', 'ash', 'mount', 'umount', 'echo', 'cat', 'ls', 'uname', 'ps', 'mkdir',
  'dmesg', 'cp', 'mv', 'rm', 'sleep', 'df', 'free', 'ln', 'chmod', 'grep',
  'head', 'tail', 'wc', 'sync', 'poweroff', 'reboot', 'hostname', 'date',
];
const MINI_DIRS = ['bin', 'lib', 'dev', 'proc', 'sys', 'tmp', 'root', 'etc', 'var', 'run'];
const MINI_FILES: Array<[string, string]> = [
  ['bin/busybox', 'bin/busybox'],
  ['lib/ld-musl-riscv64.so.1', 'lib/ld-musl-riscv64.so.1'],
];
const MINI_DEV_NODES: Array<[string, number, number, number]> = [
  ['dev/console', 5, 1, 0o600],
  ['dev/null', 1, 3, 0o666],
  ['dev/zero', 1, 5, 0o666],
  ['dev/tty', 5, 0, 0o666],
  ['dev/ttyS0', 4, 64, 0o600],
];

const ROOT_ENTRY: CpioEntry = {
  name: '.', mode: S_IFDIR | 0o755, data: Buffer.alloc(0), nlink: 2, mtime: 1700000000, rmaj: 0, rmin: 0,
};

function devEntries(nodes: Array<[string, number, number, number]>): CpioEntry[] {
  return nodes.map(([name, rmaj, rmin, perm]) => ({
    name, mode: S_IFCHR | perm, data: Buffer.alloc(0), nlink: 1, mtime: 1700000000, rmaj, rmin,
  }));
}

export interface BuildResult {
  buf: Buffer;
  entries: number;
  execCount: number;
  /** 来自归档的可执行文件数 —— 解压丢了执行位时这里会是 0（就是 EACCES 那个病的病灶） */
  tarExecCount: number;
  symlinkCount: number;
  /** bin/sh 在不在：内核起 /init 的必要条件 */
  hasShell: boolean;
}

const isExec = (e: CpioEntry): boolean => (e.mode & S_IFMT) === S_IFREG && (e.mode & 0o111) !== 0;
const isLink = (e: CpioEntry): boolean => (e.mode & S_IFMT) === S_IFLNK;

export function buildAlpine(tarEntries: TarEntry[]): BuildResult {
  const ordered = walkOrder(tarEntries).map(toCpio);
  const entries: CpioEntry[] = [
    ROOT_ENTRY,
    ...ordered,
    { name: 'init', mode: S_IFREG | 0o755, data: INIT_SH, nlink: 1, mtime: 1700000000, rmaj: 0, rmin: 0 },
    ...devEntries(FULL_DEV_NODES),
  ];
  return {
    buf: buildCpio(entries),
    entries: entries.length,
    execCount: entries.filter(isExec).length,
    tarExecCount: ordered.filter(isExec).length,
    symlinkCount: entries.filter(isLink).length,
    hasShell: ordered.some((e) => e.name === 'bin/sh'),
  };
}

export function buildMini(tarEntries: TarEntry[]): BuildResult {
  const byName = new Map(tarEntries.map((e) => [e.name, e]));
  const entries: CpioEntry[] = [ROOT_ENTRY];
  for (const d of MINI_DIRS) {
    entries.push({ name: d, mode: S_IFDIR | 0o755, data: Buffer.alloc(0), nlink: 2, mtime: 1700000000, rmaj: 0, rmin: 0 });
  }
  for (const [src, dst] of MINI_FILES) {
    const e = byName.get(src);
    if (!e) throw new Error(`minirootfs 里缺少必需文件: ${src}`);
    entries.push({ name: dst, mode: S_IFREG | 0o755, data: e.data, nlink: 1, mtime: 1700000000, rmaj: 0, rmin: 0 });
  }
  for (const app of MINI_APPLETS) {
    entries.push({
      name: `bin/${app}`, mode: S_IFLNK | 0o777, nlink: 1, mtime: 1700000000, rmaj: 0, rmin: 0,
      data: Buffer.from('/bin/busybox\0', 'utf8'),
    });
  }
  entries.push({ name: 'init', mode: S_IFREG | 0o755, data: MINI_INIT_SH, nlink: 1, mtime: 1700000000, rmaj: 0, rmin: 0 });
  entries.push(...devEntries(MINI_DEV_NODES));
  return {
    buf: buildCpio(entries),
    entries: entries.length,
    execCount: entries.filter(isExec).length,
    tarExecCount: MINI_FILES.length,   // busybox 取自归档；执行位由脚本固定给 0755
    symlinkCount: entries.filter(isLink).length,
    hasShell: MINI_APPLETS.includes('sh'),
  };
}

// ------------------------------------------------------------------ 校验模式

function maybeGunzip(path: string, buf: Buffer): Buffer {
  if (path.endsWith('.gz') || (buf[0] === 0x1f && buf[1] === 0x8b)) return gunzipSync(buf);
  return buf;
}

/**
 * 解开 initramfs 的外层压缩，得到内核可以直接吃的裸 cpio。
 *
 * 为什么要这一步：内核在解 initramfs 之前会先认压缩格式，**认不出压缩就直接按裸 cpio 用**。
 * 压缩态下它得在模拟器里跑一遍 inflate —— 那是纯计算，实测占掉可观的指令数；
 * 换成裸 cpio 这段就整个省掉（省的是 inflate，cpio 本身的解包两条路都要做）。
 *
 * 内核认得 gzip / bzip2 / lzma / xz / lzo / lz4 / zstd；这里只做 Node 标准库做得到的两种，
 * 其余格式明确报错而不是猜 —— 猜错会产出一个内核读不懂的 initramfs。
 */
export function uncompressedInitramfs(buf: Buffer): { data: Buffer; format: string } {
  if (buf[0] === 0x1f && buf[1] === 0x8b) return { data: gunzipSync(buf), format: 'gzip' };
  if (buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd) {
    if (typeof zstdDecompressSync !== 'function') {
      throw new Error('这是 zstd 压缩的 initramfs，但当前 Node 没有 zstd（需要 22.15+）');
    }
    return { data: zstdDecompressSync(buf), format: 'zstd' };
  }
  if (buf.subarray(0, 6).toString('latin1') === '070701') {
    throw new Error('这个文件已经是未压缩的 cpio 了，不需要再解');
  }
  throw new Error(
    '认不出压缩格式（前 4 字节 ' +
    buf.subarray(0, 4).toString('hex') +
    '）。内核还支持 bzip2 / lzma / xz / lzo / lz4，但这几种 Node 标准库解不了，请用对应的外部工具',
  );
}

export function verifyCpio(buf: Buffer): { count: number; exec: number; symlinks: number; names: string[] } {
  const entries = parseCpio(buf);
  const names = entries.map((e) => e.name);
  if (names[names.length - 1] !== 'TRAILER!!!') throw new Error('归档没有以 TRAILER!!! 结束');
  return {
    count: entries.length,
    exec: entries.filter((e) => (e.mode & S_IFMT) === S_IFREG && (e.mode & 0o111) !== 0).length,
    symlinks: entries.filter((e) => (e.mode & 0o170000) === S_IFLNK).length,
    names,
  };
}

// ----------------------------------------------------------------------- CLI

function usage(): void {
  process.stderr.write(
    '用法:\n' +
    '  npx tsx tools/initramfs.ts alpine     <minirootfs.tar.gz> <out.cpio.gz>\n' +
    '  npx tsx tools/initramfs.ts mini       <minirootfs.tar.gz> <out.cpio>\n' +
    '  npx tsx tools/initramfs.ts decompress <initramfs.cpio.gz> <out.cpio>\n' +
    '  npx tsx tools/initramfs.ts verify     <initramfs.cpio[.gz]>\n',
  );
}

export function main(argv: string[]): number {
  const [cmd, input, out] = argv;
  try {
    if (cmd === 'decompress') {
      if (!input || !out) { usage(); return 2; }
      if (out.endsWith('.gz') || out.endsWith('.zst')) {
        process.stderr.write('错误: 输出别再用压缩后缀 —— 这一步的目的就是去掉压缩层\n');
        return 2;
      }
      const raw = readFileSync(input);
      const { data, format } = uncompressedInitramfs(raw);
      // 解出来必须真的是个完好的 cpio，否则交给内核只会得到一个"看起来卡住"的引导
      const r = verifyCpio(data);
      writeFileSync(out, data);
      const pct = (100 * data.length / raw.length - 100).toFixed(0);
      process.stdout.write(
        `${input}  ${raw.length} B (${format}) → ${out}  ${data.length} B（未压缩，+${pct}%）\n` +
        `条目 ${r.count}，符号链接 ${r.symlinks}，可执行文件 ${r.exec} —— 结构校验通过\n` +
        '内核认不出压缩就会直接按裸 cpio 用，省掉的是它在模拟器里跑 inflate 的那段指令。\n',
      );
      return 0;
    }
    if (cmd === 'verify') {
      if (!input) { usage(); return 2; }
      const raw = maybeGunzip(input, readFileSync(input));
      const r = verifyCpio(raw);
      process.stdout.write(`条目数: ${r.count}, 符号链接: ${r.symlinks}, 可执行文件: ${r.exec}\n`);
      process.stdout.write(`含 /init: ${r.names.includes('init')} | 含 dev/console: ${r.names.includes('dev/console')}\n`);
      process.stdout.write(`前 8 项: ${r.names.slice(0, 8).join(' ')}\n`);
      process.stdout.write(`结构校验: OK（magic / 名字 NUL 结尾 / 4 字节对齐 / TRAILER 全部通过）\n`);
      return 0;
    }
    if ((cmd !== 'alpine' && cmd !== 'mini') || !input || !out) { usage(); return 2; }

    const tar = parseTar(maybeGunzip(input, readFileSync(input)));
    const built = cmd === 'alpine' ? buildAlpine(tar) : buildMini(tar);

    // ⚠️ 自检：产物里没有可执行文件、或者没有 bin/sh，内核必然起不到 init，
    // 表现为 "Failed to execute /init (error -13)" + "Kernel panic - not syncing:
    // No working init found."（这正是当年解压丢执行位时的症状）。
    // 判据要盯**归档来的**可执行文件：/init 是我们自己加的，它可执行是理所当然的，
    // 拿它当判据等于没检查。
    if (built.tarExecCount === 0 || !built.hasShell) {
      process.stderr.write(
        `错误: 产物不可引导（归档里的可执行文件 ${built.tarExecCount} 个，bin/sh ${built.hasShell ? '有' : '无'}）。\n` +
        '      多半是归档本身的权限位/链接有问题 —— 请确认 minirootfs 完好。\n',
      );
      return 1;
    }

    if (cmd === 'mini') {
      if (out.endsWith('.gz')) {
        process.stderr.write('错误: mini 刻意不压缩（省掉内核 inflate 开销），请用 .cpio 后缀\n');
        return 2;
      }
      writeFileSync(out, built.buf);
    } else {
      const gz = gzipSync(built.buf, { level: 9 });
      writeFileSync(out, out.endsWith('.gz') ? gz : built.buf);
    }
    const written = readFileSync(out).length;
    process.stdout.write(
      `wrote ${out}: ${written} bytes (tar 条目 ${tar.length} → cpio 条目 ${built.entries})\n` +
      `可执行文件: ${built.execCount} 个（其中来自归档 ${built.tarExecCount} 个）` +
      `，符号链接: ${built.symlinkCount} 个（均取自归档元数据，未经过磁盘）\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`错误: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  process.exit(main(process.argv.slice(2)));
}
