/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import type { Device, MemSize } from '../mem/types.ts';

/**
 * SiFive Test Finisher：写 0x5555 表示测试通过并退出，
 * 写 0x3333 表示失败（QEMU `-device sifive_test` 兼容）。
 */
export class TestFinisher implements Device {
  readonly name = 'test';
  readonly size = 0x1000n;

  private onExit: (code: number, reason: string) => void;
  code: number | null = null;

  constructor(onExit: (code: number, reason: string) => void) {
    this.onExit = onExit;
  }

  read(_offset: bigint, _size: MemSize): bigint {
    return 0n;
  }

  write(_offset: bigint, value: bigint, _size: MemSize): void {
    const v = value & 0xffffffffn;
    if (v === 0x5555n) {
      this.code = 0;
      this.onExit(0, 'test-pass');
    } else if (v === 0x3333n) {
      this.code = 1;
      this.onExit(1, 'test-fail');
    } else {
      this.code = Number((v >> 1n) & 0xffn);
      this.onExit(this.code, 'test-exit');
    }
  }
}
