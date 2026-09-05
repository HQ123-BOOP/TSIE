/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import type { Bus } from '../mem/bus.ts';
import type { MemSize } from '../mem/types.ts';
import type { DiskImage } from './disk.ts';
import { SECTOR_SIZE } from './disk.ts';
import type { IrqLine } from './uart.ts';
import { VirtioMmio, type VQueue, VIRTIO_F_VERSION_1 } from './virtio-mmio.ts';

// --- 块设备特性位 ---
const F_SIZE_MAX = 1n << 1n;
const F_SEG_MAX = 1n << 2n;
const F_GEOMETRY = 1n << 4n;
const F_BLK_SIZE = 1n << 6n;
const F_FLUSH = 1n << 9n;
const F_TOPOLOGY = 1n << 10n;
const F_CONFIG_WCE = 1n << 11n;

// --- 块设备请求类型 ---
const BLK_T_IN = 0;
const BLK_T_OUT = 1;
const BLK_T_FLUSH = 4;
const BLK_T_GET_ID = 8;
const BLK_T_WRITE_ZEROES = 13;

const BLK_S_OK = 0;
const BLK_S_IOERR = 1;
const BLK_S_UNSUPP = 2;

const QUEUE_SIZE = 256;

/**
 * VirtIO-MMIO 块设备（virtio-v1.x，寄存器布局与 U-Boot virtio_mmio.h 一致）。
 * 可挂载 raw 磁盘镜像作为 U-Boot/Linux 的根文件系统。
 * 传输层（寄存器组/特性协商/virtqueue/电平中断）见基类 VirtioMmio。
 */
export class VirtioBlk extends VirtioMmio {
  readonly name = 'virtio-blk';

  private readonly disk: DiskImage;
  private reqCount = 0;

  constructor(bus: Bus, disk: DiskImage, irq?: IrqLine) {
    // 单队列（块设备请求队列）；不暴露 RING_EVENT_IDX（避免 avail/used 环布局变化）
    super(bus, irq, 1, QUEUE_SIZE);
    this.disk = disk;
  }

  protected deviceId(): number {
    return 2; // block device
  }

  protected hostFeatures(): bigint {
    return (
      VIRTIO_F_VERSION_1 |
      F_SIZE_MAX |
      F_SEG_MAX |
      F_GEOMETRY |
      F_BLK_SIZE |
      F_FLUSH |
      F_TOPOLOGY |
      F_CONFIG_WCE
    );
  }

  protected queueSizeMax(): number {
    return QUEUE_SIZE;
  }

  protected readConfig(o: number, _size: MemSize): bigint {
    const cap = this.disk.sectorCount;
    switch (o) {
      case 0x00: return cap & 0xffffffffn; // capacity low
      case 0x04: return (cap >> 32n) & 0xffffffffn; // capacity high
      case 0x08: return 0n; // size_max
      case 0x0c: return BigInt(QUEUE_SIZE - 2); // seg_max
      case 0x10: {
        // geometry: cylinders(u16) heads(u8) sectors(u8)
        const cyl = Number(cap) > 0xffff ? 0xffff : Number(cap);
        return BigInt((cyl << 16) | (16 << 8) | 63);
      }
      case 0x14: return 512n; // blk_size
      case 0x18: return 0n; // topology
      case 0x20: return 1n; // writeback
      default: return 0n;
    }
  }

  protected handleRequest(q: VQueue, headId: number): void {
    this.reqCount++;
    const chain = this.collectChain(q, headId);
    if (chain.length < 2) return;

    // 描述符 0 是请求头（布局）：type(4) + reserved(4) + sector(8)
    const type = this.mem32(chain[0].addr);
    const sector = this.mem64(chain[0].addr + 8n);

    // 最后一个可写描述符是状态码
    let statusDesc = -1;
    for (let i = chain.length - 1; i >= 1; i--) {
      if (chain[i].write) {
        statusDesc = i;
        break;
      }
    }
    const dataOut: typeof chain = []; // guest 只读（主机写）
    const dataIn: typeof chain = []; // guest 可写（主机读）
    for (let i = 1; i < chain.length; i++) {
      if (i === statusDesc) continue;
      if (chain[i].write) dataIn.push(chain[i]);
      else dataOut.push(chain[i]);
    }

    let status = BLK_S_OK;
    try {
      switch (type) {
        case BLK_T_IN: {
          let total = 0;
          for (const c of dataIn) total += c.len;
          const sectors = Math.ceil(total / SECTOR_SIZE);
          if (sectors > 0) {
            const buf = this.disk.readSectors(sector, sectors);
            let off = 0;
            for (const c of dataIn) {
              const n = Math.min(c.len, Math.max(0, buf.length - off));
              if (n > 0) this.bus.writeBytes(c.addr, buf.subarray(off, off + n));
              off += c.len;
            }
          }
          break;
        }
        case BLK_T_OUT: {
          let total = 0;
          for (const c of dataOut) total += c.len;
          const data = new Uint8Array(total);
          let off = 0;
          for (const c of dataOut) {
            data.set(this.bus.readBytes(c.addr, c.len), off);
            off += c.len;
          }
          if (total > 0) this.disk.writeSectors(sector, data);
          break;
        }
        case BLK_T_FLUSH:
          break;
        case BLK_T_GET_ID: {
          const id = Buffer.alloc(20, 0);
          Buffer.from('tsie-virtio').copy(id);
          let off = 0;
          for (const c of dataIn) {
            const n = Math.min(c.len, Math.max(0, id.length - off));
            if (n > 0) this.bus.writeBytes(c.addr, new Uint8Array(id.subarray(off, off + n)));
            off += c.len;
          }
          break;
        }
        case BLK_T_WRITE_ZEROES:
          break;
        default:
          status = BLK_S_UNSUPP;
      }
    } catch {
      status = BLK_S_IOERR;
    }

    if (statusDesc >= 0) {
      const sd = chain[statusDesc];
      this.bus.write(sd.addr + BigInt(sd.len - 1), BigInt(status), 1);
    }
    this.pushUsed(q, headId, 0);
  }

  override stats(): { requests: number; notifications: number } {
    return { requests: this.reqCount, notifications: this.notifyStats };
  }
}
