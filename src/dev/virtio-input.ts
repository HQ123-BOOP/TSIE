/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import type { Bus } from '../mem/bus.ts';
import type { MemSize } from '../mem/types.ts';
import type { IrqLine } from './uart.ts';
import { VirtioMmio, VIRTIO_F_VERSION_1, type ChainDesc, type VQueue } from './virtio-mmio.ts';

/**
 * virtio-input（键盘）设备。
 *
 * 与其它 virtio 设备最不同的一点：**eventq 是设备→guest 方向**。驱动把空缓冲挂在
 * avail 环上，设备有事件时取一个缓冲写入 `struct virtio_input_event` 再 pushUsed。
 * 所以这里像 virtio-net 的 RX 一样**自己维护 lastAvail 游标**（override processQueue，
 * 不走基类那套「guest 提交即消费」的循环）。
 *
 * config 空间走"选择式"协议（`struct virtio_input_config`，136 字节）：
 * 驱动先写 select/subsel，再读 size 与联合体。所以本设备是本仓库里**唯一需要写 config
 * 的 virtio 设备** —— 见 VirtioDevice.writeConfig 的说明。
 */

// --- linux/input-event-codes.h ---
export const EV_SYN = 0x00;
export const EV_KEY = 0x01;
export const SYN_REPORT = 0;

// --- virtio_input_config.select（virtio spec §5.8.4）---
const CFG_ID_NAME = 0x01;
const CFG_ID_DEVIDS = 0x03;
const CFG_EV_BITS = 0x11;

/** struct virtio_input_config：3 字节控制 + 5 字节保留 + 128 字节联合体 */
const CONFIG_SIZE = 0x88;
const U_OFF = 8;
const U_LEN = 128;

/** KEY_MAX（linux/input-event-codes.h）；EV_KEY 位图要覆盖到它，驱动会逐位查 */
const KEY_MAX = 0x2ff;

/** 队列容量（2 的幂；驱动 QUEUE_NUM 不能超过它） */
const QUEUE_SIZE = 64;

export interface VirtioInputOptions {
  /** 设备名（guest 侧 /sys/class/input/eventN/device/name） */
  name?: string;
}

/** 浏览器 KeyboardEvent.code → Linux keycode。表中没有的键直接忽略 */
const KEYMAP: Record<string, number> = {
  Escape: 1,
  Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6,
  Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
  KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20,
  KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
  BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
  KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34,
  KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38,
  Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48,
  KeyN: 49, KeyM: 50, Comma: 51, Period: 52, Slash: 53,
  ShiftRight: 54, NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63,
  F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  NumLock: 69, ScrollLock: 70,
  F11: 87, F12: 88,
  Numpad0: 82, Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad4: 75,
  Numpad5: 76, Numpad6: 77, Numpad7: 71, Numpad8: 72, Numpad9: 73,
  NumpadDecimal: 83, NumpadEnter: 96, ControlRight: 97, NumpadDivide: 98,
  PrintScreen: 99, AltRight: 100, NumpadAdd: 78, NumpadSubtract: 74,
  Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105,
  ArrowRight: 106, End: 107, ArrowDown: 108, PageDown: 109,
  Insert: 110, Delete: 111,
  MetaLeft: 125, MetaRight: 126,
};

/** 浏览器键码字符串 → Linux keycode；未收录返回 undefined */
export function keyCodeFromBrowser(code: string): number | undefined {
  return KEYMAP[code];
}

/** ASCII 字符 → [keycode, 是否需要 Shift]。仅覆盖可打印 ASCII 与回车/退格/Tab */
export function keyCodeFromChar(ch: string): [code: number, shift: boolean] | undefined {
  if (ch === '\r' || ch === '\n') return [28, false];
  if (ch === '\t') return [15, false];
  if (ch === ' ') return [57, false];
  if (ch >= 'a' && ch <= 'z') return [30 + (ch.charCodeAt(0) - 97), false];
  if (ch >= 'A' && ch <= 'Z') return [30 + (ch.charCodeAt(0) - 65), true];
  const digits = '1234567890';
  const i = digits.indexOf(ch);
  if (i >= 0) return [2 + i, false];
  const sym: Record<string, [number, boolean]> = {
    '-': [12, false], _: [12, true],
    '=': [13, false], '+': [13, true],
    '[': [26, false], '{': [26, true],
    ']': [27, false], '}': [27, true],
    ';': [39, false], ':': [39, true],
    "'": [40, false], '"': [40, true],
    '`': [41, false], '~': [41, true],
    '\\': [43, false], '|': [43, true],
    ',': [51, false], '<': [51, true],
    '.': [52, false], '>': [52, true],
    '/': [53, false], '?': [53, true],
    '!': [2, true], '@': [3, true], '#': [4, true], $: [5, true], '%': [6, true],
    '^': [7, true], '&': [8, true], '*': [9, true], '(': [10, true], ')': [11, true],
  };
  return sym[ch];
}

export class VirtioInput extends VirtioMmio {
  readonly name = 'virtio-input';

  /** struct virtio_input_config：select/subsel/size + 联合体内容，按需重建 */
  private readonly cfg = new Uint8Array(CONFIG_SIZE);
  private readonly devName: string;

  private eventsSent = 0;
  private eventsDropped = 0;

  constructor(bus: Bus, irq: IrqLine | undefined, opts: VirtioInputOptions = {}) {
    // 队列 0 = eventq（设备→guest），队列 1 = statusq（guest→设备，收 LED/状态）
    super(bus, irq, 2, QUEUE_SIZE);
    this.devName = opts.name ?? 'TSIE Virtio Keyboard';
    this.rebuildConfig();
  }

  protected deviceId(): number {
    return 18; // VIRTIO_ID_INPUT
  }

  protected hostFeatures(): bigint {
    // 只宣告 VERSION_1：不提供 device 侧事件上报（EV_* 反向通道），驱动会用 statusq
    return VIRTIO_F_VERSION_1;
  }

  protected queueSizeMax(): number {
    return QUEUE_SIZE;
  }

  protected override configSize(): number {
    return CONFIG_SIZE;
  }

  // ------------------------------------------------------------------
  // config 空间（选择式）
  // ------------------------------------------------------------------

  protected readConfig(o: number, size: MemSize): bigint {
    let v = 0n;
    for (let i = 0; i < size; i++) {
      const off = o + i;
      if (off >= CONFIG_SIZE) break;
      v |= BigInt(this.cfg[off]!) << BigInt(8 * i);
    }
    return v;
  }

  /** 只有 select/subsel 两个字节可写（写任意一个都会重建联合体内容） */
  protected override writeConfig(o: number, value: bigint, size: MemSize): void {
    if (o >= 3) return; // size 与保留区、联合体都是只读
    for (let i = 0; i < size; i++) {
      const off = o + i;
      if (off >= 3) break;
      this.cfg[off] = Number((value >> BigInt(8 * i)) & 0xffn);
    }
    this.rebuildConfig();
  }

  /** 按当前 select/subsel 重建 size 与联合体 */
  private rebuildConfig(): void {
    const sel = this.cfg[0]!;
    const subsel = this.cfg[1]!;
    this.cfg[2] = 0;
    this.cfg.fill(0, U_OFF, U_OFF + U_LEN);

    switch (sel) {
      case CFG_ID_NAME: {
        const n = Math.min(this.devName.length, U_LEN - 1);
        for (let i = 0; i < n; i++) this.cfg[U_OFF + i] = this.devName.charCodeAt(i) & 0xff;
        this.cfg[2] = n + 1; // 含结尾 NUL
        break;
      }
      case CFG_ID_DEVIDS: {
        // struct virtio_input_devids { u16 bustype, vendor, product, version }
        const dv = new DataView(this.cfg.buffer);
        dv.setUint16(U_OFF + 0, 0x06, true); // BUS_VIRTUAL
        dv.setUint16(U_OFF + 2, 0x1af4, true); // Red Hat / virtio
        dv.setUint16(U_OFF + 4, 0x0001, true);
        dv.setUint16(U_OFF + 6, 0x0001, true);
        this.cfg[2] = 8;
        break;
      }
      case CFG_EV_BITS: {
        // 位图按 subsel（事件类型）给出支持的 code；驱动会据此 set_bit(evbit/keybit)
        const set = (bit: number): void => {
          this.cfg[U_OFF + (bit >> 3)]! |= 1 << (bit & 7);
        };
        if (subsel === EV_SYN) {
          set(SYN_REPORT);
          this.cfg[2] = (SYN_REPORT >> 3) + 1;
        } else if (subsel === EV_KEY) {
          // 全部键位都报"支持"：键盘驱动会按自身 keymap 过滤，不必精确复刻 QEMU 的键表
          for (let k = 0; k <= KEY_MAX; k++) set(k);
          this.cfg[2] = (KEY_MAX >> 3) + 1;
        }
        break;
      }
      default:
        break; // 未提供的子配置：size = 0，驱动视为不存在
    }
  }

  // ------------------------------------------------------------------
  // 队列：eventq 由设备消费，statusq 由设备回收
  // ------------------------------------------------------------------

  /**
   * eventq（队列 0）必须绕开基类循环：基类会在 handleRequest 之后自行推进 avail 游标，
   * 而这里缓冲是**留给设备稍后填**的，不能一提交就算消费掉（同 virtio-net 的 RX）。
   */
  protected override processQueue(q: VQueue): void {
    if (this.queues.indexOf(q) === 0) {
      this.tryFlushPending();
      return;
    }
    super.processQueue(q);
  }

  /** statusq：驱动上报 LED/状态事件，读掉即可（不读也不影响，但要回 used 让驱动回收缓冲） */
  protected handleRequest(q: VQueue, headId: number): void {
    this.pushUsed(q, headId, 0);
  }

  /** 取一个驱动挂好的空缓冲；没有则返回 undefined */
  private takeBuffer(q: VQueue): { headId: number; chain: ChainDesc[] } | undefined {
    const availIdx = this.readAvailIdx(q);
    if (q.lastAvail === availIdx) return undefined;
    const slot = q.lastAvail % q.num;
    const headId = this.mem16(q.driver + BigInt(4 + slot * 2));
    const chain = this.collectChain(q, headId);
    if (chain.length === 0) return undefined;
    q.lastAvail = (q.lastAvail + 1) & 0xffff;
    return { headId, chain };
  }

  /** 送一个 input event（type/code/value 语义见 linux/input-event-codes.h） */
  sendEvent(type: number, code: number, value: number): void {
    const q = this.queues[0];
    if (!q || !q.ready) {
      this.eventsDropped++;
      return;
    }
    const buf = this.takeBuffer(q);
    if (!buf) {
      // 驱动没挂缓冲就丢弃 —— 真设备同样如此（事件语义是"尽力而为"，不排队）
      this.eventsDropped++;
      return;
    }
    const ev = new Uint8Array(8);
    const dv = new DataView(ev.buffer);
    dv.setUint16(0, type, true);
    dv.setUint16(2, code, true);
    dv.setUint32(4, value >>> 0, true);

    let off = 0;
    for (const c of buf.chain) {
      const n = Math.min(c.len, ev.length - off);
      if (n <= 0) break;
      this.bus.writeBytes(c.addr, ev.subarray(off, off + n));
      off += n;
    }
    this.pushUsed(q, buf.headId, off);
    this.eventsSent++;
    this.raiseIrq(); // 事件必须 IRQ 驱动（驱动在中断里读 eventq 并 input_sync）
  }

  /** 按键按下/抬起；自动补一个 EV_SYN/SYN_REPORT 收尾（Linux 要求成组上报） */
  sendKey(code: number, down: boolean): void {
    this.sendEvent(EV_KEY, code, down ? 1 : 0);
    this.sendEvent(EV_SYN, SYN_REPORT, 0);
  }

  /** 浏览器按键事件入口：code 是 KeyboardEvent.code 字符串 */
  sendBrowserKey(browserCode: string, down: boolean): boolean {
    const code = keyCodeFromBrowser(browserCode);
    if (code === undefined) return false;
    this.sendKey(code, down);
    return true;
  }

  /** 把一段文本敲进去（harness/测试用；大写与符号会自动带 Shift） */
  sendText(text: string): void {
    for (const ch of text) {
      const k = keyCodeFromChar(ch);
      if (!k) continue;
      const [code, shift] = k;
      if (shift) this.sendKey(42, true); // KEY_LEFTSHIFT
      this.sendKey(code, true);
      this.sendKey(code, false);
      if (shift) this.sendKey(42, false);
    }
  }

  /** 队列就绪后由外部泵一下（驱动挂上缓冲但事件已积压时的兜底） */
  tryFlushPending(): void {
    // 当前实现不排队事件：有缓冲就直接送。此钩子留作将来加 FIFO 用。
  }

  override stats(): { events: number; dropped: number; notifications: number } {
    return { events: this.eventsSent, dropped: this.eventsDropped, notifications: this.notifyStats };
  }
}
