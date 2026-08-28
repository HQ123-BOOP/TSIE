/** 访存宽度（字节） */
export type MemSize = 1 | 2 | 4 | 8;

/** 一次访存的类型，决定 MMU 的权限检查与异常编号 */
export const AccessType = {
  Instruction: 0,
  Load: 1,
  Store: 2,
} as const;
export type AccessTypeValue = (typeof AccessType)[keyof typeof AccessType];

/** MMIO / 内存区域设备 */
export interface Device {
  readonly name: string;
  /** 映射区域大小（字节） */
  readonly size: bigint;
  /**
   * @param offset 相对于设备基址的偏移
   * @returns 零扩展到 64 位的结果
   */
  read(offset: bigint, size: MemSize): bigint;
  write(offset: bigint, value: bigint, size: MemSize): void;
  /** 每个 "tick"（若干条指令）调用一次，供设备推进内部状态 */
  tick?(cycles: number): void;
  /** 复位 */
  reset?(): void;
}
