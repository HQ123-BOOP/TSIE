// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 TSIE
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import {
  FS_GUID_FFS2,
  FV_END,
  GUID_FV_IMAGE_FILE,
  GUID_LZMA_CUSTOM,
  SECTION_FV_IMAGE,
  SECTION_GUID_DEFINED,
  ffsHeaderChecksum,
  fvHeaderSum,
  guidToBytes,
  guidToText,
  uncompressFirmware,
} from '../tools/uncompress-fv.ts';

const xzAvailable = spawnSync('xz', ['--version'], { stdio: 'ignore' }).status === 0;

// ------------------------------------------------------------------ 纯函数

test('GUID 文本与固件字节序互转（前三段小端，后两段原序）', () => {
  for (const g of [GUID_LZMA_CUSTOM, GUID_FV_IMAGE_FILE, FS_GUID_FFS2]) {
    const b = guidToBytes(g);
    assert.equal(b.length, 16);
    assert.equal(guidToText(b), g.toUpperCase(), '来回一趟必须回到原值');
  }
  // 手算一例，防止"来回都对但两边都错"
  assert.equal(guidToBytes('00112233-4455-6677-8899-AABBCCDDEEFF').toString('hex'),
    '33221100554477668899aabbccddeeff');
});

test('FFS 头校验和：三处清零后取补，且把结果填回去等于自身', () => {
  const hdr = Buffer.alloc(24, 0x11);
  const sum = ffsHeaderChecksum(hdr);
  assert.equal(sum, (0x100 - ((0x11 * 21) % 0x100)) & 0xff, '21 个非零字节（24 减去被清零的 3 个）');
  hdr[16] = sum;
  assert.equal(ffsHeaderChecksum(hdr), sum, '校验字段本身在计算时要清零，所以填回去不影响结果');
  // 只清 +16 是错的：那种算法在改了 +17/+23 后会给出不同答案
  const wrong = (0x100 - ((0x11 * 23) % 0x100)) & 0xff;
  assert.notEqual(sum, wrong, '这正是原 Python 版第一版错在的地方');
});

test('FV 头校验和：按 u16 求和，填好校验字段后 ≡ 0 (mod 0x10000)', () => {
  const hdr = Buffer.alloc(56, 0);
  hdr.write('_FVH', 40, 'latin1');
  hdr.writeUInt16LE(56, 48);          // HeaderLength
  const partial = fvHeaderSum(hdr);
  hdr.writeUInt16LE((0x10000 - partial) & 0xffff, 50);
  assert.equal(fvHeaderSum(hdr), 0, '有效 FV 头的字和必须为 0');
});

// ------------------------------------------------------------- 错误路径

test('没有 LZMA 压缩节时报错，且不去调用外部工具', () => {
  const junk = Buffer.alloc(4096, 0xaa);
  assert.throws(() => uncompressFirmware(junk, () => {}), /没找到可用的 LZMA 压缩节/);
});

// ------------------------------------------------- 合成固件的端到端（需 xz）

/** 造一份 8 MiB 的假固件：FV 头 + 一个承载 LZMA GUIDed 节的 FFS 文件 */
function syntheticFirmware(): { fw: Buffer; ffsAt: number; payloadAt: number; nsSize: number } {
  const ffsAt = 0x100;
  const payloadAt = ffsAt + 24 + 24; // FFS 头 + GUIDed 节头（4 字节通用头 + 16 GUID + 2 DataOffset + 2 Attributes）

  const dxefv = Buffer.alloc(64, 0);
  guidToBytes(FS_GUID_FFS2).copy(dxefv, 16);          // ZeroVector(16) 之后是 FileSystemGuid
  const ns = Buffer.concat([
    Buffer.from([0, 0, 0, SECTION_FV_IMAGE]),         // 通用节头：Size 占 3 字节，随后填
    dxefv,
  ]);
  ns.writeUIntLE(ns.length, 0, 3);

  // 解压结果是"节流"：[RAW 节 12 字节][ns]
  const stream = Buffer.concat([Buffer.alloc(12, 0x5a), ns]);
  const lzma = spawnSync('xz', ['--format=lzma', '-c'], { input: stream, maxBuffer: 1 << 20 });
  assert.equal(lzma.status, 0, 'xz 压缩失败');
  // ⚠️ xz 往管道写时无法回填 .lzma 头的"解压后大小"（写全 0xFF = 未知），
  // 而 EDK2 的载荷里是真值 —— 不补这一下，载荷会被合理性预筛（大小必须是合理量级）挡掉。
  const payload = Buffer.from(lzma.stdout);
  payload.writeBigUInt64LE(BigInt(stream.length), 5);

  const fw = Buffer.alloc(FV_END, 0xff);
  // FV 头：HeaderLength 在 +48，校验和在 +50。
  // ⚠️ 算校验和之前必须把校验字段**清零**：填充是 0xFF 时直接套 (0x10000 - sum)
  // 会差一个 0xFFFF（本 fixture 第一版就这么错过）。
  fw.writeUInt16LE(56, 48);
  fw.write('_FVH', 40, 'latin1');
  fw.writeUInt16LE(0, 50);
  fw.writeUInt16LE((0x10000 - fvHeaderSum(fw.subarray(0, 56))) & 0xffff, 50);

  // FFS 头
  guidToBytes(GUID_FV_IMAGE_FILE).copy(fw, ffsAt);
  fw[ffsAt + 17] = 0xaa;                    // File 校验字节
  fw[ffsAt + 18] = 0x0b;                    // Type
  fw.writeUIntLE(24 + 24 + payload.length, ffsAt + 20, 3);  // Size = FFS 头 + 节
  fw[ffsAt + 23] = 0xf8;                    // State
  fw[ffsAt + 16] = ffsHeaderChecksum(fw.subarray(ffsAt, ffsAt + 24));

  // GUIDed 节头 + 载荷。节大小 = 通用头(4) + GUID(16) + DataOffset(2) + Attributes(2) + 载荷，
  // 一个字节都不能多：喂给 xz 的范围超出 EOS 会被判为损坏（原 Python 版注释里的同一个坑）。
  fw.writeUIntLE(24 + payload.length, ffsAt + 24, 3);
  fw[ffsAt + 24 + 3] = SECTION_GUID_DEFINED;
  guidToBytes(GUID_LZMA_CUSTOM).copy(fw, ffsAt + 28);
  fw.writeUInt16LE(24, ffsAt + 28 + 16);    // DataOffset 相对节头起点
  payload.copy(fw, payloadAt);

  return { fw, ffsAt, payloadAt, nsSize: ns.length };
}

test('合成固件端到端：压缩节被换成裸 FV_IMAGE 节，且自检全过', { skip: !xzAvailable ? '本机没有 xz' : false }, () => {
  const { fw, ffsAt, nsSize } = syntheticFirmware();
  const res = uncompressFirmware(fw, () => {});

  for (const [name, ok] of res.checks) assert.ok(ok, `自检未过: ${name}`);
  assert.equal(res.lzmaBefore, 1);
  assert.equal(res.lzmaAfter, 0, '压缩节的 GUID 应当消失');
  assert.equal(res.out[ffsAt + 24 + 3], SECTION_FV_IMAGE);
  assert.equal(guidToText(res.out.subarray(ffsAt + 24 + 20, ffsAt + 24 + 36)), FS_GUID_FFS2);
  assert.equal(res.ffsSize, 24 + nsSize);
  assert.ok(res.out.subarray(0, ffsAt).equals(fw.subarray(0, ffsAt)), '改动区之前必须逐字节一致');
  assert.ok(res.out.subarray(ffsAt + res.ffsSize, FV_END).every((b) => b === 0xff), '卷尾补 0xFF');
});

test('合成固件里 LZMA 载荷被破坏时应报错，而不是产出坏固件', { skip: !xzAvailable ? '本机没有 xz' : false }, () => {
  const { fw, payloadAt } = syntheticFirmware();
  fw.fill(0x00, payloadAt + 20, payloadAt + 60);   // 破坏 LZMA 流
  assert.throws(() => uncompressFirmware(fw, () => {}), /没找到可用的 LZMA 压缩节/);
});
