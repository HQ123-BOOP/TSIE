#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 TSIE
"""
去掉 EDK2 固件里的 LZMA 压缩层，让 guest 启动时不必解压。

为什么需要它
------------
EDK2 的 RiscVVirtQemu 平台在 RiscVVirtQemu.fdf 里把 DXE 固件卷包了一层压缩：

    FILE FV_IMAGE = 9E21FD93-9C72-4c15-8C4B-E77F1DB2D792 {
       SECTION GUIDED EE4E5898-... PROCESSING_REQUIRED = TRUE {   <- LZMA 压缩包装
         SECTION FV_IMAGE = DXEFV
       }
     }

启动时固件要先把这块解压开。在模拟器里代价极大 —— 实测**约占启动前段 10 亿条指令**，
到 UEFI Shell 要 23 分钟；去掉压缩后只要 2.5 分钟（约 5 倍）。

本工具不重编 EDK2，而是等价地在已有固件上做手术：解出被压缩的卷，
把 GUID_DEFINED 节换成**裸的 FV_IMAGE 节** —— 正是「去掉包装」后构建器会产出的形态。

用法
----
    python tools/uncompress-fv.py RISCV_VIRT_CODE.fd RISCV_VIRT_CODE_nocomp.fd

会做完整自检（FFS 大小/校验和、FV 头校验、DXEFV 的 FileSystemGuid 位置），
任一项不符就报错退出，不会产出一个半成品固件。

实现要点（都是踩过的坑）
------------------------
* EFI_FFS_FILE_HEADER 的 Size 是 **3 字节**（偏移 20..22），State 在 +23。
* FFS 头校验和要把 `+16(Header)`、`+17(File)`、`+23(State)` **三处都清零**再求和，
  取 `(0x100 - sum % 0x100) & 0xFF`。只清 +16 是错的（本工具第一版就错在这）。
* EFI_GUID_DEFINED_SECTION 的 DataOffset **相对节头起点**，不是相对 GUID 起点（差 4 字节）。
* LZMA 载荷 = 5 字节 props + 8 字节解压后大小 + 原始 LZMA1 流；用 Python 解压时
  **必须把输入限定在该节范围内** —— 喂多余数据会在 EOS 之后报 Corrupt input data。
* FV 头校验和：`[0, HeaderLength)` 内所有 u16 之和（含校验字段）≡ 0 (mod 0x10000)。
"""
import argparse
import lzma
import struct
import sys

GUID_LZMA_CUSTOM = 'EE4E5898-3914-4259-9D6E-DC7BD79403CF'
GUID_FV_IMAGE_FILE = '9E21FD93-9C72-4C15-8C4B-E77F1DB2D792'
FS_GUID_FFS2 = '8C8CE578-8A3D-4F1C-9935-896185C32DD3'
SECTION_GUID_DEFINED = 0x02
SECTION_FV_IMAGE = 0x17


def guid_to_bytes(text: str) -> bytes:
    """EFI GUID 文本 → 固件里的字节序（前三段小端，后两段原序）。"""
    p = text.split('-')
    return (bytes.fromhex(p[0])[::-1] + bytes.fromhex(p[1])[::-1] +
            bytes.fromhex(p[2])[::-1] + bytes.fromhex(p[3]) + bytes.fromhex(p[4]))


def guid_to_text(b: bytes) -> str:
    return '%08X-%04X-%04X-%s-%s' % (
        struct.unpack('<I', b[0:4])[0], struct.unpack('<H', b[4:6])[0],
        struct.unpack('<H', b[6:8])[0], b[8:10].hex().upper(), b[10:16].hex().upper())


def ffs_header_checksum(hdr: bytes) -> int:
    """FFS 头校验和。Header/File/State 三字节清零后求字节和。"""
    t = bytearray(hdr[:24])
    t[16] = t[17] = t[23] = 0
    return (0x100 - (sum(t) % 0x100)) & 0xFF


def fv_header_sum(hdr: bytes) -> int:
    """FV 头 16 位字之和（含校验字段）。有效时 ≡ 0 (mod 0x10000)。"""
    return sum(struct.unpack('<H', hdr[o:o + 2])[0] for o in range(0, len(hdr) - 1, 2)) & 0xFFFF


def try_lzma(data: bytearray, payload: int, end: int):
    """按 EDK2 的 LZMA 载荷布局解压（5 字节 props + 8 字节原始大小 + 原始 LZMA1 流）。

    返回解压结果，失败返回 None。**必须把输入限定在节范围内** ——
    多喂数据会在 EOS 之后报 Corrupt input data。
    """
    props = data[payload:payload + 5]
    b0 = props[0]
    lc, r = b0 % 9, b0 // 9
    lp, pb = r % 5, r // 5
    dict_size = struct.unpack('<I', props[1:5])[0]
    declared = struct.unpack('<Q', data[payload + 5:payload + 13])[0]
    # 合理性预筛：字典大小与解压后大小都该是合理量级
    if dict_size == 0 or dict_size > (1 << 30) or declared == 0 or declared > (1 << 32):
        return None
    try:
        blob = lzma.LZMADecompressor(
            format=lzma.FORMAT_RAW,
            filters=[{'id': lzma.FILTER_LZMA1, 'lc': lc, 'lp': lp, 'pb': pb,
                      'dict_size': dict_size}],
        ).decompress(data[payload + 13:end])
    except lzma.LZMAError:
        return None
    return blob if len(blob) == declared else None


def main() -> int:
    ap = argparse.ArgumentParser(description='去掉 EDK2 固件里的 LZMA 压缩层')
    ap.add_argument('source', help='输入固件（如 RISCV_VIRT_CODE.fd）')
    ap.add_argument('dest', help='输出固件（去掉压缩后的）')
    ap.add_argument('-q', '--quiet', action='store_true', help='只输出结果')
    args = ap.parse_args()

    def say(*a):
        if not args.quiet:
            print(*a)

    d = bytearray(open(args.source, 'rb').read())
    say(f'输入 {args.source}  {len(d)} 字节 = {len(d) / 1048576:.1f} MiB')

    # ---- 1) 找 LZMA 压缩节 ----
    # 注意：固件里可能**多处**出现这个 GUID —— SEC 核的 PE32 里就引用了它。
    # 所以不能取第一次命中，要遍历候选、逐个按「节头合法 + 能正常解压」筛。
    g_lzma = guid_to_bytes(GUID_LZMA_CUSTOM)
    found = None
    start = 0
    tried = 0
    while True:
        gi = d.find(g_lzma, start)
        if gi < 0:
            break
        start = gi + 1
        sec = gi - 4
        if sec < 0 or d[sec + 3] != SECTION_GUID_DEFINED:
            continue
        sec_size = d[sec] | (d[sec + 1] << 8) | (d[sec + 2] << 16)
        if sec_size < 24 or sec + sec_size > len(d):
            continue
        tried += 1
        data_offset = struct.unpack('<H', d[gi + 16:gi + 18])[0]
        payload = sec + data_offset
        if payload + 13 > len(d):
            continue
        blob = try_lzma(d, payload, sec + sec_size)
        if blob is None:
            say(f'  候选节 @0x{sec:x} 解压失败，跳过')
            continue
        found = (sec, gi, sec_size, payload, blob)
        break

    if found is None:
        print(f'错误：没找到可用的 LZMA 压缩节（GUID {GUID_LZMA_CUSTOM}，'
              f'检查了 {tried} 个候选）。固件可能本来就没压缩。', file=sys.stderr)
        return 2
    sec, gi, sec_size, payload, blob = found
    say(f'压缩节 @0x{sec:x} 大小 {sec_size} ({sec_size / 1048576:.2f} MiB) '
        f'载荷 @0x{payload:x}')
    say(f'解压 -> {len(blob)} 字节 ({len(blob) / 1048576:.2f} MiB)')

    # ---- 3) 取出裸 FV_IMAGE 节 ----
    # 解压结果是节流：[RAW 节 12 字节][FV_IMAGE 节头 4 字节 + DXEFV]
    # 去掉那 12 字节前缀，剩下的就是「去掉压缩包装」后的形态
    ns = bytes(blob[12:])
    ns_size = ns[0] | (ns[1] << 8) | (ns[2] << 16)
    if ns[3] != SECTION_FV_IMAGE or ns_size != len(ns):
        print(f'错误：解压结果不是预期的 FV_IMAGE 节流'
              f'（type=0x{ns[3]:02x} size={ns_size} len={len(ns)}）', file=sys.stderr)
        return 2
    # DXEFV = ns[4:]：ZeroVector 16 字节 + FileSystemGuid 16 字节
    fv_guid = guid_to_text(ns[20:36])
    if fv_guid != FS_GUID_FFS2:
        print(f'错误：DXEFV 的 FileSystemGuid 是 {fv_guid}，应为 {FS_GUID_FFS2}',
              file=sys.stderr)
        return 2
    say(f'新节 大小 {ns_size}  type=0x17(FV_IMAGE)  DXEFV {len(ns) - 4} 字节')

    # ---- 4) 定位承载它的 FFS 文件 ----
    fi = d.find(guid_to_bytes(GUID_FV_IMAGE_FILE))
    if fi < 0:
        print(f'错误：没找到 FV_IMAGE 的 FFS 文件（GUID {GUID_FV_IMAGE_FILE}）', file=sys.stderr)
        return 2
    old_size = d[fi + 20] | (d[fi + 21] << 8) | (d[fi + 22] << 16)
    if ffs_header_checksum(d[fi:fi + 24]) != d[fi + 16]:
        print('错误：FFS 头校验和规则不匹配，拒绝继续（避免产出坏固件）', file=sys.stderr)
        return 2
    say(f'FFS 文件 @0x{fi:x}  type=0x{d[fi+18]:02x}  原大小 {old_size}')

    # ---- 5) 组装并改写 ----
    new_size = 24 + len(ns)
    fv_end = 0x800000
    end = fi + new_size
    if end > fv_end:
        print(f'错误：新 FFS 到 0x{end:x}，超出固件卷尾 0x{fv_end:x}。'
              f'本工具不会扩卷，需要人工调整 FV 长度与块映射。', file=sys.stderr)
        return 2
    say(f'新 FFS 大小 {new_size}，覆盖 0x{fi:x}..0x{end:x}'
        f'（卷尾 0x{fv_end:x}，余 {(fv_end - end) / 1048576:.2f} MiB 填 0xFF）')

    out = bytearray(d)
    nh = bytearray(d[fi:fi + 24])
    nh[20], nh[21], nh[22] = new_size & 0xFF, (new_size >> 8) & 0xFF, (new_size >> 16) & 0xFF
    nh[17] = 0xAA          # File 校验字节：属性未置位时固定值
    nh[23] = 0xF8          # State：有效
    nh[16] = ffs_header_checksum(bytes(nh))
    out[fi:fi + 24] = nh
    out[fi + 24:fi + 24 + len(ns)] = ns
    out[fi + new_size:fv_end] = b'\xFF' * (fv_end - (fi + new_size))

    # ---- 6) 写盘 + 自检 ----
    open(args.dest, 'wb').write(bytes(out))
    chk = open(args.dest, 'rb').read()

    ok = True
    say('\n自检：')
    checks = [
        ('改动区之前逐字节一致', chk[:fi] == d[:fi]),
        ('FFS size 字段正确',
         (chk[fi + 20] | (chk[fi + 21] << 8) | (chk[fi + 22] << 16)) == new_size),
        ('FFS 头校验和正确', ffs_header_checksum(chk[fi:fi + 24]) == chk[fi + 16]),
        ('节类型为 FV_IMAGE', chk[fi + 24 + 3] == SECTION_FV_IMAGE),
        ('DXEFV 的 FileSystemGuid 正确',
         guid_to_text(chk[fi + 24 + 20:fi + 24 + 36]) == FS_GUID_FFS2),
    ]
    hdr_len = struct.unpack('<H', chk[48:50])[0]
    checks.append(('FV 头校验和有效', fv_header_sum(chk[0:hdr_len]) == 0))
    checks.append(('压缩节已消失', GUID_LZMA_CUSTOM and chk.find(g_lzma, fi) < 0
                   or chk.count(g_lzma) < d.count(g_lzma)))
    for name, good in checks:
        say(f'  {"OK  " if good else "FAIL"} {name}')
        ok = ok and good
    say(f'\n输出 {args.dest}  {len(chk)} 字节')
    if not ok:
        print('自检未全部通过，请勿使用该固件', file=sys.stderr)
        return 1
    say(f'压缩节数 {d.count(g_lzma)} -> {chk.count(g_lzma)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
