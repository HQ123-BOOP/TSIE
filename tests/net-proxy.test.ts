/**
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-FileCopyrightText: 2026 TSIE
 */
// ProxyBackend 回归测试：peer 地址学习后 send 必须仍可达。
// 回归背景：曾把 RemoteInfo 的地址字段误当 .host 解构（实际是 .address），
// 导致学习 peer 后所有帧发往 undefined 静默丢失——单测缺位让 guest
// 验证时才发现。本测试用 localhost UDP 全链路覆盖。
import * as dgram from 'node:dgram';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ProxyBackend } from '../src/dev/net-proxy.ts';
import type { EthFrame } from '../src/dev/net.ts';

test('proxy：学习 peer 后 send 仍发往守护端口（回归 .address 解构 bug）', async () => {
  // 守护：绑在随机端口，收到帧就原样回一个「回程」数据报
  const daemon = dgram.createSocket('udp4');
  const daemonPort = await new Promise<number>((resolve) => {
    daemon.on('message', (msg, rinfo) => {
      daemon.send(Buffer.from(msg), rinfo.port, rinfo.address); // 回显
    });
    daemon.bind(0, '127.0.0.1', () => resolve(daemon.address().port));
  });

  const proxy = new ProxyBackend({ host: '127.0.0.1', port: daemonPort });
  const received: EthFrame[] = [];
  proxy.onFrame((f) => received.push(f));

  // 等 proxy bind 完成
  await new Promise((r) => setTimeout(r, 50));

  const frame = new Uint8Array(42);
  frame[12] = 0x08;
  frame[13] = 0x06;

  // 1) peer 未学习：send 走 opts（127.0.0.1:daemonPort），守护收到并回显
  proxy.send(frame);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(received.length, 1, 'peer 未学习时 send 应可达守护');

  // 2) peer 已学习（守护的回显触发了地址学习）：再 send 必须仍可达
  //    （bug 场景：host 被解构成 undefined，帧静默丢失）
  proxy.send(frame);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(received.length, 2, '学习 peer 后 send 必须仍可达（.address 解构回归）');
  assert.equal(received[1]!.length, 42, '回显帧完整');

  proxy.close();
  daemon.close();
});
