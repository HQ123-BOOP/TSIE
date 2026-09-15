/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import { MASK64 } from '../core/bits.ts';
import type { Device, MemSize } from './types.ts';

/**
 * 物理内存：用 Uint8Array + DataView 实现，天然支持非对齐访问与小端序。
 */
export class RAM implements Device {
  readonly name = 'ram';
  readonly size: bigint;
  readonly data: Uint8Array;
  readonly view: DataView;
  /** 用于 32 位快速路径的视图（小端） */
  private readonly u32: Uint32Array;

  constructor(sizeBytes: bigint | number) {
    const n = typeof sizeBytes === 'bigint' ? Number(sizeBytes) : sizeBytes;
    if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid RAM size: ${sizeBytes}`);
    this.size = BigInt(n);
    this.data = new Uint8Array(n);
    this.view = new DataView(this.data.buffer);
    this.u32 = new Uint32Array(this.data.buffer);
  }

  read(offset: bigint, size: MemSize): bigint {
    const a = Number(offset);
    switch (size) {
      case 1:
        return BigInt(this.data[a]);
      case 2:
        return BigInt(this.view.getUint16(a, true));
      case 4:
        // 对齐时走 TypedArray 快路径
        return BigInt((a & 3) === 0 ? this.u32[a >>> 2] : this.view.getUint32(a, true));
      case 8:
        return this.view.getBigUint64(a, true);
    }
  }

  write(offset: bigint, value: bigint, size: MemSize): void {
    const a = Number(offset);
    switch (size) {
      case 1:
        this.data[a] = Number(value & 0xffn);
        return;
      case 2:
        this.view.setUint16(a, Number(value & 0xffffn), true);
        return;
      case 4:
        if ((a & 3) === 0) this.u32[a >>> 2] = Number(value & 0xffffffffn);
        else this.view.setUint32(a, Number(value & 0xffffffffn), true);
        return;
      case 8:
        this.view.setBigUint64(a, value & MASK64, true);
        return;
    }
  }

  /** 批量写入（加载 ELF / initrd 用） */
  writeBytes(offset: bigint, bytes: Uint8Array): void {
    this.data.set(bytes, Number(offset));
  }

  /** 批量读取到调用方缓冲（设备 DMA 用，避免逐字节走 bus） */
  readBytes(offset: bigint, dst: Uint8Array): void {
    const at = Number(offset);
    dst.set(this.data.subarray(at, at + dst.length));
  }

  /** 批量填充 */
  fill(offset: bigint, length: number, value: number): void {
    this.data.fill(value, Number(offset), Number(offset) + length);
  }

  /** 以 32 位字（机器码）批量写入，返回下一个偏移 */
  writeWords(offset: bigint, words: ArrayLike<number>): void {
    let idx = Number(offset) >>> 2;
    for (let i = 0; i < words.length; i++) this.u32[idx++] = words[i] >>> 0;
  }

  /**
   * 按指令实际长度写入程序：低 2 位为 11 视为 32 位指令，否则为 16 位压缩指令。
   * 与真实汇编器一致：32 位指令会先对齐到 4 字节（必要时插入 C.NOP）。
   * @returns 写入的字节数
   */
  writeProgram(offset: bigint, words: ArrayLike<number>): number {
    let at = Number(offset);
    for (let i = 0; i < words.length; i++) {
      const w = words[i] >>> 0;
      if ((w & 3) === 3) {
        if ((at & 3) !== 0) {
          // 插入 C.NOP 对齐
          this.view.setUint16(at, 0x0001, true);
          at += 2;
        }
        this.view.setUint32(at, w, true);
        at += 4;
      } else {
        this.view.setUint16(at, w & 0xffff, true);
        at += 2;
      }
    }
    return at - Number(offset);
  }
}
