/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
import type { Device, MemSize } from '../mem/types.ts';

// Goldfish RTC 寄存器偏移（与 QEMU hw/rtc/goldfish_rtc.c 同布局）
const R_TIME_LOW = 0x00;
const R_TIME_HIGH = 0x04;
const R_ALARM_LOW = 0x08;
const R_ALARM_HIGH = 0x0c;
const R_CLEAR_INTERRUPT = 0x10;
const R_ALARM_STATUS = 0x14;

/**
 * Goldfish RTC（QEMU virt 平台同款，地址 0x101000 / PLIC 源 11）。
 *
 * 计数器 = 自 Unix 纪元起的【真实】纳秒（Date.now()），不是虚拟时钟——
 * 用途是给 guest 一个正确的墙钟（内核 RTC_HCTOSYS 启动时自动校准
 * CLOCK_REALTIME），避免文件时间戳错乱与未来 TLS 证书校验失败。
 *
 * 内核驱动（rtc-goldfish.c）读取顺序是先 TIME_HIGH 再 TIME_LOW；
 * 用 1ms 粒度缓存保证一对读出高低位一致（换算到秒级无影响）。
 * 闹钟中断未实现：写忽略、读 0，驱动探测与 read_time 不受影响。
 */
export class GoldfishRtc implements Device {
  readonly name = 'goldfish-rtc';
  readonly size = 0x1000n;

  private cacheNs = 0n;
  private cacheAtMs = -1;

  /** 当前真实时间（纳秒）；同一毫秒内的多次读取返回同一值，保证高低位配对一致 */
  private timeNs(): bigint {
    const now = Date.now();
    if (now !== this.cacheAtMs) {
      this.cacheNs = BigInt(now) * 1_000_000n;
      this.cacheAtMs = now;
    }
    return this.cacheNs;
  }

  read(offset: bigint, _size: MemSize): bigint {
    const o = Number(offset);
    switch (o) {
      case R_TIME_LOW:
        return this.timeNs() & 0xffffffffn;
      case R_TIME_HIGH:
        return (this.timeNs() >> 32n) & 0xffffffffn;
      case R_ALARM_STATUS:
        return 0n; // 闹钟未触发
      default:
        return 0n;
    }
  }

  write(offset: bigint, _value: bigint, _size: MemSize): void {
    const o = Number(offset);
    if (o === R_CLEAR_INTERRUPT || o === R_ALARM_LOW || o === R_ALARM_HIGH) {
      return; // 闹钟/中断清除：接受写入，无副作用
    }
  }
}
