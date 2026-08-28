/**
 * ts-riscv64 —— 用 TypeScript 实现的 RISC-V 64 位模拟器。
 *
 * 主要组成：
 *  - CPU：RV64IMAFDC（RV64GC）+ Zicsr/Zifencei，M/S/U 三种特权级
 *  - MMU：Sv39 / Sv48 分页 + TLB
 *  - 外设：NS16550 UART、CLINT、PLIC、VirtIO 块设备、SiFive Test
 *  - 固件：内建 SBI v0.2（无需外部 OpenSBI 即可启动 Linux）
 *  - 加载：ELF64 装载 + 扁平设备树（DTB）生成
 */

export { Cpu, type CpuOptions, type SbiLayer, type MisalignedMode } from './cpu/cpu.ts';
export {
  CsrFile,
  CSR,
  Exc,
  Irq,
  Priv,
  type PrivLevel,
  INTERRUPT_FLAG,
  MISA_VALUE,
  type CounterSource,
} from './cpu/csr.ts';
export { Mmu, PAGE_SIZE, PAGE_SHIFT } from './cpu/mmu.ts';
export { FFLAG, RM, f32Box, unboxF32, bitsToF64, f64Box, fclassOfBits, fcmpFlags, flagsForResult, fminMax, rawF32, roundResult, canonicalNaN } from './cpu/fpu.ts';

export { Bus, BusError } from './mem/bus.ts';
export { RAM } from './mem/ram.ts';
export { AccessType, type Device, type MemSize } from './mem/types.ts';

export { Uart, type IrqLine, type UartOptions } from './dev/uart.ts';
export { Clint } from './dev/clint.ts';
export { Plic } from './dev/plic.ts';
export { TestFinisher } from './dev/test.ts';
export { VirtioBlk } from './dev/virtio-blk.ts';
export { MemoryDisk, FileDisk, SECTOR_SIZE, type DiskImage } from './dev/disk.ts';

export { SbiFirmware, type SbiContext } from './firmware/sbi.ts';

export { loadElf, loadBinary, parseElf, ElfError, type ElfSegment, type LoadedImage, type LoadOptions } from './loader/elf.ts';
export { FdtNode, buildDtb } from './loader/dtb.ts';

export {
  Machine,
  VIRT_RAM_BASE,
  VIRT_CLINT,
  VIRT_PLIC,
  VIRT_UART0,
  VIRT_VIRTIO,
  VIRT_TEST,
  VIRT_FIRMWARE,
  VIRT_KERNEL,
  VIRT_DTB,
} from './machine.ts';
export type { MachineOptions, RunOptions, MachineStats } from './machine.ts';
