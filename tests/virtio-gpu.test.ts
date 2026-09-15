/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
// virtio-gpu 设备层测试：用合成 guest 驱动（按 Linux virtio_gpu 的初始化与 2D 提交顺序）
// 直驱 MMIO 寄存器 + virtqueue，验证设备识别 / 双队列 / 命令往返 / 像素搬运。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../src/mem/bus.ts';
import { RAM } from '../src/mem/ram.ts';
import { VirtioGpu, type GpuFramebuffer } from '../src/dev/virtio-gpu.ts';
import { Machine, VIRT_VIRTIO_GPU } from '../src/machine.ts';

const RAM_BASE = 0x80000000n;
const BASE = 0x10004000n;
const O = (a: bigint) => a - RAM_BASE;

const FEATURES = 0x20;
const FEATURES_SEL = 0x24;
const QUEUE_SEL = 0x30;
const QUEUE_NUM = 0x38;
const QUEUE_READY = 0x44;
const QUEUE_NOTIFY = 0x50;
const STATUS = 0x70;

const RING_NUM = 8;
const Q = [
  { desc: 0x80010000n, avail: 0x80011000n, used: 0x80012000n },
  { desc: 0x80013000n, avail: 0x80014000n, used: 0x80015000n },
];
const REQ = 0x80020000n;
const RSP = 0x80021000n;
const PIX = 0x80040000n;

const W = 64;
const H = 32;
const STRIDE = W * 4;

const CMD_GET_DISPLAY_INFO = 0x0100;
const CMD_RESOURCE_CREATE_2D = 0x0101;
const CMD_RESOURCE_UNREF = 0x0102;
const CMD_SET_SCANOUT = 0x0103;
const CMD_RESOURCE_FLUSH = 0x0104;
const CMD_TRANSFER_TO_HOST_2D = 0x0105;
const CMD_RESOURCE_ATTACH_BACKING = 0x0106;
const CMD_RESOURCE_DETACH_BACKING = 0x0107;
const CMD_MOVE_CURSOR = 0x0301;

const RESP_OK_NODATA = 0x1100;
const RESP_OK_DISPLAY_INFO = 0x1101;
const RESP_ERR_UNSPEC = 0x1200;
const RESP_ERR_INVALID_RESOURCE_ID = 0x1203;

const FLAG_FENCE = 1;

type Size = 1 | 2 | 4 | 8;

function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, true);
  return b;
}
function u64(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}
function cat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
/** 控制头（24B）；fenceId 非 0 时驱动会等设备回显 */
function hdr(type: number, fenceId = 0n): Uint8Array {
  const b = new Uint8Array(24);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, type, true);
  dv.setUint32(4, fenceId === 0n ? 0 : FLAG_FENCE, true);
  dv.setBigUint64(8, fenceId, true);
  return b;
}
/** struct virtio_gpu_rect */
function rect(x: number, y: number, w: number, h: number): Uint8Array {
  return cat(u32(x), u32(y), u32(w), u32(h));
}

function makeEnv(onFlush?: (fb: GpuFramebuffer) => void) {
  const bus = new Bus();
  const ram = new RAM(8 * 1024 * 1024);
  bus.addDevice(RAM_BASE, ram);
  let irqs = 0;
  const dev = new VirtioGpu(bus, () => {
    irqs++;
  }, { width: 1024, height: 768, onFlush });
  bus.addDevice(BASE, dev);
  return { bus, ram, dev, irqs: () => irqs };
}

/** 按 Linux virtio_gpu 的顺序做特性协商 + 建两个队列 */
function initDriver(dev: VirtioGpu) {
  const w = (off: number, v: number, size: Size) => dev.write(BigInt(off), BigInt(v), size);
  w(FEATURES_SEL, 1, 4); // 高 32 位
  w(FEATURES, 1, 4); // VIRTIO_F_VERSION_1
  w(FEATURES_SEL, 0, 4);
  w(STATUS, 1 | 2 | 8, 4); // ACK | DRIVER | FEATURES_OK
  for (let i = 0; i < Q.length; i++) {
    w(QUEUE_SEL, i, 4);
    w(QUEUE_NUM, RING_NUM, 4);
    w(0x80, Number(Q[i].desc & 0xffffffffn), 4);
    w(0x84, Number(Q[i].desc >> 32n), 4);
    w(0x90, Number(Q[i].avail & 0xffffffffn), 4);
    w(0x94, Number(Q[i].avail >> 32n), 4);
    w(0xa0, Number(Q[i].used & 0xffffffffn), 4);
    w(0xa4, Number(Q[i].used >> 32n), 4);
    w(QUEUE_READY, 1, 4);
  }
  w(STATUS, 1 | 2 | 8 | 4, 4); // DRIVER_OK
}

/** 逐请求铺描述符链 + avail 环并 notify，返回设备写回的响应 */
function makeDriver(dev: VirtioGpu, ram: RAM) {
  const availIdx = [0, 0];
  return {
    submit(queue: number, req: Uint8Array, rspCap = 4096): Uint8Array {
      const q = Q[queue];
      const rw = (off: bigint, v: bigint, size: Size) => ram.write(O(off), v, size);
      ram.writeBytes(O(REQ), req);
      // desc[0]：请求（设备只读）+ NEXT
      rw(q.desc, REQ, 8);
      rw(q.desc + 8n, BigInt(req.length), 4);
      rw(q.desc + 12n, 1n, 2);
      rw(q.desc + 14n, 1n, 2);
      // desc[1]：响应缓冲（设备可写）
      rw(q.desc + 16n, RSP, 8);
      rw(q.desc + 24n, BigInt(rspCap), 4);
      rw(q.desc + 28n, 2n, 2);
      rw(q.desc + 30n, 0n, 2);
      // avail 环
      rw(q.avail, 0n, 2);
      const slot = availIdx[queue] % RING_NUM;
      rw(q.avail + BigInt(4 + slot * 2), 0n, 2); // head = desc 0
      availIdx[queue]++;
      rw(q.avail + 2n, BigInt(availIdx[queue]), 2);

      dev.write(BigInt(QUEUE_NOTIFY), BigInt(queue), 4);

      const usedIdx = Number(ram.read(O(q.used) + 2n, 2));
      assert.equal(usedIdx, availIdx[queue], 'used.idx 应跟上 avail.idx（设备必须 pushUsed）');
      const last = (usedIdx - 1) % RING_NUM;
      assert.equal(Number(ram.read(O(q.used) + BigInt(4 + last * 8), 4)), 0, 'used.id = head 描述符下标');
      const len = Number(ram.read(O(q.used) + BigInt(4 + last * 8 + 4), 4));
      return ram.data.slice(Number(O(RSP)), Number(O(RSP)) + len);
    },
  };
}

const dispType = (resp: Uint8Array) => new DataView(resp.buffer, resp.byteOffset, resp.byteLength).getUint32(0, true);
const d32 = (resp: Uint8Array, off: number) =>
  new DataView(resp.buffer, resp.byteOffset, resp.byteLength).getUint32(off, true);
const d64 = (resp: Uint8Array, off: number) =>
  new DataView(resp.buffer, resp.byteOffset, resp.byteLength).getBigUint64(off, true);

test('virtio-gpu：设备识别与 config 空间', () => {
  const { dev } = makeEnv();
  assert.equal(Number(dev.read(0x00n, 4)), 0x74726976, "magic 应为 'virt'");
  assert.equal(Number(dev.read(0x04n, 4)), 2, 'MMIO 版本 = 2');
  assert.equal(Number(dev.read(0x08n, 4)), 16, 'DeviceID = 16（GPU）');
  assert.equal(Number(dev.read(0x34n, 4)), 256, 'QueueNumMax = 256');
  assert.equal(Number(dev.read(0x104n, 4)), 0, 'events_read = 0');
  assert.equal(Number(dev.read(0x108n, 4)), 1, 'num_scanouts = 1（为 0 时 Linux 驱动会直接失败）');
  assert.equal(Number(dev.read(0x10cn, 4)), 0, 'num_capsets = 0（无 3D）');
  // 只宣告 VERSION_1：不暴露 VIRGL/EDID/blob，避免驱动走未实现路径
  assert.equal(Number(dev.read(0x10n, 4)), 0, '低 32 位特性位应为 0');
  dev.write(0x14n, 1n, 4);
  assert.equal(Number(dev.read(0x10n, 4)), 1, '高 32 位应含 VIRTIO_F_VERSION_1');
});

test('virtio-mmio：SHM 寄存器必须读回全 1（约定 -1 = 无共享内存区）', () => {
  // 回归：Linux vm_get_shm_region() 只在 len == ~0ULL 时判定「没有该区域」。
  // 若这些寄存器读回 0，virtio_gpu 会认为存在一个长度 0、地址 0 的 host visible 区域，
  // 进而 devm_request_mem_region(0,0) 失败 → probe 报 "Could not reserve host visible
  // region" 并以 -EBUSY 退出（2026-09-16 实机复现）。
  const { dev } = makeEnv();
  assert.equal(Number(dev.read(0xb0n, 4)), 0xffffffff, 'SHM_LEN_LOW');
  assert.equal(Number(dev.read(0xb4n, 4)), 0xffffffff, 'SHM_LEN_HIGH');
  assert.equal(Number(dev.read(0xb8n, 4)), 0xffffffff, 'SHM_BASE_LOW');
  assert.equal(Number(dev.read(0xbcn, 4)), 0xffffffff, 'SHM_BASE_HIGH');
  assert.equal(Number(dev.read(0xacn, 4)), 0, 'SHM_SEL 是写寄存器，读回 0');
});

test('virtio-gpu：GET_DISPLAY_INFO 报出可用扫描输出并回显 fence', () => {
  const { dev, ram, irqs } = makeEnv();
  initDriver(dev);
  const drv = makeDriver(dev, ram);

  const resp = drv.submit(0, hdr(CMD_GET_DISPLAY_INFO, 0x1234n), 512);
  assert.equal(dispType(resp), RESP_OK_DISPLAY_INFO);
  assert.equal(resp.length, 24 + 16 * 24, 'display_info 响应 = 头 + 16 个 pmodes');
  assert.equal(d32(resp, 4) & FLAG_FENCE, FLAG_FENCE, '响应必须回显 FENCE 位（否则驱动的 fence 等待者不完成）');
  assert.equal(d64(resp, 8), 0x1234n, 'fence_id 必须原样回显');
  // pmodes[0]
  assert.equal(d32(resp, 24 + 8), 1024, 'pmodes[0].width');
  assert.equal(d32(resp, 24 + 12), 768, 'pmodes[0].height');
  assert.equal(d32(resp, 24 + 16), 1, 'pmodes[0].enabled 必须为 1，否则驱动不建 connector');
  // pmodes[1] 必须关掉
  assert.equal(d32(resp, 24 + 24 + 16), 0, 'pmodes[1].enabled = 0');
  assert.ok(irqs() > 0, '必须产生中断');
});

test('virtio-gpu：2D 全流程（建资源→挂散射表→上屏→搬运→刷新）', () => {
  const seen: GpuFramebuffer[] = [];
  const { dev, ram } = makeEnv((fb) => seen.push(fb));
  dev.cmdTrace = true; // 顺便验证协议追踪能记录到关键命令
  initDriver(dev);
  const drv = makeDriver(dev, ram);

  // 1) 建 64x32 的 32bpp 资源
  const create = cat(hdr(CMD_RESOURCE_CREATE_2D), u32(1), u32(2), u32(W), u32(H));
  assert.equal(dispType(drv.submit(0, create)), RESP_OK_NODATA, 'CREATE_2D 应成功');

  // 2) 挂散射表：故意拆成两段，验证按逻辑偏移拼接
  //    struct virtio_gpu_mem_entry = addr(8) + length(4) + padding(4)
  const half = STRIDE * (H / 2);
  const attach = cat(
    hdr(CMD_RESOURCE_ATTACH_BACKING),
    u32(1),
    u32(2),
    u64(PIX),
    u32(half),
    u32(0),
    u64(PIX + BigInt(half)),
    u32(half),
    u32(0),
  );
  assert.equal(dispType(drv.submit(0, attach)), RESP_OK_NODATA, 'ATTACH_BACKING 两段应成功');

  // 3) 上屏
  const scanout = cat(hdr(CMD_SET_SCANOUT), rect(0, 0, W, H), u32(0), u32(1));
  assert.equal(dispType(drv.submit(0, scanout)), RESP_OK_NODATA, 'SET_SCANOUT 应成功');

  // 4) guest 侧把图案写进像素 buffer：每像素 (x*4, y*4, 128, 255)
  const pix = new Uint8Array(STRIDE * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = y * STRIDE + x * 4;
      pix[o] = (x * 4) & 0xff;
      pix[o + 1] = (y * 4) & 0xff;
      pix[o + 2] = 128;
      pix[o + 3] = 255;
    }
  }
  ram.writeBytes(O(PIX), pix);

  // 5) TRANSFER_TO_HOST_2D：设备按 GPA 直读 guest 内存
  const xfer = cat(hdr(CMD_TRANSFER_TO_HOST_2D), rect(0, 0, W, H), u64(0n), u32(1), u32(0));
  assert.equal(dispType(drv.submit(0, xfer)), RESP_OK_NODATA, 'TRANSFER_TO_HOST_2D 应成功');

  // 6) FLUSH → 触发回调，画面内容应已同步
  const flush = cat(hdr(CMD_RESOURCE_FLUSH), rect(0, 0, W, H), u32(1), u32(0));
  assert.equal(dispType(drv.submit(0, flush)), RESP_OK_NODATA);
  assert.equal(seen.length, 1, 'RESOURCE_FLUSH 应触发一次 onFlush');
  assert.equal(seen[0].width, W);
  assert.equal(seen[0].height, H);
  assert.deepEqual(Array.from(seen[0].data), Array.from(pix), 'host 侧副本应与 guest 像素完全一致');

  const fb = dev.getFramebuffer();
  assert.ok(fb, '绑定扫描输出后应能取到画面');
  assert.equal(fb.width, W);
  assert.equal(fb.height, H);
  assert.deepEqual(Array.from(fb.data.subarray(0, 16)), [0, 0, 128, 255, 4, 0, 128, 255, 8, 0, 128, 255, 12, 0, 128, 255]);

  // 7) UNREF 之后不再有画面
  assert.equal(dispType(drv.submit(0, cat(hdr(CMD_RESOURCE_UNREF), u32(1), u32(0)))), RESP_OK_NODATA);
  assert.equal(dev.getFramebuffer(), undefined, '资源释放后扫描输出应解绑');

  // cmdTrace 应完整记录本轮的协议交互（含关键参数）
  const t = dev.cmdTraceLog.join('\n');
  assert.ok(t.includes('RESOURCE_CREATE_2D'), '追踪应含建资源');
  assert.ok(t.includes('fmt=2 64x32'), '追踪应含格式与尺寸');
  assert.ok(t.includes('ATTACH_BACKING') && t.includes('nr=2'), '追踪应含散射表条目数');
  assert.ok(t.includes('SET_SCANOUT') && t.includes('res=1'), '追踪应含上屏');
  assert.ok(t.includes('TRANSFER_TO_HOST_2D'), '追踪应含搬运');
  assert.ok(t.includes('RESOURCE_FLUSH'), '追踪应含刷新');
  assert.ok(t.includes('RESOURCE_UNREF'), '追踪应含释放');
});

test('virtio-gpu：错误路径与光标队列', () => {
  const { dev, ram } = makeEnv();
  initDriver(dev);
  const drv = makeDriver(dev, ram);

  // 未建过的 resource → INVALID_RESOURCE_ID
  const bad = cat(hdr(CMD_RESOURCE_FLUSH), rect(0, 0, W, H), u32(99), u32(0));
  assert.equal(dispType(drv.submit(0, bad)), RESP_ERR_INVALID_RESOURCE_ID);
  // 非法参数：格式不支持（8bpp 之类）→ INVALID_PARAMETER
  const badFmt = cat(hdr(CMD_RESOURCE_CREATE_2D), u32(2), u32(200), u32(4), u32(4));
  assert.equal(dispType(drv.submit(0, badFmt)), 0x1205, '不支持的像素格式应报 INVALID_PARAMETER');
  // 未知命令 → UNSPEC
  assert.equal(dispType(drv.submit(0, hdr(0x9999))), RESP_ERR_UNSPEC);
  // 未挂载散射表就搬运 → INVALID_PARAMETER
  drv.submit(0, cat(hdr(CMD_RESOURCE_CREATE_2D), u32(3), u32(2), u32(W), u32(H)));
  const noBacking = cat(hdr(CMD_TRANSFER_TO_HOST_2D), rect(0, 0, W, H), u64(0n), u32(3), u32(0));
  assert.equal(dispType(drv.submit(0, noBacking)), 0x1205);
  // 解绑
  const detach = cat(hdr(CMD_RESOURCE_DETACH_BACKING), u32(3), u32(0));
  assert.equal(dispType(drv.submit(0, detach)), RESP_OK_NODATA);

  // 光标队列（queue 1）：应答但不绘制
  const move = cat(hdr(CMD_MOVE_CURSOR), u32(0), u32(10), u32(20), u32(0), u32(0), u32(0));
  assert.equal(dispType(drv.submit(1, move)), RESP_OK_NODATA, 'cursorq 必须应答，否则驱动会卡住');
});

test('virtio-gpu：挂载到 virt 机器后 DTB 出现 GPU 节点', () => {
  const dtbText = (m: Machine) => new TextDecoder('latin1').decode(m.generateDtb('console=ttyS0'));

  assert.equal(VIRT_VIRTIO_GPU, 0x10004000n, 'GPU 的 MMIO 基址');
  const withGpu = new Machine({ memSize: 128n * 1024n * 1024n, gpu: { width: 800, height: 600 } });
  assert.ok(withGpu.gpu, 'gpu 设备应已挂载到总线');
  const nodeName = 'virtio_mmio@' + VIRT_VIRTIO_GPU.toString(16);
  const text = dtbText(withGpu);
  assert.ok(text.includes(nodeName), 'DTB 应含 GPU 的 virtio_mmio 节点');
  assert.ok(text.includes('virtio,mmio'), 'GPU 节点应为 virtio,mmio 兼容');

  // 不启用时节点不该出现（否则 guest 会去找一个不存在的设备）
  const plain = new Machine({ memSize: 128n * 1024n * 1024n });
  assert.equal(plain.gpu, undefined);
  assert.ok(!dtbText(plain).includes('10004000'), '未启用 GPU 时 DTB 不应含该节点');
});
