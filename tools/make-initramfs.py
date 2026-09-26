#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 TSIE
"""
把 Alpine minirootfs 打包成内核可用的 cpio-newc initramfs（Windows 上自制）。

cpio newc 关键点（对照 Linux init/initramfs.c）：
  header 固定 110 字节，字段顺序:
    magic(6) ino mode uid gid nlink mtime filesize devmaj devmin rdevmaj rdevmin namesize check
    —— 每个字段 8 位小写十六进制，注意 uid/gid 在 nlink 之前。
  c_namesize 含结尾 NUL，name 必须以 \0 结束（否则内核报 "name without nulterm"）。
  name 之后的填充量按 (110 + len(name+\0)) 对齐到 4 —— 内核 N_ALIGN(len)=(((len+1)&~3)+2)，
    其中 +2 正是补偿 header 110%4=2（否则条目起始偏移非 4 对齐，内核报 "broken padding"）。
  data 之后再对齐到 4（110+name+pad 已 4 对齐，故按 len(data) 补零即可）。

用法: python make-initramfs.py <rootfs_dir> <out.cpio[.gz]>
"""
import os
import stat
import sys

HEADER_LEN = 110


def field(v: int) -> bytes:
    return f'{v & 0xffffffff:08x}'.encode()


def entry(ino: int, mode: int, uid: int, gid: int, nlink: int, mtime: int,
          devmaj: int, devmin: int, rmaj: int, rmin: int, name: str, data: bytes) -> bytes:
    name_bytes = name.encode() + b'\x00'
    namesize = len(name_bytes)
    h = b'070701'
    for v in (ino, mode, uid, gid, nlink, mtime, len(data), devmaj, devmin, rmaj, rmin, namesize, 0):
        h += field(v)
    assert len(h) == HEADER_LEN, len(h)
    name_pad = (4 - ((HEADER_LEN + namesize) % 4)) % 4
    data_pad = (4 - (len(data) % 4)) % 4
    return h + name_bytes + b'\x00' * name_pad + data + b'\x00' * data_pad


def load_modes(root: str) -> dict:
    """读 extract_archive.py 写出的权限表（<root>.modes.json）。

    ⚠️ 为什么必须用它：Windows 文件系统不保存 Unix 权限位，os.lstat() 对任何普通
    文件都返回 0666 —— 执行位全丢。直接从磁盘读 mode 会让 cpio 里的 /bin/busybox
    变成 0666，内核 execve 返回 EACCES(-13)，表现为
        Failed to execute /init (error -13)
        Kernel panic - not syncing: No working init found.
    所以优先用归档记录的真实 mode；没有权限表（例如在真 POSIX 上解压）才回退到 lstat。
    """
    path = root.rstrip('\\/') + '.modes.json'
    if not os.path.isfile(path):
        return {}
    try:
        import json
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f'警告: 权限表读取失败（{e}），回退到磁盘 mode', file=sys.stderr)
        return {}


def cpio_newc(root: str, out: str) -> None:
    items: list[tuple[str, str]] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        filenames.sort()
        rel = os.path.relpath(dirpath, root)
        if rel != '.':
            items.append((rel, dirpath))
        for f in filenames:
            items.append((os.path.relpath(os.path.join(dirpath, f), root), os.path.join(dirpath, f)))

    modes = load_modes(root)
    exec_count = 0

    blob = bytearray()
    ino = 0

    # 标准 initramfs 的首个条目是 "." 目录（find . | cpio -o 的产物即如此）
    ino += 1
    blob += entry(ino, 0o040755, 0, 0, 2, 1700000000, 0, 0, 0, 0, '.', b'')

    for rel, full in items:
        ino += 1
        name = rel.replace('\\', '/')
        st = os.lstat(full)
        mode = st.st_mode
        if stat.S_ISLNK(mode):
            blob += entry(ino, 0o120777, 0, 0, 1, int(st.st_mtime), 0, 0, 0, 0,
                          name, os.readlink(full).encode() + b'\x00')
            continue
        if stat.S_ISDIR(mode):
            blob += entry(ino, (mode & 0o7777) | 0o040000, 0, 0, 2, int(st.st_mtime),
                          0, 0, 0, 0, name, b'')
            continue
        if stat.S_ISCHR(mode):
            rdev = st.st_rdev
            blob += entry(ino, (mode & 0o7777) | 0o020000, 0, 0, 1, int(st.st_mtime),
                          0, 0, (rdev >> 8) & 0xfff, rdev & 0xff, name, b'')
            continue
        if not stat.S_ISREG(mode):
            continue
        # 权限位优先取归档真值（Windows 磁盘上的 0666 会丢掉执行位）
        perm = modes.get(name)
        if perm is None:
            perm = mode & 0o7777
        else:
            perm &= 0o7777
        if perm & 0o111:
            exec_count += 1
        with open(full, 'rb') as f:
            data = f.read()
        blob += entry(ino, perm | 0o100000, 0, 0, 1, int(st.st_mtime),
                      0, 0, 0, 0, name, data)

    # /init：mount 必要文件系统后起 shell
    init_sh = (b'#!/bin/sh\n'
               b'mount -t proc none /proc 2>/dev/null\n'
               b'mount -t sysfs none /sys 2>/dev/null\n'
               b'mkdir -p /dev 2>/dev/null\n'
               b'echo ""\n'
               b'echo "[ts-riscv64] Alpine initramfs alive"\n'
               b'echo "kernel: $(uname -a 2>/dev/null || echo unknown)"\n'
               b'echo "---------------------------------------------"\n'
               b'exec /bin/sh\n')
    ino += 1
    blob += entry(ino, 0o100755, 0, 0, 1, 1700000000, 0, 0, 0, 0, 'init', init_sh)

    # 控制台/空设备（内核早期 console 需要 dev/console）
    for name, rmaj, rmin, perm in (('dev/console', 5, 1, 0o0600),
                                   ('dev/null', 1, 3, 0o0666),
                                   ('dev/zero', 1, 5, 0o0666),
                                   ('dev/ttyS0', 4, 64, 0o0600)):
        ino += 1
        blob += entry(ino, 0o020000 | perm, 0, 0, 1, 1700000000, 0, 0, rmaj, rmin, name, b'')

    # 结束标记
    ino += 1
    blob += entry(ino, 0, 0, 0, 1, 0, 0, 0, 0, 0, 'TRAILER!!!', b'')

    raw = bytes(blob)
    if out.endswith('.gz'):
        import gzip
        raw = gzip.compress(raw, mtime=0)
    with open(out, 'wb') as f:
        f.write(raw)
    print(f'wrote {out}: {len(raw)} bytes ({len(items)} files + . + init + dev nodes)')
    print(f'可执行文件: {exec_count} 个（源自{"归档权限表" if modes else "磁盘 mode"}）')

    # ⚠️ 自检：一个可执行文件都没有 = 内核必然 execve 失败（EACCES），
    # 表现为 "Failed to execute /init (error -13)" + "No working init found" panic。
    # 这正是 Windows 上丢掉执行位时的症状，所以在这里拦下而不是等内核报。
    if exec_count == 0:
        print('错误: 产物里没有任何可执行文件，内核无法启动 init。\n'
              '      多半是解压时丢了权限位 —— 请用 tools/extract_archive.py 解压（它会写权限表），\n'
              '      而不是 tar/7-Zip。', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    cpio_newc(sys.argv[1], sys.argv[2])
