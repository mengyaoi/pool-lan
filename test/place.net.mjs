/**
 * place.net.mjs — 联机模式「自由球摆放」全链路回归
 * A 打一杆空杆 → 服务端判犯规 → B 获得 ballInHand → B 发 place → 快照里母球落位
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const PORT = 8147;
const WS_URL = `ws://127.0.0.1:${PORT}`;
const NODE = 'C:/Users/pc/.workbuddy/binaries/node/versions/22.22.2/node.exe';
const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

function open(name) {
  const ws = new WebSocket(WS_URL);
  ws.msgs = []; ws.name = name;
  ws.onmessage = (e) => { try { ws.msgs.push(JSON.parse(e.data)); } catch { } };
  return new Promise((res) => { ws.onopen = () => res(ws); ws.onerror = () => res(ws); });
}
const send = (ws, o) => ws.send(JSON.stringify(o));
function lastOf(ws, t) { for (let i = ws.msgs.length - 1; i >= 0; i--) if (ws.msgs[i].t === t) return ws.msgs[i]; return null; }
function lastSnapWith(ws, fn) {
  for (let i = ws.msgs.length - 1; i >= 0; i--) {
    const m = ws.msgs[i];
    if (m.t === 'snap' && fn(m)) return m;
  }
  return null;
}
const cueOf = (snap) => snap && snap.balls.find((x) => x.i === 0);

/** 轮询等待某一端出现满足条件的快照（默认最多 8s） */
async function waitSnap(ws, fn, timeoutMs = 8000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = lastSnapWith(ws, fn);
    if (s) return s;
    await sleep(120);
  }
  console.log(`  [timeout] 等待快照超时 ${label}`);
  return null;
}

async function main() {
  const srv = spawn(NODE, [SERVER], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', () => { });
  srv.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  let up = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) { up = true; break; } } catch { }
    await sleep(150);
  }
  ok(up, 'server /health 就绪');

  const a = await open('A');
  const b = await open('B');
  send(a, { t: 'hello', name: 'A', room: 'ptest' });
  send(b, { t: 'hello', name: 'B', room: 'ptest' });

  ok(!!(await waitSnap(a, () => true, 5000, 'start')), '收到首帧快照');
  ok(!!lastOf(a, 'start'), '收到 start');
  const seatA = lastOf(a, 'welcome')?.seat;
  ok(seatA === 0, `A 是 0 号位（实际 ${seatA}）`);

  // ---- 1. A 打一杆朝左的极轻球：母球碰不到任何球 → 空杆犯规 ----
  send(a, { t: 'shot', angle: Math.PI, power: 0.06, spin: { a: 0, b: 0 } });

  // 轮询直到停稳（实测这杆要 3.5~4s 才 settled）
  const snapFoul = await waitSnap(b, (m) => m.phase !== 'run' && m.ballInHand != null, 9000, 'A 犯规判定');
  {
    const s = lastSnapWith(b, () => true);
    console.log('  [debug] 最后一帧 snap:', JSON.stringify({
      phase: s && s.phase, turn: s && s.turn, bih: s && s.ballInHand,
      cue: (() => { const c = cueOf(s); return c ? [c.x, c.y, c.p] : null; })(),
    }));
    console.log('  [debug] B 收到的 toast:', b.msgs.filter((m) => m.t === 'toast').map((m) => m.text).join(' | '));
  }

  ok(!!snapFoul, 'B 的快照里出现 ballInHand（A 犯规给对手自由球）');
  ok(snapFoul && snapFoul.ballInHand === 1, `自由球归属 B（ballInHand=${snapFoul && snapFoul.ballInHand}）`);
  ok(snapFoul && snapFoul.turn === 1, `同时轮到 B（turn=${snapFoul && snapFoul.turn}）`);

  const cueBefore = cueOf(snapFoul);
  ok(!!cueBefore, '快照含母球');

  // ---- 2. 越权测试：A（无自由球）尝试摆放 → 应被静默忽略 ----
  send(a, { t: 'place', x: -0.5, y: 0.4 });
  await sleep(400);
  {
    const after = lastSnapWith(a, () => true);
    const c = cueOf(after);
    const moved = c && cueBefore && Math.hypot(c.x - cueBefore.x, c.y - cueBefore.y) > 1;
    ok(!moved, `A 越权 place 被忽略（母球仍在 ${c && (c.x / 1000).toFixed(3)},${c && (c.y / 1000).toFixed(3)}）`);
    ok(after && after.ballInHand === 1, '越权尝试后自由球仍归 B，未被消费');
  }

  // ---- 3. B 压球摆放 → 应被服务端拒绝并回 toast ----
  const bMsgsBefore = b.msgs.length;
  // 主球堆顶点大约在 x≈0.635，这里直接压在球堆上
  send(b, { t: 'place', x: 0.70, y: 0 });
  await sleep(450);
  {
    const rejected = b.msgs.slice(bMsgsBefore).some((m) => m.t === 'toast' && /放不了/.test(m.text || ''));
    ok(rejected, '压球位置被服务端拒绝并回了提示');
    const after = lastSnapWith(b, () => true);
    ok(after && after.ballInHand === 1, '拒绝后自由球仍归 B（未被误消费）');
  }

  // ---- 4. B 合法摆放 ----
  const TX = 0, TY = 0.30;
  const aMsgsBefore = a.msgs.length;
  send(b, { t: 'place', x: TX, y: TY });

  const snapPlaced = await waitSnap(
    a,
    (m) => m.ballInHand === null && (() => { const c = cueOf(m); return c && Math.abs(c.x / 1000 - TX) < 0.01 && Math.abs(c.y / 1000 - TY) < 0.01; })(),
    6000,
    '母球落位',
  );
  ok(!!snapPlaced, 'A 的快照里看到母球落位且 ballInHand 清空');
  const cuePlaced = cueOf(snapPlaced);
  ok(!!cuePlaced && Math.abs(cuePlaced.x / 1000 - TX) < 0.01 && Math.abs(cuePlaced.y / 1000 - TY) < 0.01,
    `母球落位到 (${TX},${TY})，实际 (${cuePlaced && (cuePlaced.x / 1000).toFixed(3)},${cuePlaced && (cuePlaced.y / 1000).toFixed(3)})`);
  ok(a.msgs.slice(aMsgsBefore).some((m) => m.t === 'toast' && /摆好/.test(m.text || '')), '双端收到「母球已摆好」提示');

  // ---- 5. 摆放后 B 能正常出杆 ----
  send(b, { t: 'shot', angle: 0, power: 0.5, spin: { a: 0, b: 0 } });
  const snapShot = await waitSnap(a, () => true, 3000, '出杆');
  ok(!!snapShot, '摆放后可以正常出杆（快照仍在流动）');

  ok(srv.exitCode === null, 'server 进程仍在运行（未崩溃）');

  srv.kill('SIGKILL');
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
