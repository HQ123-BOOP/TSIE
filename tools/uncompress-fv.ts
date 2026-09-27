// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 TSIE
/**
 * 去掉 EDK2 固件里的 LZMA 压缩层，让 guest 启动时不必解压。
 *
 * 为什么需要它
 * ------------
 * EDK2 的 RiscVVirtQemu 平台在 RiscVVirtQemu.fdf 里把 DXE 固件卷包了一层压缩：
 *
 *     FILE FV_IMAGE = 9E21FD93-9C72-4c15-8C4B-E77F1DB2D792 {
 *        SECTION GUIDED EE4E5898-... PROCESSING_REQUIRED = TRUE {   <- LZMA 压缩包装
 *          SECTION FV_IMAGE = DXEFV
 *        }
 *      }
 *
 * 启动时固件要先把这块解压开。在模拟器里代价极大 —— 实测**约占启动前段 10 亿条指令**，
 * 到 UEFI Shell 要 23 分钟；去掉压缩后只要 2.5 分钟（约 5 倍）。
 *
 * 本工具不重编 EDK2，而是等价地在已有固件上做手术：解出被压缩的卷，
 * 把 GUID_DEFINED 节换成**裸的 FV_IMAGE 节** —— 正是「去掉包装」后构建器会产出的形态。
 *
 * 用法
 * ----
 *     npx tsx tools/uncompress-fv.ts RISCV_VIRT_CODE.fd RISCV_VIRT_CODE_nocomp.fd
 *
 * 会做完整自检（FFS 大小/校验和、FV 头校验、DXEFV 的 FileSystemGuid 位置），
 * 任一项不符就报错退出，不会产出一个半成品固件。
 *
 * 关于 LZMA
 * ---------
 * Node 标准库没有 LZMA（Node 26 实测：有 gzip / brotli / zstd，就是没有 lzma），
 * 所以这一步调用外部 `xz`。EDK2 的载荷布局恰好就是 `.lzma`(LZMA_alone) 容器头：
 *
 *     1 字节 props + 4 字节字典大小 + 8 字节解压后大小 + 原始 LZMA1 流  = 13 字节头
 *
 * 于是 `xz --format=lzma -dc` 能直接吃。实测与 Python `lzma` 模块的产物**逐字节一致**
 * （5373968 B，sha256 1281f3cf…）。xz 在 Git for Windows 与各大发行版里都有。
 *
 * 实现要点（都是踩过的坑）
 * ------------------------
 * * EFI_FFS_FILE_HEADER 的 Size 是 **3 字节**（偏移 20..22），State 在 +23。
 * * FFS 头校验和要把 `+16(Header)`、`+17(File)`、`+23(State)` **三处都清零**再求和，
 *   取 `(0x100 - sum % 0x100) & 0xFF`。只清 +16 是错的（原 Python 版第一版就错在这）。
 * * EFI_GUID_DEFINED_SECTION 的 DataOffset **相对节头起点**，不是相对 GUID 起点（差 4 字节）。
 * * 喂给 xz 的输入**必须限定在该节范围内** —— 多余数据会在 EOS 之后报 Corrupt input data。
 * * FV 头校验和：`[0, HeaderLength)` 内所有 u16 之和（含校验字段）≡ 0 (mod 0x10000)。
 * * LZMA 的 GUID 在固件里**不止一处**（SEC 核的 PE32 里就引用了它），
 *   不能取第一次命中，要逐个按「节头合法 + 能正常解压」筛。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const GUID_LZMA_CUSTOM = 'EE4E5898-3914-4259-9D6E-DC7BD79403CF';
export const GUID_FV_IMAGE_FILE = '9E21FD93-9C72-4C15-8C4B-E77F1DB2D792';
export const FS_GUID_FFS2 = '8C8CE578-8A3D-4F1C-9935-896185C32DD3';
export const SECTION_GUID_DEFINED = 0x02;
export const SECTION_FV_IMAGE = 0x17;
/** DXEFV 卷尾（8 MiB）。本工具不扩卷，越界就报错让人工处理。 */
export const FV_END = 0x800000;

/** EFI GUID 文本 → 固件里的字节序（前三段小端，后两段原序） */
export function guidToBytes(text: string): Buffer {
  const p = text.split('-');
  const g = (i: number): Buffer => Buffer.from(p[i]!, 'hex');
  return Buffer.concat([
    g(0).reverse(), g(1).reverse(), g(2).reverse(), g(3), g(4),
  ]);
}

export function guidToText(b: Buffer): string {
  const hex = (from: number, to: number): string => b.subarray(from, to).toString('hex').toUpperCase();
  const le = (from: number, to: number): string => Buffer.from(b.subarray(from, to)).reverse().toString('hex').toUpperCase();
  return `${le(0, 4)}-${le(4, 6)}-${le(6, 8)}-${hex(8, 10)}-${hex(10, 16)}`;
}

/** FFS 头校验和。Header/File/State 三字节清零后求字节和。 */
export function ffsHeaderChecksum(hdr: Buffer): number {
  let sum = 0;
  for (let i = 0; i < 24; i++) {
    sum += i === 16 || i === 17 || i === 23 ? 0 : hdr[i]!;
  }
  return (0x100 - (sum % 0x100)) & 0xff;
}

/** FV 头 16 位字之和（含校验字段）。有效时 ≡ 0 (mod 0x10000)。 */
export function fvHeaderSum(hdr: Buffer): number {
  let sum = 0;
  for (let o = 0; o + 1 < hdr.length; o += 2) sum += hdr.readUInt16LE(o);
  return sum & 0xffff;
}

function countOccurrences(buf: Buffer, needle: Buffer): number {
  let n = 0;
  let at = buf.indexOf(needle);
  while (at >= 0) { n++; at = buf.indexOf(needle, at + 1); }
  return n;
}

/** 调 xz 解 LZMA_alone 载荷。输入必须已限定在该节范围内。 */
export function decompressLzma(payload: Buffer): Buffer {
  const r = spawnSync('xz', ['--format=lzma', '-dc'], {
    input: payload,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) {
    const e = r.error as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new Error('找不到 xz。Node 标准库没有 LZMA，这一步需要外部 xz（Git for Windows 或 xz-utils 自带）');
    }
    throw new Error(`调用 xz 失败: ${e.message}`);
  }
  if (r.status !== 0) {
    throw new Error(`xz 解压失败（退出码 ${r.status}）: ${(r.stderr ?? Buffer.alloc(0)).toString().slice(0, 200)}`);
  }
  return r.stdout as Buffer;
}

/** 按 EDK2 的 LZMA 载荷布局解压；失败返回 null（用于筛掉不合法候选） */
export function tryLzma(d: Buffer, payload: number, end: number): Buffer | null {
  if (payload + 13 > end) return null;
  const dictSize = d.readUInt32LE(payload + 1);
  const declared = Number(d.readBigUInt64LE(payload + 5));
  // 合理性预筛：字典大小与解压后大小都该是合理量级
  if (dictSize === 0 || dictSize > (1 << 30) || declared === 0 || declared > 0x100000000) return null;
  let blob: Buffer;
  try {
    blob = decompressLzma(d.subarray(payload, end));
  } catch {
    return null;
  }
  // props 字节（lc/lp/pb）不用自己解析：它就在 .lzma 头里，xz 自己会读
  return blob.length === declared ? blob : null;
}

export interface Candidate {
  sec: number;
  gi: number;
  size: number;
  payload: number;
  blob: Buffer;
}

/** 遍历所有 LZMA GUID 命中，挑出第一个「节头合法且能解压」的 */
export function findLzmaSection(d: Buffer, log: (s: string) => void): Candidate | null {
  const g = guidToBytes(GUID_LZMA_CUSTOM);
  let at = d.indexOf(g);
  while (at >= 0) {
    const sec = at - 4;
    if (sec >= 0 && d[sec + 3] === SECTION_GUID_DEFINED) {
      const size = d[sec]! | (d[sec + 1]! << 8) | (d[sec + 2]! << 16);
      if (size >= 24 && sec + size <= d.length) {
        // ⚠️ DataOffset 相对**节头**起点，不是相对 GUID 起点（差 4 字节）
        const dataOffset = d.readUInt16LE(at + 16);
        const payload = sec + dataOffset;
        const blob = tryLzma(d, payload, sec + size);
        if (blob) return { sec, gi: at, size, payload, blob };
        log(`  候选节 @0x${sec.toString(16)} 解压失败，跳过`);
      }
    }
    at = d.indexOf(g, at + 1);
  }
  return null;
}

export interface UncompressResult {
  out: Buffer;
  checks: Array<[string, boolean]>;
  lzmaBefore: number;
  lzmaAfter: number;
  /** 改动区间 [ffsStart, FV_END)，自检里用 */
  ffsStart: number;
  ffsSize: number;
}

/**
 * 去压缩。任何一步与预期不符都抛错，绝不产出半成品固件。
 */
export function uncompressFirmware(d: Buffer, log: (s: string) => void): UncompressResult {
  log(`输入 ${d.length} 字节 = ${(d.length / 1048576).toFixed(1)} MiB`);

  const found = findLzmaSection(d, log);
  if (!found) {
    throw new Error(
      `没找到可用的 LZMA 压缩节（GUID ${GUID_LZMA_CUSTOM}）。固件可能本来就没压缩。`,
    );
  }
  const { sec, size: secSize, payload, blob } = found;
  log(`压缩节 @0x${sec.toString(16)} 大小 ${secSize} (${(secSize / 1048576).toFixed(2)} MiB) 载荷 @0x${payload.toString(16)}`);
  log(`解压 -> ${blob.length} 字节 (${(blob.length / 1048576).toFixed(2)} MiB)`);

  // 解压结果是节流：[RAW 节 12 字节][FV_IMAGE 节头 4 字节 + DXEFV]
  // 去掉那 12 字节前缀，剩下的就是「去掉压缩包装」后的形态
  const ns = blob.subarray(12);
  const nsSize = ns[0]! | (ns[1]! << 8) | (ns[2]! << 16);
  if (ns[3] !== SECTION_FV_IMAGE || nsSize !== ns.length) {
    throw new Error(
      `解压结果不是预期的 FV_IMAGE 节流（type=0x${(ns[3] ?? 0).toString(16)} size=${nsSize} len=${ns.length}）`,
    );
  }
  // DXEFV = ns[4:]：ZeroVector 16 字节 + FileSystemGuid 16 字节
  const fvGuid = guidToText(ns.subarray(20, 36));
  if (fvGuid !== FS_GUID_FFS2) {
    throw new Error(`DXEFV 的 FileSystemGuid 是 ${fvGuid}，应为 ${FS_GUID_FFS2}`);
  }
  log(`新节 大小 ${nsSize}  type=0x17(FV_IMAGE)  DXEFV ${ns.length - 4} 字节`);

  // 定位承载它的 FFS 文件
  const fi = d.indexOf(guidToBytes(GUID_FV_IMAGE_FILE));
  if (fi < 0) throw new Error(`没找到 FV_IMAGE 的 FFS 文件（GUID ${GUID_FV_IMAGE_FILE}）`);
  const oldSize = d[fi + 20]! | (d[fi + 21]! << 8) | (d[fi + 22]! << 16);
  if (ffsHeaderChecksum(d.subarray(fi, fi + 24)) !== d[fi + 16]) {
    throw new Error('FFS 头校验和规则不匹配，拒绝继续（避免产出坏固件）');
  }
  log(`FFS 文件 @0x${fi.toString(16)}  type=0x${(d[fi + 18] ?? 0).toString(16).padStart(2, '0')}  原大小 ${oldSize}`);

  // 组装并改写
  const newSize = 24 + ns.length;
  const end = fi + newSize;
  if (end > FV_END) {
    throw new Error(
      `新 FFS 到 0x${end.toString(16)}，超出固件卷尾 0x${FV_END.toString(16)}。` +
      '本工具不会扩卷，需要人工调整 FV 长度与块映射。',
    );
  }
  log(`新 FFS 大小 ${newSize}，覆盖 0x${fi.toString(16)}..0x${end.toString(16)}` +
      `（卷尾 0x${FV_END.toString(16)}，余 ${((FV_END - end) / 1048576).toFixed(2)} MiB 填 0xFF）`);

  const out = Buffer.from(d);
  const nh = Buffer.from(d.subarray(fi, fi + 24));
  nh[20] = newSize & 0xff;
  nh[21] = (newSize >> 8) & 0xff;
  nh[22] = (newSize >> 16) & 0xff;
  nh[17] = 0xaa;   // File 校验字节：属性未置位时固定值
  nh[23] = 0xf8;   // State：有效
  nh[16] = ffsHeaderChecksum(nh);
  nh.copy(out, fi);
  ns.copy(out, fi + 24);
  out.fill(0xff, fi + newSize, FV_END);

  const gLzma = guidToBytes(GUID_LZMA_CUSTOM);
  const hdrLen = out.readUInt16LE(48);
  const checks: Array<[string, boolean]> = [
    ['改动区之前逐字节一致', out.subarray(0, fi).equals(d.subarray(0, fi))],
    ['FFS size 字段正确', (out[fi + 20]! | (out[fi + 21]! << 8) | (out[fi + 22]! << 16)) === newSize],
    ['FFS 头校验和正确', ffsHeaderChecksum(out.subarray(fi, fi + 24)) === out[fi + 16]],
    ['节类型为 FV_IMAGE', out[fi + 24 + 3] === SECTION_FV_IMAGE],
    ['DXEFV 的 FileSystemGuid 正确', guidToText(out.subarray(fi + 24 + 20, fi + 24 + 36)) === FS_GUID_FFS2],
    ['FV 头校验和有效', fvHeaderSum(out.subarray(0, hdrLen)) === 0],
    ['压缩节已消失', out.indexOf(gLzma, fi) < 0 || countOccurrences(out, gLzma) < countOccurrences(d, gLzma)],
  ];

  return {
    out,
    checks,
    lzmaBefore: countOccurrences(d, gLzma),
    lzmaAfter: countOccurrences(out, gLzma),
    ffsStart: fi,
    ffsSize: newSize,
  };
}

function usage(): void {
  process.stderr.write(
    '用法: npx tsx tools/uncompress-fv.ts <源固件> <目标固件> [-q]\n' +
    '  例: npx tsx tools/uncompress-fv.ts RISCV_VIRT_CODE.fd RISCV_VIRT_CODE_nocomp.fd\n',
  );
}

export function main(argv: string[]): number {
  const pos = argv.filter((a) => !a.startsWith('-'));
  const quiet = argv.includes('-q') || argv.includes('--quiet');
  if (pos.length !== 2) { usage(); return 2; }
  const [source, dest] = pos as [string, string];

  const log = (s: string): void => { if (!quiet) process.stdout.write(`${s}\n`); };

  let src: Buffer;
  try {
    src = readFileSync(source);
  } catch (err) {
    process.stderr.write(`错误: 读不了 ${source}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  let res: UncompressResult;
  try {
    res = uncompressFirmware(src, log);
  } catch (err) {
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  writeFileSync(dest, res.out);

  log('\n自检：');
  let ok = true;
  for (const [name, good] of res.checks) {
    log(`  ${good ? 'OK  ' : 'FAIL'} ${name}`);
    ok = ok && good;
  }
  log(`\n输出 ${dest}  ${res.out.length} 字节`);
  log(`压缩节数 ${res.lzmaBefore} -> ${res.lzmaAfter}`);
  if (!ok) {
    process.stderr.write('自检未全部通过，请勿使用该固件\n');
    return 1;
  }
  return 0;
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  process.exit(main(process.argv.slice(2)));
}
