/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
// BMP 编码器测试：头部字段必须严格符合 BITMAPFILEHEADER / BITMAPINFOHEADER，
// 像素必须逐字节可对，且行序与帧缓冲一致（靠负高度实现，不能翻转）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeBmp, bmpByteLength } from '../src/dev/bmp.ts';

const PIXEL_OFFSET = 54;

/** 造一个 w×h 的 32bpp BGRA 帧 */
function frame(w: number, h: number): Uint8Array {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      d[o] = (x * 7) & 0xff; // B
      d[o + 1] = (y * 11) & 0xff; // G
      d[o + 2] = 0x80; // R
      d[o + 3] = 0x00; // X（应被编码器强制成 0xFF）
    }
  }
  return d;
}

test('BMP：文件头与信息头字段符合规范', () => {
  const w = 64;
  const h = 32;
  const bmp = encodeBmp({ width: w, height: h, data: frame(w, h) });
  const dv = new DataView(bmp.buffer, bmp.byteOffset, bmp.byteLength);

  assert.equal(bmp[0], 0x42, "magic 第 1 字节应为 'B'");
  assert.equal(bmp[1], 0x4d, "magic 第 2 字节应为 'M'");
  assert.equal(dv.getUint32(2, true), 54 + w * h * 4, 'bfSize = 头 + 像素');
  assert.equal(dv.getUint16(6, true), 0, 'bfReserved1');
  assert.equal(dv.getUint16(8, true), 0, 'bfReserved2');
  assert.equal(dv.getUint32(10, true), PIXEL_OFFSET, 'bfOffBits = 54');

  assert.equal(dv.getUint32(14, true), 40, 'biSize = 40（BITMAPINFOHEADER）');
  assert.equal(dv.getInt32(18, true), w, 'biWidth');
  assert.equal(dv.getInt32(22, true), -h, 'biHeight 必须为负（自上而下）');
  assert.equal(dv.getUint16(26, true), 1, 'biPlanes = 1');
  assert.equal(dv.getUint16(28, true), 32, 'biBitCount = 32');
  assert.equal(dv.getUint32(30, true), 0, 'biCompression = BI_RGB');
  assert.equal(dv.getUint32(34, true), w * h * 4, 'biSizeImage');

  assert.equal(bmp.length, bmpByteLength(w, h), 'bmpByteLength 与实际长度一致');
});

test('BMP：像素逐字节一致，且保留通道被填成不透明', () => {
  const w = 16;
  const h = 8;
  const src = frame(w, h);
  const bmp = encodeBmp({ width: w, height: h, data: src });

  for (let i = 0; i < w * h; i++) {
    const s = i * 4;
    const d = PIXEL_OFFSET + i * 4;
    assert.equal(bmp[d], src[s], `像素 ${i} 的 B 通道`);
    assert.equal(bmp[d + 1], src[s + 1], `像素 ${i} 的 G 通道`);
    assert.equal(bmp[d + 2], src[s + 2], `像素 ${i} 的 R 通道`);
    assert.equal(bmp[d + 3], 0xff, `像素 ${i} 的第 4 字节应被填成 0xFF`);
  }
});

test('BMP：行序自上而下（第 0 行必须落在文件最前面）', () => {
  const w = 4;
  const h = 3;
  const src = new Uint8Array(w * h * 4);
  // 第 0 行整行蓝，最后一行整行红 —— 顺序错乱会立刻暴露
  for (let x = 0; x < w; x++) {
    src[x * 4] = 0xff; // 第 0 行 B=255
    const last = ((h - 1) * w + x) * 4;
    src[last + 2] = 0xff; // 最后一行 R=255
  }
  const bmp = encodeBmp({ width: w, height: h, data: src });

  assert.equal(bmp[PIXEL_OFFSET], 0xff, '文件里第一个像素应是第 0 行的蓝');
  assert.equal(bmp[PIXEL_OFFSET + 2], 0x00, '文件里第一个像素的 R 应为 0');
  const lastRowStart = PIXEL_OFFSET + (h - 1) * w * 4;
  assert.equal(bmp[lastRowStart + 2], 0xff, '文件末尾应是最后一行的红');
});

test('BMP：非法输入必须报错而不是产出坏文件', () => {
  assert.throws(() => encodeBmp({ width: 0, height: 4, data: new Uint8Array(0) }), /invalid bmp size/);
  assert.throws(() => encodeBmp({ width: 4, height: -1, data: new Uint8Array(16) }), /invalid bmp size/);
  assert.throws(
    () => encodeBmp({ width: 8, height: 8, data: new Uint8Array(8 * 8 * 4 - 1) }),
    /pixel buffer too small/,
  );
});

test('BMP：真机分辨率 1024x768 的文件大小对得上', () => {
  // 真机 fb0 的 stride = 4096 = 1024*4，说明就是紧凑 32bpp
  assert.equal(bmpByteLength(1024, 768), 54 + 1024 * 768 * 4);
  const bmp = encodeBmp({ width: 8, height: 4, data: new Uint8Array(8 * 4 * 4) });
  assert.equal(bmp.length, 54 + 128);
});
