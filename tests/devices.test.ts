import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Uart } from '../src/dev/uart.ts';
import { Clint } from '../src/dev/clint.ts';
import { Plic } from '../src/dev/plic.ts';
import { VirtioBlk } from '../src/dev/virtio-blk.ts';
import { MemoryDisk, SECTOR_SIZE } from '../src/dev/disk.ts';
import { Bus } from '../src/mem/bus.ts';
import { RAM } from '../src/mem/ram.ts';

const BASE = 0x10000000n;

test('UART：轮询发送与状态寄存器', () => {
  const out: number[] = [];
  const uart = new Uart({ onTx: (b) => out.push(b) });
  // LSR 默认：THRE + TEMT 置位
  assert.equal(Number(uart.read(5n, 1)) & 0x60, 0x60);
  uart.write(0n, 0x48n, 1); // 'H'
  uart.write(0n, 0x69n, 1); // 'i'
  assert.deepEqual(out, [0x48, 0x69]);
  // 无接收数据
  assert.equal(Number(uart.read(5n, 1)) & 0x01, 0);
  assert.equal(uart.read(0n, 1), 0n);
});

test('UART：接收 FIFO 与中断', () => {
  let irqLevel = false;
  const uart = new Uart({ onTx: () => undefined, irq: (l) => (irqLevel = l) });
  uart.write(1n, 0x01n, 1); // IER：接收中断使能
  assert.equal(irqLevel, false);
  uart.pushString('ab');
  assert.equal(irqLevel, true);
  assert.equal(Number(uart.read(5n, 1)) & 0x01, 0x01, 'LSR.DR 应置位');
  assert.equal(uart.read(0n, 1), 0x61n); // 'a'
  assert.equal(uart.read(0n, 1), 0x62n);
  assert.equal(Number(uart.read(5n, 1)) & 0x01, 0, '读空后 DR 应清除');
  assert.equal(Number(uart.read(2n, 1)) & 0x01, 0x01, 'IIR 不再指示接收中断');
});

test('UART：DLL/DLM 分频寄存器（DLAB）与回环', () => {
  const uart = new Uart({ onTx: () => undefined });
  uart.write(3n, 0x80n, 1); // LCR.DLAB = 1
  uart.write(0n, 0x34n, 1); // DLL
  uart.write(1n, 0x12n, 1); // DLM
  uart.write(3n, 0x03n, 1); // 恢复
  uart.write(3n, 0x83n, 1);
  assert.equal(uart.read(0n, 1), 0x34n);
  assert.equal(uart.read(1n, 1), 0x12n);
  // 回环模式：MCR.LOOP
  uart.write(3n, 0x03n, 1);
  uart.write(4n, 0x13n, 1); // MCR = LOOP | RTS | DTR
  const msr = Number(uart.read(6n, 1));
  assert.notEqual(msr & 0x30, 0, '回环时 CTS/DSR 应反映 RTS/DTR');
});

test('CLINT：mtime / mtimecmp / msip', () => {
  const clint = new Clint();
  assert.equal(clint.timerPending, false);
  clint.write(0x4000n, 100n, 8); // mtimecmp
  assert.equal(clint.mtimecmp, 100n);
  clint.write(0xbff8n, 99n, 8); // mtime
  assert.equal(clint.mtime, 99n);
  assert.equal(clint.timerPending, false);
  clint.write(0xbff8n, 100n, 8);
  assert.equal(clint.timerPending, true);
  assert.equal(clint.read(0xbff8n, 8), 100n);
  // msip
  clint.write(0n, 1n, 4);
  assert.equal(clint.softwarePending, true);
  clint.write(0n, 0n, 4);
  assert.equal(clint.softwarePending, false);
});

test('CLINT：部分写入（字节/半字）正确合并', () => {
  const clint = new Clint();
  clint.write(0x4000n, 0n, 8); // 先清零
  clint.write(0x4000n, 0x34n, 1); // 低字节
  clint.write(0x4002n, 0x12n, 2); // 高半字
  assert.equal(clint.read(0x4000n, 4), 0x00120034n);
});

test('PLIC：优先级、使能、claim/complete', () => {
  const plic = new Plic(32, 2);
  const events: Array<[number, boolean]> = [];
  plic.bindContext(1, (l) => events.push([1, l]));
  plic.bindContext(0, (l) => events.push([0, l]));

  plic.write(0x0004n, 5n, 4); // 中断源 1 的优先级 = 5
  plic.write(0x200004n, 0n, 4); // 上下文 0 阈值 = 0
  plic.write(0x201004n, 2n, 4); // 上下文 1（S 模式）阈值 = 2

  plic.setIrq(1, true);
  assert.equal(events.length, 0, '未使能前不应触发');

  // 使能上下文 0 的中断源 1（enable 寄存器基址 0x2000 + ctx*0x80）
  plic.write(0x2000n, 0x2n, 4);
  assert.equal(events.at(-1)?.[0], 0, '上下文 0 应先被通知');

  assert.equal(plic.read(0x200000n, 4), 1n, 'claim 应返回中断号 1');
  assert.equal(plic.read(0x200000n, 4), 0n, 'claim 后不再挂起');
  plic.write(0x200000n, 1n, 4); // complete

  // 上下文 1：阈值 2 < 优先级 5，应能 claim
  plic.write(0x2080n, 0x2n, 4); // 使能上下文 1 的源 1
  plic.setIrq(1, true);
  assert.equal(plic.read(0x201000n, 4), 1n);
});

test('PLIC：低于阈值的中断不投递', () => {
  const plic = new Plic(32, 2);
  plic.write(0x0004n, 1n, 4); // 源 1 优先级 = 1
  plic.write(0x201004n, 7n, 4); // 上下文 1 阈值 = 7
  plic.write(0x2080n, 0x2n, 4); // 使能上下文 1 的源 1
  plic.setIrq(1, true);
  assert.equal(plic.read(0x201000n, 4), 0n, '优先级 1 <= 阈值 7，不应投递');
});

// ----------------------------------------------------------------------
// VirtIO 块设备
// ----------------------------------------------------------------------

function makeVirtio(sectorCount = 8) {
  const bus = new Bus();
  const ram = new RAM(4 * 1024 * 1024);
  bus.addDevice(0x80000000n, ram);
  const disk = MemoryDisk.zero(sectorCount);
  // 写入一些测试数据
  const pattern = Buffer.alloc(SECTOR_SIZE * 2);
  for (let i = 0; i < pattern.length; i++) pattern[i] = i & 0xff;
  disk.writeSectors(0n, new Uint8Array(pattern));
  let irqCount = 0;
  const dev = new VirtioBlk(bus, disk, () => irqCount++);
  bus.addDevice(BASE, dev);
  return { bus, ram, dev, disk, irqs: () => irqCount };
}

/** 建立描述符链：header → data → status */
function buildRequest(
  ram: RAM,
  layout: { desc: bigint; hdr: bigint; data: bigint; status: bigint },
  type: number,
  sector: bigint,
  dataLen: number,
  dataWritable = true,
) {
  const O = (a: bigint) => a - 0x80000000n;
  const D = O(layout.desc);
  // 请求头：type(4) + reserved(4) + sector(8)
  ram.write(O(layout.hdr), BigInt(type), 4);
  ram.write(O(layout.hdr) + 4n, 0n, 4);
  ram.write(O(layout.hdr) + 8n, sector, 8);
  // desc[0]：请求头（只读，NEXT → 1）
  ram.write(D, layout.hdr, 8);
  ram.write(D + 8n, 16n, 4);
  ram.write(D + 12n, (1n << 16n) | 1n, 4); // next=1, flags=NEXT
  // desc[1]：数据（读请求时设备写入，写请求时设备读取）
  ram.write(D + 16n, layout.data, 8);
  ram.write(D + 24n, BigInt(dataLen), 4);
  ram.write(D + 28n, (2n << 16n) | BigInt(dataWritable ? 3 : 1), 4);
  // desc[2]：状态（可写，1 字节）
  ram.write(D + 32n, layout.status, 8);
  ram.write(D + 40n, 1n, 4);
  ram.write(D + 44n, 2n, 4); // flags=WRITE
}

function setupQueue(_ram: RAM, dev: VirtioBlk, layout: { desc: bigint; avail: bigint; used: bigint }, num = 8) {
  dev.write(0x30n, 0n, 4); // QueueSel = 0
  dev.write(0x38n, BigInt(num), 4); // QueueNum
  dev.write(0x80n, layout.desc & 0xffffffffn, 4); // QueueDescLow
  dev.write(0x84n, layout.desc >> 32n, 4);
  dev.write(0x90n, layout.avail & 0xffffffffn, 4);
  dev.write(0x94n, layout.avail >> 32n, 4);
  dev.write(0xa0n, layout.used & 0xffffffffn, 4);
  dev.write(0xa4n, layout.used >> 32n, 4);
  dev.write(0x44n, 1n, 4); // QueueReady = 1
  dev.write(0x70n, 0x4n, 4); // Status = DRIVER_OK（简化）
}

test('VirtIO：设备识别与配置空间', () => {
  const { dev, ram } = makeVirtio();
  assert.equal(ram.size, BigInt(4 * 1024 * 1024), 'RAM 应已挂载');
  assert.equal(Number(dev.read(0x00n, 4)), 0x74726976, "magic 应为 'virt'");
  assert.equal(Number(dev.read(0x04n, 4)), 2, 'MMIO 版本');
  assert.equal(Number(dev.read(0x08n, 4)), 2, 'DeviceID = block');
  assert.equal(Number(dev.read(0x10n, 4)) & 0x2, 0x2, '应支持 SIZE_MAX 特性');
  // modern 设备必须把 VERSION_1 暴露在高 32 位特性页上
  dev.write(0x14n, 1n, 4); // DeviceFeaturesSel = 1（高 32 位）
  assert.equal(Number(dev.read(0x10n, 4)) & 0x1, 0x1, '高 32 位应置 VIRTIO_F_VERSION_1');
  dev.write(0x14n, 0n, 4); // 复位回低页
  assert.equal(Number(dev.read(0x34n, 4)), 256, 'QueueNumMax');
  assert.equal(dev.read(0x100n, 8), 8n, 'capacity = 8 个扇区');
  assert.equal(Number(dev.read(0x114n, 4)), 512, 'blk_size = 512');
});

test('VirtIO：读请求（VIRTIO_BLK_T_IN）', () => {
  const { ram, dev, irqs } = makeVirtio();
  const DESC = 0x80010000n;
  const AVAIL = 0x80011000n;
  const USED = 0x80012000n;
  const DATA = 0x80020000n;
  const STATUS = 0x80030000n;
  const HDR = 0x80040000n;

  setupQueue(ram, dev, { desc: DESC, avail: AVAIL, used: USED });
  buildRequest(ram, { desc: DESC, hdr: HDR, data: DATA, status: STATUS }, 0 /* IN */, 2n, 1024);

  // avail 环：flags=0, idx=1, ring[0]=0
  const O = (a: bigint) => a - 0x80000000n;
  ram.write(O(AVAIL), 0n, 2);
  ram.write(O(AVAIL) + 2n, 1n, 2);
  ram.write(O(AVAIL) + 4n, 0n, 2);

  dev.write(0x50n, 0n, 4); // QueueNotify

  // 状态字节应为 OK
  assert.equal(ram.read(O(STATUS), 1), 0n, '请求状态应为 BLK_S_OK');
  // used 环 idx 应为 1，ring[0].id = 0
  assert.equal(ram.read(O(USED) + 2n, 2), 1n);
  assert.equal(ram.read(O(USED) + 4n, 4), 0n, 'used ring[0].id');
  assert.equal(ram.read(O(USED) + 4n + 4n, 4), 0n, 'used ring[0].len');
  // 数据应从扇区 2 读取（我们的镜像扇区 2 开始是 0）
  assert.equal(ram.read(O(DATA), 4) & 0xffffffffn, 0n);
  assert.ok(irqs() > 0, '应产生中断');
});

test('VirtIO：写请求（VIRTIO_BLK_T_OUT）后再读回', () => {
  const { ram, dev, disk } = makeVirtio();
  const DESC = 0x80010000n;
  const AVAIL = 0x80011000n;
  const USED = 0x80012000n;
  const DATA = 0x80020000n;
  const STATUS = 0x80030000n;
  const O = (a: bigint) => a - 0x80000000n;

  const HDR = 0x80040000n;
  setupQueue(ram, dev, { desc: DESC, avail: AVAIL, used: USED });
  for (let i = 0; i < 64; i++) ram.write(O(DATA) + BigInt(i), BigInt(0xa0 | (i & 0xf)), 1);
  buildRequest(ram, { desc: DESC, hdr: HDR, data: DATA, status: STATUS }, 1 /* OUT */, 4n, 64, false);

  ram.write(O(AVAIL), 0n, 2);
  ram.write(O(AVAIL) + 2n, 1n, 2);
  ram.write(O(AVAIL) + 4n, 0n, 2);
  dev.write(0x50n, 0n, 4);

  assert.equal(ram.read(O(STATUS), 1), 0n);
  const back = disk.readSectors(4n, 1);
  assert.equal(back[0], 0xa0, '镜像中应能看到写入的数据');
  assert.equal(back[5], 0xa5);
});

test('VirtIO：不支持的请求返回 UNSUPP', () => {
  const { ram, dev } = makeVirtio();
  const DESC = 0x80010000n;
  const AVAIL = 0x80011000n;
  const USED = 0x80012000n;
  const DATA = 0x80020000n;
  const STATUS = 0x80030000n;
  const O = (a: bigint) => a - 0x80000000n;

  const HDR = 0x80040000n;
  setupQueue(ram, dev, { desc: DESC, avail: AVAIL, used: USED });
  buildRequest(ram, { desc: DESC, hdr: HDR, data: DATA, status: STATUS }, 99 /* 未知类型 */, 0n, 8);
  ram.write(O(AVAIL), 0n, 2);
  ram.write(O(AVAIL) + 2n, 1n, 2);
  ram.write(O(AVAIL) + 4n, 0n, 2);
  dev.write(0x50n, 0n, 4);
  assert.equal(ram.read(O(STATUS), 1), 2n, '状态应为 BLK_S_UNSUPP');
});

// ----------------------------------------------------------------------
// PLIC 电平敏感语义 + 16550 中断式发送
// 回归：内核跑到 Run /init 后，用户态 write() 全部成功但串口零输出。
// ----------------------------------------------------------------------

/**
 * 模拟 Linux serial8250 驱动的中断式发送流程：
 *   __uart_start → 打开 IER.THRI
 *   ISR          → claim → 读 IIR → 写一个字节到 THR
 *   缓冲空       → serial8250_stop_tx 关掉 THRI
 *   ISR 结束     → complete
 * 16550 的 THRE 在发送期间**始终为高**、不会自行下降，因此 complete 之后
 * 必须能重新挂起，否则剩下的数据会永久卡在驱动的 xmit 缓冲里。
 */
function drive8250Tx(plic: Plic, uart: Uart, data: number[], irq: number, maxRounds = 500) {
  const out: number[] = [];
  const queued = [...data];
  let ier = 0;
  let sLevel = false;
  plic.bindContext(1, (l) => { sLevel = l; });
  // 模仿 Linux PLIC 驱动初始化：源优先级 1、阈值 0、使能 S 模式上下文
  plic.write(0x201004n, 0n, 4);
  plic.write(BigInt(irq) * 4n, 1n, 4);
  plic.write(0x2080n, 1n << BigInt(irq), 4);

  for (let r = 0; r < maxRounds; r++) {
    if (queued.length > 0 && !(ier & 0x02)) {
      ier |= 0x02;
      uart.write(1n, BigInt(ier), 1); // IER
    }
    if (!sLevel) break; // 中断没来，驱动推不动了
    const id = Number(plic.read(0x201000n, 4)); // claim
    if (id !== irq) { plic.write(0x201000n, BigInt(id), 4); break; }
    if ((Number(uart.read(2n, 1)) & 0x0f) !== 0x02) { // IIR 非 THRE
      plic.write(0x201000n, BigInt(id), 4);
      break;
    }
    out.push(queued.shift()!);
    uart.write(0n, BigInt(out.at(-1)!), 1); // THR
    if (queued.length === 0) {
      ier &= ~0x02;
      uart.write(1n, BigInt(ier), 1);
    }
    plic.write(0x201000n, BigInt(id), 4); // complete
    if (queued.length === 0) break;
  }
  return out;
}

test('PLIC 电平敏感：complete 后源仍为高应重新挂起', () => {
  const plic = new Plic(32, 2);
  plic.write(0x0004n, 5n, 4); // 源 1 优先级 = 5
  plic.write(0x201004n, 0n, 4); // 上下文 1 阈值 = 0
  plic.write(0x2080n, 0x2n, 4); // 使能上下文 1 的源 1
  plic.setIrq(1, true);

  assert.equal(plic.read(0x201000n, 4), 1n, '首次 claim');
  assert.equal(plic.read(0x201000n, 4), 0n, '已 claim 未 complete 时不重复投递');
  plic.write(0x201000n, 1n, 4); // complete

  // 物理电平没撤（如 16550 的 THRE），必须重新挂起
  assert.equal(plic.read(0x201000n, 4), 1n, '电平仍为高，complete 后应再次可 claim');
  plic.write(0x201000n, 1n, 4);

  plic.setIrq(1, false); // 源撤掉
  assert.equal(plic.read(0x201000n, 4), 0n, '源撤掉后不应再投递');
});

test('PLIC：complete 了别的中断号不应误清除 in-service', () => {
  const plic = new Plic(32, 2);
  for (const s of [1, 2]) plic.write(BigInt(s) * 4n, BigInt(s), 4); // 优先级 1、2
  plic.write(0x201004n, 0n, 4);
  plic.write(0x2080n, 0x6n, 4); // 使能源 1、2
  plic.setIrq(1, true);
  plic.setIrq(2, true);

  assert.equal(plic.read(0x201000n, 4), 2n, '优先级 2 更高，先 claim 源 2');
  plic.write(0x201000n, 1n, 4); // 错误地 complete 源 1
  assert.equal(plic.read(0x201000n, 4), 1n, '错误的 complete 不影响源 2 的 in-service');
  plic.write(0x201000n, 2n, 4); // 正确 complete 源 2
  plic.write(0x201000n, 1n, 4); // complete 刚才 claim 的源 1
  assert.equal(plic.read(0x201000n, 4), 2n, '两个都 complete 后，高优先级的源 2 重新挂起');
});

test('16550 + PLIC：中断式发送能把整块数据发完', () => {
  const plic = new Plic(32, 2);
  const uart = new Uart({ irq: (level) => plic.setIrq(10, level) });
  const payload = Array.from('ts-riscv64: Linux userspace is ALIVE\n').map((c) => c.charCodeAt(0));
  const out = drive8250Tx(plic, uart, payload, 10);
  assert.equal(
    Buffer.from(out).toString('latin1'),
    'ts-riscv64: Linux userspace is ALIVE\n',
    'THRE 持续为高时，必须靠重复的 THRE 中断把数据推完',
  );
  assert.equal(out.length, payload.length, '不应丢字节');
});
