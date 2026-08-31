/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import { MASK64 } from '../core/bits.ts';
import type { Cpu, SbiLayer } from '../cpu/cpu.ts';
import { CSR } from '../cpu/csr.ts';
import type { Clint } from '../dev/clint.ts';
import type { Uart } from '../dev/uart.ts';

// SBI 扩展 ID
const EID_TIMER = 0x00;
const EID_RFENCE = 0x03;
const EID_HSM = 0x48534d;
const EID_SRST = 0x53525354;
const EID_BASE = 0x10;

// SBI 返回码
const SBI_SUCCESS = 0n;
const SBI_ERR_FAILED = 0xffffffffffffffffn; // -1
const SBI_ERR_NOT_SUPPORTED = 0xfffffffffffffffen; // -2

const MIP_STIP = 1n << 5n;
const MIP_SSIP = 1n << 1n;

export interface SbiContext {
  clint: Clint;
  uart: Uart;
  shutdown: (reason: string) => void;
}

/**
 * 内建 SBI v0.2 固件：让 Linux 无需外部 OpenSBI 也能直接启动。
 */
export class SbiFirmware implements SbiLayer {
  private ctx: SbiContext;
  specVersion = { major: 0, minor: 2 };
  implId = 0x999;
  implVersion = 1;

  constructor(ctx: SbiContext) {
    this.ctx = ctx;
  }

  /** 处理 S 模式发起的 ECALL；返回 true 表示已被 SBI 处理 */
  handleEcall(cpu: Cpu): boolean {
    const eid = cpu.x[17] & MASK64;
    const fid = cpu.x[16] & MASK64;
    const a0 = cpu.x[10];
    const a1 = cpu.x[11];

    const setRet = (err: bigint, value: bigint): void => {
      cpu.x[10] = err & MASK64;
      cpu.x[11] = value & MASK64;
    };

    switch (Number(eid)) {
      case EID_BASE:
        switch (fid) {
          case 0n: // get_spec_version
            setRet(SBI_SUCCESS, (BigInt(this.specVersion.major) << 24n) | BigInt(this.specVersion.minor));
            return true;
          case 1n: // get_impl_id
            setRet(SBI_SUCCESS, BigInt(this.implId));
            return true;
          case 2n: // get_impl_version
            setRet(SBI_SUCCESS, BigInt(this.implVersion));
            return true;
          case 3n: { // probe_extension
            const supported: bigint[] = [EID_BASE, EID_TIMER, EID_RFENCE, EID_HSM].map(BigInt);
            setRet(SBI_SUCCESS, supported.includes(a0) ? 1n : 0n);
            return true;
          }
          case 4n: // get_mvendorid
            setRet(SBI_SUCCESS, 0n);
            return true;
          case 5n: // get_marchid
            setRet(SBI_SUCCESS, 0n);
            return true;
          case 6n: // get_mimpid
            setRet(SBI_SUCCESS, 1n);
            return true;
          default:
            setRet(SBI_ERR_NOT_SUPPORTED, 0n);
            return true;
        }

      case EID_TIMER:
        // sbi_set_timer(stime_value)
        this.ctx.clint.mtimecmp = a0 & MASK64;
        // 重新编程后清除挂起的 S 模式定时器中断
        {
          const mip = cpu.csr.read(CSR.MIP) ?? 0n;
          cpu.csr.writeRaw(CSR.MIP, mip & ~MIP_STIP);
        }
        setRet(SBI_SUCCESS, 0n);
        return true;

      case 0x01: { // legacy console_putchar
        this.ctx.uart.write(0n, a0 & 0xffn, 1);
        setRet(SBI_SUCCESS, 0n);
        return true;
      }
      case 0x02: // legacy console_getchar
        // 未接入 stdin，返回 -1（无数据）
        setRet(SBI_SUCCESS, 0xffffffffffffffffn);
        return true;
      case 0x03: { // legacy clear_ipi
        const mip = cpu.csr.read(CSR.MIP) ?? 0n;
        cpu.csr.writeRaw(CSR.MIP, mip & ~MIP_SSIP);
        setRet(SBI_SUCCESS, 0n);
        return true;
      }
      case 0x08: // legacy shutdown
        this.ctx.shutdown('sbi-shutdown');
        setRet(SBI_SUCCESS, 0n);
        return true;

      case EID_RFENCE:
        // 单核：远端 fence 等价于本地 fence
        switch (fid) {
          case 0n: // remote_fence_i
          case 1n: // remote_sfence_vma
          case 2n: // remote_sfence_vma_asid
            cpu.mmu.flush();
            setRet(SBI_SUCCESS, 0n);
            return true;
          default:
            setRet(SBI_ERR_NOT_SUPPORTED, 0n);
            return true;
        }

      case EID_HSM:
        switch (fid) {
          case 0n: // hart_start：单核无意义
            setRet(SBI_ERR_NOT_SUPPORTED, 0n);
            return true;
          case 2n: // hart_get_status
            setRet(SBI_SUCCESS, 1n); // started
            return true;
          default:
            setRet(SBI_ERR_NOT_SUPPORTED, 0n);
            return true;
        }

      case EID_SRST:
        if (fid === 0n) {
          this.ctx.shutdown(a1 === 0n ? 'sbi-reset-shutdown' : 'sbi-reset');
          setRet(SBI_SUCCESS, 0n);
          return true;
        }
        setRet(SBI_ERR_NOT_SUPPORTED, 0n);
        return true;

      default:
        setRet(SBI_ERR_NOT_SUPPORTED, 0n);
        return true;
    }
  }

  /**
   * M 模式定时器中断转交 S 模式（设置 sip.STIP）。
   * 仅当 STIP 已被 mideleg 委派给 S 模式时才生效。
   */
  forwardTimerInterrupt(cpu: Cpu): boolean {
    const mideleg = cpu.csr.read(CSR.MIDELEG) ?? 0n;
    if ((mideleg & MIP_STIP) === 0n) return false;
    const mip = cpu.csr.read(CSR.MIP) ?? 0n;
    cpu.csr.writeRaw(CSR.MIP, mip | MIP_STIP);
    return true;
  }

  /** 旧版 legacy SBI 调用（a7 为功能号，返回值放在 a0） */
  legacyReturn(err: bigint): bigint {
    return err === SBI_SUCCESS ? SBI_SUCCESS : SBI_ERR_FAILED;
  }
}
