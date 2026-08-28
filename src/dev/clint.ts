import { MASK64 } from '../core/bits.ts';
import type { Device, MemSize } from '../mem/types.ts';

const CLINT_MSIP = 0x0000n;
const CLINT_TIMECMP = 0x4000n;
const CLINT_TIME = 0xbff8n;

/**
 * Core Local Interruptor：mtime / mtimecmp / msip（QEMU virt 布局）。
 */
export class Clint implements Device {
  readonly name = 'clint';
  readonly size = 0x10000n;

  mtime = 0n;
  mtimecmp = 0xffffffffffffffffn;
  msip = 0n;

  /** 定时器中断挂起 */
  get timerPending(): boolean {
    return this.mtime >= this.mtimecmp;
  }

  /** 软件中断挂起 */
  get softwarePending(): boolean {
    return (this.msip & 0x1n) !== 0n;
  }

  read(offset: bigint, size: MemSize): bigint {
    const o = offset & MASK64;
    if (o >= CLINT_TIME) {
      const v = this.mtime >> BigInt(8 * (Number(o - CLINT_TIME)));
      return this.slice(v, size);
    }
    if (o >= CLINT_TIMECMP && o < CLINT_TIME) {
      const v = this.mtimecmp >> BigInt(8 * Number(o - CLINT_TIMECMP));
      return this.slice(v, size);
    }
    if (o >= CLINT_MSIP && o < CLINT_TIMECMP) {
      const v = this.msip >> BigInt(8 * Number(o - CLINT_MSIP));
      return this.slice(v, size);
    }
    return 0n;
  }

  write(offset: bigint, value: bigint, size: MemSize): void {
    const o = offset & MASK64;
    if (o >= CLINT_TIME) {
      this.mtime = this.deposit(this.mtime, value, size, Number(o - CLINT_TIME));
    } else if (o >= CLINT_TIMECMP) {
      this.mtimecmp = this.deposit(this.mtimecmp, value, size, Number(o - CLINT_TIMECMP));
    } else if (o >= CLINT_MSIP) {
      this.msip = this.deposit(this.msip, value, size, Number(o - CLINT_MSIP)) & 0x1n;
    }
  }

  private slice(v: bigint, size: MemSize): bigint {
    switch (size) {
      case 1: return v & 0xffn;
      case 2: return v & 0xffffn;
      case 4: return v & 0xffffffffn;
      case 8: return v & MASK64;
    }
  }

  /** 把 value 写入 64 位寄存器的第 byteOff 字节开始的若干字节 */
  private deposit(reg: bigint, value: bigint, size: MemSize, byteOff: number): bigint {
    const shift = BigInt(8 * byteOff);
    const mask = ((1n << BigInt(8 * size)) - 1n) << shift;
    return (reg & ~mask) | ((value << shift) & mask & MASK64);
  }
}
