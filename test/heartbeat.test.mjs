/**
 * 心跳与幽灵连接清理断言
 *
 * 场景：玩家直接关掉浏览器标签页时，TCP 不一定会立刻断，
 * 服务端若不主动探测，幽灵连接会白占座位（真实玩家进来被 ROOM_FULL 挡住）。
 *
 * 断言：
 *  1) 不回 pong 的假客户端会被服务端在 DEAD_AFTER 内踢掉（socket 被销毁）
 *  2) 踢掉之后真客户端能拿回座位 0（说明座位确实释放了）
 *  3) 真客户端能跨过多个 ping 周期继续通信（服务端 ping 不会打死正常连接）
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 8091;
const PING_EVERY = 500;
const DEAD_AFTER = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, detail = '') {
  pass++;
  console.log(`  ✅ ${name}` + (detail ? `  —  ${detail}` : ''));
}
function bad(name, detail = '') {
  fail++;
  console.log(`  ❌ ${name}` + (detail ? `  —  ${detail}` : ''));
}
function check(name, cond, detail) { cond ? ok(name, detail) : bad(name, detail); }

/* ---------------- 假客户端：完成握手后收到 ping 一律不回 ---------------- */
function clientFrame(str) {
  const p = Buffer.from(str, 'utf8');
  const mask = crypto.randomBytes(4);
  const n = p.length;
  let head;
  if (n < 126) head = Buffer.from([0x81, 0x80 | n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(n), 2); }
  const body = Buffer.alloc(n);
  for (let i = 0; i < n; i++) body[i] = p[i] ^ mask[i % 4];
  return Buffer.concat([head, mask, body]);
}

function dumbGhost(room) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const st = { closed: false, pings: 0, sock: null };
    const sock = net.connect(PORT, '127.0.0.1');
    st.sock = sock;
    sock.setNoDelay(true);
    sock.on('connect', () => {
      sock.write(
        `GET /?room=${room} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('\r\n\r\n');
      if (i >= 0 && !st.handshook) {
        st.handshook = true;
        sock.write(clientFrame(JSON.stringify({ t: 'hello', name: '幽灵', room })));
        sock.write(clientFrame(JSON.stringify({ t: 'join' })));
        resolve(st);
      }
      // 统计服务端发来的 ping（opcode 0x9），但故意不回 pong
      const body = buf.subarray(i >= 0 ? i + 4 : 0);
      for (let k = 0; k + 1 < body.length; k++) {
        if (body[k] === 0x89 || body[k] === 0x09) st.pings++;
      }
    });
    sock.on('close', () => { st.closed = true; });
    sock.on('error', () => { st.closed = true; });
    setTimeout(() => { if (!st.handshook) reject(new Error('握手超时')); }, 4000);
  });
}

function realClient(room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?room=${room}`);
    const st = { ws, seat: -1, err: null, msgs: [] };
    const t = setTimeout(() => reject(new Error('welcome 超时')), 5000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', name: '真玩家', room }));
      ws.send(JSON.stringify({ t: 'join' }));
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      st.msgs.push(m);
      if (m.t === 'welcome') { st.seat = m.seat; clearTimeout(t); resolve(st); }
      if (m.t === 'err') st.err = m.code;
    };
    ws.onerror = () => { clearTimeout(t); reject(new Error('ws error')); };
  });
}

/* ---------------- 起测试服务端 ---------------- */
const srv = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), PING_EVERY: String(PING_EVERY), DEAD_AFTER: String(DEAD_AFTER) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', (d) => { srvLog += d.toString(); });
srv.stderr.on('data', (d) => { srvLog += d.toString(); });

async function waitHealth(ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return true;
    } catch { }
    await sleep(120);
  }
  return false;
}

console.log('\n=== 心跳 / 幽灵连接清理断言 ===\n');

try {
  check('测试服务端就绪', await waitHealth(), `端口 ${PORT}，PING_EVERY=${PING_EVERY}ms，DEAD_AFTER=${DEAD_AFTER}ms`);

  const ghost = await dumbGhost('hb');
  ok('假客户端完成握手并占座（故意不回 pong）');
  await sleep(250);

  // 等它被踢
  const t0 = Date.now();
  let pings = 0;
  while (Date.now() - t0 < DEAD_AFTER + 3000 && !ghost.closed) {
    pings = Math.max(pings, ghost.pings);
    await sleep(80);
  }
  pings = Math.max(pings, ghost.pings);
  check('收到服务端心跳 ping', pings > 0, `共 ${pings} 个 ping 帧`);
  check('超时未回 pong → 连接被服务端销毁',
    ghost.closed, `${Date.now() - t0}ms 内断开（阈值 ${DEAD_AFTER}ms）`);
  check('服务端日志记录了踢人', /心跳超时/.test(srvLog),
    (srvLog.match(/心跳超时.*/) || [''])[0].trim());

  // 座位是否真的释放：新来的真玩家应该拿 seat 0（幽灵还在就会是 seat 1 或 ROOM_FULL）
  const real = await realClient('hb');
  check('幽灵被清后真客户端拿回座位 0', real.seat === 0,
    `seat=${real.seat}${real.err ? ` err=${real.err}` : ''}`);

  // 跨过多个 ping 周期仍能正常收发
  const before = real.msgs.length;
  await sleep(PING_EVERY * 3);
  real.ws.send(JSON.stringify({ t: 'aim', angle: 0.3, power: 0.5 }));
  await sleep(400);
  const got = real.msgs.slice(before).some((m) => m.t === 'oppAim');
  check('正常运行跨过多个 ping 周期（不被误杀）',
    real.ws.readyState === 1 && got, `readyState=${real.ws.readyState}，ping 周期 ${PING_EVERY}ms`);

  real.ws.close();
} catch (e) {
  bad('测试过程异常', e.message);
} finally {
  try { srv.kill('SIGKILL'); } catch { }
  await sleep(200);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail ? 1 : 0);
