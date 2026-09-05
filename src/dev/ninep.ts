/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 9P2000.L 协议服务器（与传输层解耦：输入一个 T 消息，输出一个 R 消息）。
 * 把 9P 操作映射到 Host 的一个目录（Node fs），供 virtio-9p 设备适配。
 *
 * 支持的 T 消息：version/attach/walk/lopen/lcreate/read/write/clunk/
 * getattr/setattr/statfs/mkdir/remove/rename/flush；其余回 Rerror(ENOSYS)。
 * fid → Host 路径映射挂在实例上；路径全部做过越界防护（不得逃出根目录）。
 */

// ---- 消息类型（9P2000.L）----
// 基础操作沿用 9P2000 编号；.L 扩展操作使用 v9fs 的小号段（p9_msg_t）。
const T_VERSION = 100, R_VERSION = 101;
const T_ATTACH = 104, R_ATTACH = 105;
const R_ERROR = 107;
const T_FLUSH = 108, R_FLUSH = 109;
const T_WALK = 110, R_WALK = 111;
const T_READ = 116, R_READ = 117;
const T_WRITE = 118, R_WRITE = 119;
const T_CLUNK = 120, R_CLUNK = 121;
const T_REMOVE = 122, R_REMOVE = 123;
// 9P2000.L 扩展（小号段）：绝不能写成 124/126/128 等 9P2000 的 stat/wstat 编号
const T_STATFS = 8, R_STATFS = 9;
const T_LOPEN = 12, R_LOPEN = 13;
const T_LCREATE = 14, R_LCREATE = 15;
const T_RENAME = 20, R_RENAME = 21;
const T_GETATTR = 24, R_GETATTR = 25;
const T_SETATTR = 26, R_SETATTR = 27;
const T_READDIR = 40, R_READDIR = 41;
const T_MKDIR = 72, R_MKDIR = 73;
const T_UNLINKAT = 76, R_UNLINKAT = 77;

const NOFID = 0xffffffff;
const QTDIR = 0x80;
const MSIZE_MAX = 65536;

// errno（Linux 值）
const ERRNO: Record<string, number> = {
  EPERM: 1, ENOENT: 2, EACCES: 13, EEXIST: 17, ENOTDIR: 20, EISDIR: 21,
  EINVAL: 22, ENOSPC: 28, ENOTEMPTY: 39, ENOSYS: 38, EBADF: 9,
};

export class NinePError extends Error {
  readonly ename: string;
  readonly errno: number;
  constructor(ename: string, errno: number) {
    super(ename);
    this.ename = ename;
    this.errno = errno;
  }
}

function errnoOf(e: unknown): { ename: string; errno: number } {
  if (e instanceof NinePError) return { ename: e.ename, errno: e.errno };
  const code = (e as { code?: string })?.code;
  if (code && ERRNO[code] !== undefined) return { ename: code, errno: ERRNO[code] };
  return { ename: 'internal', errno: 38 };
}

// ---- 编解码游标 ----

class Writer {
  private buf: Buffer = Buffer.alloc(64);
  private n = 0;
  private ensure(k: number): void {
    if (this.n + k > this.buf.length) {
      let cap = this.buf.length * 2;
      while (cap < this.n + k) cap *= 2;
      const nb = Buffer.alloc(cap);
      this.buf.copy(nb, 0, 0, this.n);
      this.buf = nb;
    }
  }
  u8(v: number): this { this.ensure(1); this.buf[this.n++] = v & 0xff; return this; }
  u16(v: number): this { this.ensure(2); this.buf.writeUInt16LE(v, this.n); this.n += 2; return this; }
  u32(v: number): this { this.ensure(4); this.buf.writeUInt32LE(v >>> 0, this.n); this.n += 4; return this; }
  u64(v: bigint): this { this.ensure(8); this.buf.writeBigUInt64LE(BigInt.asUintN(64, v), this.n); this.n += 8; return this; }
  str(s: string): this {
    const b = Buffer.from(s, 'utf8');
    this.u16(b.length);
    this.ensure(b.length);
    b.copy(this.buf, this.n);
    this.n += b.length;
    return this;
  }
  qid(type: number, version: number, path: bigint): this {
    this.u8(type); this.u32(version); this.u64(path);
    return this;
  }
  bytes(b: Uint8Array): this { this.ensure(b.length); b.copy ? b.copy(this.buf, this.n) : this.buf.set(b, this.n); this.n += b.length; return this; }
  /** 当前已写内容的裸字节（用于需要前缀长度的场景，如 readdir） */
  raw(): Buffer { return Buffer.from(this.buf.subarray(0, this.n)); }
  /** size[4] 头 + 已写内容 */
  finish(type: number, tag: number): Buffer {
    const total = 7 + this.n;
    const out = Buffer.alloc(total);
    out.writeUInt32LE(total, 0);
    out[4] = type;
    out.writeUInt16LE(tag, 5);
    this.buf.copy(out, 7, 0, this.n);
    return out;
  }
}

class Reader {
  private n = 7; // 跳过 size+type+tag
  readonly buf: Buffer;
  readonly type: number;
  readonly tag: number;
  private readonly size: number;
  constructor(buf: Buffer, type: number, tag: number, size: number) {
    this.buf = buf; this.type = type; this.tag = tag; this.size = size;
  }
  get remaining(): number { return this.size - this.n; }
  u8(): number { return this.buf[this.n++]; }
  u16(): number { const v = this.buf.readUInt16LE(this.n); this.n += 2; return v; }
  u32(): number { const v = this.buf.readUInt32LE(this.n); this.n += 4; return v; }
  u64(): bigint { const v = this.buf.readBigUInt64LE(this.n); this.n += 8; return v; }
  raw(n: number): Buffer { const b = Buffer.from(this.buf.subarray(this.n, this.n + n)); this.n += n; return b; }
  str(): string {
    const len = this.u16();
    const s = this.buf.toString('utf8', this.n, this.n + len);
    this.n += len;
    return s;
  }
}

// ---- qid ----

function qidType(st: fs.Stats): number {
  return st.isDirectory() ? QTDIR : 0;
}

interface Fid {
  path: string; // 绝对 Host 路径
  fh?: fs.promises.FileHandle; // lopen/lcreate 后持有的句柄
  openFlags?: number;
}

export interface NinePStats {
  requests: number;
  errors: number;
  hostBytesRead: number;
  hostBytesWritten: number;
}

/**
 * 一个 9P2000.L 文件服务器实例：把请求映射到 root 目录下的真实文件。
 * 多实例安全； fid 表挂在实例上（一个 virtio 设备对应一个实例）。
 */
export class NinePServer {
  private fids = new Map<number, Fid>();
  msize = MSIZE_MAX;
  readonly stats: NinePStats = { requests: 0, errors: 0, hostBytesRead: 0, hostBytesWritten: 0 };

  readonly root: string;
  readonly tag: string;
  /** 消息级调试日志（stderr） */
  debug = false;
  constructor(root: string, tag = 'hostshare') {
    this.root = root;
    this.tag = tag;
  }

  /** 处理一个完整 T 消息，返回完整 R 消息（含 size 头）。保证不抛异常。 */
  async handle(req: Uint8Array): Promise<Buffer> {
    try {
      const size = req[0] | (req[1] << 8) | (req[2] << 16) | (req[3] << 24);
      const type = req[4];
      const tag = req[5] | (req[6] << 8);
      this.stats.requests++;
      if (this.debug) console.error(`[9p] T type=${type} tag=${tag} size=${size}`);
      const resp = await this.dispatch(new Reader(Buffer.from(req), type, tag, size));
      if (this.debug) console.error(`[9p] R type=${resp[4]} tag=${resp[5] | (resp[6] << 8)} size=${resp.length}`);
      return resp;
    } catch (e) {
      this.stats.errors++;
      const { ename, errno } = errnoOf(e);
      if (this.debug) console.error(`[9p] Rerror tag=${req.length >= 7 ? req[5] | (req[6] << 8) : -1} ${ename}(${errno}) -- ${(e as Error).message}`);
      const tag = req.length >= 7 ? req[5] | (req[6] << 8) : 0xffff;
      return new Writer().str(ename).u32(errno).finish(R_ERROR, tag);
    }
  }

  private safeJoin(...parts: string[]): string {
    const full = path.resolve(this.root, ...parts);
    const normRoot = path.resolve(this.root);
    if (full !== normRoot && !full.startsWith(normRoot + path.sep)) {
      throw new NinePError('EPERM', 1); // 路径逃逸防护
    }
    return full;
  }

  private fidPath(fid: number): string {
    const f = this.fids.get(fid);
    if (!f) throw new NinePError('EBADF', 9);
    return f.path;
  }

  private async dispatch(r: Reader): Promise<Buffer> {
    switch (r.type) {
      case T_VERSION: return this.tVersion(r);
      case T_ATTACH: return this.tAttach(r);
      case T_FLUSH: return new Writer().finish(R_FLUSH, r.tag);
      case T_WALK: return this.tWalk(r);
      case T_LOPEN: return this.tLopen(r);
      case T_LCREATE: return this.tLcreate(r);
      case T_READ: return this.tRead(r);
      case T_WRITE: return this.tWrite(r);
      case T_CLUNK: return this.tClunk(r);
      case T_REMOVE: return this.tRemove(r);
      case T_STATFS: return this.tStatfs(r);
      case T_GETATTR: return this.tGetattr(r);
      case T_READDIR: return this.tReaddir(r);
      case T_SETATTR: return this.tSetattr(r);
      case T_MKDIR: return this.tMkdir(r);
      case T_UNLINKAT: return this.tUnlinkat(r);
      case T_RENAME: return this.tRename(r);
      default: throw new NinePError('ENOSYS', 38);
    }
  }

  // ---- 各消息实现 ----

  private async tVersion(r: Reader): Promise<Buffer> {
    const reqMsize = r.u32();
    const version = r.str();
    if (version !== '9P2000.L') throw new NinePError('ENOSYS', 38);
    // 回复 msize 不得超过客户端请求值（否则内核报 Protocol error）
    this.msize = Math.min(Math.max(reqMsize, 4096), MSIZE_MAX);
    this.fids.clear(); // version 重置会话
    return new Writer().u32(this.msize).str('9P2000.L').finish(R_VERSION, r.tag);
  }

  private async statQid(p: string): Promise<{ type: number; version: number; path: bigint; st: fs.Stats }> {
    const st = await fsp.stat(p);
    return { type: qidType(st), version: 0, path: BigInt(st.ino.toString()), st };
  }

  private async tAttach(r: Reader): Promise<Buffer> {
    const fid = r.u32();
    r.u32(); // afid（不支持 auth）
    r.str(); // uname
    const aname = r.str();
    r.u32(); // n_uname（9P2000.L 尾部字段）
    const sub = aname && aname !== this.tag ? aname : '';
    const p = this.safeJoin(this.root, sub);
    const q = await this.statQid(p);
    this.fids.set(fid, { path: p });
    return new Writer().qid(q.type, q.version, q.path).finish(R_ATTACH, r.tag);
  }

  private async tWalk(r: Reader): Promise<Buffer> {
    const fid = r.u32();
    const newfid = r.u32();
    const nwname = r.u16();
    const base = this.fidPath(fid);
    let cur = base;
    const qids: { type: number; version: number; path: bigint }[] = [];
    const normRoot = path.resolve(this.root);
    for (let i = 0; i < nwname; i++) {
      const name = r.str();
      let next = path.resolve(cur, name);
      // '..' 走出导出根时钳制在根上（QEMU 9p local 同语义），绝不逃逸
      if (!next.startsWith(normRoot)) next = normRoot;
      try {
        const q = await this.statQid(next);
        qids.push({ type: q.type, version: q.version, path: q.path });
        cur = next;
      } catch {
        break; // 部分走：Rwalk 带已走 qid 数，内核据此报 ENOENT
      }
    }
    this.fids.set(newfid, { path: cur });
    const w = new Writer();
    w.u16(qids.length); // nwqid 必须在 qid 数组之前
    for (const q of qids) w.qid(q.type, q.version, q.path);
    return w.finish(R_WALK, r.tag);
  }

  private async tLopen(r: Reader): Promise<Buffer> {
    const fid = r.u32();
    const flags = r.u32();
    const p = this.fidPath(fid);
    const q = await this.statQid(p);
    const acc = flags & 3;
    let node = 'r';
    if ((flags & 0x400) !== 0) node = 'a+'; // O_APPEND
    else if (acc === 0) node = 'r';
    else if (acc === 1) node = 'w';
    else if (acc === 2) node = 'r+';
    const fh = await fsp.open(p, node);
    const old = this.fids.get(fid);
    this.fids.set(fid, { path: p, fh, openFlags: flags });
    void old?.fh?.close().catch(() => {});
    return new Writer().qid(q.type, q.version, q.path).u32(this.msize - 24).finish(R_LOPEN, r.tag);
  }

  private async tLcreate(r: Reader): Promise<Buffer> {
    const dfid = r.u32();
    const name = r.str();
    r.u32(); // flags
    r.u32(); // mode
    r.u32(); // gid
    const dir = this.fidPath(dfid);
    const p = path.join(dir, name);
    const fh = await fsp.open(p, 'w+');
    const q = await this.statQid(p);
    this.fids.set(dfid, { path: p, fh });
    return new Writer().qid(q.type, q.version, q.path).u32(this.msize - 24).finish(R_LCREATE, r.tag);
  }

  private fhOf(fid: number): fs.promises.FileHandle {
    const f = this.fids.get(fid);
    if (!f?.fh) throw new NinePError('EBADF', 9);
    return f.fh;
  }

  private async tRead(r: Reader): Promise<Buffer> {
    const fid = r.u32();
    const offset = r.u64();
    const count = r.u32();
    const f = this.fids.get(fid);
    if (!f) throw new NinePError('EBADF', 9);
    const fh = f.fh ?? (f.fh = await fsp.open(f.path, 'r'));
    const buf = Buffer.alloc(count);
    const { bytesRead } = await fh.read(buf, 0, count, Number(offset));
    this.stats.hostBytesRead += bytesRead;
    return new Writer().u32(bytesRead).bytes(buf.subarray(0, bytesRead)).finish(R_READ, r.tag);
  }

  private async tWrite(r: Reader): Promise<Buffer> {
    const fid = r.u32();
    const offset = r.u64();
    const count = r.u32();
    const data = r.remaining >= count ? r.raw(count) : Buffer.alloc(0);
    const f = this.fids.get(fid);
    if (!f) throw new NinePError('EBADF', 9);
    // 只写模式懒开句柄；已有句柄直接用
    const fh = f.fh ?? (f.fh = await fsp.open(f.path, 'r+'));
    const { bytesWritten } = await fh.write(data, 0, count, Number(offset));
    this.stats.hostBytesWritten += bytesWritten;
    return new Writer().u32(bytesWritten).finish(R_WRITE, r.tag);
  }

  private async tClunk(r: Reader): Promise<Buffer> {
    const fid = r.u32();
    const f = this.fids.get(fid);
    void f?.fh?.close().catch(() => {});
    this.fids.delete(fid);
    return new Writer().finish(R_CLUNK, r.tag);
  }

  private async tRemove(r: Reader): Promise<Buffer> {
    const fid = r.u32();
    const p = this.fidPath(fid);
    const f = this.fids.get(fid);
    void f?.fh?.close().catch(() => {});
    this.fids.delete(fid);
    await fsp.rm(p, { recursive: true, force: false });
    return new Writer().finish(R_REMOVE, r.tag);
  }

  private async tStatfs(r: Reader): Promise<Buffer> {
    const fid = r.u32();
    this.fidPath(fid);
    const s = await fsp.statfs(this.root);
    const w = new Writer();
    w.u32(0);            // type
    w.u32(s.bsize);      // bsize
    w.u64(BigInt(s.blocks)); w.u64(BigInt(s.bfree)); w.u64(BigInt(s.bavail));
    w.u64(BigInt(s.files)); w.u64(BigInt(s.ffree));
    w.u64(1n);           // fsid
    w.u32(255);          // namelen
    return w.finish(R_STATFS, r.tag);
  }

  private async tGetattr(r: Reader): Promise<Buffer> {
    const fid = r.u32();
    r.u64(); // request_mask
    const p = this.fidPath(fid);
    const q = await this.statQid(p);
    const st = q.st;
    const w = new Writer();
    w.u64(0x7ffn); // valid：全部常规字段有效
    w.qid(q.type, q.version, q.path);
    w.u32(st.mode & 0xffff);
    w.u32(st.uid); w.u32(st.gid);
    w.u64(BigInt(st.nlink)); w.u64(0n); // rdev
    w.u64(BigInt(st.size)); w.u64(BigInt(st.blksize || 4096)); w.u64(BigInt(Math.ceil(st.size / 512)));
    w.u64(BigInt(Math.floor(st.atimeMs / 1000)));
    w.u64(BigInt(Math.floor(st.mtimeMs / 1000)));
    w.u64(BigInt(Math.floor(st.ctimeMs / 1000)));
    w.u64(0n); w.u64(0n); w.u64(0n); // btime/gen/data_version
    return w.finish(R_GETATTR, r.tag);
  }

  /**
   * Treaddir(40)：目录项流（9P2000.L 的 ls 依赖它，而非 Tread）。
   * 回复体 = count[4] + dirent[]；dirent = qid[13] + offset[8] + type[1] + name[s]
   */
  private async tReaddir(r: Reader): Promise<Buffer> {
    const fid = r.u32();
    const offset = Number(r.u64());
    const count = r.u32();
    const p = this.fidPath(fid);
    const entries = await fsp.readdir(p, { withFileTypes: true });
    const body = new Writer();
    let used = 0;
    // offset 语义：已返回的条目数（用下标做游标，末尾返回 0 字节表示 EOF）
    for (let i = offset; i < entries.length; i++) {
      const e = entries[i];
      let st: fs.Stats;
      try {
        st = await fsp.stat(path.join(p, e.name));
      } catch {
        continue;
      }
      const type = e.isDirectory() ? 4 : e.isSymbolicLink() ? 10 : 8; // DT_DIR/DT_LNK/DT_REG
      const nameBuf = Buffer.from(e.name, 'utf8');
      const size = 13 + 8 + 1 + 2 + nameBuf.length;
      if (size + 4 + used > count) break; // 装不下就停（内核会再来一次）
      body.qid(qidType(st), 0, BigInt(st.ino.toString()));
      body.u64(BigInt(i + 1));
      body.u8(type);
      body.str(e.name);
      used += size;
    }
    return new Writer().u32(used).bytes(body.raw()).finish(R_READDIR, r.tag);
  }

  private async tSetattr(r: Reader): Promise<Buffer> {
    const fid = r.u32();
    const valid = r.u32();
    const mode = r.u32();
    r.u32(); r.u32();
    const size = r.u64();
    r.u64(); r.u64(); r.u64(); r.u64();
    const p = this.fidPath(fid);
    if (valid & 0x08) await fsp.truncate(p, Number(size)); // ATTR_SIZE
    if (valid & 0x04) await fsp.chmod(p, mode & 0xffff);   // ATTR_MODE
    return new Writer().finish(R_SETATTR, r.tag);
  }

  private async tMkdir(r: Reader): Promise<Buffer> {
    const dfid = r.u32();
    const name = r.str();
    r.u32(); r.u32();
    const dir = this.fidPath(dfid);
    const p = path.join(dir, name);
    await fsp.mkdir(p);
    const q = await this.statQid(p);
    this.fids.set(dfid, { path: dir });
    return new Writer().qid(q.type, q.version, q.path).finish(R_MKDIR, r.tag);
  }

  /** Tunlinkat(76)：9P2000.L 的 rm/unlink 走它，而非 Tremove */
  private async tUnlinkat(r: Reader): Promise<Buffer> {
    const dirfid = r.u32();
    const name = r.str();
    r.u32(); // flags
    const dir = this.fidPath(dirfid);
    const p = this.safeJoin(dir, name);
    const st = await fsp.stat(p);
    await (st.isDirectory() ? fsp.rmdir(p) : fsp.unlink(p));
    return new Writer().finish(R_UNLINKAT, r.tag);
  }

  private async tRename(r: Reader): Promise<Buffer> {
    const fid = r.u32();
    const dfid = r.u32();
    const name = r.str();
    const p = this.fidPath(fid);
    const dir = this.fidPath(dfid);
    const np = path.join(dir, name);
    await fsp.rename(p, np);
    const f = this.fids.get(fid);
    if (f) f.path = np;
    return new Writer().finish(R_RENAME, r.tag);
  }

  // ---- 便捷方法（测试用） ----

  /** 关闭所有仍打开的句柄（测试收尾） */
  async closeAll(): Promise<void> {
    for (const f of this.fids.values()) await f.fh?.close().catch(() => {});
    this.fids.clear();
  }
}
