/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import type { Bus } from '../mem/bus.ts';
import type { MemSize } from '../mem/types.ts';
import type { EthFrame, NetBackend } from './net.ts';
import type { IrqLine } from './uart.ts';
import { VirtioMmio, type VQueue, VIRTIO_F_VERSION_1 } from './virtio-mmio.ts';

// --- virtio-net 特性位（只暴露真正实现的；MRG_RXBUF/STATUS/CSUM/CTRL_VQ
//     一律不 offer——Linux 驱动会优雅降级：small buffer RX、假定 link up、
//     软件校验和。见 virtio_net.c virtnet_validate_features 的硬约束）---
const F_MAC = 1n << 5n;

/** virtio_net_hdr（VERSION_1 设备恒 12 字节 = mrg 布局，num_buffers 在偏移 10） */
const NET_HDR_SIZE = 12;

/** 设备内待注入帧队列上限（RX avail 暂无缓冲时排队，防无界增长） */
const RX_PENDING_MAX = 128;

/**
 * VirtIO-MMIO 网络设备（virtio-v1.x）。
 * 双队列：vq0=RX（驱动挂空缓冲，设备写头+帧）、vq1=TX（驱动挂帧，设备回 0）。
 * 无控制队列（不 offer CTRL_VQ 及其全部依赖位）。
 *
 * RX 注入：外部（后端/测试）调 injectRx(frame)，设备从 RX avail 取空缓冲
 * 写入「12B 全零头 + 帧」并 pushUsed(len=12+帧长)、拉 IRQ；无缓冲时帧进
 * 内部 FIFO（上限 RX_PENDING_MAX，溢出丢弃计数），QUEUE_READY/新增缓冲
 * 时再泵。异步入口参考 UART pushRx——本模拟器无设备 tick 轮询。
 */
export class VirtioNet extends VirtioMmio {
  readonly name = 'virtio-net';

  private readonly backend: NetBackend;
  private readonly mac: Uint8Array;
  private readonly rxPending: EthFrame[] = [];
  private rxDropped = 0;
  private txCount = 0;
  private rxCount = 0;

  constructor(bus: Bus, backend: NetBackend, irq?: IrqLine, mac?: Uint8Array) {
    super(bus, irq, 2, 64); // 队列容量 64（2 的幂，驱动要求）
    this.backend = backend;
    this.mac = mac ? Uint8Array.from(mac.subarray(0, 6)) : defaultMac();
    backend.onFrame((f) => this.injectRx(f));
  }

  protected deviceId(): number {
    return 1; // network device
  }

  protected hostFeatures(): bigint {
    return VIRTIO_F_VERSION_1 | F_MAC;
  }

  protected queueSizeMax(): number {
    return 64;
  }

  /** config：mac[6] @0（packed，无对齐填充；status/max_pairs/mtu 未 offer 不需要） */
  protected readConfig(o: number, _size: MemSize): bigint {
    if (o < 6) return BigInt(this.mac[o]);
    return 0n;
  }

  /**
   * RX 队列的 avail 条目归 injectRx/tryDeliver 专属消费（lastAvail 是它的游标）。
   * 驱动 NOTIFY「挂新缓冲」时只泵一下积压帧，绝不能走基类 processQueue——
   * 否则 RX 的空缓冲条目会被当请求消费掉（lastAvail 被推到 availIdx），
   * 之后 tryDeliver 的「驱动还没挂缓冲」判断永远为真 → RX 永远收不到帧
   * （症状：ifconfig eth0 的 RX packets 恒为 0，帧全卡在 rxPending）。
   */
  protected override processQueue(q: VQueue): void {
    if (this.queues.indexOf(q) === 0) {
      this.tryDrainPending();
      return;
    }
    super.processQueue(q);
  }

  protected handleRequest(q: VQueue, headId: number): void {
    const isRx = this.queues.indexOf(q) === 0;
    if (isRx) {
      // RX 的空缓冲由 tryDeliver（injectRx 路径）按自己的游标消费；
      // 此分支在 processQueue 被 override 后不可达，保留兜底。
      this.tryDrainPending();
      return;
    }
    // TX：链开头 12B 头（未协商 offload，全 0 可忽略），其余字节 = 完整以太帧。
    // 注意驱动 can_push（VERSION_1）时头与帧可能在同一个 desc，不能假设二段式。
    this.txCount++;
    const chain = this.collectChain(q, headId);
    let total = 0;
    for (const c of chain) total += c.len;
    if (total > NET_HDR_SIZE) {
      const frame = new Uint8Array(total - NET_HDR_SIZE);
      let off = 0;
      let skipped = 0;
      for (const c of chain) {
        const start = Math.max(0, NET_HDR_SIZE - skipped);
        const n = Math.min(c.len - start, frame.length - off);
        if (n > 0) frame.set(this.bus.readBytes(c.addr + BigInt(start), n), off);
        off += n;
        skipped += c.len;
        if (off >= frame.length) break;
      }
      if (frame.length > 0) this.backend.send(frame);
    }
    // used.len 对 TX 无意义（驱动只释放 skb），必须回环并最终拉 IRQ——
    // 否则 sq 满停队列后无人唤醒（check_sq_full_and_disable 只认完成中断）
    this.pushUsed(q, headId, 0);
  }

  // ------------------------------------------------------------------
  // RX 注入路径（设备主动面）
  // ------------------------------------------------------------------

  /** 外部注入一帧进 guest（后端 onFrame 回调 / 测试直接调） */
  injectRx(frame: EthFrame): void {
    if (!this.tryDeliver(frame)) {
      if (this.rxPending.length >= RX_PENDING_MAX) {
        this.rxDropped++;
      } else {
        this.rxPending.push(frame);
      }
    }
  }

  /** 尝试立即投递一帧；成功返回 true（无 ready 队列/无缓冲返回 false） */
  private tryDeliver(frame: EthFrame): boolean {
    const q = this.queues[0];
    if (!q || !q.ready) return false;
    const availIdx = this.readAvailIdx(q);
    if (q.lastAvail === availIdx) return false; // 驱动还没挂缓冲

    const slot = q.lastAvail % q.num;
    const headId = this.mem16(q.driver + BigInt(4 + slot * 2));
    const chain = this.collectChain(q, headId);
    if (chain.length === 0) return false;

    // 头 + 帧按序写进描述符链各段（驱动 small buffer 模式是单 desc 12+1522）
    let need = NET_HDR_SIZE + frame.length;
    const zeroHdr = new Uint8Array(NET_HDR_SIZE);
    let written = 0;
    for (const c of chain) {
      if (need <= 0) break;
      const n = Math.min(c.len, need);
      const src = written < NET_HDR_SIZE
        ? (written + n <= NET_HDR_SIZE
            ? zeroHdr.subarray(written)
            : concat(zeroHdr.subarray(written), frame.subarray(0, n - (NET_HDR_SIZE - written))))
        : frame.subarray(written - NET_HDR_SIZE, written - NET_HDR_SIZE + n);
      this.bus.writeBytes(c.addr, src.subarray(0, n));
      written += n;
      need -= n;
    }
    if (need > 0) {
      // 帧太大放不下缓冲链（超过 12+1522）：丢弃不入 used，让驱动回收缓冲
      this.rxDropped++;
      return true;
    }
    this.pushUsed(q, headId, NET_HDR_SIZE + frame.length);
    q.lastAvail = (q.lastAvail + 1) & 0xffff;
    this.rxCount++;
    this.raiseIrq(); // RX 必须 IRQ 驱动（NAPI 由 skb_recv_done 调度）
    return true;
  }

  /** RX 队列有新缓冲（handleRequest 时机）或恢复 ready 时泵内部 FIFO */
  private tryDrainPending(): void {
    let guard = this.rxPending.length;
    while (guard-- > 0 && this.rxPending.length > 0) {
      const f = this.rxPending[0]!;
      if (!this.tryDeliver(f)) break;
      this.rxPending.shift();
    }
  }

  override stats(): { tx: number; rx: number; rxDropped: number; notifications: number } {
    return { tx: this.txCount, rx: this.rxCount, rxDropped: this.rxDropped, notifications: this.notifyStats };
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** 本地管理位（bit1）+ 序列号，QEMU 风格默认 MAC：52:54:00:xx:xx:xx */
function defaultMac(): Uint8Array {
  const mac = new Uint8Array(6);
  mac.set([0x52, 0x54, 0x00, 0x12, 0x34, 0x56]);
  return mac;
}
