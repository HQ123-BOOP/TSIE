#!/usr/bin/env python3
"""
生成「最小化 + 不压缩」的 initramfs，专为慢速指令级模拟器优化。

为什么需要它：
  完整 Alpine minirootfs 打出来是 7.28MB / 517 条目（其中 libcrypto.so.3 独占 3.87MB，
  只有 apk/ssl 需要）。内核 gunzip 这 7.28MB 在 ~0.5 MIPS 的模拟器上要花 3~4 亿条指令，
  且解压期间**零串口输出**，看起来和死机一模一样。
  本脚本只保留启动 shell 的最小集（busybox + musl 动态链接器 ≈ 1.44MB），
  并且**不做 gzip 压缩**——内核识别未压缩 cpio 会直接跳过 inflate，省掉全部解压开销。

用法: python make-mini-initramfs.py <alpine_rootfs_dir> <out.cpio>
"""
import os
import sys

HEADER_LEN = 110

# busybox 需要的 applet 符号链接（argv[0] 决定行为）
APPLETS = [
    'sh', 'ash', 'mount', 'umount', 'echo', 'cat', 'ls', 'uname', 'ps', 'mkdir',
    'dmesg', 'cp', 'mv', 'rm', 'sleep', 'df', 'free', 'ln', 'chmod', 'grep',
    'head', 'tail', 'wc', 'sync', 'poweroff', 'reboot', 'hostname', 'date',
]

DIRS = ['bin', 'lib', 'dev', 'proc', 'sys', 'tmp', 'root', 'etc', 'var', 'run']

# (源文件相对 rootfs 的路径, initramfs 内路径)
FILES = [
    ('bin/busybox', 'bin/busybox'),
    ('lib/ld-musl-riscv64.so.1', 'lib/ld-musl-riscv64.so.1'),
]

DEV_NODES = [
    ('dev/console', 5, 1, 0o600),
    ('dev/null', 1, 3, 0o666),
    ('dev/zero', 1, 5, 0o666),
    ('dev/tty', 5, 0, 0o666),
    ('dev/ttyS0', 4, 64, 0o600),
]

INIT_SH = b'''#!/bin/sh
mount -t proc none /proc 2>/dev/null
mount -t sysfs none /sys 2>/dev/null
mount -t devtmpfs none /dev 2>/dev/null
echo ""
echo "==============================================="
echo " ts-riscv64: Linux userspace is ALIVE"
echo "==============================================="
echo "uname: $(uname -a 2>/dev/null)"
echo "-----------------------------------------------"
exec /bin/sh
'''


def field(v: int) -> bytes:
    return f'{v & 0xffffffff:08x}'.encode()


def entry(ino: int, mode: int, nlink: int, rmaj: int, rmin: int,
          name: str, data: bytes) -> bytes:
    """构造一个 cpio-newc 条目。对齐规则见 tools/make-initramfs.py 的注释。"""
    name_bytes = name.encode() + b'\x00'
    namesize = len(name_bytes)
    h = b'070701'
    for v in (ino, mode, 0, 0, nlink, 1700000000, len(data),
              0, 0, rmaj, rmin, namesize, 0):
        h += field(v)
    assert len(h) == HEADER_LEN, len(h)
    name_pad = (4 - ((HEADER_LEN + namesize) % 4)) % 4
    data_pad = (4 - (len(data) % 4)) % 4
    return h + name_bytes + b'\x00' * name_pad + data + b'\x00' * data_pad


def build(rootfs: str, out: str) -> None:
    blob = bytearray()
    ino = 0

    def add(mode, nlink, name, data=b'', rmaj=0, rmin=0):
        nonlocal ino
        ino += 1
        blob.extend(entry(ino, mode, nlink, rmaj, rmin, name, data))

    # 标准 initramfs 首个条目必须是 "." 目录
    add(0o040755, 2, '.')

    for d in DIRS:
        add(0o040755, 2, d)

    total_data = 0
    for src, dst in FILES:
        path = os.path.join(rootfs, src)
        if not os.path.isfile(path):
            raise SystemExit(f'缺少必需文件: {path}')
        with open(path, 'rb') as f:
            data = f.read()
        total_data += len(data)
        add(0o100755, 1, dst, data)

    # busybox applet 符号链接（symlink 的 data 即目标路径，需 NUL 结尾）
    for app in APPLETS:
        add(0o120777, 1, f'bin/{app}', b'/bin/busybox\x00')

    add(0o100755, 1, 'init', INIT_SH)

    for name, rmaj, rmin, perm in DEV_NODES:
        add(0o020000 | perm, 1, name, b'', rmaj, rmin)

    add(0, 1, 'TRAILER!!!')

    raw = bytes(blob)
    if out.endswith('.gz'):
        raise SystemExit('本脚本刻意不压缩（省掉内核 inflate 开销），请用 .cpio 后缀')
    with open(out, 'wb') as f:
        f.write(raw)
    print(f'wrote {out}: {len(raw)} bytes, {ino} 条目, 文件数据 {total_data} bytes (未压缩)')


if __name__ == '__main__':
    build(sys.argv[1], sys.argv[2])
