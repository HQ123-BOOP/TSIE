// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 TSIE
/**
 * 手写 FAT16 镜像构造器 —— 给两条引导路径造一块固件真能读的盘。
 *
 *  1. U-Boot:  `fatload virtio 0:1 <addr> Image`（镜像以 virtio-blk 暴露给 guest）；
 *  2. EDK II:  镜像本身就是 EFI 系统分区（ESP，分区类型 0xEF），里面要有
 *              EFI/BOOT/BOOTRISCV64.EFI、grub.cfg、内核与 initramfs。
 *
 * 为什么不调外部工具
 * ------------------
 * 仓库的硬规矩是"除 ws 外零依赖"，而 mkfs.vfat / mtools / mcopy 在 Windows 上要么没有、
 * 要么得额外装；更要命的是它们会往时间戳、卷序列号、卷标里塞**当前时间**，
 * 于是同一个输入两次跑出来的镜像不一样，`cmp` 一下全是噪声。这里的产物要求
 * **字节确定**（固定 DOS 时间戳 + 由输入派生的卷序列号），所以布局必须自己写。
 *
 * 磁盘布局（本文件的第一原则：MBR 与 BPB 里每个字段都要有出处）
 * -------------------------------------------------------------
 *   扇区 0            MBR：一个主分区项，可引导标志 0x80，分区从 LBA 2048 起（1 MiB 对齐，
 *                    U-Boot / EDK II / 分区工具都按这个惯例办事）。CHS 字段填 255 头
 *                    63 扇区换算出来的"传统值"（起始 0/32/33）；表里没人真拿它寻址，
 *                    但 `part list` 会打印，留 0 会显示成一堆 0/0/0 —— 填对不花钱。
 *   LBA 2048          FAT16 卷（BPB + 两份 FAT + 固定根目录 + 数据区）
 *
 * 卷内参数与理由：
 *   - 512 B/扇区（virtio-blk 的逻辑块就是 512，改不得）。
 *   - 保留扇区 1：与 mkfs.fat 对 FAT12/16 的默认一致，只放引导扇区。
 *   - 两份 FAT：FAT 规范要求，只写一份的话有些固件会直接判卷损坏。
 *   - 根目录固定 512 项（32 扇区）：FAT16 的特征就是根目录不在数据区里，
 *     项数必须是 16 的整数倍（否则折算出的扇区数不是整数）。
 *   - 簇大小自动挑，规则见 chooseSectorsPerCluster()。
 *
 * 簇大小为什么"挑大"而不是"挑小"
 * ------------------------------
 * 簇数必须落在 FAT16 的合法区间 4085…65524。这个区间的**下界是硬约束**：
 * 驱动（EDK II 的 FatPkg、U-Boot 的 fs/fat）判定 FAT12/16 靠的是数簇的个数，
 * 不是 BPB 里那行 "FAT16" 字符串。若簇数只有两三千，固件会按 FAT12 去解 12 位的
 * FAT 链，读出来的簇号整个错位 —— 症状是目录能列、文件读出来是垃圾，
 * 比"直接报错"难查得多。上界 65524 是 16 位 FAT 项的容量。
 *
 * 所以规则是：从大到小试 128/64/…/1 扇区每簇，取**第一个（也就是最大的）**能让簇数
 * 仍然 ≥ 4085 的簇大小。这样得到的簇大小永远"刚好没掉进 FAT12"，同时簇数尽量少 ⇒
 * FAT 表尽量小 ⇒ 固件扫 FAT 的扇区数最少（对 2–4 MIPS 的模拟器来说，U-Boot 的
 * fatload 是大文件的主要成本之一，FileDisk 虽有 1 MiB 缓存，但 U-Boot 是 512 B 粒度
 * 的随机读，FAT 少一半就是实打实的少读）。实测档位（镜像大小 → 簇大小）：
 *   8 MiB → 1 KiB（7123 簇）   17–32 MiB → 4 KiB（7924 簇 @32 MiB，也就是预期答案）
 *   16 MiB → 2 KiB（7656 簇）  33–64 MiB → 8 KiB   128 MiB → 16 KiB   512 MiB → 64 KiB
 * 32 MiB 那一档特别重要：它正好是"卷 31 MiB、8 扇区/簇"，再大一档（16 扇区/簇）簇数
 * 会掉到 3965 —— 那就进 FAT12 区间了，所以它是这个卷大小下能取的最大簇。
 *
 * 长文件名（VFAT）为什么必须实现
 * -----------------------------
 * 引导链上真实的名字几乎都不是 8.3：`initramfs.cpio.gz`、`BOOTRISCV64.EFI`、
 * `grub.cfg`。U-Boot 与 EDK II 都按 VFAT 规则把 0x0F 属性项拼回长名；如果只写 8.3 项，
 * `fatload virtio 0:1 0x84000000 initramfs.cpio.gz` 会找不到文件（或只能退化成
 * `INITRA~1.GZ`）。几个必须一次做对的点：
 *   1. 0x0F 属性项**倒序**存放：物理上第一项是长名的最后 13 个码元，且带 0x40 标志位，
 *      紧挨着 8.3 项的那一项才是长名的开头。写反了固件拼出来是倒的名字。
 *   2. 每项 13 个 UTF-16LE 码元，分三段放在偏移 1/14/28；名字不足时先写 0x0000 结束符，
 *      其余填 0xFFFF。
 *   3. 校验和是对**生成的 8.3 名**（11 字节）算的，不是对长名算的。名字末尾不能有 NUL，
 *      只能是空格填充。
 *   4. LFN 项的首簇字段必须为 0，且没有时间戳字段（偏移 12/13 是类型与校验和）。
 *
 * 确定性
 * ------
 * DOS 时间戳固定为 2026-01-01 00:00:00（日期字 0x5C21、时间字 0），卷序列号由
 * 卷标 + 卷扇区数 + 簇大小做 FNV-1a 派生。同一组输入 ⇒ 逐字节相同的镜像，
 * 两次构建可以 `cmp`；不同的输入也会得到不同的序列号（不是写死常量）。
 *
 * 实机验证（Debian u-boot-qemu 2025.01-3，跑在本仓库自己的模拟器里）
 * ---------------------------------------------------------------
 *   npx tsx src/cli.ts --bios firmware/opensbi-1.9-rv-bin/share/opensbi/lp64/generic/firmware/fw_jump.bin \
 *     --kernel tmp/uboot/uboot.elf --disk tmp/fat-test2.img --script tmp/fat-test3-cmd.txt -n 70000000
 * U-Boot 的原话（这就是"真固件读得懂"的证据）：
 *   part list virtio 0        →  1  2048  30720  00000000-01  0c Boot
 *   fatinfo virtio 0:1        →  Filesystem: FAT16 "TSIE       "
 *   fatls virtio 0:1          →  2037 TEST.TXT / 0 empty.bin / 2037 hello-long-name.txt
 *   fatls virtio 0:1 EFI/BOOT →  300000 BOOTRISCV64.EFI（子目录里的长名）
 *   fatload ... hello-long-name.txt → 2037 bytes read，crc32 = 0e3238c4
 *   fatload ... EFI/BOOT/BOOTRISCV64.EFI（300000 字节 = 147 个簇）→ crc32 = c4f63fa3
 * 两个 crc32 与宿主机的 zlib.crc32 逐位相同 ⇒ MBR、BPB、根目录、子目录、长名、
 * 簇链、数据区全部过了真固件的解析与搬运，不是"看起来像 FAT"。
 *
 * ESP 那一档（--part-type=0xEF）同样过了一遍：
 *   part list virtio 0 → 1  2048  47104  ef Boot
 *   fatls virtio 0:1   → 1048576 Image / 4096 initramfs.cpio.gz / 84 startup.nsh
 *   fatload virtio 0:1 <addr> Image（大小写混合的长名，正是引导脚本里的那条命令）
 *     → 1048576 bytes read，crc32 = 731dfd7e，与宿主机一致；分区类型只影响那一个字节。
 *
 * 踩坑记录：
 *   - U-Boot 的 crc32 命令把长度参数当**十六进制**解析（`crc32 <addr> 2037` 校验的是
 *     0x2037 = 8247 字节），第一次对不上就是这么来的 —— 传长度前先换成十六进制。
 *   - 空文件（长度 0、首簇 0）U-Boot 报的是 "0 bytes read" 而不是错误，正是期望行为。
 *   - 根目录那条卷标项（属性 0x08）U-Boot 在 fatls 里会跳过，但它的 8.3 名占着命名
 *     空间：卷标叫 TSIE 时，一个名为 tsie 的文件必须让开成 TSIE~1，否则两者同名。
 *
 * 用法:
 *   npx tsx tools/mkfat.ts <out.img> [--size=BYTES] [--part-type=0x0C] [--label=TSIE] \
 *                          NAME=HOSTPATH [NAME=HOSTPATH ...]
 *
 * 用户可见的文案走 tools/i18n/messages.tsv（与 tools/initramfs.ts 同一张表）。
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { loadMessages, type Translate } from './i18n/read.ts';

// ------------------------------------------------------------------ 常量

export const BYTES_PER_SECTOR = 512;
/** 分区起始 LBA：1 MiB 对齐，业界惯例（也正好躲开镜像头部可能出现的其它结构） */
export const PARTITION_LBA = 2048;
export const RESERVED_SECTORS = 1;
export const NUM_FATS = 2;
export const ROOT_ENTRIES = 512;
export const ROOT_DIR_SECTORS = (ROOT_ENTRIES * 32) / BYTES_PER_SECTOR;
/** FAT16 的合法簇数区间：低于下界固件会按 FAT12 解析，高于上界 16 位 FAT 装不下 */
export const FAT16_MIN_CLUSTERS = 4085;
export const FAT16_MAX_CLUSTERS = 65524;
/** 512 B/扇区下 FAT 允许的最大簇：64 KiB */
export const MAX_SECTORS_PER_CLUSTER = 128;
export const DEFAULT_PART_TYPE = 0x0c;
export const DEFAULT_LABEL = 'TSIE';
/** 自动定尺寸时的余量：文件总字节 + 这个数，再向上取整到整 MiB */
export const SIZE_SLACK_BYTES = 2 * 1024 * 1024;
/** 定长镜像超过这个大小就不在内存里拼了（Buffer 与内存都吃不消；ESP 场景远小于它） */
export const MAX_IMAGE_BYTES_IN_RAM = 1024 * 1024 * 1024;

const SECTOR_BYTES = BYTES_PER_SECTOR;
const MIB = 1024 * 1024;
/** 固定时间戳：2026-01-01 00:00:00 的 DOS 日期字（年份从 1980 起算） */
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
const OEM_NAME = 'TSIE';
const FS_TYPE = 'FAT16';
const LABEL_MAX = 11;
/** LFN 单个分量最多 255 个 UTF-16 码元（一个 0x0F 项装 13 个，最多 20 项） */
const LFN_MAX_UNITS = 255;
const LFN_UNITS_PER_ENTRY = 13;

const ATTR_READ_ONLY = 0x01;
const ATTR_HIDDEN = 0x02;
const ATTR_SYSTEM = 0x04;
const ATTR_VOLUME_ID = 0x08;
const ATTR_DIRECTORY = 0x10;
const ATTR_ARCHIVE = 0x20;
const ATTR_LFN = ATTR_READ_ONLY | ATTR_HIDDEN | ATTR_SYSTEM | ATTR_VOLUME_ID; // 0x0F

/** 8.3 名里合法的字符（其余一律映射成 '_'）。注意不含空格、点与中文 */
const SFN_ALLOWED = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$%'-_@~`!(){}^#&".split(''),
);
/** 8.3 名里明确非法的字符（点只作分隔符，另有专门检查） */
const SFN_FORBIDDEN = new Set(['<', '>', ':', '"', '|', '?', '*']);

// ------------------------------------------------------------------ 错误

/**
 * 用户可见的错误：只带文案 key 与参数，由 CLI 层查表翻译。
 *
 * 与 tools/initramfs.ts 同一套做法：这里抛出的 Error.message 只是 key ——
 * 真正给人看的那行必须来自 tools/i18n/messages.tsv，否则英文流程里会漏出中文。
 * 只有"不该发生"的内部断言才用普通 Error + 中文消息。
 */
export class MkfatError extends Error {
  readonly key: string;
  readonly args: Array<string | number>;

  constructor(key: string, args: Array<string | number> = []) {
    super(key);
    this.name = 'MkfatError';
    this.key = key;
    this.args = args;
  }
}

function fail(key: string, ...args: Array<string | number>): never {
  throw new MkfatError(key, args);
}

// ------------------------------------------------------------------ 名字

/**
 * 规范化镜像内的路径：反斜杠当分隔符（Windows 用户习惯）、去掉前导/重复的 '/'、
 * 丢掉 '.' 这种无意义分量。**不**在这里做合法性判断 —— 那需要错误上下文，
 * 统一交给 validateComponent()。
 */
export function normalizeImagePath(raw: string): string {
  const out: string[] = [];
  for (const part of raw.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    out.push(part);
  }
  return out.join('/');
}

/** 单个路径分量的合法性检查。path 是完整路径，只用于报错时定位。 */
function validateComponent(comp: string, path: string): void {
  if (comp === '') fail('fat.errNameEmpty', path);
  if (comp === '.' || comp === '..') fail('fat.errNameDot', path);
  if (comp.length > LFN_MAX_UNITS) fail('fat.errNameTooLong', path, comp.length);
  for (let i = 0; i < comp.length; i++) {
    const code = comp.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      fail('fat.errNameChar', path, `0x${code.toString(16).toUpperCase().padStart(2, '0')}`);
    }
    if (code >= 0xd800 && code <= 0xdfff) {
      // 高代理后面必须紧跟低代理，否则这个字符串根本没法编码成 UTF-16LE 名字
      const next = comp.charCodeAt(i + 1);
      if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { i++; continue; }
      fail('fat.errNameChar', path, `0x${code.toString(16).toUpperCase()}`);
    }
    if (SFN_FORBIDDEN.has(comp[i]!)) {
      fail('fat.errNameChar', path, `0x${code.toString(16).toUpperCase()}`);
    }
  }
  // 结尾的空格/点在 VFAT 里会被吞掉：长名 "A." 与 8.3 名 "A" 对不上，
  // 固件按长名找文件时行为随实现而异 —— 拒绝比"看起来成功了"好。
  if (comp.endsWith(' ') || comp.endsWith('.')) fail('fat.errNameTrail', path);
}

/** 单个字符映射成 8.3 合法字符；多字符的大写映射（如 ß→SS）也按非法处理 */
function sfnChar(ch: string): string {
  const up = ch.toUpperCase();
  return up.length === 1 && SFN_ALLOWED.has(up) ? up : '_';
}

function sanitizeSfn(text: string): string {
  let out = '';
  for (const ch of text) out += sfnChar(ch);
  return out;
}

/** 8.3 名 → 11 字节定长字段（BASE 补空格到 8 + EXT 补空格到 3）。目录项的"身份"就是它。 */
export function sfnField(shortName: string): string {
  const dot = shortName.lastIndexOf('.');
  const base = dot < 0 ? shortName : shortName.slice(0, dot);
  const ext = dot < 0 ? '' : shortName.slice(dot + 1);
  return base.padEnd(8, ' ').slice(0, 8) + ext.padEnd(3, ' ').slice(0, 3);
}

/** 11 字节字段 → 给人看的 8.3 名（去掉填充空格） */
export function sfnText(field: string): string {
  const base = field.slice(0, 8).replace(/ +$/, '');
  const ext = field.slice(8, 11).replace(/ +$/, '');
  return ext === '' ? base : `${base}.${ext}`;
}

/** VFAT 校验和：对 11 字节的 8.3 名做移位累加，长名项靠它跟短名配对 */
export function lfnChecksum(field: string): number {
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    sum = ((((sum & 1) << 7) + (sum >> 1) + field.charCodeAt(i)) & 0xff) >>> 0;
  }
  return sum;
}

/** 长名要几个 0x0F 项（每项 13 个 UTF-16 码元，向上取整） */
function lfnEntryCount(name: string): number {
  return Math.ceil(name.length / LFN_UNITS_PER_ENTRY);
}

/**
 * 由长名生成 8.3 短名，并保证在**同一个目录内**不重复（used 是 11 字节字段的集合，
 * 大小写不敏感是天然的 —— 字段本身就全大写）。
 *
 * 规则（对齐 VFAT 的实际行为，也是"数字尾巴规则"那部分）：
 *   1. 最后一个点之前是名字、之后是扩展名；点开头的名字（.gitignore）不拆扩展名；
 *      其余的点在 8.3 里非法，直接删掉。
 *   2. 非法字符（空格、中文、+ , ; = [ ] 等）映射成 '_'。
 *   3. 如果映射后本来就是个合法 8.3 形状（名字 ≤ 8、扩展名 ≤ 3），**原样用大写形式** ——
 *      所以 `file~1.txt` 得到 `FILE~1.TXT`，不会变成 `FILE~1~1.TXT`；大小写差异不影响
 *      8.3 名，只是额外带一个长名项。
 *   4. 否则截断名字腾出 `~N` 的位置：`~1`…`~9` 留 6 个字符，`~10` 以上只能留 5 个。
 *      名字自带 `~数字` 尾巴时（"verylongname~3"），那个尾巴当编号起点保留下来。
 *   5. 仍是空名字（如 "..."）说明没法编码，报错而不是硬凑一个。
 */
function makeShortName(
  name: string,
  path: string,
  used: Set<string>,
): { field: string; lfnCount: number } {
  let base = name;
  let ext = '';
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    base = name.slice(0, dot);
    ext = name.slice(dot + 1);
  }
  const sBase = sanitizeSfn(base.split('.').join(''));
  const sExt = sanitizeSfn(ext).slice(0, 3);
  if (sBase === '') fail('fat.errNameUnencodable', path);

  const withLfn = (field: string): { field: string; lfnCount: number } => ({
    field,
    // 8.3 名严格等于原名（全大写 8.3）时不需要长名项
    lfnCount: name === sfnText(field) ? 0 : lfnEntryCount(name),
  });

  if (sBase.length <= 8 && sExt.length <= 3) {
    const field = sfnField(sExt === '' ? sBase : `${sBase}.${sExt}`);
    if (!used.has(field)) { used.add(field); return withLfn(field); }
  }

  // 名字自带 ~数字 尾巴时把编号接上（数字尾巴规则），否则从 1 开始
  const tail = /^(.*?)~(\d+)$/.exec(sBase);
  const stem = tail === null ? sBase : tail[1]!;
  const first = tail === null ? 1 : Number.parseInt(tail[2]!, 10);

  for (let n = first; n <= 999999; n++) {
    const suffix = `~${n}`;
    const keep = 8 - suffix.length;
    if (keep < 1) break;
    const candidate = stem.slice(0, keep) + suffix;
    const field = sfnField(sExt === '' ? candidate : `${candidate}.${sExt}`);
    if (!used.has(field)) { used.add(field); return withLfn(field); }
  }
  fail('fat.errNameUnencodable', path);
}

/**
 * 长名的 0x0F 目录项，按**物理顺序**返回（长名尾部的项在前，带 0x40 的那项紧贴 8.3 项）。
 */
export function lfnEntries(name: string, field: string): Buffer[] {
  const checksum = lfnChecksum(field);
  const units: number[] = [];
  for (let i = 0; i < name.length; i++) units.push(name.charCodeAt(i));

  const chunks: number[][] = [];
  for (let p = 0; p < units.length; p += LFN_UNITS_PER_ENTRY) {
    chunks.push(units.slice(p, p + LFN_UNITS_PER_ENTRY));
  }

  const items: Buffer[] = [];
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]!;
    const entry = Buffer.alloc(32, 0xff);
    entry[0] = (c + 1) | (c === chunks.length - 1 ? 0x40 : 0);
    entry[11] = ATTR_LFN;
    entry[12] = 0; // 类型：长名项必须为 0
    entry[13] = checksum;
    entry.writeUInt16LE(0, 26); // 长名项的首簇必须是 0
    const slots = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
    for (let i = 0; i < slots.length; i++) {
      const code = i < chunk.length ? chunk[i]! : i === chunk.length ? 0 : 0xffff;
      entry.writeUInt16LE(code, slots[i]!);
    }
    items.push(entry);
  }
  items.reverse(); // 物理上倒序：最后一段在前
  return items;
}

/** 普通 8.3 目录项（文件 / 目录 / 卷标都用它） */
function directoryEntry(opts: {
  field: string;
  attr: number;
  cluster: number;
  size: number;
}): Buffer {
  const e = Buffer.alloc(32);
  Buffer.from(opts.field, 'latin1').copy(e, 0, 0, 11);
  e[11] = opts.attr;
  e[12] = 0; // NT 保留
  e[13] = 0; // 创建时间 1/10 秒
  e.writeUInt16LE(DOS_TIME, 14);
  e.writeUInt16LE(DOS_DATE, 16);
  e.writeUInt16LE(DOS_DATE, 18); // 最后访问日期
  e.writeUInt16LE(Math.floor(opts.cluster / 0x10000), 20); // 首簇高 16 位
  e.writeUInt16LE(DOS_TIME, 22);
  e.writeUInt16LE(DOS_DATE, 24);
  e.writeUInt16LE(opts.cluster & 0xffff, 26); // 首簇低 16 位
  e.writeUInt32LE(opts.size >>> 0, 28);
  return e;
}

// ------------------------------------------------------------ 布局计算

export interface Layout {
  imageSize: number;
  partitionLba: number;
  partitionSectors: number;
  partType: number;
  bytesPerSector: number;
  sectorsPerCluster: number;
  clusterBytes: number;
  reservedSectors: number;
  numFats: number;
  fatSectors: number;
  rootEntries: number;
  rootDirSectors: number;
  /** 卷内总扇区数（= 分区长度；BPB 的 TotSec16/TotSec32 就是它） */
  totalSectors: number;
  clusters: number;
  dataSectors: number;
  fatLba: number;
  rootLba: number;
  dataLba: number;
  serial: number;
  label: string;
}

/**
 * 给定卷扇区数与簇大小，解出 FAT 需要的扇区数和最终簇数。
 *
 * 这里有自洽问题：FAT 大小取决于簇数，簇数又取决于 FAT 大小。fat 越大 ⇒ 数据区越小 ⇒
 * 簇数越少 ⇒ 需要的 FAT 越小，所以约束 `簇数 ≤ fat*512/2 - 2`（减 2 是 FAT[0]/FAT[1]
 * 两个保留项）对 fat 单调，直接二分出**最小**的合法 fat —— 取最小是为了让簇数最大、
 * 不浪费一个扇区（简单的迭代逼近在这里会在两个值之间来回震荡，边界上差一个扇区）。
 */
export function layoutForVolume(totalSectors: number, spc: number): { fatSectors: number; clusters: number } {
  const capacity = (fat: number): number => Math.floor((fat * SECTOR_BYTES) / 2) - 2;
  const clustersWith = (fat: number): number =>
    Math.floor((totalSectors - RESERVED_SECTORS - NUM_FATS * fat - ROOT_DIR_SECTORS) / spc);

  const hi = Math.max(1, Math.ceil(((Math.floor(totalSectors / spc) + 2) * 2) / SECTOR_BYTES));
  let lo = 1;
  let high = hi;
  const ok = (fat: number): boolean => {
    const clusters = clustersWith(fat);
    return clusters > 0 && clusters <= capacity(fat);
  };
  if (!ok(high)) return { fatSectors: high, clusters: Math.max(0, clustersWith(high)) };
  while (lo < high) {
    const mid = (lo + high) >> 1;
    if (ok(mid)) high = mid; else lo = mid + 1;
  }
  return { fatSectors: lo, clusters: clustersWith(lo) };
}

/**
 * 挑簇大小：从 128 扇区（64 KiB，FAT 规范上限）往下试，取第一个让簇数落在
 * 4085…65524 的值。这样簇大小永远"刚好没掉进 FAT12 区间"，同时簇数尽量少、FAT 尽量小。
 * 一个都不满足（卷太小或太大）返回 null，由调用方报错。
 */
export function chooseSectorsPerCluster(totalSectors: number): number | null {
  for (let spc = MAX_SECTORS_PER_CLUSTER; spc >= 1; spc >>= 1) {
    const { clusters } = layoutForVolume(totalSectors, spc);
    if (clusters >= FAT16_MIN_CLUSTERS && clusters <= FAT16_MAX_CLUSTERS) return spc;
  }
  return null;
}

/** 能装下 4085 个簇的最小卷（扇区）。比它还小的卷在 FAT16 里表达不出来。 */
export function minVolumeSectors(): number {
  const start = FAT16_MIN_CLUSTERS + 2 + RESERVED_SECTORS + ROOT_DIR_SECTORS;
  for (let s = start; s < start + 4096; s++) if (chooseSectorsPerCluster(s) !== null) return s;
  throw new Error('找不到 FAT16 的最小合法卷大小 —— 布局计算有漏洞');
}

/** FAT16 能表达的最大卷（扇区）：簇数到顶、簇大小到顶。 */
function maxVolumeSectors(): number {
  const fat = Math.ceil(((FAT16_MAX_CLUSTERS + 2) * 2) / SECTOR_BYTES);
  return FAT16_MAX_CLUSTERS * MAX_SECTORS_PER_CLUSTER + RESERVED_SECTORS + NUM_FATS * fat + ROOT_DIR_SECTORS;
}

export const FAT16_MAX_IMAGE_BYTES = (PARTITION_LBA + maxVolumeSectors()) * SECTOR_BYTES;
export const MIN_IMAGE_BYTES = Math.ceil(((PARTITION_LBA + minVolumeSectors()) * SECTOR_BYTES) / MIB) * MIB;

/** 卷序列号：由卷标 + 卷扇区数 + 簇大小派生，同样的输入必得同样的号（不是写死常量） */
export function volumeSerial(label: string, totalSectors: number, spc: number): number {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(`${label}|${totalSectors}|${spc}`, 'utf8')) {
    h = (h ^ b) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h === 0 ? 1 : h;
}

// ------------------------------------------------------------ 目录树

interface Node {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  data: Buffer;
  children: Node[];
  byName: Map<string, Node>;
  /** 11 字节的 8.3 字段 */
  field: string;
  lfnCount: number;
  /** 目录自己写进目录区的 32 字节目录项总数（含长名项、卷标项、'.'/'..'） */
  dirEntries: number;
  firstCluster: number;
  clusters: number;
}

function makeNode(kind: 'file' | 'dir', name: string, path: string, data: Buffer): Node {
  return {
    name, path, kind, data,
    children: [], byName: new Map(),
    field: '', lfnCount: 0, dirEntries: 0,
    firstCluster: 0, clusters: 0,
  };
}

/**
 * 由 `NAME=HOSTPATH` 列表建出镜像内的目录树。
 *
 * 重名按**大小写不敏感**判重：FAT 的命名空间本来就不区分大小写，
 * 同时放进 `readme.txt` 与 `README.TXT` 只会让固件按 LFN 匹配时结果随机 —— 报错更好。
 */
function buildTree(files: Array<{ name: string; data: Buffer }>): Node {
  const root = makeNode('dir', '', '', Buffer.alloc(0));
  for (const f of files) {
    const path = normalizeImagePath(f.name);
    if (path === '') fail('fat.errNameEmpty', f.name);
    const comps = path.split('/');
    let dir = root;
    for (let i = 0; i < comps.length; i++) {
      const comp = comps[i]!;
      const sub = comps.slice(0, i + 1).join('/');
      validateComponent(comp, sub);
      const key = comp.toUpperCase();
      const existing = dir.byName.get(key);
      if (i === comps.length - 1) {
        if (existing) fail('fat.errDupName', sub);
        const node = makeNode('file', comp, sub, f.data);
        dir.children.push(node);
        dir.byName.set(key, node);
      } else if (existing) {
        if (existing.kind === 'file') fail('fat.errPathConflict', sub);
        dir = existing;
      } else {
        const node = makeNode('dir', comp, sub, Buffer.alloc(0));
        dir.children.push(node);
        dir.byName.set(key, node);
        dir = node;
      }
    }
  }
  sortTree(root);
  return root;
}

function sortTree(dir: Node): void {
  dir.children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const c of dir.children) if (c.kind === 'dir') sortTree(c);
}

/** 给每个目录的孩子分配 8.3 名（顺便统计目录项数），顺序固定 ⇒ 编号固定 ⇒ 产物确定 */
function assignShortNames(dir: Node, isRoot: boolean, labelField: string): void {
  const used = new Set<string>();
  if (isRoot) used.add(labelField); // 卷标项也占一个名字，别让同名文件跟它撞
  for (const child of dir.children) {
    const { field, lfnCount } = makeShortName(child.name, child.path, used);
    child.field = field;
    child.lfnCount = lfnCount;
  }
  let entries = isRoot ? 1 : 2; // 根目录是卷标项；子目录是 '.' 与 '..'
  for (const child of dir.children) entries += child.lfnCount + 1;
  dir.dirEntries = entries;
  for (const child of dir.children) if (child.kind === 'dir') assignShortNames(child, false, labelField);
}

/** 该目录树在各簇大小下需要多少个数据簇（根目录不占数据簇，它有自己的固定区域） */
function clustersNeeded(dir: Node, clusterBytes: number, isRoot: boolean): number {
  let need = 0;
  if (!isRoot) need += Math.max(1, Math.ceil((dir.dirEntries * 32) / clusterBytes));
  for (const child of dir.children) {
    if (child.kind === 'file') {
      need += child.data.length === 0 ? 0 : Math.ceil(child.data.length / clusterBytes);
    } else {
      need += Math.max(1, Math.ceil((child.dirEntries * 32) / clusterBytes));
      need += clustersNeeded(child, clusterBytes, false);
    }
  }
  return need;
}

// ------------------------------------------------------------ 镜像组装

export interface PlacedEntry {
  path: string;
  shortName: string;
  kind: 'file' | 'dir';
  size: number;
  firstCluster: number;
  clusters: number;
}

export interface BuiltImage {
  buf: Buffer;
  layout: Layout;
  /** 按簇分配顺序排列，便于打印与测试 */
  entries: PlacedEntry[];
  /** 自动定尺寸时被抬到 FAT16 的最小体积 —— CLI 要提示用户 */
  sizeBumped: boolean;
}

export interface BuildOptions {
  files: Array<{ name: string; data: Buffer }>;
  /** 镜像总字节数；省略则按"文件总字节 + 2 MiB 余量、向上取整到 MiB"自动定 */
  size?: number;
  partType?: number;
  label?: string;
}

interface Ctx {
  buf: Buffer;
  layout: Layout;
  /** 簇号 → 下一簇（0xFFFF 表示链尾）；索引 0/1 是保留项 */
  fat: Uint16Array;
  next: number;
  entries: PlacedEntry[];
}

function clusterOffset(layout: Layout, cluster: number): number {
  return (layout.dataLba + (cluster - 2) * layout.sectorsPerCluster) * SECTOR_BYTES;
}

function labelFieldOf(label: string): string {
  return label.padEnd(LABEL_MAX, ' ');
}

function planLayout(imageSize: number, partType: number, label: string): Layout | null {
  const totalImageSectors = Math.floor(imageSize / SECTOR_BYTES);
  const partitionSectors = totalImageSectors - PARTITION_LBA;
  if (partitionSectors <= 0) return null;
  const spc = chooseSectorsPerCluster(partitionSectors);
  if (spc === null) return null;
  const { fatSectors, clusters } = layoutForVolume(partitionSectors, spc);
  if (clusters < FAT16_MIN_CLUSTERS || clusters > FAT16_MAX_CLUSTERS) return null;
  const fatLba = PARTITION_LBA + RESERVED_SECTORS;
  const rootLba = fatLba + NUM_FATS * fatSectors;
  const dataLba = rootLba + ROOT_DIR_SECTORS;
  return {
    imageSize,
    partitionLba: PARTITION_LBA,
    partitionSectors,
    partType,
    bytesPerSector: SECTOR_BYTES,
    sectorsPerCluster: spc,
    clusterBytes: spc * SECTOR_BYTES,
    reservedSectors: RESERVED_SECTORS,
    numFats: NUM_FATS,
    fatSectors,
    rootEntries: ROOT_ENTRIES,
    rootDirSectors: ROOT_DIR_SECTORS,
    totalSectors: partitionSectors,
    clusters,
    dataSectors: partitionSectors - (dataLba - PARTITION_LBA),
    fatLba,
    rootLba,
    dataLba,
    serial: volumeSerial(label, partitionSectors, spc),
    label,
  };
}

/** 校验并规范化卷标：FAT 的卷标是 11 字节字段，惯例大写、空格补齐 */
function normalizeLabel(raw: string): string {
  const label = raw.toUpperCase();
  if (label.length === 0 || label.length > LABEL_MAX) fail('fat.errLabel', raw, LABEL_MAX);
  for (const ch of label) {
    if (ch !== ' ' && !SFN_ALLOWED.has(ch)) fail('fat.errLabel', raw, LABEL_MAX);
  }
  return label;
}

export function buildImage(opts: BuildOptions): BuiltImage {
  const label = normalizeLabel(opts.label ?? DEFAULT_LABEL);
  const partType = opts.partType ?? DEFAULT_PART_TYPE;
  if (!Number.isInteger(partType) || partType < 0 || partType > 0xff) fail('fat.errPartType', String(partType));

  const tree = buildTree(opts.files);
  assignShortNames(tree, true, labelFieldOf(label));
  if (tree.dirEntries > ROOT_ENTRIES) fail('fat.errRootFull', tree.dirEntries, ROOT_ENTRIES);

  const payload = opts.files.reduce((sum, f) => sum + f.data.length, 0);

  // ---- 定尺寸 ----
  let sizeBumped = false;
  let imageSize: number;
  if (opts.size !== undefined) {
    if (!Number.isFinite(opts.size) || opts.size <= 0) fail('fat.errSizeSyntax', String(opts.size));
    imageSize = Math.ceil(opts.size / SECTOR_BYTES) * SECTOR_BYTES; // 非整扇区向上取整
    if (imageSize > FAT16_MAX_IMAGE_BYTES) fail('fat.errTooLarge', imageSize, FAT16_MAX_IMAGE_BYTES);
    if (imageSize > MAX_IMAGE_BYTES_IN_RAM) fail('fat.errTooLargeRam', imageSize, MAX_IMAGE_BYTES_IN_RAM);
  } else {
    imageSize = Math.ceil((payload + SIZE_SLACK_BYTES) / MIB) * MIB;
    if (imageSize < MIN_IMAGE_BYTES) { imageSize = MIN_IMAGE_BYTES; sizeBumped = true; }
    if (imageSize > FAT16_MAX_IMAGE_BYTES) fail('fat.errTooLarge', imageSize, FAT16_MAX_IMAGE_BYTES);
  }

  // ---- 定布局（自动尺寸时如果装不下就继续长大 1 MiB，直到装得下）----
  let layout = planLayout(imageSize, partType, label);
  for (;;) {
    if (layout === null) {
      if (opts.size !== undefined) {
        // 括号里的数字要跟文案对上：太小报"最小镜像"，其余报"FAT16 容量上限"
        if (imageSize < MIN_IMAGE_BYTES) fail('fat.errSizeTooSmall', imageSize, MIN_IMAGE_BYTES);
        fail('fat.errTooLarge', imageSize, FAT16_MAX_IMAGE_BYTES);
      }
      imageSize += MIB;
      if (imageSize > FAT16_MAX_IMAGE_BYTES) fail('fat.errTooLarge', imageSize, FAT16_MAX_IMAGE_BYTES);
      layout = planLayout(imageSize, partType, label);
      continue;
    }
    const need = clustersNeeded(tree, layout.clusterBytes, true);
    if (need <= layout.clusters) break;
    if (opts.size !== undefined) fail('fat.errPayloadTooBig', payload, imageSize, layout.clusters, need);
    imageSize += MIB;
    if (imageSize > FAT16_MAX_IMAGE_BYTES) fail('fat.errTooLarge', imageSize, FAT16_MAX_IMAGE_BYTES);
    layout = planLayout(imageSize, partType, label);
  }

  // ---- 组装：全零 Buffer，只有结构区和文件数据被写进去 ----
  const buf = Buffer.alloc(imageSize);
  writeMbr(buf, layout);
  writeBootSector(buf, layout);

  const ctx: Ctx = {
    buf,
    layout,
    fat: new Uint16Array(layout.clusters + 2),
    next: 2,
    entries: [],
  };
  ctx.fat[0] = 0xfff8; // 介质描述符与 BPB 的 Media 字节一致
  ctx.fat[1] = 0xffff; // 干净标志：有些驱动会检查 FAT[1] 的最高位

  placeDirectory(ctx, tree, 0, 0);
  writeFatCopies(ctx);
  checkChains(ctx, tree);

  return { buf, layout, entries: ctx.entries, sizeBumped };
}

/**
 * 分配一段**连续**的簇链（连续只是分配策略，读的时候仍然按 FAT 链走）。
 * 分配到的簇如果超出容量说明容量检查有漏洞 —— 那是内部错误，直接抛。
 */
function allocClusters(ctx: Ctx, count: number): number {
  if (count <= 0) return 0;
  const first = ctx.next;
  if (first - 2 + count > ctx.layout.clusters) {
    throw new Error(
      `FAT16 簇不足：还要 ${count} 个，只剩 ${ctx.layout.clusters - (first - 2)} 个 —— 容量检查有漏洞`,
    );
  }
  for (let i = 0; i < count; i++) {
    const c = first + i;
    ctx.fat[c] = i === count - 1 ? 0xffff : c + 1;
  }
  ctx.next = first + count;
  return first;
}

/** 沿 FAT 链把数据写进数据区；最后一个簇尾部不写 —— 全零 Buffer 天然就是补零 */
function writeChain(ctx: Ctx, first: number, data: Buffer): void {
  const { clusterBytes } = ctx.layout;
  let c = first;
  let off = 0;
  while (off < data.length) {
    const n = Math.min(clusterBytes, data.length - off);
    data.copy(ctx.buf, clusterOffset(ctx.layout, c), off, off + n);
    off += n;
    if (off < data.length) {
      c = ctx.fat[c]!;
      if (c >= 0xfff8) throw new Error('FAT 链提前结束 —— 簇链构造有漏洞');
    }
  }
}

/** 把一个目录的所有 32 字节目录项写进它的簇链（或根目录的固定区域） */
function writeDirectoryTable(ctx: Ctx, dir: Node, ownFirst: number, items: Buffer[]): void {
  const l = ctx.layout;
  if (dir.path === '') {
    // 根目录是固定区域，写超了会踩进数据区 —— 这道闸必须在这里（容量检查在前，这里是兜底）
    if (items.length > l.rootEntries) fail('fat.errRootFull', items.length, l.rootEntries);
    const base = l.rootLba * SECTOR_BYTES;
    items.forEach((item, i) => item.copy(ctx.buf, base + i * 32));
    return; // 其余 0x00 项由全零 Buffer 提供 —— 那正是"目录到此结束"的标记
  }
  const perCluster = l.clusterBytes / 32;
  let c = ownFirst;
  for (let i = 0; i < items.length; i++) {
    if (i > 0 && i % perCluster === 0) c = ctx.fat[c]!;
    items[i]!.copy(ctx.buf, clusterOffset(l, c) + (i % perCluster) * 32);
  }
}

/**
 * 递归写一个目录：先给子项分配簇（子目录也要在这里拿到首簇，父目录的目录项得记它），
 * 写完本目录的目录项后再进子目录 —— 顺序固定，产物才确定。
 */
function placeDirectory(ctx: Ctx, dir: Node, ownFirst: number, parentFirst: number): void {
  const items: Buffer[] = [];
  if (dir.path === '') {
    items.push(directoryEntry({ field: labelFieldOf(ctx.layout.label), attr: ATTR_VOLUME_ID, cluster: 0, size: 0 }));
  } else {
    items.push(directoryEntry({ field: '.'.padEnd(11, ' '), attr: ATTR_DIRECTORY, cluster: ownFirst, size: 0 }));
    // FAT16 里根目录的簇号是 0（不在数据区），所以顶层目录的 '..' 指向 0
    items.push(directoryEntry({ field: '..'.padEnd(11, ' '), attr: ATTR_DIRECTORY, cluster: parentFirst, size: 0 }));
  }

  for (const child of dir.children) {
    if (child.lfnCount > 0) items.push(...lfnEntries(child.name, child.field));
    if (child.kind === 'file') {
      child.clusters = child.data.length === 0 ? 0 : Math.ceil(child.data.length / ctx.layout.clusterBytes);
      child.firstCluster = allocClusters(ctx, child.clusters);
      if (child.clusters > 0) writeChain(ctx, child.firstCluster, child.data);
      items.push(directoryEntry({
        field: child.field, attr: ATTR_ARCHIVE, cluster: child.firstCluster, size: child.data.length,
      }));
    } else {
      child.clusters = Math.max(1, Math.ceil((child.dirEntries * 32) / ctx.layout.clusterBytes));
      child.firstCluster = allocClusters(ctx, child.clusters);
      items.push(directoryEntry({ field: child.field, attr: ATTR_DIRECTORY, cluster: child.firstCluster, size: 0 }));
    }
    ctx.entries.push({
      path: child.path,
      shortName: sfnText(child.field),
      kind: child.kind,
      size: child.kind === 'file' ? child.data.length : 0,
      firstCluster: child.firstCluster,
      clusters: child.clusters,
    });
  }

  writeDirectoryTable(ctx, dir, ownFirst, items);
  for (const child of dir.children) if (child.kind === 'dir') placeDirectory(ctx, child, child.firstCluster, ownFirst);
}

function writeFatCopies(ctx: Ctx): void {
  const bytes = ctx.layout.fatSectors * SECTOR_BYTES;
  const table = Buffer.alloc(bytes);
  for (let i = 0; i < ctx.fat.length; i++) table.writeUInt16LE(ctx.fat[i]!, i * 2);
  for (let k = 0; k < ctx.layout.numFats; k++) {
    table.copy(ctx.buf, (ctx.layout.fatLba + k * ctx.layout.fatSectors) * SECTOR_BYTES);
  }
}

/**
 * 自检：所有已分配的簇必须恰好被某条链引用一次，且链长与记录一致。
 * 这是"不该发生"的断言 —— 真错了说明本文件的分配逻辑有漏洞，早死早超生，
 * 免得固件报一句语法不通的 I/O 错误让人去猜。
 */
function checkChains(ctx: Ctx, root: Node): void {
  const seen = new Set<number>();
  let visited = 0;
  const walk = (node: Node, first: number, count: number): void => {
    let c = first;
    let n = 0;
    while (c !== 0 && c < 0xfff8) {
      if (c < 2 || c >= ctx.next) throw new Error(`${node.path}: 簇号 ${c} 越界`);
      if (seen.has(c)) throw new Error(`${node.path}: 簇 ${c} 被两条链引用`);
      seen.add(c);
      n++;
      if (n > count) throw new Error(`${node.path}: 簇链比记录的 ${count} 长`);
      c = ctx.fat[c]!;
      if (c !== 0 && c < 0xfff8 && (c < 2 || c >= ctx.next)) {
        throw new Error(`${node.path}: 簇链里出现非法簇号 ${c}`);
      }
    }
    if (n !== count) throw new Error(`${node.path}: 簇链长 ${n}，记录是 ${count}`);
    visited += n;
  };
  const walkDir = (dir: Node): void => {
    for (const child of dir.children) {
      if (child.kind === 'dir') {
        walk(child, child.firstCluster, child.clusters);
        walkDir(child);
      } else {
        walk(child, child.firstCluster, child.clusters);
      }
    }
  };
  walkDir(root);
  if (visited !== ctx.next - 2) {
    throw new Error(`簇泄漏：已分配 ${ctx.next - 2} 个，可追溯 ${visited} 个`);
  }
}

// -------------------------------------------------------- MBR 与 BPB

/** LBA → 传统 CHS（255 头 63 扇区/道）。超过 1023 柱面按惯例钳到 1023/254/63。 */
function writeChs(buf: Buffer, off: number, lba: number): void {
  const heads = 255;
  const sectors = 63;
  let cyl = Math.floor(lba / (heads * sectors));
  const rem = lba % (heads * sectors);
  let head = Math.floor(rem / sectors);
  let sector = (rem % sectors) + 1;
  if (cyl > 1023) { cyl = 1023; head = 254; sector = 63; }
  buf[off] = head & 0xff;
  buf[off + 1] = ((sector & 0x3f) | ((cyl >> 2) & 0xc0)) & 0xff;
  buf[off + 2] = cyl & 0xff;
}

function writeMbr(buf: Buffer, layout: Layout): void {
  const e = 446;
  buf[e] = 0x80; // 可引导
  writeChs(buf, e + 1, layout.partitionLba);
  buf[e + 4] = layout.partType;
  writeChs(buf, e + 5, layout.partitionLba + layout.partitionSectors - 1);
  buf.writeUInt32LE(layout.partitionLba, e + 8);
  buf.writeUInt32LE(layout.partitionSectors, e + 12);
  // 其余三个分区项保持全零（part list 会显示成空项）
  buf[510] = 0x55;
  buf[511] = 0xaa;
}

function writeBootSector(buf: Buffer, layout: Layout): void {
  const b = layout.partitionLba * SECTOR_BYTES;
  const put = (off: number, text: string): void => {
    Buffer.from(text, 'latin1').copy(buf, b + off, 0, text.length);
  };
  // jmp + nop：引导扇区的传统开头（我们不放引导代码，但格式要像）
  buf[b] = 0xeb; buf[b + 1] = 0x3c; buf[b + 2] = 0x90;
  put(0x03, OEM_NAME.padEnd(8, ' '));
  buf.writeUInt16LE(layout.bytesPerSector, b + 0x0b);
  buf[b + 0x0d] = layout.sectorsPerCluster;
  buf.writeUInt16LE(layout.reservedSectors, b + 0x0e);
  buf[b + 0x10] = layout.numFats;
  buf.writeUInt16LE(layout.rootEntries, b + 0x11);
  // 扇区数放 16 位字段还是 32 位字段：<= 65535 用 16 位，否则 16 位填 0
  const fits16 = layout.totalSectors <= 0xffff;
  buf.writeUInt16LE(fits16 ? layout.totalSectors : 0, b + 0x13);
  buf[b + 0x15] = 0xf8; // 固定盘介质描述符
  buf.writeUInt16LE(layout.fatSectors, b + 0x16);
  buf.writeUInt16LE(63, b + 0x18);
  buf.writeUInt16LE(255, b + 0x1a);
  buf.writeUInt32LE(layout.partitionLba, b + 0x1c); // 隐藏扇区 = 分区前的扇区数
  buf.writeUInt32LE(fits16 ? 0 : layout.totalSectors, b + 0x20);
  buf[b + 0x24] = 0x80; // 驱动器号
  buf[b + 0x25] = 0x00;
  buf[b + 0x26] = 0x29; // 扩展引导签名：后面跟着序列号/卷标/文件系统类型
  buf.writeUInt32LE(layout.serial, b + 0x27);
  put(0x2b, labelFieldOf(layout.label));
  put(0x36, FS_TYPE.padEnd(8, ' '));
  buf[b + 510] = 0x55;
  buf[b + 511] = 0xaa;
}

// ------------------------------------------------------------------ CLI

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

const defaultIo: CliIo = {
  out: (s) => { process.stdout.write(s + '\n'); },
  err: (s) => { process.stderr.write(s + '\n'); },
};

function usage(t: Translate, io: CliIo): void {
  io.err(t('fat.usage'));
}

/** 解析尺寸：纯字节数，或带 K/M/G 后缀（1 M = 1 MiB） */
function parseSize(raw: string): number {
  const m = /^(\d+)([kKmMgG])?$/.exec(raw.trim());
  if (m === null) fail('fat.errSizeSyntax', raw);
  const scale = m[2] === undefined ? 1 : { k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }[m[2].toLowerCase() as 'k' | 'm' | 'g'];
  return Number.parseInt(m[1]!, 10) * scale;
}

function parsePartType(raw: string): number {
  const m = /^(0x[0-9a-fA-F]{1,2}|[0-9]{1,3})$/.exec(raw.trim());
  if (m === null) fail('fat.errPartType', raw);
  const v = m[1]!.startsWith('0x') ? Number.parseInt(m[1]!.slice(2), 16) : Number.parseInt(m[1]!, 10);
  if (!Number.isInteger(v) || v < 1 || v > 0xff) fail('fat.errPartType', raw);
  return v;
}

function readHostFile(path: string): Buffer {
  let st;
  try {
    st = statSync(path);
  } catch {
    return fail('fat.errMissingFile', path);
  }
  if (!st.isFile()) fail('fat.errNotFile', path);
  return readFileSync(path);
}

export function main(argv: string[], io: CliIo = defaultIo): number {
  const { t } = loadMessages();
  const err = (s: string): void => { io.err(`${t('error.prefix')} ${s}`); };

  try {
    const positional: string[] = [];
    let size: number | undefined;
    let partType = DEFAULT_PART_TYPE;
    let label = DEFAULT_LABEL;

    for (const arg of argv) {
      if (arg === '--help' || arg === '-h') { usage(t, io); return 0; }
      if (arg.startsWith('--size=')) { size = parseSize(arg.slice('--size='.length)); continue; }
      if (arg.startsWith('--part-type=')) { partType = parsePartType(arg.slice('--part-type='.length)); continue; }
      if (arg.startsWith('--label=')) { label = arg.slice('--label='.length); continue; }
      if (arg.startsWith('-')) fail('fat.errUnknownOpt', arg);
      positional.push(arg);
    }

    const [outPath, ...assignments] = positional;
    if (outPath === undefined) { usage(t, io); return 2; }
    if (assignments.length === 0) { err(t('fat.errNoFiles')); return 2; }

    const files = assignments.map((a) => {
      const eq = a.indexOf('=');
      if (eq <= 0 || eq === a.length - 1) fail('fat.errBadAssign', a);
      return { name: a.slice(0, eq), data: readHostFile(a.slice(eq + 1)) };
    });

    const built = buildImage({ files, ...(size === undefined ? {} : { size }), partType, label });
    writeFileSync(outPath, built.buf);

    const l = built.layout;
    const dirs = built.entries.filter((e) => e.kind === 'dir').length;
    const bytes = built.entries.reduce((sum, e) => sum + e.size, 0);
    io.out(t('fat.wrote', outPath, l.imageSize, built.entries.length - dirs, dirs, bytes));
    io.out(t('fat.mbr', `0x${l.partType.toString(16).toUpperCase().padStart(2, '0')}`, l.partitionLba, l.partitionSectors));
    io.out(t(
      'fat.layout',
      l.sectorsPerCluster,
      l.clusterBytes,
      l.clusters,
      l.fatSectors,
      l.reservedSectors,
      l.rootEntries,
    ));
    io.out(t('fat.volume', l.label, l.serial.toString(16).toUpperCase().padStart(8, '0'), OEM_NAME));
    io.out(t('fat.clusterNote'));
    if (size === undefined) {
      io.out(t('fat.autoSize', bytes, l.imageSize));
      if (built.sizeBumped) io.out(t('fat.autoSizeBumped', MIN_IMAGE_BYTES));
    }
    for (const e of built.entries) {
      io.out(t('fat.entry', e.path, e.shortName, e.kind === 'dir' ? t('fat.kindDir') : t('fat.kindFile'), e.size, e.clusters));
    }
    return 0;
  } catch (caught) {
    if (caught instanceof MkfatError) {
      err(t(caught.key, ...caught.args));
      return 1;
    }
    err(caught instanceof Error ? caught.message : String(caught));
    return 1;
  }
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  process.exit(main(process.argv.slice(2)));
}
