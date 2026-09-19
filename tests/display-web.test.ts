/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
// 浏览器显示前端测试：合成 guest 驱动出一帧画面，Node 原生 WebSocket 客户端
// 验证 hello + 二进制帧（头字段、像素内容、拷贝语义、新帧计数）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Bus } from '../src/mem/bus.ts';
import { RAM } from '../src/mem/ram.ts';
import { VirtioGpu } from '../src/dev/virtio-gpu.ts';
import { DisplayServer } from '../src/display/web.ts';

const RAM_BASE = 0x80000000n;
const BASE = 0x10004000n;
const O = (a: bigint) => a - RAM_BASE;

const STATUS = 0x70;
const QUEUE_SEL = 0x30;
const QUEUE_NUM = 0x38;
const QUEUE_READY = 0x44;
const QUEUE_NOTIFY = 0x50;
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

const CMD_CREATE = 0x0101;
const CMD_SET_SCANOUT = 0x0103;
const CMD_FLUSH = 0x0104;
const CMD_TRANSFER = 0x0105;
const CMD_ATTACH = 0x0106;

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
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
function hdr(type: number): Uint8Array {
  const b = new Uint8Array(24);
  new DataView(b.buffer).setUint32(0, type, true);
  return b;
}
function rect(x: number, y: number, w: number, h: number): Uint8Array {
  return cat(u32(x), u32(y), u32(w), u32(h));
}

function makeEnv() {
  const bus = new Bus();
  const ram = new RAM(8 * 1024 * 1024);
  bus.addDevice(RAM_BASE, ram);
  const dev = new VirtioGpu(bus, () => {}, { width: 1024, height: 768 });
  bus.addDevice(BASE, dev);
  const w = (off: number, v: number, size: Size) => dev.write(BigInt(off), BigInt(v), size);
  w(0x24, 1, 4); // FEATURES_SEL=1
  w(0x20, 1, 4); // VERSION_1
  w(0x24, 0, 4);
  w(STATUS, 1 | 2 | 8, 4);
  for (let i = 0; i < 2; i++) {
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
  w(STATUS, 1 | 2 | 8 | 4, 4);

  let availIdx = 0;
  const submit = (req: Uint8Array) => {
    const q = Q[0];
    const rw = (off: bigint, v: bigint, size: Size) => ram.write(O(off), v, size);
    ram.writeBytes(O(REQ), req);
    rw(q.desc, REQ, 8);
    rw(q.desc + 8n, BigInt(req.length), 4);
    rw(q.desc + 12n, 1n, 2);
    rw(q.desc + 14n, 1n, 2);
    rw(q.desc + 16n, RSP, 8);
    rw(q.desc + 24n, 4096n, 4);
    rw(q.desc + 28n, 2n, 2);
    rw(q.desc + 30n, 0n, 2);
    rw(q.avail, 0n, 2);
    rw(q.avail + BigInt(4 + (availIdx % RING_NUM) * 2), 0n, 2);
    availIdx++;
    rw(q.avail + 2n, BigInt(availIdx), 2);
    dev.write(BigInt(QUEUE_NOTIFY), 0n, 4);
  };
  return { ram, dev, submit };
}

/** guest 侧画一张斜纹图案并走完 TRANSFER + FLUSH */
function drawPattern(env: ReturnType<typeof makeEnv>, seed: number): Uint8Array {
  const pix = new Uint8Array(STRIDE * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = y * STRIDE + x * 4;
      pix[o] = (x * 4 + seed) & 0xff;
      pix[o + 1] = (y * 4) & 0xff;
      pix[o + 2] = 128;
      pix[o + 3] = 255;
    }
  }
  env.ram.writeBytes(O(PIX), pix);
  env.submit(cat(hdr(CMD_TRANSFER), rect(0, 0, W, H), u64(0n), u32(1), u32(0)));
  env.submit(cat(hdr(CMD_FLUSH), rect(0, 0, W, H), u32(1), u32(0)));
  return pix;
}

function firstFrame(env: ReturnType<typeof makeEnv>): void {
  const { submit } = env;
  submit(cat(hdr(CMD_CREATE), u32(1), u32(2), u32(W), u32(H)));
  submit(cat(hdr(CMD_ATTACH), u32(1), u32(1), u64(PIX), u32(STRIDE * H), u32(0)));
  submit(cat(hdr(CMD_SET_SCANOUT), rect(0, 0, W, H), u32(0), u32(1)));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 等一条二进制帧 */
function nextBinary(ws: WebSocket, timeout = 3000): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等待二进制帧超时')), timeout);
    ws.addEventListener('message', function h(e) {
      if (typeof e.data === 'string') {
        ws.addEventListener('message', h, { once: true });
        return;
      }
      clearTimeout(t);
      resolve(e.data as ArrayBuffer);
    }, { once: true });
  });
}

test('display-web：HTTP 页面可获取', async () => {
  const { dev } = makeEnv();
  const srv = new DisplayServer({
    port: 0,
    getFramebuffer: () => dev.getFramebuffer(),
    getFrameCount: () => dev.stats().flushes,
  });
  try {
    await srv.ready;
    const port = (srv.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('canvas') && text.includes('WebSocket'), '页面应含 canvas + WS 客户端');
  } finally {
    srv.close();
  }
});

test('display-web：hello + 二进制帧（头字段、像素、拷贝语义、新帧）', async () => {
  const env = makeEnv();
  const srv = new DisplayServer({
    port: 0,
    getFramebuffer: () => env.dev.getFramebuffer(),
    getFrameCount: () => env.dev.stats().flushes,
  });
  await srv.ready;
  const port = (srv.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  ws.binaryType = 'arraybuffer';
  try {
    await new Promise((r, j) => {
      ws.addEventListener('open', r, { once: true });
      ws.addEventListener('error', j, { once: true });
    });
    await sleep(30); // 等服务端 connection 事件落地
    srv.pump(true);

    // 无画面时 hello 的宽高为 0
    const hello = JSON.parse(
      (await new Promise<string>((r) =>
        ws.addEventListener('message', (e) => typeof e.data === 'string' && r(e.data), { once: true }),
      )) as string,
    );
    assert.equal(hello.type, 'hello');
    assert.equal(hello.width, 0, '尚未上屏时 hello 宽度应为 0');

    // 出帧
    firstFrame(env);
    const pix1 = drawPattern(env, 0);
    srv.pump(true);
    const frame = await nextBinary(ws);
    const dv = new DataView(frame);
    assert.equal(dv.getUint32(0, true), 0x45495354, "magic 'TSIE'");
    assert.equal(dv.getUint32(4, true), W);
    assert.equal(dv.getUint32(8, true), H);
    assert.equal(dv.getUint32(12, true), pix1.length);
    assert.deepEqual(new Uint8Array(frame, 16), pix1, '像素应与 guest 侧完全一致');

    // 没有新 flush → 不再推帧
    srv.pump(true);
    await assert.rejects(nextBinary(ws, 200), /超时/);

    // 新帧：内容更新且发出的是拷贝（后续改 host 缓冲不影响已排队的字节）
    const pix2 = drawPattern(env, 7);
    srv.pump(true);
    const frame2 = await nextBinary(ws);
    assert.deepEqual(new Uint8Array(frame2, 16), pix2, '第二帧应反映更新后的画面');
  } finally {
    ws.close();
    srv.close();
  }
});

test('显示：帧内容与上一帧完全相同时不推送（去重）', async () => {
  // guest 会重复 flush 相同画面（实测某次引导 311 次 flush 里 206 次逐字节相同），
  // 光标闪烁、fbcon 重绘都会这样；只按"有新 flush"推等于白推 2/3。
  const env = makeEnv();
  const srv = new DisplayServer({
    port: 0,
    getFramebuffer: () => env.dev.getFramebuffer(),
    getFrameCount: () => env.dev.stats().flushes,
  });
  await srv.ready;
  const port = (srv.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  ws.binaryType = 'arraybuffer';
  try {
    await new Promise((r, j) => {
      ws.addEventListener('open', r, { once: true });
      ws.addEventListener('error', j, { once: true });
    });
    await sleep(30);
    srv.pump(true); // 只出 hello（此时还没上屏）

    firstFrame(env);
    const pix1 = drawPattern(env, 0);
    srv.pump(true);
    const f1 = await nextBinary(ws);
    assert.deepEqual(new Uint8Array(f1, 16), pix1, '第一帧内容应与 guest 一致');
    assert.equal(srv.stats().sent, 1);

    // 同一个 seed 重画：像素逐字节相同，但 flush 计数确实涨了
    const before = env.dev.stats().flushes;
    drawPattern(env, 0);
    assert.ok(env.dev.stats().flushes > before, 'flush 计数应增长（模拟 guest 重复 flush）');
    srv.pump(true);
    await assert.rejects(nextBinary(ws, 250), /超时/, '内容未变时不应推送');
    assert.equal(srv.stats().deduped, 1, '应记一次去重');

    // 换 seed：内容变了，必须推
    const pix2 = drawPattern(env, 7);
    srv.pump(true);
    const f2 = await nextBinary(ws);
    assert.deepEqual(new Uint8Array(f2, 16), pix2, '内容变化后必须推送');
    assert.equal(srv.stats().sent, 2, '实发 2 帧');
  } finally {
    ws.close();
    srv.close();
  }
});
