/**
 * reconnect.net.mjs — 断线重连保局回归
 *
 * 真实事故：手机锁屏/切后台/刷新会先断开再重连。
 * 旧实现一断线就把玩家移出房间并把 phase 打回 wait，
 * 同 token 重连时房间又「凑满两人」→ 重新开局，整局进度清零。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const PORT = 8151;
const WS_URL = `ws://127.0.0.1:${PORT}`;
const NODE = 'C:/Users/pc/.workbuddy/binaries/node/versions/22.22.2/node.exe';
const SERVER = fileURLToPath(new URL('../dev/serve.mjs', import.meta.url));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

function open() {
  const ws = new WebSocket(WS_URL + '/api/ws?room=rtest');
  ws.msgs = [];
  ws.onmessage = (e) => { try { ws.msgs.push(JSON.parse(e.data)); } catch { } };
  return new Promise((res) => { ws.onopen = () => res(ws); ws.onerror = () => res(ws); });
}
const send = (ws, o) => ws.send(JSON.stringify(o));
function lastOf(ws, t) { for (let i = ws.msgs.length - 1; i >= 0; i--) if (ws.msgs[i].t === t) return ws.msgs[i]; return null; }

const srv = spawn(NODE, [SERVER], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => { });
srv.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

try {
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) { up = true; break; } } catch { }
    await sleep(150);
  }
  ok(up, 'server /health 就绪');

  const a = await open();
  send(a, { t: 'hello', name: 'A', room: 'rtest', token: 'ta' });
  await sleep(300);
  const b = await open();
  send(b, { t: 'hello', name: 'B', room: 'rtest', token: 'tb' });
  await sleep(400);

  ok(lastOf(a, 'welcome')?.seat === 0, 'A 分到座位 0');
  ok(lastOf(b, 'welcome')?.seat === 1, 'B 分到座位 1');
  ok(!!lastOf(a, 'start'), '开局 start 已广播');

  // A 出杆并结算：shots=1，轮到 B
  send(a, { t: 'shot', angle: 0, power: 0.5 });
  await sleep(250);
  send(a, {
    t: 'report', group: [null, null], open: true, turn: 1, shots: 1,
    over: false, ballInHand: null,
    snapshot: { seq: 1, time: 1200, balls: [{ i: 0, x: 0, y: 0, p: 0 }, { i: 1, x: 700, y: 0, p: 0 }], potted: [] },
  });
  await sleep(500);
  // 结算只广播 result，不会额外推 room
  const before = lastOf(a, 'result');
  ok(before && before.shots === 1, `出杆后 shots=1（实际 ${before && before.shots}）`);

  // A 断线重连（模拟刷新/锁屏回来）
  a.close();
  await sleep(600);
  const a2 = await open();
  send(a2, { t: 'hello', name: 'A', room: 'rtest', token: 'ta' });
  await sleep(700);

  const welcome2 = lastOf(a2, 'welcome');
  const room2 = lastOf(a2, 'room');
  ok(welcome2 && welcome2.seat === 0, `重连仍拿到原座位 0（实际 ${welcome2 && welcome2.seat}）`);
  ok(room2 && room2.shots === 1, `重连后 shots 仍是 1（实际 ${room2 && room2.shots}）`);
  ok(room2 && room2.turn === 1, `重连后轮次仍是 B（实际 ${room2 && room2.turn}）`);
  ok(room2 && room2.players.length === 2, `重连后房间仍 2 人（实际 ${room2 && room2.players.length}）`);
  ok(!lastOf(a2, 'start'), '重连没有触发重新开局');

  // 模拟手机切后台超过 8 秒宽限才回来：仍应拿回原座位和整局进度
  a2.close();
  await sleep(10000);
  const a3 = await open();
  send(a3, { t: 'hello', name: 'A', room: 'rtest', token: 'ta' });
  await sleep(900);

  const welcome3 = lastOf(a3, 'welcome');
  const room3 = lastOf(a3, 'room');
  ok(welcome3 && welcome3.seat === 0, `超时归来座位仍是 0（实际 ${welcome3 && welcome3.seat}）`);
  ok(room3 && room3.shots === 1, `超时归来 shots 仍是 1（实际 ${room3 && room3.shots}）`);
  ok(room3 && room3.turn === 1, `超时归来轮次仍是 B（实际 ${room3 && room3.turn}）`);
  ok(room3 && room3.players.length === 2, `超时归来房间仍 2 人（实际 ${room3 && room3.players.length}）`);
  ok(!lastOf(a3, 'start'), '超时归来没有触发重新开局');

  a3.close();
  b.close();
} catch (e) {
  fail++;
  console.log('  ✗ 异常：', e && e.message);
} finally {
  try { srv.kill(); } catch { }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
