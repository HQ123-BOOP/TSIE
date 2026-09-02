/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */

/** 一个完整以太网帧（dst MAC 起，不含 virtio-net 头） */
export type EthFrame = Uint8Array;

/**
 * 网络后端：向模拟器提供「帧从哪来、到哪去」的抽象（类比 DiskImage）。
 * 设备侧 TX 帧调 send()；外部数据源调 device.injectRx() 注入。
 */
export interface NetBackend {
  /** 设备发来一帧（guest TX）。实现应尽快返回，不做重活 */
  send(frame: EthFrame): void;
  /** 注册注入回调（后端有帧要进 guest 时调用），通常只调一次 */
  onFrame(cb: (frame: EthFrame) => void): void;
  close(): void;
}

/**
 * 回环后端：TX 帧原样注入回 RX（自发自收）。
 * 用于 guest 内 ip link/ping 自身验证 virtio-net 数据通路，
 * 不依赖任何主机网络。
 */
export class LoopbackBackend implements NetBackend {
  private sink: ((frame: EthFrame) => void) | undefined;

  send(frame: EthFrame): void {
    // 拷贝一份：TX 缓冲可能被复用，注入是异步语义
    const copy = new Uint8Array(frame.length);
    copy.set(frame);
    this.sink?.(copy);
  }

  onFrame(cb: (frame: EthFrame) => void): void {
    this.sink = cb;
  }

  close(): void {
    this.sink = undefined;
  }
}
