#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 TSIE
"""
解压归档，**保留符号链接**（Windows 上 tar 做不到）。

为什么需要这个工具
------------------
Alpine 的 minirootfs 里绝大多数可执行文件是指向 /bin/busybox 的符号链接
（/bin/sh、/bin/ls 等几千个）。把这些链接喂给内核的 initramfs 时，
tools/make-initramfs.py 靠 `os.readlink()` 把它们编码成 cpio 的 S_IFLNK 条目 ——
**前提是解压后磁盘上确实存在符号链接**。

但 Windows 上：
  * GNU tar（Git Bash）与 bsdtar 都建不了符号链接，报
    "Cannot create symlink to '/bin/busybox': No such file or directory"，
    并且以退出码 2 结束（更糟的是会**提前中止**，只解出一百多个文件）。
  * `ln -s` 同样失败 —— 创建符号链接需要管理员权限或开发者模式。
  * 实测 minirootfs 解压后符号链接数为 **0**，打出来的 initramfs 里 /bin/sh 不存在，
    根本起不到 shell。

Python 的 tarfile 走的是另一条路：它用重解析点（reparse point）写符号链接，
普通用户即可，不需要提权。所以解压这一步交给它。

用法: python extract_archive.py <归档> <目标目录>
支持 .tar / .tar.gz / .tar.xz / .tgz（tarfile 的 r:* 模式自动识别压缩格式）。
"""
import os
import sys
import tarfile


def main() -> int:
    if len(sys.argv) != 3:
        print('用法: python extract_archive.py <归档> <目标目录>', file=sys.stderr)
        return 2

    src, dst = sys.argv[1], sys.argv[2]
    if not os.path.isfile(src):
        print(f'归档不存在: {src}', file=sys.stderr)
        return 2

    os.makedirs(dst, exist_ok=True)

    symlinks = 0
    files = 0
    dirs = 0

    with tarfile.open(src, 'r:*') as tf:
        for m in tf:
            try:
                # filter='fully_trusted' 是必需的：Python 3.12+ 默认（3.14 起强制）会拒绝
                # 指向目标目录之外的符号链接，而 Alpine 的链接恰恰都是绝对路径
                # （/bin/sh -> /bin/busybox），会直接抛 LinkOutsideDestinationError。
                # 归档来自 Alpine 官方且已过 sha256 校验，且我们构建的是 initramfs
                # （解出来的绝对链接在内核里正是指向根目录 /bin/busybox，语义正确），
                # 所以这里按可信内容处理。
                tf.extract(m, dst, set_attrs=False, filter='fully_trusted')
            except (OSError, NotImplementedError) as e:
                # 少数成员（如设备节点）在 Windows 上无法创建，跳过但要说出来。
                # 设备节点由 make-initramfs.py 自己补，不依赖归档里的这些。
                print(f'  跳过 {m.name}: {e}', file=sys.stderr)
                continue
            if m.issym() or m.islnk():
                symlinks += 1
            elif m.isdir():
                dirs += 1
            elif m.isfile():
                files += 1

    print(f'解压完成: {files} 文件 / {dirs} 目录 / {symlinks} 符号链接 -> {dst}')
    if symlinks == 0:
        # 不是致命错误，但对 Alpine rootfs 是强信号：正常应有成百上千个指向 /bin/busybox 的链接。
        print('警告: 一个符号链接都没建出来。若这是 Alpine minirootfs，'
              '产物很可能是废的（/bin/sh 会缺失）。', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
