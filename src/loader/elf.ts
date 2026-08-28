import { MASK64, hex } from '../core/bits.ts';
import type { Bus } from '../mem/bus.ts';

const PT_LOAD = 1;
const EM_RISCV = 243;
const HIGH_CANONICAL = 0xffffff8000000000n;

export interface ElfSegment {
  /** 段在文件内的偏移 */
  offset: bigint;
  vaddr: bigint;
  paddr: bigint;
  filesz: bigint;
  memsz: bigint;
  flags: number;
}

export interface LoadedImage {
  entry: bigint;
  bias: bigint;
  /** 镜像占用的物理区间 [start, end) */
  physStart: bigint;
  physEnd: bigint;
  segments: ElfSegment[];
  bssEnd: bigint;
}

export class ElfError extends Error {}

function view(buf: Uint8Array): DataView {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** 解析 ELF64 小端头部与程序头 */
export function parseElf(buf: Uint8Array): { entry: bigint; segments: ElfSegment[]; machine: number } {
  if (buf.length < 64) throw new ElfError('file too small to be an ELF');
  const dv = view(buf);
  const magic = [buf[0], buf[1], buf[2], buf[3]];
  if (magic[0] !== 0x7f || magic[1] !== 0x45 || magic[2] !== 0x4c || magic[3] !== 0x46) {
    throw new ElfError('not an ELF file');
  }
  const is64 = buf[4] === 2;
  const little = buf[5] === 1;
  if (!is64) throw new ElfError('only ELF64 is supported');
  if (!little) throw new ElfError('only little-endian ELF is supported');

  const machine = dv.getUint16(18, true);
  const entry = dv.getBigUint64(24, true);
  const phoff = Number(dv.getBigUint64(32, true));
  const phentsize = dv.getUint16(54, true);
  const phnum = dv.getUint16(56, true);

  const segments: ElfSegment[] = [];
  for (let i = 0; i < phnum; i++) {
    const off = phoff + i * phentsize;
    const type = dv.getUint32(off, true);
    if (type !== PT_LOAD) continue;
    segments.push({
      offset: dv.getBigUint64(off + 8, true),
      flags: dv.getUint32(off + 4, true),
      vaddr: dv.getBigUint64(off + 16, true),
      paddr: dv.getBigUint64(off + 24, true),
      filesz: dv.getBigUint64(off + 32, true),
      memsz: dv.getBigUint64(off + 40, true),
    });
  }
  return { entry, segments, machine };
}

export interface LoadOptions {
  /** 强制把镜像加载到该物理地址（同时调整入口） */
  loadAt?: bigint;
  /** 内存物理区间，用于校验 */
  ramBase: bigint;
  ramSize: bigint;
  /** 是否允许加载到 RAM 之外（例如加载到 ROM） */
  allowOutside?: boolean;
}

/**
 * 把 ELF 镜像装入物理内存。
 *
 * 地址策略：
 *  1. 指定 loadAt 时，整体按 (loadAt - minVaddr) 平移；
 *  2. 否则若程序头的 p_paddr 是合理的物理地址，按 (p_paddr - p_vaddr) 平移；
 *  3. 否则按虚拟地址直接加载。
 */
export function loadElf(bus: Bus, buf: Uint8Array, opts: LoadOptions): LoadedImage {
  const { entry, segments, machine } = parseElf(buf);
  if (machine !== EM_RISCV) throw new ElfError(`unsupported ELF machine: ${machine} (expect ${EM_RISCV} = RISC-V)`);
  if (segments.length === 0) throw new ElfError('no PT_LOAD segments');

  let minVaddr = segments[0].vaddr;
  for (const s of segments) if (s.vaddr < minVaddr) minVaddr = s.vaddr;
  const pageAlignedMin = minVaddr & ~0xfffn;

  let bias = 0n;
  if (opts.loadAt !== undefined) {
    bias = opts.loadAt - pageAlignedMin;
  } else {
    const physicalized = segments.every((s) => s.paddr !== 0n && s.paddr < HIGH_CANONICAL);
    if (physicalized) bias = segments[0].paddr - segments[0].vaddr;
  }

  let physStart = 0xffffffffffffffffn;
  let physEnd = 0n;
  let bssEnd = 0n;

  for (const s of segments) {
    const dest = (s.vaddr + bias) & MASK64;
    if (!opts.allowOutside && (dest < opts.ramBase || dest + s.memsz > opts.ramBase + opts.ramSize)) {
      throw new ElfError(
        `segment would land outside RAM: vaddr=${hex(s.vaddr)} dest=${hex(dest)} size=${s.memsz} ` +
          `(RAM ${hex(opts.ramBase)}..${hex(opts.ramBase + opts.ramSize)})`,
      );
    }
    const data = buf.subarray(Number(s.offset), Number(s.offset + s.filesz));
    bus.writeBytes(dest, data);
    if (s.memsz > s.filesz) {
      // BSS 清零
      const zeroStart = dest + s.filesz;
      const zeroLen = Number(s.memsz - s.filesz);
      const zeroes = new Uint8Array(Math.min(zeroLen, 1 << 20));
      let off = 0n;
      while (off < BigInt(zeroLen)) {
        const n = Math.min(zeroes.length, zeroLen - Number(off));
        bus.writeBytes(zeroStart + off, zeroes.subarray(0, n));
        off += BigInt(n);
      }
    }
    if (dest < physStart) physStart = dest;
    if (dest + s.memsz > physEnd) physEnd = dest + s.memsz;
    if (dest + s.memsz > bssEnd) bssEnd = dest + s.memsz;
  }

  const entryPhys = (entry + bias) & MASK64;
  return { entry: entryPhys, bias, physStart, physEnd, segments, bssEnd };
}

/** 以二进制镜像方式加载（无 ELF 头） */
export function loadBinary(bus: Bus, buf: Uint8Array, dest: bigint): { entry: bigint; physEnd: bigint } {
  bus.writeBytes(dest, buf);
  return { entry: dest, physEnd: dest + BigInt(buf.length) };
}
