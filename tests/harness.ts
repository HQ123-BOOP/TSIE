/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import { Bus } from '../src/mem/bus.ts';
import { RAM } from '../src/mem/ram.ts';
import { Cpu } from '../src/cpu/cpu.ts';
import { TestFinisher } from '../src/dev/test.ts';
import { CSR } from '../src/cpu/csr.ts';
import { li, sd } from '../tools/encoder.ts';

export const TEST_BASE = 0x80000000n;
/** 停机设备地址：程序往这里写一次即可结束运行 */
export const TEST_HALT = 0x100000n;
export const TEST_RAM_SIZE = 4 * 1024 * 1024;

export interface Harness {
  cpu: Cpu;
  bus: Bus;
  ram: RAM;
  /** 已执行指令数 */
  steps: number;
  /** 继续执行 n 条指令 */
  run(n: number): void;
  /** 运行直到 x31（或指定寄存器）变成 sentinel 值 */
  x(i: number): bigint;
}

/** 构造一个只含 RAM 的最小机器，用于指令级单元测试 */
export function makeCpu(program: number[], opts: { misaligned?: 'trap' | 'slow' } = {}): Harness {
  const bus = new Bus();
  const ram = new RAM(TEST_RAM_SIZE);
  bus.addDevice(TEST_BASE, ram);
  const cpu = new Cpu(bus, { misaligned: opts.misaligned ?? 'trap' });
  bus.addDevice(TEST_HALT, new TestFinisher(() => cpu.halt('test-finisher', 0)));
  cpu.reset(TEST_BASE);
  // 按指令实际长度（2 或 4 字节）写入程序
  ram.writeProgram(0n, program);
  const h: Harness = {
    cpu,
    bus,
    ram,
    steps: 0,
    run(n: number) {
      for (let i = 0; i < n; i++) {
        if (cpu.halted) break;
        cpu.step();
        h.steps++;
      }
    },
    x(i: number) {
      return cpu.x[i];
    },
  };
  return h;
}

/** 物理地址 → RAM 内偏移 */
export function off(paddr: bigint): bigint {
  return paddr - TEST_BASE;
}

/** 向内存写入 64 位值 */
export function poke(ram: RAM, addr: bigint, value: bigint): void {
  ram.write(off(addr), value, 8);
}

/** 从内存读 64 位值 */
export function peek(ram: RAM, addr: bigint): bigint {
  return ram.read(off(addr), 8);
}

/** 程序结束：写停机设备使 CPU 进入 halted 状态（scratch 寄存器会被占用） */
export function halt(): number[] {
  return [...li(31, TEST_HALT, 30), sd(31, 0, 0)];
}

/** 运行到指定 PC（便于在目标指令前停下） */
export function runToPc(h: Harness, pc: bigint, max = 5000): void {
  let guard = 0;
  while (h.cpu.pc !== pc && guard++ < max) {
    if (h.cpu.halted) throw new Error(`CPU halted before reaching pc ${pc.toString(16)}`);
    h.cpu.step();
    h.steps++;
  }
  if (h.cpu.pc !== pc) throw new Error(`timeout waiting for pc ${pc.toString(16)} (at ${h.cpu.pc.toString(16)})`);
}

/** 第 n 条指令（从 0 开始）的地址：程序由 32 位指令构成时成立 */
export function pcOf(index: number): bigint {
  return TEST_BASE + BigInt(index * 4);
}

/** 把 32 位机器码数组打包成字节（用于加载到任意地址） */
export function wordsToBytes(words: number[]): Uint8Array {
  const out = new Uint8Array(words.length * 4);
  const dv = new DataView(out.buffer);
  words.forEach((w, i) => dv.setUint32(i * 4, w >>> 0, true));
  return out;
}

/** 在指定地址安装陷阱入口（内容为停机序列），并把 mtvec/stvec 指向它 */
export function installTrapHandler(h: Harness, addr: bigint): void {
  h.ram.writeProgram(addr - TEST_BASE, halt());
  h.cpu.csr.writeRaw(CSR.MTVEC, addr);
  h.cpu.csr.writeRaw(CSR.STVEC, addr);
}

// ----------------------------------------------------------------------
// Sv39 页表构造助手
// ----------------------------------------------------------------------

export const PTE_V = 0x01n;
export const PTE_R = 0x02n;
export const PTE_W = 0x04n;
export const PTE_X = 0x08n;
export const PTE_U = 0x10n;
export const PTE_A = 0x40n;
export const PTE_D = 0x80n;

/**
 * 简易 Sv39 页表构造器：自动分配中间级页表，支持 4KB / 2MB / 1GB 页。
 */
export class Sv39Mapper {
  readonly root: bigint;
  /** 根页表所在层级：Sv39 = 2，Sv48 = 3 */
  readonly topLevel: 0 | 1 | 2 | 3;
  private ram: RAM;
  private pool: bigint;

  constructor(h: { ram: RAM }, rootPhys: bigint, tablePool: bigint, topLevel: 0 | 1 | 2 | 3 = 2) {
    this.ram = h.ram;
    this.root = rootPhys;
    this.pool = tablePool;
    this.topLevel = topLevel;
    this.ram.fill(rootPhys - TEST_BASE, 0x1000, 0);
  }

  private alloc(): bigint {
    const p = this.pool;
    this.pool += 0x1000n;
    this.ram.fill(p - TEST_BASE, 0x1000, 0);
    return p;
  }

  private readPte(table: bigint, idx: number): bigint {
    return this.ram.read(table - TEST_BASE + BigInt(idx * 8), 8);
  }

  private writePte(table: bigint, idx: number, pte: bigint): void {
    this.ram.write(table - TEST_BASE + BigInt(idx * 8), pte, 8);
  }

  /** 读取叶子页表项（便于断言 A/D 位） */
  leafPte(va: bigint, level: 0 | 1 | 2 | 3 = 0): bigint {
    let table = this.root;
    for (let i = this.topLevel; i > level; i--) {
      const idx = Number((va >> BigInt(12 + 9 * i)) & 0x1ffn);
      const pte = this.readPte(table, idx);
      if ((pte & PTE_V) === 0n) return 0n;
      table = ((pte >> 10n) & 0xfffffffffffn) << 12n;
    }
    const idx = Number((va >> BigInt(12 + 9 * level)) & 0x1ffn);
    return this.readPte(table, idx);
  }

  /** 建立映射：level = 0(4KB) / 1(2MB) / 2(1GB) */
  map(va: bigint, pa: bigint, flags: bigint, level: 0 | 1 | 2 | 3 = 0): void {
    let table = this.root;
    for (let i = this.topLevel; i > level; i--) {
      const idx = Number((va >> BigInt(12 + 9 * i)) & 0x1ffn);
      let pte = this.readPte(table, idx);
      if ((pte & PTE_V) === 0n) {
        const next = this.alloc();
        pte = ((next >> 12n) << 10n) | PTE_V;
        this.writePte(table, idx, pte);
      }
      table = ((pte >> 10n) & 0xfffffffffffn) << 12n;
    }
    const idx = Number((va >> BigInt(12 + 9 * level)) & 0x1ffn);
    this.writePte(table, idx, ((pa >> 12n) << 10n) | flags | PTE_V);
  }

  /** 生成 satp 值（默认 Sv39，ASID=0） */
  satp(mode = 8n, asid = 0n): bigint {
    return (mode << 60n) | (asid << 44n) | ((this.root >> 12n) & 0xfffffffffffn);
  }
}
