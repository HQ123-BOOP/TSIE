/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
// 9P2000.L 服务器协议测试：真实临时目录 + 编码 T 消息直驱 NinePServer。
// 覆盖：version 协商 / attach / walk（含部分走）/ lcreate+write+read /
// getattr / mkdir / statfs / 路径逃逸防护 / Host 侧落盘校验。
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { NinePServer } from '../src/dev/ninep.ts';

function str(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  const h = Buffer.alloc(2);
  h.writeUInt16LE(b.length);
  return Buffer.concat([h, b]);
}
function u16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
}
function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
}
function u64(v: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt.asUintN(64, BigInt(v)));
  return b;
}
function msg(type: number, tag: number, body: Buffer): Buffer {
  const out = Buffer.alloc(7 + body.length);
  out.writeUInt32LE(out.length, 0);
  out[4] = type;
  out.writeUInt16LE(tag, 5);
  body.copy(out, 7);
  return out;
}
function parseR(f: Buffer): { type: number; tag: number; body: Buffer } {
  return { type: f[4], tag: f.readUInt16LE(5), body: f.subarray(7) };
}

test('9p：version 协商 → attach → walk → lcreate → write → read 全链路', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tsie-9p-'));
  const srv = new NinePServer(dir, 'hostshare');
  try {
    // Tversion：请求 8192 时回复必须 ≤ 8192（协议违规会报 Protocol error）
    const rv = parseR(await srv.handle(msg(100, 0, Buffer.concat([u32(8192), str('9P2000.L')]))));
    assert.equal(rv.type, 101);
    assert.equal(rv.body.readUInt32LE(0), 8192, 'msize 应回显请求值');
    assert.equal(rv.body.readUInt16LE(4), 8, "version 串长度 8 ('9P2000.L')");
    assert.equal(rv.body.toString('utf8', 6, 14), '9P2000.L');

    // Tattach fid=1
    const ra = parseR(await srv.handle(msg(104, 1, Buffer.concat([u32(1), u32(0), u32(0xffffffff), str('root'), str('')]))));
    assert.equal(ra.type, 105);
    assert.equal(ra.body[0], 0x80, '根目录 qid.type=QTDIR');

    // Twalk fid=1 → newfid=2 ['hello.txt']（先由 lcreate 创建前无法走通，直接 lcreate 在 fid=2 上）
    // 部分走：不存在的名字
    const rw = parseR(await srv.handle(msg(110, 2, Buffer.concat([u32(1), u32(2), u16(1), str('nope.txt')]))));
    assert.equal(rw.type, 111);
    assert.equal(rw.body.readUInt16LE(0), 0, '走失败返回 nwqid=0');

    // Tlcreate dfid=1 name=hello.txt —— 9P2000.L 语义：dfid 本身变成打开的文件 fid
    const rc = parseR(await srv.handle(msg(128, 3, Buffer.concat([u32(1), str('hello.txt'), u32(0), u32(0), u32(0)]))));
    assert.equal(rc.type, 129, 'Rlcreate');

    // Twrite fid=1（lcreate 后 dfid 即文件 fid）
    const data = Buffer.from('hello from 9p\n');
    const rwrt = parseR(await srv.handle(msg(118, 4, Buffer.concat([u32(1), u64(0n), u32(data.length), data]))));
    assert.equal(rwrt.type, 119);
    assert.equal(rwrt.body.readUInt32LE(0), data.length, '写入字节数');

    // Host 侧直接校验落盘
    const onDisk = await fsp.readFile(path.join(dir, 'hello.txt'));
    assert.equal(onDisk.toString(), data.toString(), 'Host 目录真实写入');

    // Tread fid=1
    const rr = parseR(await srv.handle(msg(116, 5, Buffer.concat([u32(1), u64(0n), u32(64)]))));
    assert.equal(rr.type, 117);
    assert.equal(rr.body.readUInt32LE(0), data.length);
    assert.equal(rr.body.toString('utf8', 4, 4 + data.length), data.toString());
  } finally {
    await srv.closeAll();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('9p：getattr 反映真实文件大小 / mkdir 建目录', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tsie-9p-'));
  const srv = new NinePServer(dir, 'hostshare');
  try {
    await fsp.writeFile(path.join(dir, 'a.txt'), Buffer.alloc(1234, 'A'));
    await srv.handle(msg(100, 0, Buffer.concat([u32(65536), str('9P2000.L')])));
    await srv.handle(msg(104, 1, Buffer.concat([u32(1), u32(0), u32(0xffffffff), str('root'), str('')])));
    // walk 到 a.txt → fid=2
    await srv.handle(msg(110, 2, Buffer.concat([u32(1), u32(2), u16(1), str('a.txt')])));
    // Tgetattr fid=2
    const rg = parseR(await srv.handle(msg(138, 3, Buffer.concat([u32(2), u64(0x7ffn)]))));
    assert.equal(rg.type, 139);
    // qid(13) 后是 mode[4]
    const mode = rg.body.readUInt32LE(21); // valid8+qid13 之后
    assert.ok(mode & 0x8000, 'S_IFREG 置位');
    // size 在 valid8+qid13+mode4+uid4+gid4+nlink8+rdev8 之后
    const size = Number(rg.body.readBigUInt64LE(49));
    assert.equal(size, 1234, 'getattr.size 与真实文件一致');
    // Tmkdir
    const rm = parseR(await srv.handle(msg(146, 4, Buffer.concat([u32(1), str('subdir'), u32(0), u32(0)]))));
    assert.equal(rm.type, 147);
    const st = await fsp.stat(path.join(dir, 'subdir'));
    assert.ok(st.isDirectory(), 'Host 侧目录真实创建');
  } finally {
    await srv.closeAll();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('9p：路径逃逸防护与 statfs', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tsie-9p-'));
  const srv = new NinePServer(dir, 'hostshare');
  try {
    await fsp.writeFile(path.join(os.tmpdir(), 'escape-canary.txt'), 'secret');
    await srv.handle(msg(100, 0, Buffer.concat([u32(65536), str('9P2000.L')])));
    await srv.handle(msg(104, 1, Buffer.concat([u32(1), u32(0), u32(0xffffffff), str('root'), str('')])));
    // Twalk '..' 出根：钳制在根上（nwqid=1，qid=根），绝不逃逸
    const rw = parseR(await srv.handle(msg(110, 2, Buffer.concat([u32(1), u32(3), u16(1), str('..')]))));
    assert.equal(rw.type, 111);
    assert.equal(rw.body.readUInt16LE(0), 1, '.. 在根上钳制为 1 步');
    assert.equal(rw.body[2], 0x80, '钳制后 qid 是根目录');
    // statfs
    const rs = parseR(await srv.handle(msg(124, 3, Buffer.concat([u32(1)]))));
    assert.equal(rs.type, 125);
    assert.ok(rs.body.readUInt32LE(4) > 0, 'bsize > 0');
  } finally {
    await srv.closeAll();
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(path.join(os.tmpdir(), 'escape-canary.txt'), { force: true });
  }
});
