/**
 * server.js — 零依赖联机服务端
 *   · HTTP 静态文件（MIME 白名单 + 路径穿越防护）
 *   · 手写 RFC6455 WebSocket（握手 / 帧解析 / 分片 / ping-pong / close）
 *   · 房间管理 + 服务端权威物理（1/240 固定步长），快照 20Hz 广播
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  createWorld, rack15, stepWorld, applyShot, settled, respotCue, respotBall, serializeWorld, TW, TH,
  placeCue,
} from './public/js/physics.js';
import { createMatch, resolveShot } from './public/js/rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 8080;
const STEP = 1 / 240;
const MASK_MAX = 2;              // 每房间最多 2 人对局

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ================================================================== */
/* HTTP                                                               */
/* ================================================================== */
const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, ts: Date.now() }));
  }

  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  try { rel = decodeURIComponent(rel); } catch { res.writeHead(400); return res.end('bad path'); }
  if (rel.includes('\0')) { res.writeHead(400); return res.end('bad path'); }

  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 forbidden');
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

/* ================================================================== */
/* WebSocket 编解码                                                   */
/* ================================================================== */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81; // FIN + opcode=text
  return Buffer.concat([header, payload]);
}

function encodeControl(opcode, payload = Buffer.alloc(0)) {
  const h = Buffer.alloc(2);
  h[0] = 0x80 | opcode;
  h[1] = payload.length;
  return Buffer.concat([h, payload]);
}

/**
 * 增量帧解析：处理半包/粘包、客户端掩码、126/127 扩展长度、分片。
 */
function createParser(onMessage, onClose) {
  let buf = Buffer.alloc(0);
  let frag = Buffer.alloc(0);
  let fragOp = 0;
  let closed = false;

  return (chunk) => {
    if (closed) return;
    buf = Buffer.concat([buf, chunk]);

    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;

      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > 8n * 1024n * 1024n) { // 8MB 上限，防内存打爆
          closed = true;
          onClose();
          return;
        }
        len = Number(big);
        off = 10;
      }

      let mask = null;
      if (masked) {
        if (buf.length < off + 4) return;
        mask = buf.subarray(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) return;

      let payload = buf.subarray(off, off + len);
      if (masked) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buf = buf.subarray(off + len);

      if (opcode === 0x8) {           // close
        closed = true;
        onClose();
        return;
      } else if (opcode === 0x9) {    // ping → pong
        onMessage({ __ping: true, payload });
      } else if (opcode === 0xA) {    // pong
        onMessage({ __pong: true });
      } else if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        if (opcode !== 0x0) fragOp = opcode;
        frag = frag.length ? Buffer.concat([frag, payload]) : Buffer.from(payload);
        if (fin) {
          const text = frag.toString('utf8');
          frag = Buffer.alloc(0);
          onMessage({ text });
        }
      }
      // 其他 opcode 忽略
    }
  };
}

/* ================================================================== */
/* 房间                                                               */
/* ================================================================== */
const rooms = new Map();

function getRoom(id) {
  let r = rooms.get(id);
  if (!r) {
    r = {
      id,
      clients: [],
      world: null,
      match: null,
      phase: 'wait',       // wait | aim | run | over
      markPotted: [],
      seq: 0,
      acc: 0,
      evts: [],
      emptySince: Date.now(),
    };
    rooms.set(id, r);
    log(`房间 ${id} 创建`);
  }
  return r;
}

function broadcast(room, obj) {
  if (!room.clients.length) return;
  const data = encodeFrame(JSON.stringify(obj));
  for (const c of room.clients) {
    if (!c.socket.destroyed && c.socket.writable) {
      try { c.socket.write(data); } catch { }
    }
  }
}

function send(client, obj) {
  if (!client.socket.destroyed && client.socket.writable) {
    try { client.socket.write(encodeFrame(JSON.stringify(obj))); } catch { }
  }
}

function roomState(room) {
  return {
    t: 'room',
    id: room.id,
    players: room.clients.map((c) => ({ seat: c.seat, name: c.name, online: true })),
    phase: room.phase,
    group: room.match ? room.match.group : [null, null],
    open: room.match ? room.match.open : true,
  };
}

function startGame(room) {
  room.world = createWorld();
  rack15(room.world, (Date.now() % 90000) + 3);
  room.match = createMatch();
  room.phase = 'aim';
  room.markPotted = [];
  room.seq = 0;
  room.acc = 0;
  room.evts = [];
  broadcast(room, { t: 'start', breaker: 0 });
  broadcast(room, { t: 'turn', p: 0 });
  broadcast(room, { t: 'groups', group: room.match.group, open: room.match.open });
  log(`房间 ${room.id} 开局`);
}

/* ================================================================== */
/* 物理循环                                                            */
/* ================================================================== */
setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.world || room.phase !== 'run') continue;

    room.acc += 1 / 120;         // 每 8.33ms 推进 8.33ms 物理
    let guard = 0;
    while (room.acc >= STEP && guard++ < 40) {
      const evs = stepWorld(room.world, STEP);
      room.acc -= STEP;
      for (const e of evs) {
        if (e.type === 'pocket') {
          room.evts.push({
            t: 'evt', type: 'pocket', id: e.id,
            x: Math.round(e.x * 1000), y: Math.round(e.y * 1000),
          });
        } else {
          room.evts.push({ t: 'evt', type: e.type, speed: Math.round(e.speed * 100) / 100 });
        }
      }
    }

    if (settled(room.world)) finishShot(room);
  }
}, 1000 / 120);

function finishShot(room) {
  const pottedNow = room.world.pocketed.slice();
  const newPotted = pottedNow.filter((id) => id !== 0 && !room.markPotted.includes(id));
  const cuePotted = pottedNow.includes(0);
  const firstHit = room.world.firstContact;
  const anyHit = firstHit !== null;
  const pottedAll = pottedNow.filter((id) => id !== 0);

  const r = resolveShot(room.match, { newPotted, cuePotted, firstHit, anyHit, pottedAll });
  if (cuePotted) respotCue(room.world);
  if (r.respot && r.respot.length) {
    for (const id of r.respot) respotBall(room.world, id);
  }
  room.phase = room.match.phase;
  room.acc = 0;

  broadcast(room, { t: 'toast', text: r.hint });
  broadcast(room, { t: 'groups', group: room.match.group, open: room.match.open });

  if (newPotted.length) broadcast(room, { t: 'evt', type: 'score' });
  if (cuePotted) broadcast(room, { t: 'evt', type: 'miscue' });

  if (r.over) {
    broadcast(room, { t: 'over', winner: room.match.winner });
  } else {
    broadcast(room, { t: 'turn', p: room.match.turn });
  }
  log(`房间 ${room.id} ${r.hint}`);
}

/* ================================================================== */
/* 快照广播（20Hz）                                                   */
/* ================================================================== */
setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.world || !room.clients.length) continue;

    room.seq++;
    const snap = serializeWorld(room.world);
    const msg = {
      t: 'snap',
      seq: room.seq,
      time: snap.time,
      balls: snap.balls,
      potted: snap.potted,
      phase: room.phase,
      turn: room.match.turn,
      group: room.match.group,
      open: room.match.open,
      ballInHand: room.match.ballInHand,
      winner: room.match.winner,
      names: [0, 1].map((i) => {
        const c = room.clients.find((x) => x.seat === i);
        return c ? c.name : `玩家 ${i + 1}`;
      }),
    };
    broadcast(room, msg);

    if (room.evts.length) {
      for (const e of room.evts) broadcast(room, e);
      room.evts = [];
    }
  }
}, 50);

/* 房间回收 */
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.clients.length === 0) {
      if (!room.emptySince) room.emptySince = now;
      if (now - room.emptySince > 10 * 60 * 1000) {
        rooms.delete(id);
        log(`房间 ${id} 回收`);
      }
    } else room.emptySince = 0;
  }
}, 60 * 1000);

/* 心跳：页面被直接关掉时 TCP 不一定立刻断，幽灵连接会白占座位。
   每 15s 发一个 WS ping，45s 收不到任何帧（含 pong）就销毁连接触发清理。 */
const sockets = new Set();
const PING_EVERY = Number(process.env.PING_EVERY) || 15000;
const DEAD_AFTER = Number(process.env.DEAD_AFTER) || 45000;

setInterval(() => {
  const now = Date.now();
  for (const c of sockets) {
    if (!c.alive) continue;
    if (now - c.lastSeen > DEAD_AFTER) {
      log(`心跳超时，踢掉 ${c.name || '未命名'}（座位 ${c.seat}）`);
      try { c.socket.destroy(); } catch { }
      continue;
    }
    try { c.socket.write(encodeControl(0x9, Buffer.alloc(0))); } catch { }
  }
}, PING_EVERY);

/* ================================================================== */
/* 连接处理                                                           */
/* ================================================================== */
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();

  if (upgrade !== 'websocket' || !key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  socket.on('error', () => { try { socket.destroy(); } catch { } });

  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const client = {
    socket, seat: -1, name: '', room: null, alive: true, rejected: false, lastSeen: Date.now(),
  };
  sockets.add(client);

  let roomParam = new URL(req.url, 'http://x').searchParams.get('room') || 'main';

  const cleanup = () => {
    if (!client.alive) return;
    client.alive = false;
    sockets.delete(client);
    const room = client.room;
    if (!room) return;
    room.clients = room.clients.filter((c) => c !== client);

    if (room.clients.length === 0) {
      // 没人了：本局作废，等下一批人重开
      room.phase = 'wait';
      room.world = null;
      room.match = null;
      room.emptySince = Date.now();
    } else {
      // 重排座位，让留下的人继续坐 0
      room.clients.forEach((c, i) => { c.seat = i; });
      room.phase = 'wait';
      room.world = null;
      room.match = null;
      broadcast(room, { t: 'peer', state: 'left' });
      broadcast(room, roomState(room));
    }
    log(`玩家离开房间 ${room.id}（剩 ${room.clients.length}）`);
  };

  const parser = createParser((m) => {
    client.lastSeen = Date.now();
    if (m.__ping) {
      try { socket.write(encodeControl(0xA, m.payload)); } catch { }
      return;
    }
    if (m.__pong || !m.text) return;

    let msg;
    try { msg = JSON.parse(m.text); } catch { return; }
    handle(client, msg, roomParam, cleanup);
  }, cleanup);

  socket.on('data', parser);
  socket.on('close', cleanup);
  socket.on('end', cleanup);
});

function handle(client, msg, roomParam, cleanup) {
  switch (msg.t) {
    case 'hello': {
      if (client.room) break;
      const roomId = String(msg.room || roomParam || 'main').slice(0, 24).replace(/[^\w-]/g, '') || 'main';
      const room = getRoom(roomId);

      // 先清掉房间里的死连接（半开 socket，心跳可能还没轮到），避免被幽灵占位卡死
      room.clients = room.clients.filter((c) => {
        const dead = c.socket.destroyed || !c.socket.writable;
        if (dead) { c.alive = false; sockets.delete(c); }
        return !dead;
      });

      if (room.clients.length >= MASK_MAX) {
        client.rejected = true;   // 标记：后续 join 不再回 NO_HELLO，避免误导性报错
        send(client, { t: 'err', code: 'ROOM_FULL', msg: '房间已满（最多 2 人），换个房间号试试' });
        setTimeout(cleanup, 100);
        break;
      }

      client.name = String(msg.name || '').slice(0, 14) || `玩家 ${room.clients.length + 1}`;
      client.seat = room.clients.length;
      client.room = room;
      room.clients.push(client);
      room.emptySince = 0;

      send(client, { t: 'welcome', seat: client.seat, room: room.id, name: client.name });
      broadcast(room, roomState(room));
      log(`玩家 ${client.name} 进入房间 ${room.id}（座位 ${client.seat}）`);

      if (room.clients.length >= 2 && room.phase === 'wait') startGame(room);
      break;
    }

    case 'join': {
      // 客户端会补一条 join；已入房或被拒（满房）则忽略
      if (!client.room && !client.rejected) {
        send(client, { t: 'err', code: 'NO_HELLO', msg: '先发 hello' });
      }
      break;
    }

    case 'shot': {
      const room = client.room;
      if (!room || !room.world || room.phase !== 'aim') break;
      if (room.match.turn !== client.seat) break;

      room.markPotted = room.world.pocketed.slice();
      const r = applyShot(room.world, {
        angle: Number(msg.angle) || 0,
        power: Number(msg.power) || 0,
        spin: msg.spin ? { a: Number(msg.spin.a) || 0, b: Number(msg.spin.b) || 0 } : { a: 0, b: 0 },
      });
      if (!r.ok) break;
      if (r.miscue) broadcast(room, { t: 'toast', text: '滑杆了！击球点太靠边' });
      room.phase = 'run';
      room.acc = 0;
      broadcast(room, { t: 'evt', type: 'cue' });
      break;
    }

    case 'place': {
      // 自由球摆放：只有「轮到自己 + 自己持有自由球 + 当前可出杆」时才受理
      const room = client.room;
      if (!room || !room.world || room.phase !== 'aim') break;
      if (room.match.ballInHand !== client.seat) break;
      if (room.match.turn !== client.seat) break;
      const x = Number(msg.x), y = Number(msg.y);
      if (!placeCue(room.world, x, y)) {
        send(client, { t: 'toast', text: '这个位置放不了（压球或压袋口）' });
        break;
      }
      room.match.ballInHand = null;
      broadcast(room, { t: 'toast', text: '母球已摆好，出杆' });
      break;
    }

    case 'aim': {
      const room = client.room;
      if (!room) break;
      broadcast(room, {
        t: 'oppAim',
        seat: client.seat,
        angle: Number(msg.angle) || 0,
        power: Number(msg.power) || 0,
      });
      break;
    }

    case 'rematch': {
      const room = client.room;
      if (!room) break;
      if (!room.match) { if (room.clients.length >= 2) startGame(room); break; }
      if (room.phase !== 'over') break;
      client.voted = true;
      if (room.clients.length >= 2 && room.clients.every((c) => c.voted)) {
        room.clients.forEach((c) => { c.voted = false; });
        startGame(room);
      } else {
        send(client, { t: 'toast', text: '等待对手确认再来一局…' });
      }
      break;
    }

    case 'ping':
      send(client, { t: 'pong', ts: msg.ts });
      break;
  }
}

/* ================================================================== */
/* 启动                                                               */
/* ================================================================== */
function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

function log(...a) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${t}]`, ...a);
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = lanIPs();
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║        双人台球 · 局域网对战 已启动          ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
  console.log(`  本机：      http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  局域网：    http://${ip}:${PORT}`);
  console.log('');
  console.log('  两台电脑连同一个 WiFi，各自打开上面「局域网」地址即可对战。');
  console.log(`  台面尺寸 ${TW}m × ${TH}m，服务端物理 ${Math.round(1 / STEP)}Hz，快照 20Hz。`);
  console.log('  首次运行 Windows 会弹防火墙提示，请点「允许访问」。');
  console.log('');
});
