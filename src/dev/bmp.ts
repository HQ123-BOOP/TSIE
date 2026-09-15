/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */

/** BITMAPFILEHEADER 大小 */
const FILE_HEADER_SIZE = 14;
/** BITMAPINFOHEADER 大小 */
const INFO_HEADER_SIZE = 40;
/** 像素数据起始偏移 */
const PIXEL_OFFSET = FILE_HEADER_SIZE + INFO_HEADER_SIZE;

/** 可被 BMP 编码的帧缓冲视图 */
export interface BmpFrame {
  width: number;
  height: number;
  /**
   * 32bpp 行主序像素，紧凑排列（每行 width*4 字节），字节序 B,G,R,X。
   * 与 virtio-gpu 的 B8G8R8X8 / XRGB8888 内存布局一致，因此无需通道重排。
   */
  data: Uint8Array;
}

/**
 * 把帧缓冲编码成 32bpp BMP（BI_RGB）。
 *
 * 之所以选 BMP：virtio-gpu 资源在内存里就是 B,G,R,X 每像素 4 字节，而 BMP 的
 * 32bpp BI_RGB 在文件里也是同样的字节序 —— 不用重排通道，也不用压缩。
 * 高度写成负数表示自上而下，与帧缓冲的行序一致，省掉逐行翻转。
 *
 * 纯函数、不碰 node API，浏览器端（Blob/URL.createObjectURL）同样可用。
 */
export function encodeBmp(frame: BmpFrame): Uint8Array {
  const { width, height, data } = frame;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`invalid bmp size: ${width}x${height}`);
  }
  const pixels = width * height * 4;
  if (data.length < pixels) {
    throw new Error(`pixel buffer too small: ${data.length} < ${pixels}`);
  }

  const out = new Uint8Array(PIXEL_OFFSET + pixels);
  const dv = new DataView(out.buffer);

  // --- BITMAPFILEHEADER ---
  out[0] = 0x42; // 'B'
  out[1] = 0x4d; // 'M'
  dv.setUint32(2, out.length, true); // bfSize
  dv.setUint16(6, 0, true); // bfReserved1
  dv.setUint16(8, 0, true); // bfReserved2
  dv.setUint32(10, PIXEL_OFFSET, true); // bfOffBits

  // --- BITMAPINFOHEADER ---
  dv.setUint32(14, INFO_HEADER_SIZE, true); // biSize
  dv.setInt32(18, width, true); // biWidth
  dv.setInt32(22, -height, true); // biHeight（负 = 自上而下）
  dv.setUint16(26, 1, true); // biPlanes
  dv.setUint16(28, 32, true); // biBitCount
  dv.setUint32(30, 0, true); // biCompression = BI_RGB
  dv.setUint32(34, pixels, true); // biSizeImage
  dv.setInt32(38, 2835, true); // biXPelsPerMeter（72 DPI）
  dv.setInt32(42, 2835, true); // biYPelsPerMeter
  dv.setUint32(46, 0, true); // biClrUsed
  dv.setUint32(50, 0, true); // biClrImportant

  // --- 像素 ---
  out.set(data.subarray(0, pixels), PIXEL_OFFSET);
  // 第 4 字节是 guest 侧的保留通道（X），BI_RGB 下本应被忽略，
  // 但部分查看器会当 alpha 用 —— 统一填 0xFF，免得出现"整张图透明"
  for (let i = PIXEL_OFFSET + 3; i < out.length; i += 4) out[i] = 0xff;

  return out;
}

/** 编码后 BMP 的字节数（不实际分配） */
export function bmpByteLength(width: number, height: number): number {
  return PIXEL_OFFSET + width * height * 4;
}
