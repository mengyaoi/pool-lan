/**
 * worker/index.mjs — Cloudflare Workers 版联机服务
 *
 * 与 api/ws.mjs（Vercel 版）的关系
 *   · 游戏逻辑完全复用 lib/room.mjs + lib/protocol.mjs，两边只是宿主不同。
 *   · 关键差别：Cloudflare 用 Durable Object 做「一房间一实例」。
 *     Vercel 的函数是无状态的，两个玩家可能落到不同实例、互相看不见；
 *     Durable Object 由 roomId 决定路由，同一个房间必然落在同一个对象上，根除该问题。
 *
 * 为什么用 hibernation
 *   · 免费档按 WebSocket 消息计费，但空闲连接可以休眠、不计 duration。
 *     acceptWebSocket() + serializeAttachment() 让连接休眠后仍能恢复座位信息。
 */
import { normalizeRoom, out, PROTOCOL } from '../lib/protocol.mjs';
import {
  createRoom, publicRoom, seatPlayer, acceptShot, acceptPlace,
  reportShot, requestRematch, leavePlayer, recoverStalled,
} from '../lib/room.mjs';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, protocol: PROTOCOL, backend: 'cloudflare-do' }), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }

    if (url.pathname === '/api/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      const roomId = normalizeRoom(url.searchParams.get('room'));
      const id = env.ROOMS.idFromName(roomId);
      return env.ROOMS.get(id).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};

/* ================================================================== */
/* Durable Object：一个房间一个实例                                    */
/* ================================================================== */

export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null;
  }

  /** 首次或休眠唤醒后加载房间状态；房间号由 Worker 通过 URL 传入 */
  async load(roomId) {
    if (this.room) return this.room;
    this.room = await this.state.storage.get('room');
    if (!this.room) this.room = createRoom(normalizeRoom(roomId));
    this.roomId = this.room.id;
    return this.room;
  }

  async save() {
    if (this.room) await this.state.storage.put('room', this.room);
  }

  /** 房间内所有活跃（或休眠）的连接 */
  peers() {
    return this.state.getWebSockets();
  }

  broadcast(obj, except = null) {
    const data = JSON.stringify(obj);
    for (const ws of this.peers()) {
      if (except && ws === except) continue;
      try { ws.send(data); } catch { }
    }
  }

  broadcastAll(msgs) {
    for (const m of msgs) this.broadcast(m);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const roomId = normalizeRoom(url.searchParams.get('room'));
    const room = await this.load(roomId);
    const token = url.searchParams.get('token') || '';
    const name = url.searchParams.get('name') || '';

    // 用真实活着的连接核对座位：崩溃/被系统杀掉的旧连接不会走 close，
    // 座位上却一直留着记录，结果房间永远「已满」。
    const liveSeats = this.state.getWebSockets()
      .map((ws) => (ws.deserializeAttachment() || {}).seat)
      .filter((s) => Number.isInteger(s));
    const r = seatPlayer(room, { name, token, liveSeats });
    if (r.full) {
      // 房间已满：不开 socket，直接拒绝，省一次消息往返
      server.accept();
      server.send(JSON.stringify(out.err('ROOM_FULL', '房间已满（最多 2 人），换个房间号试试')));
      server.close(1000, 'room full');
      return new Response(null, { status: 101, webSocket: client });
    }

    // 同一 token 重连时，旧连接若还挂着就必须踢掉：
    // 否则两个人的收件箱里有一个是僵尸连接，出杆广播会发不到真人。
    if (r.reconnected) {
      for (const old of this.state.getWebSockets()) {
        const att = old.deserializeAttachment() || {};
        if (att.token === token && att.seat === r.seat) {
          try { old.close(4000, 'replaced by reconnect'); } catch { }
        }
      }
    }

    // 座位信息挂到连接上，休眠唤醒后仍能读回来
    server.serializeAttachment({ seat: r.seat, token });

    this.state.acceptWebSocket(server);
    await this.save();

    // hello 阶段就把开局信息一次发全，避免客户端多等一轮
    server.send(JSON.stringify(out.welcome(r.seat, room.id, name || `玩家 ${r.seat + 1}`)));
    this.broadcast(out.room(publicRoom(room)));
    if (r.events.length) this.broadcastAll(r.events);
    await this.save();

    return new Response(null, { status: 101, webSocket: client });
  }

  /** 收到消息（休眠唤醒后也走这里） */
  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    const att = ws.deserializeAttachment() || {};
    const seat = att.seat;
    const room = await this.load(this.roomId);

    // 每一帧消息都顺手回收僵死一杆：上报丢失时房间不能永久卡在 run
    const recovered = recoverStalled(room);
    if (recovered.length) { this.broadcastAll(recovered); await this.save(); }

    if (msg.t === 'ping') {
      // 心跳顺便刷新 lastSeen：DO 里 close 不一定会触发，靠这个判断座位上的人还活着
      const me = room.players.find((p) => p.seat === seat);
      if (me) { me.lastSeen = Date.now(); me.goneAt = 0; }
      try { ws.send(JSON.stringify(out.pong(msg.ts))); } catch { }
      return;
    }
    if (msg.t === 'join') { try { ws.send(JSON.stringify(out.room(publicRoom(room)))); } catch { } return; }
    if (msg.t === 'resync') { try { ws.send(JSON.stringify({ t: 'state', room: publicRoom(room) })); } catch { } return; }

    if (msg.t === 'aim') {
      const data = JSON.stringify(out.aim(seat, Number(msg.angle) || 0, Number(msg.power) || 0));
      for (const peer of this.peers()) {
        if (peer === ws) continue;
        try { peer.send(data); } catch { }
      }
      return;
    }

    switch (msg.t) {
      case 'shot': {
        const r = acceptShot(room, seat, msg);
        if (r.ok) { this.broadcastAll(r.events); await this.save(); }
        else {
          // 出杆被拒时必须把权威局面发回去让客户端回滚。
          // 以前这里直接 break，客户端仍在本地把这杆打完 → 两端分叉（一边定组一边没定）。
          try {
            ws.send(JSON.stringify(out.toast('这一杆服务器没受理，已为你同步回当前局面')));
            ws.send(JSON.stringify({ t: 'state', room: publicRoom(room), reason: r.reason }));
          } catch { }
        }
        break;
      }
      case 'place': {
        const r = acceptPlace(room, seat, msg);
        if (r.ok) { this.broadcastAll(r.events); await this.save(); }
        else { try { ws.send(JSON.stringify(out.toast('这个位置放不了（压球或压袋口）'))); } catch { } }
        break;
      }
      case 'report': {
        const r = reportShot(room, seat, msg);
        if (r.ok) { this.broadcastAll(r.events); await this.save(); }
        else {
          try {
            ws.send(JSON.stringify(out.toast('结算没对上服务器，已重新同步局面')));
            ws.send(JSON.stringify({ t: 'state', room: publicRoom(room), reason: r.reason }));
          } catch { }
        }
        break;
      }
      case 'rematch': {
        const r = requestRematch(room, seat);
        if (r.ok) { this.broadcastAll(r.events); await this.save(); }
        break;
      }
    }
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    // 重连时我们主动关掉了旧连接。此时同座位已经有新连接在服务，
    // 不能把这个座位当成「玩家离开」删掉，否则重连的人立刻被踢出房间。
    const stillServed = this.state.getWebSockets().some((other) => {
      if (other === ws) return false;
      const a = other.deserializeAttachment() || {};
      return a.seat === att.seat && a.token === att.token;
    });
    if (stillServed) return;

    const room = await this.load(this.roomId);
    // 浏览器刷新会先断后连：先留座，等重连用同一个 token 拿回原座位和牌局。
    const events = leavePlayer(room, att.seat, { keepSeat: true });
    this.broadcastAll(events);
    await this.save();
  }

  async webSocketError(ws) {
    return this.webSocketClose(ws);
  }
}
