#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 TSIE
"""
让 EDK II 不启用分页（把 RiscVConfigureMmu 的候选模式数组首项改成 SATP_MODE_OFF）。

什么时候需要它
--------------
RiscVVirtQemu 在启动早期就启用 Sv48 分页，并按内存类型套用 NX 策略，
于是常规内存/引导服务数据全被标成不可执行。把内核原样搬到内存再跳过去执行的
引导器（OpenBSD 的 BOOTRISCV64.EFI 就是）必然撞上取指页错。实测：

    PTE@0x84200000 = 0x210800e7 (R|W|G|A|D，X=0)，mstatus.MXR=0
    → 按 RISC-V 规范这是**正确**的取指页错，不是模拟器缺陷。

PTE 采样显示 X 位的变化过程：
    @76857792  0x210800ef  RWX   ← 建表时是 RWX（与 BaseRiscVMmuLib 源码一致）
    @77230336  0x210800e7  RW-   ← 之后被主动清掉，早在 UEFI 早期

对比之下 U-Boot 全程 satp=0（不分页、不查 PTE 权限），所以那条路没事。
本工具让 EDK2 也变得不分页，**不需要在模拟器里引入任何偏离 ISA 的开关**。

原理
----
BaseRiscVMmuLib.c：
    STATIC UINTN mModeSupport[] = { SATP_MODE_SV57, SATP_MODE_SV48, SATP_MODE_SV39, SATP_MODE_OFF };
    RiscVConfigureMmu():       for (Idx…) { RiscVMmuSetSatpMode(mModeSupport[Idx]); … break; }
    RiscVMmuSetSatpMode():     case SATP_MODE_OFF: return EFI_SUCCESS;   // 什么都不做

把首项 10(SV57) 改成 0(OFF)，循环第一次就成功返回，分页永不启用。
该数组在固件里是 4 个 RV64 UINTN，字节签名唯一（本平台实测仅 1 处命中）。

用法
----
    # 输入必须是**未压缩**固件（数组在 DXEFV 里，压缩态搜不到）
    python tools/uncompress-fv.py RISCV_VIRT_CODE.fd code_nocomp.fd
    python tools/no-paging.py code_nocomp.fd code_nopaging.fd

结果（实测）：EDK2 引导 OpenBSD 全程零页错，落到与 U-Boot 路径相同的位置。
"""
import argparse
import struct
import sys

MODES = (10, 9, 8, 0)  # SV57, SV48, SV39, OFF


def main() -> int:
    ap = argparse.ArgumentParser(description='让 EDK II 不启用分页（SATP_MODE_OFF 优先）')
    ap.add_argument('source', help='输入固件（须为未压缩态，见 uncompress-fv.py）')
    ap.add_argument('dest', help='输出固件')
    ap.add_argument('--force', action='store_true', help='命中多处时也继续（取第一处）')
    args = ap.parse_args()

    orig = open(args.source, 'rb').read()
    d = bytearray(orig)
    pat = b''.join(struct.pack('<Q', v) for v in MODES)

    hits = []
    s = 0
    while True:
        i = d.find(pat, s)
        if i < 0:
            break
        hits.append(i)
        s = i + 1

    print(f'输入 {args.source}  {len(d)} 字节')
    print(f'模式签名 {pat.hex(" ")}')
    print(f'命中 {len(hits)} 处: {[hex(x) for x in hits]}')

    if not hits:
        print(
            '错误：找不到 mModeSupport 数组。\n'
            '  多半是输入的是压缩固件（数组在 DXEFV 里被 LZMA 压住）——\n'
            '  先用 tools/uncompress-fv.py 解出未压缩固件再跑本工具。',
            file=sys.stderr,
        )
        return 2
    if len(hits) > 1 and not args.force:
        print('错误：命中多处，无法确定是哪一处。请人工确认后用 --force。', file=sys.stderr)
        return 2

    off = hits[0]
    before = bytes(d[off:off + 8])
    struct.pack_into('<Q', d, off, 0)
    after = bytes(d[off:off + 8])
    print(f'\n改写 @0x{off:x}: {before.hex(" ")}  ->  {after.hex(" ")}')
    print('  mModeSupport = [OFF(0), SV48(9), SV39(8), OFF(0)]')
    print('  效果：RiscVConfigureMmu 第一次尝试即成功返回，satp 保持 0（不分页）')

    open(args.dest, 'wb').write(bytes(d))

    # 自检：源只读一次，别在循环里重复读整文件（那是 O(n²)，33MB 跑不完）
    src = bytes(d)
    changed = sum(1 for i in range(len(orig)) if orig[i] != src[i])
    print(f'\n输出 {args.dest}  {len(src)} 字节')
    print(f'自检：与源相比改动 {changed} 字节（应为 1）')
    if changed != 1:
        print('警告：改动字节数不是 1，请检查', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
