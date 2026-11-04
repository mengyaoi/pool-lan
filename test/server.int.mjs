/**
 * server.int.mjs — 联机服务端集成冒烟（真实起 server + 双 WS 客户端）
 * 验证：握手/开局/groups 广播/snapshot 含 group+open/开球后状态一致/服务不崩
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const PORT = 8137;
const WS_URL = `ws://127.0.0.1:${PORT}`;
const NODE = 'C:/Users/pc/.workbuddy/binaries/node/versions/22.22.2/node.exe';
const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

function open(name) {
  const ws = new WebSocket(WS_URL);
  ws.msgs = [];
  ws.name = name;
  ws.onmessage = (e) => { try { ws.msgs.push(JSON.parse(e.data)); } catch { } };
  return new Promise((res) => { ws.onopen = () => res(ws); ws.onerror = () => res(ws); });
}
const send = (ws, o) => ws.send(JSON.stringify(o));
function lastOf(ws, t) { for (let i = ws.msgs.length - 1; i >= 0; i--) if (ws.msgs[i].t === t) return ws.msgs[i]; return null; }

async function main() {
  const srv = spawn(NODE, [SERVER], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', () => { });
  srv.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  // 等健康
  let up = false;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) { up = true; break; } } catch { }
    await sleep(150);
  }
  ok(up, 'server /health 就绪');

  const a = await open('A');
  const b = await open('B');
  send(a, { t: 'hello', name: 'A', room: 'itest' });
  send(b, { t: 'hello', name: 'B', room: 'itest' });
  await sleep(400);

  ok(lastOf(a, 'welcome')?.seat === 0, 'A 分到座位 0');
  ok(lastOf(b, 'welcome')?.seat === 1, 'B 分到座位 1');

  const startA = lastOf(a, 'start');
  ok(startA && startA.breaker === 0, '收到 start（breaker=0）');
  const gA = lastOf(a, 'groups');
  ok(gA && Array.isArray(gA.group) && gA.group[0] === null && gA.group[1] === null && gA.open === true, `开局 groups 广播 [null,null] open=true：${JSON.stringify(gA)}`);

  // 收若干 snapshot，确认带 group/open 字段
  let sawGroup = false, sawOpen = false, sawSnap = false;
  for (let i = 0; i < 30; i++) {
    const s = lastOf(a, 'snap');
    if (s) {
      sawSnap = true;
      if ('group' in s) sawGroup = true;
      if ('open' in s) sawOpen = true;
    }
    await sleep(40);
  }
  ok(sawSnap, '收到 snapshot');
  ok(sawGroup, 'snapshot 含 group 字段');
  ok(sawOpen, 'snapshot 含 open 字段');

  // A 开球（朝 +x 打向右边球堆）
  send(a, { t: 'shot', angle: 0, power: 0.85, spin: { a: 0, b: 0 } });
  await sleep(150);
  ok(lastOf(a, 'evt')?.type === 'cue' || lastOf(a, 'toast'), '开球被服务端接受（evt cue / toast）');

  // 等本杆结算：先观察到 run（球在动），再等回到 aim/over
  let sawRun = false, resolved = false;
  for (let i = 0; i < 400; i++) {
    const ph = lastOf(a, 'snap')?.phase;
    const over = lastOf(a, 'over');
    if (ph === 'run') sawRun = true;
    if (sawRun && (over || ph === 'aim')) { resolved = true; break; }
    await sleep(40);
  }
  ok(resolved, '开球后本杆结算完成（先 run 后回到 aim/over，无死锁）');

  const over = lastOf(a, 'over');
  if (over) ok('winner' in over && !('scores' in over), `over 广播只含 winner 不含 scores：${JSON.stringify(over)}`);
  else ok(true, '开球未直接结束（正常）');

  await sleep(200);
  ok(srv.exitCode === null, 'server 进程仍在运行（未崩溃）');

  a.close(); b.close(); srv.kill('SIGKILL');
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
