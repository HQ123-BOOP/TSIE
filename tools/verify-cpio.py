/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import gzip
import sys

path = sys.argv[1] if len(sys.argv) > 1 else 'initramfs.cpio.gz'
d = gzip.decompress(open(path, 'rb').read())
print('解压后字节:', len(d))
off = 0
idx = 0
ok = True
names = []
while off < len(d):
    if d[off:off + 6] != b'070701':
        print('  !! magic 错误 at', off, d[off:off + 6])
        ok = False
        break
    def fld(i):
        return int(d[off + 6 + i * 8: off + 6 + i * 8 + 8], 16)
    ino, mode, uid, gid, nlink, mtime, filesize = (fld(i) for i in range(7))
    devmaj, devmin, rdevmaj, rdevmin, namesize, check = (fld(i) for i in range(7, 13))
    name = d[off + 110: off + 110 + namesize]
    if len(name) < namesize or name[-1:] != b'\x00':
        print('  !! 名字缺少 NUL 结尾:', name[:40])
        ok = False
    names.append(name[:-1].decode('utf-8', 'replace'))
    hdr = 110 + namesize + ((4 - ((110 + namesize) % 4)) % 4)
    data = d[off + hdr: off + hdr + filesize]
    off += hdr + ((filesize + 3) & ~3)
    idx += 1
    if names[-1] == 'TRAILER!!!':
        break
    if idx > 5000:
        print('  (截断检查)')
        break
print(f'条目数: {idx}, 结构校验: {"OK" if ok else "FAILED"}')
print('前 8 项:', names[:8])
print('含 /init:', '/init' in names, '| 含 dev/console:', 'dev/console' in names)
sym = [n for n in names if n in ('bin', 'sbin', 'lib')]
print('目录示例:', names[:3])
