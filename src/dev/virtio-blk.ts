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

  /**
   * 调试：记录**前** 60 条块请求（类型/扇区/描述符数/状态）。
   * Linux 只用整盘不读分区表，所以这些路径一直没被压过；U-Boot 会扫分区表，
   * 出问题时要能看清它到底在读哪些扇区。同时统计扇区访问范围。
   */
  cmdTrace = false;
  readonly cmdTraceLog: string[] = [];
  sectorMin = -1n;
  sectorMax = -1n;

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

  /**
   * config 空间读取。
   *
   * ⚠️ **必须按字节组装，不能只匹配对齐的 4 字节偏移。** 同一个字段，不同驱动的
   * 读法不一样：Linux / OpenBSD 用对齐的 32 位读（capacity 低/高各一次 readl），
   * 而 EDK II 的 `VirtioMmioDeviceRead` 会**逐字节**读那 8 字节 capacity
   * （实测寄存器追踪是 `R 0x100, 0x101, … 0x107` 连续 8 次 1 字节访问）。
   *
   * 只按 0x00/0x04/0x08… 匹配的话，偏移 1/2/3/5/6/7 全部落到 default 返回 0，
   * 于是 capacity 被读成 **0**，VirtioBlkInit 紧接着
   * `if (NumSectors == 0) { Status = EFI_UNSUPPORTED; goto Failed; }`，
   * 写状态 `0x83`(=ACK|DRIVER|FAILED) 放弃 —— UEFI 里磁盘就此消失。
   * 而 Linux 走对齐读，永远碰不到这些偏移，所以这个洞藏了很久。
   *
   * 字段布局（virtio spec §5.2，小端）：
   *   0x00 u64 capacity        0x08 u32 size_max      0x0c u32 seg_max
   *   0x10 geometry(u16,u8,u8) 0x14 u32 blk_size      0x18 topology(8B)
   *   0x20 u8  writeback
   */
  protected readConfig(o: number, size: MemSize): bigint {
    const cap = this.disk.sectorCount;
    const cfg = new Uint8Array(0x24);
    const dv = new DataView(cfg.buffer);
    dv.setBigUint64(0x00, cap, true); // capacity（扇区数）
    // size_max **必须非 0**！我们宣告了 VIRTIO_BLK_F_SIZE_MAX，而 U-Boot 会照它算
    // 单段上限：seg_sec_cnt = size_max / 512，再 blk_per_sg = min(剩余, seg_sec_cnt*seg_max)。
    // 返回 0 会让 U-Boot 的 blk_per_sg 恒为 0 → while (i < blkcnt) 永不前进 →
    // 疯狂发零长度读（实测 9.8 万次）后卡死。Linux 不读这个字段，所以只有 U-Boot 中招。
    dv.setUint32(0x08, 0x7fffffff, true); // size_max（单段不超过这么多字节）
    dv.setUint32(0x0c, QUEUE_SIZE - 2, true); // seg_max
    // geometry: cylinders(u16) heads(u8) sectors(u8)
    dv.setUint16(0x10, cap > 0xffffn ? 0xffff : Number(cap), true);
    cfg[0x12] = 16; // heads
    cfg[0x13] = 63; // sectors
    dv.setUint32(0x14, 512, true); // blk_size
    // 0x18 topology 全 0：physical_block_exp / alignment_offset / min_io_size / opt_io_size
    cfg[0x20] = 1; // writeback（回写缓存开启）

    let v = 0n;
    for (let i = 0; i < size; i++) {
      const off = o + i;
      if (off >= cfg.length) break;
      v |= BigInt(cfg[off]) << BigInt(8 * i);
    }
    return v;
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
    if (this.sectorMin < 0n || sector < this.sectorMin) this.sectorMin = sector;
    if (sector > this.sectorMax) this.sectorMax = sector;
    if (this.cmdTrace && this.cmdTraceLog.length < 60) {
      const shape = chain.map((c, i) => `[${i}]${c.write ? 'W' : 'R'}${c.len}`).join(' ');
      // 原始描述符（含 flags/next）：判断是不是 indirect 表、或链在中间被截断
      const rawDesc = (i: number): string => {
        const d = q.desc + BigInt(i * 16);
        return `d${i}(addr=0x${this.mem64(d).toString(16)} len=${this.mem32(d + 8n)} fl=${this.mem16(d + 12n)} nx=${this.mem16(d + 14n)})`;
      };
      const rawDump = [0, 1, 2].map(rawDesc).join(' ');
      this.cmdTraceLog.push(
        `type=${type} sector=${sector} ndesc=${chain.length} qnum=${q.num} status=${status}` +
          ` | ${shape} | dataIn=${dataIn.length} dataOut=${dataOut.length} statusDesc=${statusDesc} | ${rawDump}`,
      );
    }
    this.pushUsed(q, headId, 0);
  }

  override stats(): { requests: number; notifications: number } {
    return { requests: this.reqCount, notifications: this.notifyStats };
  }
}
