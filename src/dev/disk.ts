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

  constructor(path: string, readOnly = false) {
    this.fd = openSync(path, readOnly ? 'r' : 'r+');
    const st = fstatSync(this.fd);
    this.sectorCount = BigInt(st.size / SECTOR_SIZE);
  }

  readSectors(lba: bigint, count: number): Uint8Array {
    const buf = Buffer.alloc(count * SECTOR_SIZE);
    let off = 0;
    let left = count * SECTOR_SIZE;
    let cur = Number(lba) * SECTOR_SIZE;
    while (left > 0) {
      const n = readSync(this.fd, buf, off, left, cur);
      if (n <= 0) break;
      off += n;
      cur += n;
      left -= n;
    }
    return new Uint8Array(buf);
  }

  writeSectors(lba: bigint, data: Uint8Array): void {
    const buf = Buffer.from(data);
    let off = 0;
    let left = buf.length;
    let cur = Number(lba) * SECTOR_SIZE;
    while (left > 0) {
      const n = writeSync(this.fd, buf, off, left, cur);
      off += n;
      cur += n;
      left -= n;
    }
  }

  close(): void {
    if (this.fd >= 0) closeSync(this.fd);
    this.fd = -1;
  }
}
