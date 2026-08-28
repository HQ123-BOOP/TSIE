import type { Device, MemSize } from '../mem/types.ts';
import type { IrqLine } from './uart.ts';

const PLIC_PRIORITY_BASE = 0x000000;
const PLIC_PENDING_BASE = 0x001000;
const PLIC_ENABLE_BASE = 0x002000;
const PLIC_ENABLE_STRIDE = 0x80;
const PLIC_CONTEXT_BASE = 0x200000;
const PLIC_CONTEXT_STRIDE = 0x1000;

/**
 * RISC-V PLIC（平台级中断控制器），QEMU virt 兼容布局。
 * 上下文 0 = M 模式 hart0，上下文 1 = S 模式 hart0。
 */
export class Plic implements Device {
  readonly name = 'plic';
  readonly size = 0x4000000n;

  readonly numSources: number;
  readonly numContexts: number;

  private priority: Uint32Array;
  /** 每个中断源的挂起状态 */
  private pending = 0n;
  /** 每个上下文的使能位 */
  private enables: bigint[];
  /** 每个上下文的优先级阈值 */
  private threshold: number[];
  /** 已 claim 但尚未 complete 的中断（用于 debug） */
  private claimed: number[];

  private irqLines: Array<IrqLine | undefined> = [];

  constructor(numSources = 32, numContexts = 2) {
    this.numSources = numSources;
    this.numContexts = numContexts;
    this.priority = new Uint32Array(numSources + 1);
    this.enables = new Array(numContexts).fill(0n);
    this.threshold = new Array(numContexts).fill(0);
    this.claimed = new Array(numContexts).fill(0);
    this.irqLines = new Array(numContexts).fill(undefined);
  }

  /** 绑定某上下文的中断输出线 */
  bindContext(ctx: number, line: IrqLine): void {
    this.irqLines[ctx] = line;
  }

  /** 设备拉高/拉低某个中断源 */
  setIrq(source: number, level: boolean): void {
    if (source <= 0 || source > this.numSources) return;
    const bit = 1n << BigInt(source);
    if (level) this.pending |= bit;
    else this.pending &= ~bit;
    this.update();
  }

  /** 当前上下文的最高优先级待处理中断（0 表示无） */
  private bestFor(ctx: number): number {
    const enabled = this.pending & this.enables[ctx];
    if (enabled === 0n) return 0;
    let best = 0;
    let bestPrio = this.threshold[ctx];
    for (let s = 1; s <= this.numSources; s++) {
      const bit = 1n << BigInt(s);
      if ((enabled & bit) === 0n) continue;
      const p = this.priority[s];
      if (p > bestPrio) {
        bestPrio = p;
        best = s;
      }
    }
    return best;
  }

  private lastLevel: boolean[] = [];
  private update(): void {
    for (let c = 0; c < this.numContexts; c++) {
      const level = this.bestFor(c) !== 0;
      if (this.lastLevel[c] !== level) {
        this.lastLevel[c] = level;
        this.irqLines[c]?.(level);
      }
    }
  }

  read(offset: bigint, size: MemSize): bigint {
    const o = Number(offset);
    if (o >= PLIC_CONTEXT_BASE) {
      const ctx = Math.floor((o - PLIC_CONTEXT_BASE) / PLIC_CONTEXT_STRIDE);
      const off = (o - PLIC_CONTEXT_BASE) % PLIC_CONTEXT_STRIDE;
      if (ctx >= this.numContexts) return 0n;
      if (off === 0) {
        // claim / complete
        const id = this.bestFor(ctx);
        if (id !== 0) {
          this.pending &= ~(1n << BigInt(id));
          this.claimed[ctx] = id;
          this.update();
        }
        return BigInt(id);
      }
      if (off === 4) return BigInt(this.threshold[ctx]); // threshold
      return 0n;
    }
    if (o >= PLIC_ENABLE_BASE) {
      const rel = o - PLIC_ENABLE_BASE;
      const ctx = Math.floor(rel / PLIC_ENABLE_STRIDE);
      const word = Math.floor((rel % PLIC_ENABLE_STRIDE) / 4);
      if (ctx >= this.numContexts) return 0n;
      const v = (this.enables[ctx] >> BigInt(32 * word)) & 0xffffffffn;
      return size === 8 ? v : v & 0xffffffffn;
    }
    if (o >= PLIC_PENDING_BASE) {
      const word = Math.floor((o - PLIC_PENDING_BASE) / 4);
      const v = (this.pending >> BigInt(32 * word)) & 0xffffffffn;
      return v;
    }
    // 优先级区
    if (o < PLIC_PRIORITY_BASE) return 0n;
    const idx = Math.floor((o - PLIC_PRIORITY_BASE) / 4);
    if (idx <= this.numSources) return BigInt(this.priority[idx]);
    return 0n;
  }

  write(offset: bigint, value: bigint, _size: MemSize): void {
    const o = Number(offset);
    const v = Number(value & 0xffffffffn);
    if (o >= PLIC_CONTEXT_BASE) {
      const ctx = Math.floor((o - PLIC_CONTEXT_BASE) / PLIC_CONTEXT_STRIDE);
      const off = (o - PLIC_CONTEXT_BASE) % PLIC_CONTEXT_STRIDE;
      if (ctx >= this.numContexts) return;
      if (off === 0) {
        // complete：重新计算（源可能仍处于挂起状态）
        this.claimed[ctx] = 0;
        this.update();
      } else if (off === 4) {
        this.threshold[ctx] = v & 0xff;
        this.update();
      }
      return;
    }
    if (o >= PLIC_ENABLE_BASE) {
      const rel = o - PLIC_ENABLE_BASE;
      const ctx = Math.floor(rel / PLIC_ENABLE_STRIDE);
      const word = Math.floor((rel % PLIC_ENABLE_STRIDE) / 4);
      if (ctx >= this.numContexts) return;
      const shift = BigInt(32 * word);
      const mask = 0xffffffffn << shift;
      this.enables[ctx] = (this.enables[ctx] & ~mask) | ((BigInt(v) << shift) & mask);
      this.update();
      return;
    }
    if (o >= PLIC_PENDING_BASE || o < PLIC_PRIORITY_BASE) return; // pending 区只读
    const idx = Math.floor((o - PLIC_PRIORITY_BASE) / 4);
    if (idx <= this.numSources) {
      this.priority[idx] = v & 0x7;
      this.update();
    }
  }
}
