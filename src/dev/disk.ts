import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';

/** 块设备镜像抽象 */
export interface DiskImage {
  readonly sectorCount: bigint;
  readSectors(lba: bigint, count: number): Uint8Array;
  writeSectors(lba: bigint, data: Uint8Array): void;
  close(): void;
}

export const SECTOR_SIZE = 512;

/** 内存盘：整个镜像加载到 Buffer */
export class MemoryDisk implements DiskImage {
  readonly sectorCount: bigint;
  private buf: Buffer;

  constructor(buf: Buffer | Uint8Array) {
    this.buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    this.sectorCount = BigInt(this.buf.length / SECTOR_SIZE);
  }

  static zero(sectors: number): MemoryDisk {
    return new MemoryDisk(Buffer.alloc(sectors * SECTOR_SIZE));
  }

  readSectors(lba: bigint, count: number): Uint8Array {
    const start = Number(lba) * SECTOR_SIZE;
    const end = start + count * SECTOR_SIZE;
    if (end > this.buf.length) throw new Error(`disk read out of range: lba=${lba} count=${count}`);
    return new Uint8Array(this.buf.subarray(start, end));
  }

  writeSectors(lba: bigint, data: Uint8Array): void {
    const start = Number(lba) * SECTOR_SIZE;
    if (start + data.length > this.buf.length) throw new Error(`disk write out of range: lba=${lba}`);
    Buffer.from(data).copy(this.buf, start);
  }

  close(): void {
    /* 内存盘无需关闭 */
  }
}

/** 文件盘：同步读写宿主机文件 */
export class FileDisk implements DiskImage {
  readonly sectorCount: bigint;
  private fd: number;

  /** 读缓存：1 MiB 粒度 LRU。机械盘/网络盘上 U-Boot 与内核的 ext4 遍历
   *  大量小粒度随机读（512B~16KB/次），每次 readSync 都付出完整磁盘延迟，
   *  顺序读场景靠预读整块几乎全部命中。 */
  private readonly cacheBlk = 1 << 20; // 1 MiB
  private readonly cacheMax = 32; // 32 MiB
  private cache = new Map<number, Buffer>();

  constructor(path: string, readOnly = false) {
    this.fd = openSync(path, readOnly ? 'r' : 'r+');
    const st = fstatSync(this.fd);
    this.sectorCount = BigInt(st.size / SECTOR_SIZE);
  }

  /** 按 1MiB 块缓存读取 [off, off+len) */
  private cachedRead(off: number, len: number): Buffer {
    const out = Buffer.alloc(len);
    let done = 0;
    while (done < len) {
      const blk = Math.floor((off + done) / this.cacheBlk);
      let buf = this.cache.get(blk);
      if (!buf) {
        buf = Buffer.alloc(this.cacheBlk);
        let got = 0;
        const base = blk * this.cacheBlk;
        while (got < this.cacheBlk) {
          const n = readSync(this.fd, buf, got, this.cacheBlk - got, base + got);
          if (n <= 0) break;
          got += n;
        }
        this.cache.set(blk, buf);
        if (this.cache.size > this.cacheMax) {
          const first = this.cache.keys().next().value as number;
          this.cache.delete(first);
        }
      }
      const inBlk = off + done - blk * this.cacheBlk;
      const take = Math.min(len - done, this.cacheBlk - inBlk);
      buf.copy(out, done, inBlk, inBlk + take);
      done += take;
    }
    return out;
  }

  readSectors(lba: bigint, count: number): Uint8Array {
    return new Uint8Array(this.cachedRead(Number(lba) * SECTOR_SIZE, count * SECTOR_SIZE));
  }

  writeSectors(lba: bigint, data: Uint8Array): void {
    const buf = Buffer.from(data);
    let off = 0;
    let left = buf.length;
    let cur = Number(lba) * SECTOR_SIZE;
    // 写会改变内容，使相关缓存块失效
    while (left > 0) {
      const n = writeSync(this.fd, buf, off, left, cur);
      off += n;
      cur += n;
      left -= n;
    }
    this.invalidate(Number(lba) * SECTOR_SIZE, buf.length);
  }

  /** 使 [off, off+len) 覆盖的缓存块失效 */
  private invalidate(off: number, len: number): void {
    const first = Math.floor(off / this.cacheBlk);
    const last = Math.floor((off + len - 1) / this.cacheBlk);
    for (let b = first; b <= last; b++) this.cache.delete(b);
  }

  close(): void {
    if (this.fd >= 0) closeSync(this.fd);
    this.fd = -1;
  }
}
