/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import type { Bus } from '../mem/bus.ts';
import type { MemSize } from '../mem/types.ts';
import type { IrqLine } from './uart.ts';
import { VirtioMmio, VIRTIO_F_VERSION_1, type VQueue } from './virtio-mmio.ts';
import { NinePServer } from './ninep.ts';

/** virtio-9p 设备特定位：config 空间携带挂载 tag（9pnet_virtio 依赖） */
const VIRTIO_9P_MOUNT_TAG = 1n;

/**
 * VirtIO-MMIO 9P 设备（DeviceID=9，单队列）。
 * 请求链 = T 消息（out 描述符）+ R 消息缓冲（in 描述符）；设备把 T 交给
 * NinePServer（映射到 Host 目录），把 R 写回 in 描述符并 pushUsed+IRQ。
 * 异步完成与 virtio-net 的 RX 注入同模式（promise 回调里 pushUsed/raiseIrq）。
 */
export class Virtio9p extends VirtioMmio {
  readonly name = 'virtio-9p';
  private readonly server: NinePServer;
  private readonly tagBytes: Buffer;
  private reqCount = 0;
  private replyCount = 0;

  constructor(bus: Bus, irq: IrqLine | undefined, root: string, tag = 'hostshare') {
    super(bus, irq, 1, 64);
    this.server = new NinePServer(root, tag);
    this.tagBytes = Buffer.from(tag, 'utf8');
  }

  protected deviceId(): number {
    return 9; // VIRTIO_ID_9P
  }

  protected hostFeatures(): bigint {
    return VIRTIO_F_VERSION_1 | VIRTIO_9P_MOUNT_TAG;
  }

  protected queueSizeMax(): number {
    return 64;
  }

  /** config 空间：tag_len[2](LE) + tag[]（struct virtio_9p_config） */
  protected readConfig(o: number, _size: MemSize): bigint {
    if (o === 0) return BigInt(this.tagBytes.length & 0xff);
    if (o === 1) return BigInt((this.tagBytes.length >> 8) & 0xff);
    if (o >= 2 && o < 2 + this.tagBytes.length) return BigInt(this.tagBytes[o - 2]);
    return 0n;
  }

  stats(): { notifications: number; requests: number; replies: number } {
    return {
      ...super.stats(),
      requests: this.reqCount,
      replies: this.replyCount,
    };
  }

  protected handleRequest(q: VQueue, headId: number): void {
    const chain = this.collectChain(q, headId);
    let outLen = 0;
    let inCap = 0;
    for (const c of chain) {
      if (c.write) inCap += c.len;
      else outLen += c.len;
    }
    const req = new Uint8Array(outLen);
    let roff = 0;
    for (const c of chain) {
      if (!c.write) {
        req.set(this.bus.readBytes(c.addr, c.len), roff);
        roff += c.len;
      }
    }
    this.reqCount++;

    const complete = (resp: Buffer): void => {
      let off = 0;
      let total = 0;
      for (const c of chain) {
        if (!c.write) continue;
        const n = Math.min(c.len, resp.length - off);
        if (n > 0) this.bus.writeBytes(c.addr, resp.subarray(off, off + n));
        off += n;
        total += n;
      }
      this.replyCount++;
      this.pushUsed(q, headId, total);
      this.raiseIrq();
    };

    this.server
      .handle(req)
      .then((resp) => {
        if (resp.length > inCap) resp = resp.subarray(0, inCap); // 不越过 in 缓冲
        complete(resp);
      })
      .catch((e: unknown) => {
        if (this.debug) console.error(`[9p] 内部错误: ${(e as Error).message}`);
        complete(Buffer.alloc(0)); // 空回复保底，驱动按 0 长消息处理
      });
  }

  debug = false;
}
