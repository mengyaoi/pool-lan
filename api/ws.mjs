/**
 * api/ws.mjs — Vercel Function：WebSocket 房间服务
 *
 * 与旧 server.js 的分工完全不同：
 *   · 旧版：服务器跑物理、40Hz 推快照（球位每次都跨网传，延迟 = RTT × 2 + 处理）
 *   · 新版：服务器只转发「击球指令」，物理两端各自算（自己出杆 0 延迟）
 *
 * 状态存放
 *   · 同一连接内的多人一定落在同一实例（Vercel 会钉住），所以房间状态放实例内存。
 *   · Hobby 函数 5 分钟会被切断，客户端重连后可凭房间 + 座位号重建。
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { normalizeRoom, out, PROTOCOL } from '../lib/protocol.mjs';
import {
  createRoom, publicRoom, seatPlayer, acceptShot, acceptPlace,
  reportShot, requestRematch, leavePlayer,
} from '../lib/room.mjs';

/** 房间表：同实例内共享。进程被回收时房间也随之消失（客户端会重连重建）。 */
const rooms = new Map();
/** 每个连接的对象，用于广播 */
const clients = new Map();   // roomId -> Set<{ ws, seat, name }>

function getRoom(id) {
  let r = rooms.get(id);
  if (!r) { r = createRoom(id); rooms.set(id, r); }
  return r;
}

function peers(roomId) {
  let s = clients.get(roomId);
  if (!s) { s = new Set(); clients.set(roomId, s); }
  return s;
}

function broadcast(roomId, obj, exceptWs = null) {
  const data = JSON.stringify(obj);
  for (const c of peers(roomId)) {
    if (c.ws === exceptWs) continue;
    if (c.ws.readyState === 1) {
      try { c.ws.send(data); } catch { }
    }
  }
}

function broadcastAll(roomId, msgs) {
  for (const m of msgs) {
    const data = JSON.stringify(m);
    for (const c of peers(roomId)) {
      if (c.ws.readyState === 1) { try { c.ws.send(data); } catch { } }
    }
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ ok: true, protocol: PROTOCOL, rooms: rooms.size }));
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const wantRoom = normalizeRoom(url.searchParams.get('room'));
  const wantSeat = url.searchParams.get('seat');
  const token = url.searchParams.get('token') || '';

  let roomId = wantRoom;
  let seat = -1;
  let name = '';
  let settled = false;   // 是否已经登记进房间（避免重复 cleanup）

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'ping') { ws.send(JSON.stringify(out.pong(msg.ts))); return; }

    if (msg.t === 'hello') {
      if (settled) return;
      roomId = normalizeRoom(msg.room || wantRoom);
      name = String(msg.name || '').slice(0, 14) || '玩家';
      const room = getRoom(roomId);
      const r = seatPlayer(room, { name, token: token || msg.token || '' });
      if (r.full) {
        ws.send(JSON.stringify(out.err('ROOM_FULL', '房间已满（最多 2 人），换个房间号试试')));
        settled = true;
        setTimeout(() => { try { ws.close(); } catch { } }, 50);
        return;
      }
      seat = r.seat;
      settled = true;
      peers(roomId).add({ ws, seat, name });
      ws.send(JSON.stringify(out.welcome(seat, roomId, name)));
      broadcastAll(roomId, [out.room(publicRoom(room))]);
      if (r.events.length) broadcastAll(roomId, r.events);
      return;
    }

    if (!settled) { ws.send(JSON.stringify(out.err('NO_HELLO', '先发 hello'))); return; }
    const room = getRoom(roomId);

    switch (msg.t) {
      case 'join':
        ws.send(JSON.stringify(out.room(publicRoom(room))));
        break;

      case 'shot': {
        const r = acceptShot(room, seat, msg);
        if (r.ok) broadcastAll(roomId, r.events);
        break;
      }

      case 'place': {
        const r = acceptPlace(room, seat, msg);
        if (r.ok) broadcastAll(roomId, r.events);
        else ws.send(JSON.stringify(out.toast('这个位置放不了（压球或压袋口）')));
        break;
      }

      case 'report': {
        const r = reportShot(room, seat, msg);
        if (r.ok) broadcastAll(roomId, r.events);
        break;
      }

      case 'aim':
        broadcast(roomId, out.aim(seat, Number(msg.angle) || 0, Number(msg.power) || 0), ws);
        break;

      case 'rematch': {
        const r = requestRematch(room, seat);
        if (r.ok) broadcastAll(roomId, r.events);
        break;
      }

      case 'resync':
        ws.send(JSON.stringify({ t: 'state', room: publicRoom(room) }));
        break;
    }
  });

  const cleanup = () => {
    if (!settled) return;
    settled = false;
    const set = peers(roomId);
    for (const c of set) if (c.ws === ws) set.delete(c);
    const room = rooms.get(roomId);
    if (room) broadcastAll(roomId, leavePlayer(room, seat));
    if (set.size === 0) clients.delete(roomId);
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// 心跳：Vercel 会在 5 分钟切断长连接，这里只负责及早发现死连接
const timer = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { try { ws.terminate(); } catch { } continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { }
  }
}, 15000);
timer.unref?.();

export default server;
