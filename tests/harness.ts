import { Bus } from '../src/mem/bus.ts';
import { RAM } from '../src/mem/ram.ts';
import { Cpu } from '../src/cpu/cpu.ts';
import { TestFinisher } from '../src/dev/test.ts';
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
