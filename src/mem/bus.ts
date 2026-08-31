/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import { MASK64, hex } from '../core/bits.ts';
import type { Device, MemSize } from './types.ts';

interface Region {
  base: bigint;
  end: bigint; // 开区间
  dev: Device;
}

export class BusError extends Error {}

/**
 * 物理地址空间总线。设备按区间注册，命中查找带一级缓存（上一命中优先）。
 */
export class Bus {
  private regions: Region[] = [];
  private lastHit = -1;

  /** 注册设备到物理地址 base */
  addDevice(base: bigint, dev: Device): void {
    if ((base & 0xfffn) !== 0n && dev.name !== 'ram') {
      // 仅提示，不强制（部分设备确实可以非页对齐）
    }
    this.regions.push({ base, end: base + dev.size, dev });
    this.regions.sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));
    this.lastHit = -1;
  }

  removeDevice(dev: Device): void {
    this.regions = this.regions.filter((r) => r.dev !== dev);
    this.lastHit = -1;
  }

  devices(): Device[] {
    return this.regions.map((r) => r.dev);
  }

  private find(addr: bigint): [Device, bigint] {
    const n = this.lastHit;
    if (n >= 0) {
      const r = this.regions[n];
      if (addr >= r.base && addr < r.end) return [r.dev, addr - r.base];
    }
    for (let i = 0; i < this.regions.length; i++) {
      const r = this.regions[i];
      if (addr >= r.base && addr < r.end) {
        this.lastHit = i;
        return [r.dev, addr - r.base];
      }
    }
    throw new BusError(`unmapped physical address ${hex(addr)}`);
  }

  /** 物理读（越界抛 BusError） */
  read(addr: bigint, size: MemSize): bigint {
    const [dev, off] = this.find(addr & MASK64);
    return dev.read(off, size);
  }

  /** 物理写 */
  write(addr: bigint, value: bigint, size: MemSize): void {
    const [dev, off] = this.find(addr & MASK64);
    dev.write(off, value & MASK64, size);
  }

  /** 直接写一块字节（可跨设备边界，ELF/initrd 加载用） */
  writeBytes(addr: bigint, bytes: Uint8Array): void {
    let off = 0;
    let cur = addr & MASK64;
    const total = bytes.length;
    while (off < total) {
      const [dev, devOff] = this.find(cur);
      const remainInRegion = dev.size - devOff;
      const chunk = Math.min(Number(remainInRegion), total - off);
      const sub = bytes.subarray(off, off + chunk);
      if (dev.name === 'ram') (dev as unknown as { writeBytes(o: bigint, b: Uint8Array): void }).writeBytes(devOff, sub);
      else for (let i = 0; i < sub.length; i++) dev.write(devOff + BigInt(i), BigInt(sub[i]), 1);
      off += chunk;
      cur += BigInt(chunk);
    }
  }

  readBytes(addr: bigint, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = Number(this.read(addr + BigInt(i), 1) & 0xffn);
    return out;
  }

  /** 供调试器使用：读取以 NUL 结尾的字符串 */
  readCString(addr: bigint, max = 4096): string {
    let s = '';
    for (let i = 0n; i < BigInt(max); i++) {
      const c = Number(this.read(addr + i, 1) & 0xffn);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
}
