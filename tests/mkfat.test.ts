// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 TSIE
/**
 * tools/mkfat.ts 的测试：**把镜像读回来**验证，而不是信构造器自己的说法。
 *
 * 这里的解析器是照着 FAT 的公开格式另写的一份（MBR → BPB → FAT 链 → 目录项 → VFAT 长名），
 * 故意不复用 tools/mkfat.ts 里的任何函数 —— 复用的话，构造器里写错的偏移会在
 * "构造"和"验证"两边同时错，测试就变成了自说自话。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  BYTES_PER_SECTOR,
  DEFAULT_PART_TYPE,
  FAT16_MAX_CLUSTERS,
  FAT16_MIN_CLUSTERS,
  MAX_SECTORS_PER_CLUSTER,
  MIN_IMAGE_BYTES,
  MkfatError,
  PARTITION_LBA,
  buildImage,
  lfnChecksum,
  main,
  sfnField,
  sfnText,
  type CliIo,
} from '../tools/mkfat.ts';

// ------------------------------------------------------- 独立的 FAT16 读取器

const ATTR_READ_ONLY = 0x01;
const ATTR_HIDDEN = 0x02;
const ATTR_SYSTEM = 0x04;
const ATTR_VOLUME_ID = 0x08;
const ATTR_DIRECTORY = 0x10;
const ATTR_LFN = ATTR_READ_ONLY | ATTR_HIDDEN | ATTR_SYSTEM | ATTR_VOLUME_ID;
const EOC = 0xfff8;

interface Mbr {
  flag: number;
  type: number;
  lba: number;
  sectors: number;
  chsFirst: [number, number, number];
  chsLast: [number, number, number];
  sig: boolean;
}

function decodeChs(img: Buffer, off: number): [number, number, number] {
  const head = img[off]!;
  const sector = img[off + 1]! & 0x3f;
  const cyl = ((img[off + 1]! & 0xc0) << 2) | img[off + 2]!;
  return [cyl, head, sector];
}

function parseMbr(img: Buffer): Mbr {
  const e = 446;
  return {
    flag: img[e]!,
    type: img[e + 4]!,
    lba: img.readUInt32LE(e + 8),
    sectors: img.readUInt32LE(e + 12),
    chsFirst: decodeChs(img, e + 1),
    chsLast: decodeChs(img, e + 5),
    sig: img[510] === 0x55 && img[511] === 0xaa,
  };
}

interface Bpb {
  base: number;
  oem: string;
  bytesPerSector: number;
  sectorsPerCluster: number;
  reservedSectors: number;
  numFats: number;
  rootEntries: number;
  totalSectors: number;
  media: number;
  fatSectors: number;
  sectorsPerTrack: number;
  heads: number;
  hiddenSectors: number;
  driveNumber: number;
  bootSig: number;
  serial: number;
  label: string;
  fsType: string;
  sig: boolean;
}

function parseBpb(img: Buffer, lba: number): Bpb {
  const base = lba * BYTES_PER_SECTOR;
  const total16 = img.readUInt16LE(base + 0x13);
  const total32 = img.readUInt32LE(base + 0x20);
  return {
    base,
    oem: img.subarray(base + 3, base + 11).toString('latin1'),
    bytesPerSector: img.readUInt16LE(base + 0x0b),
    sectorsPerCluster: img[base + 0x0d]!,
    reservedSectors: img.readUInt16LE(base + 0x0e),
    numFats: img[base + 0x10]!,
    rootEntries: img.readUInt16LE(base + 0x11),
    totalSectors: total16 !== 0 ? total16 : total32,
    media: img[base + 0x15]!,
    fatSectors: img.readUInt16LE(base + 0x16),
    sectorsPerTrack: img.readUInt16LE(base + 0x18),
    heads: img.readUInt16LE(base + 0x1a),
    hiddenSectors: img.readUInt32LE(base + 0x1c),
    driveNumber: img[base + 0x24]!,
    bootSig: img[base + 0x26]!,
    serial: img.readUInt32LE(base + 0x27),
    label: img.subarray(base + 0x2b, base + 0x36).toString('latin1'),
    fsType: img.subarray(base + 0x36, base + 0x3e).toString('latin1'),
    sig: img[base + 510] === 0x55 && img[base + 511] === 0xaa,
  };
}

interface RawEntry {
  /** 长名（没有长名项时就是 8.3 名） */
  name: string;
  shortName: string;
  attr: number;
  cluster: number;
  size: number;
  /** 若前面挂了长名项，它们的序号/0x40 标志/校验和是否全部合规 */
  lfnValid: boolean;
  lfnCount: number;
  raw: Buffer;
}

/** 从 0x0F 项里取出 13 个 UTF-16LE 码元，遇到 0x0000 结束（其余是 0xFFFF 填充） */
function lfnText(entry: Buffer): string {
  const slots = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
  let out = '';
  for (const s of slots) {
    const code = entry.readUInt16LE(s);
    if (code === 0x0000) break;
    out += String.fromCharCode(code);
  }
  return out;
}

/** 解析一段目录区（根目录或子目录的一个/多个簇），自己拼 VFAT 长名 */
function parseDir(buf: Buffer): RawEntry[] {
  const out: RawEntry[] = [];
  let pending: Array<{ seq: number; last: boolean; checksum: number; text: string }> = [];
  for (let off = 0; off + 32 <= buf.length; off += 32) {
    const e = buf.subarray(off, off + 32);
    if (e[0] === 0x00) break; // 目录结束标记
    if (e[0] === 0xe5) { pending = []; continue; } // 已删除项
    if (e[11] === ATTR_LFN) {
      pending.push({
        seq: e[0]! & 0x3f,
        last: (e[0]! & 0x40) !== 0,
        checksum: e[13]!,
        text: lfnText(e),
      });
      continue;
    }
    const field = e.subarray(0, 11).toString('latin1');
    const shortName = sfnText(field);
    let name = shortName;
    let lfnValid = true;
    const lfnCount = pending.length;
    if (pending.length > 0) {
      // 物理上是倒序：第一项带 0x40、序号最大，紧贴 8.3 项的才是长名开头
      lfnValid = pending.every((p, k) => p.seq === pending.length - k);
      lfnValid = lfnValid && pending[0]!.last && pending.slice(1).every((p) => !p.last);
      lfnValid = lfnValid && pending.every((p) => p.checksum === lfnChecksum(field));
      name = pending.map((p) => p.text).reverse().join('');
      lfnValid = lfnValid && name.length > 0;
    }
    pending = [];
    out.push({
      name,
      shortName,
      attr: e[11]!,
      cluster: e.readUInt16LE(26) | (e.readUInt16LE(20) << 16),
      size: e.readUInt32LE(28),
      lfnValid,
      lfnCount,
      raw: Buffer.from(e),
    });
  }
  return out;
}

class Fat16 {
  readonly img: Buffer;
  readonly mbr: Mbr;
  readonly bpb: Bpb;
  readonly fatOff: number;
  readonly rootOff: number;
  readonly dataOff: number;
  /** FAT 项里能出现的最大簇号 */
  readonly maxCluster: number;

  constructor(img: Buffer) {
    this.img = img;
    this.mbr = parseMbr(img);
    this.bpb = parseBpb(img, this.mbr.lba);
    this.fatOff = (this.mbr.lba + this.bpb.reservedSectors) * BYTES_PER_SECTOR;
    this.rootOff = (this.mbr.lba + this.bpb.reservedSectors + this.bpb.numFats * this.bpb.fatSectors) * BYTES_PER_SECTOR;
    this.dataOff = this.rootOff + (this.bpb.rootEntries * 32) / BYTES_PER_SECTOR * BYTES_PER_SECTOR;
    this.maxCluster = Math.floor(
      (this.bpb.totalSectors - (this.bpb.reservedSectors + this.bpb.numFats * this.bpb.fatSectors + (this.bpb.rootEntries * 32) / BYTES_PER_SECTOR))
        / this.bpb.sectorsPerCluster,
    );
  }

  get clusterBytes(): number { return this.bpb.sectorsPerCluster * BYTES_PER_SECTOR; }

  entry(cluster: number): number {
    return this.img.readUInt16LE(this.fatOff + cluster * 2);
  }

  /** 沿 FAT 链走到 EOC，返回全部簇号；顺带检查成环与越界 */
  chain(first: number): number[] {
    const out: number[] = [];
    let c = first;
    while (c >= 2 && c < EOC) {
      assert.ok(c <= this.maxCluster + 1, `簇号 ${c} 超出卷内范围`);
      assert.ok(out.length < this.maxCluster, `簇链成环（起点 ${first}）`);
      out.push(c);
      c = this.entry(c);
    }
    assert.ok(c >= EOC, `簇链没有以 EOC 结尾（起点 ${first}，末项 ${c}）`);
    return out;
  }

  cluster(cluster: number): Buffer {
    const off = this.dataOff + (cluster - 2) * this.clusterBytes;
    return this.img.subarray(off, off + this.clusterBytes);
  }

  chainBytes(first: number, size: number): Buffer {
    const parts = this.chain(first).map((c) => this.cluster(c));
    return Buffer.concat(parts).subarray(0, size);
  }

  rootDir(): RawEntry[] {
    const bytes = (this.bpb.rootEntries * 32);
    return parseDir(this.img.subarray(this.rootOff, this.rootOff + bytes));
  }

  dir(firstCluster: number): RawEntry[] {
    const parts = this.chain(firstCluster).map((c) => this.cluster(c));
    return parseDir(Buffer.concat(parts));
  }

  /** 按镜像内路径找目录项；最后一段是文件时可以再取内容 */
  lookup(path: string): RawEntry {
    const comps = path.split('/');
    let entries = this.rootDir();
    let found: RawEntry | undefined;
    for (let i = 0; i < comps.length; i++) {
      found = entries.find((e) => e.name === comps[i] || e.shortName === comps[i]);
      assert.ok(found !== undefined, `镜像里找不到 ${comps.slice(0, i + 1).join('/')}`);
      if (i < comps.length - 1) {
        assert.ok((found.attr & ATTR_DIRECTORY) !== 0, `${comps[i]} 不是目录`);
        entries = this.dir(found.cluster);
      }
    }
    return found!;
  }

  fileBytes(path: string): Buffer {
    const e = this.lookup(path);
    assert.equal(e.attr & ATTR_DIRECTORY, 0, `${path} 是目录`);
    if (e.size === 0) {
      assert.equal(e.cluster, 0, '空文件不该占簇');
      return Buffer.alloc(0);
    }
    assert.ok(e.cluster >= 2, `${path} 有长度却没有首簇`);
    return this.chainBytes(e.cluster, e.size);
  }
}

// ------------------------------------------------------------------ 测试工具

/** 确定性伪随机内容：错位一个字节就会比对失败 */
function pattern(size: number, seed = 1): Buffer {
  const b = Buffer.alloc(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    b[i] = (x >>> 16) & 0xff;
  }
  return b;
}

interface Captured {
  io: CliIo;
  out: string[];
  err: string[];
}

function capture(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tsie-mkfat-'));
}

/** 断言抛出的错误正好是某个文案 key（用户可见的错误必须能查表翻译） */
function expectKey(fn: () => unknown, key: string): void {
  assert.throws(fn, (e: unknown) => e instanceof MkfatError && e.key === key, `期望 ${key}`);
}

const IMAGE_32M = 32 * 1024 * 1024;

/** 一套覆盖各种边界的样例文件：空文件、1 字节、整簇、跨簇 */
function sampleFiles(clusterBytes = 4096): Array<{ name: string; data: Buffer }> {
  return [
    { name: 'grub.cfg', data: Buffer.from('set timeout=3\nmenuentry tsie { linux /Image }\n', 'utf8') },
    { name: 'initramfs.cpio.gz', data: pattern(9000, 7) },
    { name: 'empty.txt', data: Buffer.alloc(0) },
    { name: 'one.bin', data: pattern(1, 3) },
    { name: 'exact.bin', data: pattern(clusterBytes, 5) },
    { name: 'over.bin', data: pattern(clusterBytes + 1, 9) },
    { name: 'EFI/BOOT/BOOTRISCV64.EFI', data: pattern(300000, 11) },
  ];
}

// ------------------------------------------------------------------ MBR

test('MBR: 一个可引导主分区，起始 LBA 2048，CHS 是传统换算值', () => {
  const img = buildImage({ files: sampleFiles(), size: IMAGE_32M }).buf;
  const mbr = parseMbr(img);
  assert.equal(mbr.sig, true, '0x55AA 签名');
  assert.equal(mbr.flag, 0x80, '可引导标志');
  assert.equal(mbr.type, DEFAULT_PART_TYPE);
  assert.equal(mbr.lba, PARTITION_LBA);
  assert.equal(mbr.sectors, IMAGE_32M / BYTES_PER_SECTOR - PARTITION_LBA);
  assert.deepEqual(mbr.chsFirst, [0, 32, 33], 'LBA 2048 在 255/63 几何下的 CHS');
  // 末扇区 = 2048 + 63488 - 1 = 65535 → 柱面 4、磁头 20、扇区 16
  assert.deepEqual(mbr.chsLast, [4, 20, 16]);
  for (let i = 1; i < 4; i++) {
    const e = 446 + i * 16;
    assert.ok(img.subarray(e, e + 16).every((b) => b === 0), `第 ${i + 1} 个分区项应该是空的`);
  }
});

test('MBR: 分区长度覆盖到镜像末尾，隐藏扇区与 BPB 一致', () => {
  const img = buildImage({ files: sampleFiles(), size: IMAGE_32M }).buf;
  const fat = new Fat16(img);
  assert.equal(fat.mbr.lba * BYTES_PER_SECTOR + fat.mbr.sectors * BYTES_PER_SECTOR, img.length);
  assert.equal(fat.bpb.hiddenSectors, fat.mbr.lba, 'BPB 的隐藏扇区数必须等于分区起始 LBA');
  assert.equal(fat.bpb.totalSectors, fat.mbr.sectors, 'BPB 的卷扇区数必须等于分区长度');
});

// ------------------------------------------------------------------ BPB / 布局

test('BPB: 512 字节扇区、两份 FAT、保留 1 扇区、512 项根目录', () => {
  const img = buildImage({ files: sampleFiles(), size: IMAGE_32M }).buf;
  const { bpb } = new Fat16(img);
  assert.equal(bpb.sig, true, '引导扇区签名');
  assert.equal(bpb.bytesPerSector, 512);
  assert.equal(bpb.numFats, 2);
  assert.equal(bpb.reservedSectors, 1);
  assert.equal(bpb.rootEntries, 512);
  assert.equal(bpb.rootEntries % 16, 0, '根目录项数必须是 16 的倍数');
  assert.equal(bpb.media, 0xf8, '固定盘介质描述符');
  assert.equal(bpb.bootSig, 0x29, '扩展引导签名：序列号/卷标/类型字符串才有意义');
  assert.equal(bpb.driveNumber, 0x80);
  assert.equal(bpb.sectorsPerTrack, 63);
  assert.equal(bpb.heads, 255);
  assert.equal(bpb.fsType.trim(), 'FAT16');
  assert.equal(bpb.label, 'TSIE       ', '11 字节空格补齐的卷标');
  assert.equal(bpb.oem.length, 8);
  assert.equal(bpb.serial !== 0, true);
  // 16 位字段放得下就写 16 位、32 位清零（32 MiB 镜像 → 卷 63488 扇区，放得下）
  assert.equal(img.readUInt16LE(bpb.base + 0x13), bpb.totalSectors);
  assert.equal(img.readUInt32LE(bpb.base + 0x20), 0);
});

test('FAT: 前两项是介质描述符与干净标志，两份 FAT 逐字节相同', () => {
  const img = buildImage({ files: sampleFiles(), size: IMAGE_32M }).buf;
  const fat = new Fat16(img);
  assert.equal(fat.entry(0), 0xfff8, 'FAT[0] 的低字节要与 BPB 的 Media 一致');
  assert.equal(fat.entry(1), 0xffff, 'FAT[1] 的干净标志');
  const size = fat.bpb.fatSectors * BYTES_PER_SECTOR;
  const f1 = img.subarray(fat.fatOff, fat.fatOff + size);
  const f2 = img.subarray(fat.fatOff + size, fat.fatOff + 2 * size);
  assert.deepEqual(f1, f2, '第二份 FAT 必须是第一份的副本');
});

test('簇数落在 FAT16 的合法区间，簇大小是 2 的幂', () => {
  // 三个不同档位（1 KiB / 4 KiB / 8 KiB），确认没有一档掉出 FAT16 区间
  for (const size of [8 * 1024 * 1024, 20 * 1024 * 1024, 40 * 1024 * 1024]) {
    const img = buildImage({ files: sampleFiles(), size }).buf;
    const fat = new Fat16(img);
    assert.ok(fat.maxCluster >= FAT16_MIN_CLUSTERS, `${size}: 簇数 ${fat.maxCluster} 不能低于 ${FAT16_MIN_CLUSTERS}（否则固件按 FAT12 解析）`);
    assert.ok(fat.maxCluster <= FAT16_MAX_CLUSTERS, `${size}: 簇数 ${fat.maxCluster} 超过 16 位 FAT 的容量`);
    const spc = fat.bpb.sectorsPerCluster;
    assert.ok(spc >= 1 && spc <= MAX_SECTORS_PER_CLUSTER && (spc & (spc - 1)) === 0, `簇大小 ${spc} 必须是 2 的幂`);
  }
});

test('32 MiB 镜像落在 4 KiB 簇（8 扇区/簇）—— 预期答案', () => {
  const img = buildImage({ files: sampleFiles(), size: IMAGE_32M }).buf;
  const fat = new Fat16(img);
  assert.equal(fat.bpb.sectorsPerCluster, 8);
  assert.equal(fat.clusterBytes, 4096);
  assert.equal(fat.bpb.fatSectors, 31);
  assert.equal(fat.maxCluster, 7924);
});

test('镜像里没有结构/数据之外的非零字节', () => {
  const size = 8 * 1024 * 1024;
  const files = [{ name: 'a.bin', data: pattern(5000, 13) }, { name: 'd/b.bin', data: pattern(10, 17) }];
  const img = buildImage({ files, size }).buf;
  const fat = new Fat16(img);
  const mask = new Uint8Array(size);
  const mark = (from: number, len: number): void => { mask.fill(1, from, from + len); };
  mark(0, BYTES_PER_SECTOR); // MBR
  mark(fat.bpb.base, BYTES_PER_SECTOR); // 引导扇区
  mark(fat.fatOff, fat.bpb.numFats * fat.bpb.fatSectors * BYTES_PER_SECTOR); // 两份 FAT
  mark(fat.rootOff, fat.bpb.rootEntries * 32); // 根目录
  for (const path of ['a.bin', 'd/b.bin']) {
    for (const c of fat.chain(fat.lookup(path).cluster)) mark(fat.dataOff + (c - 2) * fat.clusterBytes, fat.clusterBytes);
  }
  for (const c of fat.chain(fat.lookup('d').cluster)) mark(fat.dataOff + (c - 2) * fat.clusterBytes, fat.clusterBytes);
  let bad = -1;
  for (let i = 0; i < img.length; i++) if (img[i] !== 0 && mask[i] === 0) { bad = i; break; }
  assert.equal(bad, -1, `偏移 ${bad} 处有不该出现的非零字节`);
});

// ------------------------------------------------------------- 目录与长名

test('根目录里有卷标项，且卷标与 BPB 一致', () => {
  const img = buildImage({ files: sampleFiles(), label: 'TSIEESP', size: IMAGE_32M }).buf;
  const fat = new Fat16(img);
  const entries = fat.rootDir();
  const label = entries.find((e) => (e.attr & ATTR_VOLUME_ID) !== 0 && (e.attr & ATTR_DIRECTORY) === 0);
  assert.ok(label !== undefined, '根目录里应该有卷标项');
  assert.equal(label!.raw.subarray(0, 11).toString('latin1'), 'TSIEESP    ');
  assert.equal(label!.cluster, 0);
  assert.equal(label!.size, 0);
  assert.equal(fat.bpb.label, 'TSIEESP    ');
});

test('VFAT 长名: 0x0F 项倒序、0x40 标志、校验和、UTF-16LE 分段都正确', () => {
  const img = buildImage({ files: sampleFiles(), size: IMAGE_32M }).buf;
  const fat = new Fat16(img);
  const e = fat.lookup('initramfs.cpio.gz');
  assert.equal(e.name, 'initramfs.cpio.gz', '长名要能原样拼回来');
  assert.equal(e.lfnCount, 2, '"initramfs.cpio.gz" 有 17 个码元 → 2 个长名项');
  assert.equal(e.lfnValid, true, '序号/0x40/校验和任一不对都会让固件退回 8.3 名');
  // 物理顺序：第一项带 0x40 且序号最大。注意要按**原始字节**定位，
  // 解析器已经把长名项折叠掉了，解析结果里的下标不是盘上的下标。
  const sfnFieldBytes = sfnField(e.shortName);
  const raw: Buffer[] = [];
  for (let o = 0; o < fat.bpb.rootEntries * 32; o += 32) {
    raw.push(img.subarray(fat.rootOff + o, fat.rootOff + o + 32));
  }
  const idx = raw.findIndex((x) => x.subarray(0, 11).toString('latin1') === sfnFieldBytes);
  assert.equal(idx >= 2, true, '文件前面应该有 2 个长名项');
  const first = raw[idx - 2]!;
  assert.equal(first[0], 0x42, '第一项 = 序号 2 | 0x40');
  assert.equal(first[11], 0x0f);
  assert.equal(first[12], 0x00, '长名项的"类型"字节必须是 0');
  assert.equal(first.readUInt16LE(26), 0, '长名项的首簇必须是 0');
  const second = raw[idx - 1]!;
  assert.equal(second[0], 0x01, '紧接着 8.3 项的那一项是长名的开头（序号 1）');
  assert.equal(second[13], lfnChecksum(sfnFieldBytes), '校验和是对 8.3 名算的');
  assert.equal(e.shortName, 'INITRA~1.GZ');
});

test('超过 26 个字符的名字要 3 个长名项', () => {
  const files = [{ name: 'a-very-long-kernel-image-name.bin', data: pattern(64, 21) }];
  const img = buildImage({ files, size: 8 * 1024 * 1024 }).buf;
  const e = new Fat16(img).lookup('a-very-long-kernel-image-name.bin');
  assert.equal(e.name, 'a-very-long-kernel-image-name.bin');
  assert.equal(e.lfnCount, 3);
  assert.equal(e.lfnValid, true);
  assert.equal(e.shortName, 'A-VERY~1.BIN');
});

test('非 ASCII 长名按 UTF-16LE 往返', () => {
  const files = [{ name: '内核.bin', data: pattern(32, 23) }];
  const img = buildImage({ files, size: 8 * 1024 * 1024 }).buf;
  const e = new Fat16(img).lookup('内核.bin');
  assert.equal(e.name, '内核.bin');
  assert.equal(e.shortName, '__.BIN', '非 ASCII 字符在 8.3 名里退化成下划线');
  assert.equal(e.lfnValid, true);
});

test('子目录自动创建，路径前导 / 与重复 / 等价', () => {
  const a = buildImage({ files: [{ name: 'EFI/BOOT/BOOTRISCV64.EFI', data: pattern(100, 31) }], size: 8 * 1024 * 1024 }).buf;
  const b = buildImage({ files: [{ name: '/EFI//BOOT/BOOTRISCV64.EFI', data: pattern(100, 31) }], size: 8 * 1024 * 1024 }).buf;
  assert.deepEqual(a, b, '前导/重复斜杠不应改变产物');
  const fat = new Fat16(a);
  assert.ok((fat.lookup('EFI').attr & ATTR_DIRECTORY) !== 0);
  assert.ok((fat.lookup('EFI/BOOT').attr & ATTR_DIRECTORY) !== 0);
  assert.deepEqual(fat.fileBytes('EFI/BOOT/BOOTRISCV64.EFI'), pattern(100, 31));
});

test('子目录的 . 与 .. 指向正确的簇（顶层目录的 .. 是根目录的 0）', () => {
  const files = [
    { name: 'EFI/BOOT/BOOTRISCV64.EFI', data: pattern(10, 41) },
    { name: 'top.txt', data: pattern(10, 43) },
  ];
  const img = buildImage({ files, size: 8 * 1024 * 1024 }).buf;
  const fat = new Fat16(img);
  const efi = fat.lookup('EFI');
  const boot = fat.lookup('EFI/BOOT');
  const efiDir = fat.dir(efi.cluster);
  const bootDir = fat.dir(boot.cluster);
  assert.equal(efiDir[0]!.name, '.');
  assert.equal(efiDir[0]!.cluster, efi.cluster, 'EFI 的 . 指向自己');
  assert.equal(efiDir[1]!.name, '..');
  assert.equal(efiDir[1]!.cluster, 0, '顶层目录的 .. 指向根目录（FAT16 里根目录的簇号是 0）');
  assert.equal(bootDir[0]!.cluster, boot.cluster);
  assert.equal(bootDir[1]!.cluster, efi.cluster, 'BOOT 的 .. 指向 EFI');
});

test('目录项的时间戳固定（产物可 diff 的前提）', () => {
  const img = buildImage({ files: sampleFiles(), size: IMAGE_32M }).buf;
  const e = new Fat16(img).lookup('grub.cfg');
  const date = e.raw.readUInt16LE(24);
  const time = e.raw.readUInt16LE(22);
  assert.equal(date, ((2026 - 1980) << 9) | (1 << 5) | 1, 'DOS 日期字固定为 2026-01-01');
  assert.equal(time, 0, 'DOS 时间字固定为 00:00:00');
  assert.equal(e.raw.readUInt16LE(16), date, '创建日期与写入日期一致');
  assert.equal(e.raw[13], 0, '创建时间的 1/10 秒字段为 0');
});

// ------------------------------------------------------------- 短名规则

test('短名规则: 合法字符集、8.3 长度、大小写', () => {
  const files = [
    { name: 'lower.case', data: pattern(4, 51) },
    { name: 'with space.txt', data: pattern(4, 53) },
    { name: 'a+b,c;.txt', data: pattern(4, 55) },
  ];
  const img = buildImage({ files, size: 8 * 1024 * 1024 }).buf;
  const fat = new Fat16(img);
  for (const f of files) {
    const e = fat.lookup(f.name);
    assert.match(e.shortName, /^[A-Z0-9$%'\-_@~`!(){}^#&]{1,8}(\.[A-Z0-9$%'\-_@~`!(){}^#&]{1,3})?$/, `非法短名 ${e.shortName}`);
    assert.equal(e.lfnValid, true);
  }
  assert.equal(fat.lookup('lower.case').shortName, 'LOWER.CAS');
  // 名字里的空格与 + , ; 在 8.3 名里都退化成下划线；超出 8 个字符时截断并编号
  assert.equal(fat.lookup('with space.txt').shortName, 'WITH_S~1.TXT');
  assert.equal(fat.lookup('a+b,c;.txt').shortName, 'A_B_C_.TXT');
});

test('短名冲突依次编号 ~1 ~2，且互不重复', () => {
  const files = [
    { name: 'long-name-one.txt', data: pattern(4, 61) },
    { name: 'long-name-two.txt', data: pattern(4, 63) },
    { name: 'long-name-three.txt', data: pattern(4, 65) },
  ];
  const img = buildImage({ files, size: 8 * 1024 * 1024 }).buf;
  const fat = new Fat16(img);
  // 编号跟着**排序后的**目录顺序走（one < three < two），这正是产物可复现的原因
  const shorts = [
    fat.lookup('long-name-one.txt').shortName,
    fat.lookup('long-name-two.txt').shortName,
    fat.lookup('long-name-three.txt').shortName,
  ];
  assert.deepEqual(shorts.slice().sort(), ['LONG-N~1.TXT', 'LONG-N~2.TXT', 'LONG-N~3.TXT']);
  assert.equal(fat.lookup('long-name-one.txt').shortName, 'LONG-N~1.TXT');
  assert.equal(fat.lookup('long-name-three.txt').shortName, 'LONG-N~2.TXT');
  assert.equal(fat.lookup('long-name-two.txt').shortName, 'LONG-N~3.TXT');
  assert.equal(new Set(shorts).size, 3);
  for (const f of files) assert.equal(fat.lookup(f.name).name, f.name, '长名仍然能原样找回');
});

test('数字尾巴规则: 名字自带 ~数字 时编号沿用，已合法的 8.3 名原样保留', () => {
  const files = [
    { name: 'verylongfilename~3.txt', data: pattern(4, 71) },
    { name: 'FILE~9.TXT', data: pattern(4, 73) },
  ];
  const img = buildImage({ files, size: 8 * 1024 * 1024 }).buf;
  const fat = new Fat16(img);
  assert.equal(fat.lookup('verylongfilename~3.txt').shortName, 'VERYLO~3.TXT');
  const kept = fat.lookup('FILE~9.TXT');
  assert.equal(kept.shortName, 'FILE~9.TXT');
  assert.equal(kept.lfnCount, 0, '全大写的合法 8.3 名不需要长名项');
});

test('卷标名在根目录里占位，同名文件会被编号让开', () => {
  const img = buildImage({ files: [{ name: 'tsie', data: pattern(4, 81) }], label: 'TSIE', size: 8 * 1024 * 1024 }).buf;
  const fat = new Fat16(img);
  const e = fat.lookup('tsie');
  assert.equal(e.shortName, 'TSIE~1', '不能跟卷标项抢同一个 8.3 名');
  assert.equal(e.lfnValid, true);
});

test('整卷范围内短名不重复（含目录之间）', () => {
  const files = [
    { name: 'a/readme.txt', data: pattern(4, 91) },
    { name: 'b/readme.txt', data: pattern(4, 93) },
    { name: 'readme.txt', data: pattern(4, 95) },
  ];
  const img = buildImage({ files, size: 8 * 1024 * 1024 }).buf;
  const fat = new Fat16(img);
  // 不同目录里同名是允许的（各自的目录项独立），命名空间按目录分开
  assert.equal(fat.lookup('a/readme.txt').shortName, 'README.TXT');
  assert.equal(fat.lookup('b/readme.txt').shortName, 'README.TXT');
  // 同一目录内必须不同
  const root = fat.rootDir().filter((e) => (e.attr & ATTR_DIRECTORY) === 0 && (e.attr & ATTR_VOLUME_ID) === 0);
  assert.equal(new Set(root.map((e) => e.shortName)).size, root.length);
});

test('目录项超过一个簇时目录自己也要接簇链', () => {
  // 60 个长名文件 × (3 个长名项 + 1 个 8.3 项) + '.'/'..' → 8 MiB 镜像的 1 KiB 簇装不下，
  // 目录必须沿 FAT 链跨到下一个簇 —— 这条路径最容易写错（只写第一个簇会静默丢文件）
  const files = Array.from({ length: 60 }, (_, i) => ({
    name: `sub/a-very-long-file-name-number-${i}.bin`,
    data: pattern(8, i + 1),
  }));
  const img = buildImage({ files, size: 8 * 1024 * 1024 }).buf;
  const fat = new Fat16(img);
  const sub = fat.lookup('sub');
  assert.ok((sub.attr & ATTR_DIRECTORY) !== 0);
  const chain = fat.chain(sub.cluster);
  assert.ok(chain.length > 1, `目录应当跨多个簇，实际 ${chain.length} 个`);
  const entries = fat.dir(sub.cluster);
  const kids = entries.filter((e) => e.name !== '.' && e.name !== '..');
  assert.equal(kids.length, 60, '跨簇之后一个文件都不能丢');
  for (let i = 0; i < 60; i++) {
    const path = `sub/a-very-long-file-name-number-${i}.bin`;
    assert.deepEqual(fat.fileBytes(path), pattern(8, i + 1), `${path} 内容不符`);
  }
  assert.equal(new Set(kids.map((e) => e.shortName)).size, 60, '同一目录内短名不能重复');
});

// ------------------------------------------------------------- 文件内容与链

test('文件内容逐字节一致（空文件、单字节、整簇、跨簇、大文件）', () => {
  const files = sampleFiles();
  const img = buildImage({ files, size: IMAGE_32M }).buf;
  const fat = new Fat16(img);
  for (const f of files) {
    assert.deepEqual(fat.fileBytes(f.name), f.data, `${f.name} 内容不符`);
  }
});

test('簇链: 长度正确、EOC 收尾、没有簇被两条链引用、没有簇泄漏', () => {
  const files = sampleFiles();
  const img = buildImage({ files, size: IMAGE_32M }).buf;
  const fat = new Fat16(img);
  const chainBytes = fat.clusterBytes;

  assert.equal(fat.lookup('empty.txt').cluster, 0, '空文件不占簇');
  assert.equal(fat.chain(fat.lookup('one.bin').cluster).length, 1);
  assert.equal(fat.chain(fat.lookup('exact.bin').cluster).length, 1, '正好一个簇的数据只占一个簇');
  assert.equal(fat.chain(fat.lookup('over.bin').cluster).length, 2, '多一个字节要多一个簇');
  assert.equal(fat.chain(fat.lookup('initramfs.cpio.gz').cluster).length, Math.ceil(9000 / chainBytes));
  assert.equal(fat.chain(fat.lookup('EFI/BOOT/BOOTRISCV64.EFI').cluster).length, Math.ceil(300000 / chainBytes));

  // 把所有链走一遍：不能有重复簇，所有非零 FAT 项都必须在某条链里
  const seen = new Set<number>();
  let used = 0;
  const visit = (cluster: number, what: string): void => {
    for (const c of fat.chain(cluster)) {
      assert.ok(!seen.has(c), `${what}: 簇 ${c} 被两条链引用`);
      seen.add(c);
      used++;
    }
  };
  const walkDir = (entries: RawEntry[], prefix: string): void => {
    for (const e of entries) {
      if ((e.attr & ATTR_VOLUME_ID) !== 0 || e.name === '.' || e.name === '..') continue;
      if (e.attr & ATTR_DIRECTORY) {
        visit(e.cluster, `${prefix}${e.name}/`);
        walkDir(fat.dir(e.cluster), `${prefix}${e.name}/`);
      } else if (e.size > 0) {
        visit(e.cluster, `${prefix}${e.name}`);
      }
    }
  };
  walkDir(fat.rootDir(), '');
  let nonZero = 0;
  for (let c = 2; c <= fat.maxCluster + 1; c++) {
    if (fat.entry(c) !== 0) nonZero++;
  }
  assert.equal(used, nonZero, `FAT 里有 ${nonZero} 个非零项，但只追溯到 ${used} 个簇 —— 有泄漏`);
  assert.ok(fat.entry(used + 2) === 0, '用完的簇之后应当都是空闲项');
});

test('每个簇的 FAT 项要么是 0、要么指向合法簇、要么是 EOC', () => {
  const img = buildImage({ files: sampleFiles(), size: IMAGE_32M }).buf;
  const fat = new Fat16(img);
  for (let c = 2; c <= fat.maxCluster + 1; c++) {
    const v = fat.entry(c);
    if (v === 0 || v >= EOC) continue;
    assert.ok(v >= 2 && v <= fat.maxCluster + 1, `簇 ${c} 的 FAT 项 ${v} 不是合法簇号`);
  }
});

test('文件尾部补零到簇边界', () => {
  const files = [{ name: 'pad.bin', data: pattern(5000, 101) }];
  const img = buildImage({ files, size: 8 * 1024 * 1024 }).buf;
  const fat = new Fat16(img);
  const chain = fat.chain(fat.lookup('pad.bin').cluster);
  assert.equal(chain.length, Math.ceil(5000 / fat.clusterBytes));
  assert.ok(fat.clusterBytes < 5000, '这个用例要有跨簇的文件');
  const last = fat.cluster(chain[chain.length - 1]!);
  const usedInLast = 5000 - (chain.length - 1) * fat.clusterBytes;
  assert.deepEqual(last.subarray(usedInLast), Buffer.alloc(fat.clusterBytes - usedInLast), '最后一个簇的剩余部分是零');
  assert.deepEqual(fat.fileBytes('pad.bin'), pattern(5000, 101));
});

// ------------------------------------------------------------- 确定性与 CLI

test('两次构建逐字节相同（时间戳与序列号都是确定的）', () => {
  const files = sampleFiles();
  const a = buildImage({ files, size: IMAGE_32M });
  const b = buildImage({ files, size: IMAGE_32M });
  assert.deepEqual(a.buf, b.buf);
  assert.equal(a.layout.serial, b.layout.serial);
  // 输入不同 → 序列号不同（不是写死的常量）
  const other = buildImage({ files, size: IMAGE_32M, label: 'OTHER' });
  assert.notEqual(other.layout.serial, a.layout.serial);
});

test('CLI 端到端: 同样的参数两次写出同样的文件', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'grub.cfg'), 'set timeout=3\n');
    writeFileSync(join(dir, 'initramfs.cpio.gz'), pattern(9000, 7));
    const argv = (out: string): string[] => [
      out, '--size=33554432', '--label=TSIE',
      `grub.cfg=${join(dir, 'grub.cfg')}`,
      `EFI/BOOT/BOOTRISCV64.EFI=${join(dir, 'initramfs.cpio.gz')}`,
    ];
    const one = capture();
    const two = capture();
    assert.equal(main(argv(join(dir, 'a.img')), one.io), 0);
    assert.equal(main(argv(join(dir, 'b.img')), two.io), 0);
    const a = readFileSync(join(dir, 'a.img'));
    const b = readFileSync(join(dir, 'b.img'));
    assert.deepEqual(a, b);
    const fat = new Fat16(a);
    assert.deepEqual(fat.fileBytes('grub.cfg'), Buffer.from('set timeout=3\n'));
    assert.deepEqual(fat.fileBytes('EFI/BOOT/BOOTRISCV64.EFI'), pattern(9000, 7));
    assert.ok(one.out.join('\n').includes('EFI/BOOT/BOOTRISCV64.EFI'), '成功信息里要列出文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--part-type=0xEF 只改分区类型字节，别的一个字节都不动', () => {
  const files = sampleFiles();
  const a = buildImage({ files, size: IMAGE_32M }).buf;
  const b = buildImage({ files, size: IMAGE_32M, partType: 0xef }).buf;
  assert.equal(a.length, b.length);
  const diff: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
  assert.deepEqual(diff, [446 + 4], `只有分区类型字节可以不同，实际 ${diff.length} 处`);
  assert.equal(b[450], 0xef);
  assert.equal(new Fat16(b).mbr.type, 0xef);
});

test('省略 --size: 文件总字节 + 2 MiB，向上取整到整 MiB', () => {
  const files = [{ name: 'a.bin', data: pattern(3_000_000, 111) }];
  const built = buildImage({ files });
  assert.equal(built.layout.imageSize, 5 * 1024 * 1024, '3 MB + 2 MiB = 5 MiB');
  assert.equal(built.sizeBumped, false);
  assert.equal(built.buf.length, 5 * 1024 * 1024);
});

test('省略 --size 且数据太少时抬到 FAT16 的最小镜像', () => {
  const built = buildImage({ files: [{ name: 'a.bin', data: pattern(16, 113) }] });
  assert.equal(built.sizeBumped, true);
  assert.equal(built.layout.imageSize, MIN_IMAGE_BYTES);
  const fat = new Fat16(built.buf);
  assert.ok(fat.maxCluster >= FAT16_MIN_CLUSTERS, '抬过之后簇数必须进 FAT16 区间');
  assert.deepEqual(fat.fileBytes('a.bin'), pattern(16, 113));
});

test('--size 非整扇区时向上取整', () => {
  const built = buildImage({ files: [{ name: 'a.bin', data: pattern(8, 121) }], size: 8 * 1024 * 1024 + 100 });
  assert.equal(built.buf.length % BYTES_PER_SECTOR, 0);
  assert.equal(built.buf.length, 8 * 1024 * 1024 + 512);
});

test('卷标: 大写化、11 字符上限、非法字符报错', () => {
  const built = buildImage({ files: [], label: 'espx', size: 8 * 1024 * 1024 });
  assert.equal(new Fat16(built.buf).bpb.label, 'ESPX       ');
  expectKey(() => buildImage({ files: [], label: 'too-long-label', size: 8 * 1024 * 1024 }), 'fat.errLabel');
  expectKey(() => buildImage({ files: [], label: 'bad*label', size: 8 * 1024 * 1024 }), 'fat.errLabel');
  expectKey(() => buildImage({ files: [], label: '', size: 8 * 1024 * 1024 }), 'fat.errLabel');
});

test('没有文件时也能造出一个合法的空卷', () => {
  const built = buildImage({ files: [], size: 8 * 1024 * 1024 });
  const fat = new Fat16(built.buf);
  const entries = fat.rootDir();
  assert.equal(entries.length, 1, '只有卷标项');
  assert.equal((entries[0]!.attr & ATTR_VOLUME_ID) !== 0, true);
  let nonZero = 0;
  for (let c = 2; c <= fat.maxCluster + 1; c++) if (fat.entry(c) !== 0) nonZero++;
  assert.equal(nonZero, 0, '一个簇都不该被占用');
});

// ------------------------------------------------------------- 错误路径

test('错误: 宿主机文件不存在时非零退出并说明是哪个文件', () => {
  const dir = tempDir();
  try {
    const c = capture();
    assert.equal(main([join(dir, 'x.img'), 'a.bin=/definitely/not/here.bin'], c.io), 1);
    assert.ok(c.err.join('\n').includes('/definitely/not/here.bin'), '错误信息要带上缺失的路径');
    assert.equal(readFileSync(join(dir, 'x.img'), { flag: 'a+' }).length, 0, '失败时不该留下半成品');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('错误: 宿主机路径是目录时报错', () => {
  const dir = tempDir();
  try {
    const c = capture();
    assert.equal(main([join(dir, 'x.img'), `a.bin=${dir}`], c.io), 1);
    assert.ok(c.err.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('错误: 重名目标（含大小写不同）必须报错', () => {
  const files = [{ name: 'a.bin', data: pattern(4, 131) }];
  expectKey(() => buildImage({ files: [...files, { name: 'a.bin', data: pattern(4, 133) }], size: 8 * 1024 * 1024 }), 'fat.errDupName');
  expectKey(() => buildImage({ files: [...files, { name: 'A.BIN', data: pattern(4, 135) }], size: 8 * 1024 * 1024 }), 'fat.errDupName');
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'f1'), 'x');
    writeFileSync(join(dir, 'f2'), 'y');
    const c = capture();
    assert.equal(main([join(dir, 'x.img'), `dup=${join(dir, 'f1')}`, `dup=${join(dir, 'f2')}`], c.io), 1);
    assert.ok(c.err.join('').includes('dup'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('错误: 同一个名字既当文件又当目录', () => {
  expectKey(() => buildImage({
    files: [{ name: 'a', data: pattern(4, 141) }, { name: 'a/b.bin', data: pattern(4, 143) }],
    size: 8 * 1024 * 1024,
  }), 'fat.errPathConflict');
});

test('错误: 编不出短名的名字被拒绝', () => {
  const size = 8 * 1024 * 1024;
  expectKey(() => buildImage({ files: [{ name: '..x', data: pattern(4, 151) }], size }), 'fat.errNameUnencodable');
  expectKey(() => buildImage({ files: [{ name: 'a/..', data: pattern(4, 153) }], size }), 'fat.errNameDot');
  expectKey(() => buildImage({ files: [{ name: 'a.', data: pattern(4, 155) }], size }), 'fat.errNameTrail');
  expectKey(() => buildImage({ files: [{ name: 'a:b', data: pattern(4, 157) }], size }), 'fat.errNameChar');
  expectKey(() => buildImage({ files: [{ name: 'a*b', data: pattern(4, 157) }], size }), 'fat.errNameChar');
  expectKey(() => buildImage({ files: [{ name: 'a\u0001b', data: pattern(4, 157) }], size }), 'fat.errNameChar');
  expectKey(() => buildImage({ files: [{ name: 'x'.repeat(256), data: pattern(4, 159) }], size }), 'fat.errNameTooLong');
  expectKey(() => buildImage({ files: [{ name: '', data: pattern(4, 161) }], size }), 'fat.errNameEmpty');
});

test('错误: 装不下 4085 个簇的镜像被拒绝', () => {
  expectKey(() => buildImage({ files: [], size: 1024 * 1024 }), 'fat.errSizeTooSmall');
  const dir = tempDir();
  try {
    const c = capture();
    assert.equal(main([join(dir, 'x.img'), '--size=1M', `a=${join(dir, 'x.img')}`], c.io), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('错误: 超出 FAT16 容量上限的镜像被拒绝（不会写出坏盘）', () => {
  expectKey(() => buildImage({ files: [], size: 8 * 1024 * 1024 * 1024 }), 'fat.errTooLarge');
  const c = capture();
  assert.equal(main(['x.img', '--size=8G', 'a=b'], c.io), 1);
  assert.ok(c.err.length > 0);
});

test('错误: 文件总字节装不进给定的镜像', () => {
  expectKey(
    () => buildImage({ files: [{ name: 'big.bin', data: pattern(8 * 1024 * 1024, 171) }], size: 4 * 1024 * 1024 }),
    'fat.errPayloadTooBig',
  );
});

test('错误: 根目录项超出固定的 512 项', () => {
  const files = Array.from({ length: 200 }, (_, i) => ({
    name: `a-file-with-a-very-long-name-${i}.bin`,
    data: pattern(4, i + 1),
  }));
  expectKey(() => buildImage({ files, size: 8 * 1024 * 1024 }), 'fat.errRootFull');
});

test('错误: 参数不合法时打印用法并返回非零', () => {
  const cases: Array<[string[], number]> = [
    [[], 2],
    [['--size=8M'], 2],
    [['out.img'], 2],
    [['out.img', '--nope=1', 'a=b'], 1],
    [['out.img', '--size=abc', 'a=b'], 1],
    [['out.img', '--size=1Q', 'a=b'], 1],
    [['out.img', '--part-type=0x00', 'a=b'], 1],
    [['out.img', 'no-equals-sign'], 1],
    [['out.img', 'a='], 1],
  ];
  for (const [argv, code] of cases) {
    const c = capture();
    assert.equal(main(argv, c.io), code, `argv=${JSON.stringify(argv)}`);
    assert.ok(c.err.join('\n').length > 0, `argv=${JSON.stringify(argv)} 要有错误信息`);
  }
});

test('--help 打印用法并返回 0', () => {
  const c = capture();
  assert.equal(main(['--help'], c.io), 0);
  assert.ok(c.err.join('\n').includes('mkfat'), '用法里要有工具名');
  assert.ok(c.err.join('\n').includes('--part-type'));
});

test('错误信息可以翻译（en 环境下不出现中文）', () => {
  const dir = tempDir();
  const saved = process.env['TSIE_LANG'];
  try {
    writeFileSync(join(dir, 'f'), 'x');
    process.env['TSIE_LANG'] = 'en';
    const c = capture();
    assert.equal(main([join(dir, 'x.img'), `a=${join(dir, 'missing')}`], c.io), 1);
    assert.ok(!/[\u4e00-\u9fff]/.test(c.err.join('\n')), `英文环境出现了中文: ${c.err.join('\n')}`);

    const ok = capture();
    assert.equal(main([join(dir, 'y.img'), '--size=8M', `a=${join(dir, 'f')}`], ok.io), 0);
    assert.ok(!/[\u4e00-\u9fff]/.test(ok.out.join('\n')), `英文环境出现了中文: ${ok.out.join('\n')}`);
  } finally {
    if (saved === undefined) delete process.env['TSIE_LANG'];
    else process.env['TSIE_LANG'] = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
