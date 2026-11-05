/**
 * lib/room.mjs — 房间状态机（服务端裁判，无物理）
 *
 * 和旧版 server.js 的关键差别：这里不再持有一个 world、不再 40Hz 广播快照。
 * 服务器只记「谁轮到、花色、比分、这一杆是否合法」，球位由两端各自算出来。
 * 状态极小（几百字节），因此可以直接塞进 HTTP 响应/Redis，Vercel 无状态也能跑。
 */
import { MAX_SEATS, normalizeShot, normalizePlace, normalizeSnapshot, out } from './protocol.mjs';

/**
 * 一个房间的权威状态。
 * @param {string} id
 */
export function createRoom(id) {
  return {
    id,
    players: [],        // [{ seat, name, token }]
    phase: 'wait',      // wait | aim | run | over
    round: 0,           // 第几局，决定 rack 种子
    turn: 0,            // 轮到谁出杆
    group: [null, null],// 双方花色
    open: true,         // 开放表
    winner: null,
    ballInHand: null,   // 自由球归属
    shotSeq: 0,         // 已受理的第几杆（防重放）
    pending: null,      // 正在飞行的这一杆 { seq, seat, shot }
    pendingAt: 0,       // pending 开始时间：用于回收「上报丢了」的僵死一杆
    snapshot: null,     // 出杆方上报的停球快照（双方对齐用）
    shots: 0,           // 累计杆数
    updatedAt: Date.now(),
  };
}

/** 房间对客户端可见的视图（不含 token） */
export function publicRoom(room) {
  return {
    id: room.id,
    players: room.players.map((p) => ({ seat: p.seat, name: p.name, online: !p.goneAt })),
    phase: room.phase,
    round: room.round,
    turn: room.turn,
    group: room.group,
    open: room.open,
    winner: room.winner,
    ballInHand: room.ballInHand,
    snapshot: room.snapshot || null,
    shots: room.shots || 0,
  };
}

/**
 * 分配座位。重复连接（同一 token）视为重连，返回原座位。
 * @returns {{ room, seat, reconnected: boolean, full: boolean, events: object[] }}
 */
export function seatPlayer(room, { name, token, liveSeats = null }) {
  const events = [];
  const now = Date.now();
  // 断线宽限：刷新/切后台通常 1~3 秒回来，给 8 秒足够；
  // 超过后即使 close 事件丢了，也按死座回收，避免房间永远「已满」。
  const GRACE = 8000;
  const stale = room.players.filter((p) => p.goneAt && now - p.goneAt > GRACE);
  if (stale.length) {
    room.players = room.players.filter((p) => !stale.includes(p));
    if (room.phase !== 'wait') { room.phase = 'wait'; room.pending = null; }
  }
  // 2) 权威核对：这个座位上已经没有活连接，就是死座，立刻回收。
  //    这是「房间一直显示已满」的真正原因——旧标签页/崩溃的连接没走到 close，
  //    goneAt 一直是 0，光靠时间戳永远回收不掉。
  if (Array.isArray(liveSeats)) {
    const alive = new Set(liveSeats);
    // 判活两路取一：socket 还在，或者最近 8 秒内发过消息（心跳 2 秒一次）。
    // DO 休眠/异常断开时 close 可能不触发，光看 socket 列表会误留死座。
    const dead = room.players.filter((p) => {
      if (token && p.token === token) return false;              // 自己正在重连
      if (alive.has(p.seat)) return false;                        // 有活 socket
      if (p.lastSeen && now - p.lastSeen <= GRACE) return false;  // 刚还有心跳
      if (p.goneAt && now - p.goneAt <= GRACE) return false;      // 刚断开
      return true;
    });
    if (dead.length) {
      room.players = room.players.filter((p) => !dead.includes(p));
      if (room.phase !== 'wait') { room.phase = 'wait'; room.pending = null; }
    }
  }
  const existing = token ? room.players.find((p) => p.token === token) : null;
  if (existing) {
    existing.name = name || existing.name;
    existing.goneAt = 0;
    existing.lastSeen = Date.now();
    room.updatedAt = Date.now();
    return { room, seat: existing.seat, reconnected: true, full: false, events };
  }
  if (room.players.length >= MAX_SEATS) {
    return { room, seat: -1, reconnected: false, full: true, events };
  }
  // 座位号必须是「不复用」的固定值：如果拿 players.length 当座位，
  // 有人离开后新玩家会继承别人的旧座位号，而对方手里的 token 仍指向那个号，
  // 会互相顶掉、并留下永远删不掉的占位记录（表现为房间一直「已满」）。
  const seat = nextFreeSeat(room);
  room.players.push({
    seat, name: name || `玩家 ${seat + 1}`, token: token || '', goneAt: 0, lastSeen: now,
  });
  room.updatedAt = Date.now();
  if (room.players.length === MAX_SEATS && room.phase === 'wait') {
    events.push(...startRound(room));
  }
  return { room, seat, reconnected: false, full: false, events };
}

/** 开局：轮次 +1，清盘面相关状态，发 start */
export function startRound(room) {
  room.round += 1;
  room.phase = 'aim';
  room.turn = 0;
  room.group = [null, null];
  room.open = true;
  room.winner = null;
  room.ballInHand = null;
  room.pending = null;
  room.pendingAt = 0;
  room.shotSeq = 0;
  room.snapshot = null;
  room.shots = 0;
  room.updatedAt = Date.now();
  return [out.start(0, null, room.round), out.turn(0), out.groups(room.group, room.open)];
}

/**
 * 有人离开：只移除本人，绝不重排其他人的座位。
 * 重排会让还连着的人的 token 指向错位置，是房间卡「已满」的根因。
 */
export function leavePlayer(room, seat, { keepSeat = false } = {}) {
  const before = room.players.length;
  if (keepSeat) {
    // 刷新/短暂断网：保留座位给本人重连，否则重连会被当成新玩家重新开局。
    const p = room.players.find((x) => x.seat === seat);
    if (!p) return [];
    p.goneAt = Date.now();
    room.updatedAt = Date.now();
    return [out.peer('left'), out.room(publicRoom(room))];
  }
  room.players = room.players.filter((p) => p.seat !== seat);
  if (room.players.length === before) return [];   // 座位本来就不存在，别广播假的「对手离开」
  room.phase = 'wait';
  room.pending = null;
  room.updatedAt = Date.now();
  return [out.peer('left'), out.room(publicRoom(room))];
}

/** 取一个当前没被占用的最小座位号 */
function nextFreeSeat(room) {
  for (let i = 0; i < MAX_SEATS; i++) {
    if (!room.players.some((p) => p.seat === i)) return i;
  }
  return room.players.length;
}

/**
 * 受理一杆。服务器只校验「是不是轮到你」「是不是在瞄准阶段」，不模拟物理。
 * 真正的犯规/花色/胜负由两端各自算完后，用 report 回来对齐。
 */
export function acceptShot(room, seat, msg) {
  if (room.phase !== 'aim') return { ok: false, reason: 'not-aiming' };
  if (room.turn !== seat) return { ok: false, reason: 'not-your-turn' };
  const shot = normalizeShot(msg);
  room.shotSeq += 1;
  room.pending = { seq: room.shotSeq, seat, shot };
  room.pendingAt = Date.now();
  room.phase = 'run';
  room.updatedAt = Date.now();
  return { ok: true, seq: room.shotSeq, events: [out.shot(seat, shot)] };
}

/**
 * 回收僵死的一杆：服务器已经受理，但出杆方一直没上报（断网/关页面/上报丢失），
 * 房间会永久卡在 run，谁都出不了杆。超时后把杆权还给出杆方，让这杆重打。
 * @returns {object[]} 需要广播的事件；空数组表示没卡住
 */
export function recoverStalled(room, staleMs = 25000, now = Date.now()) {
  if (room.phase !== 'run' || !room.pending) return [];
  if (!room.pendingAt || now - room.pendingAt <= staleMs) return [];
  const seat = room.pending.seat;
  room.pending = null;
  room.pendingAt = 0;
  room.phase = 'aim';
  room.turn = seat;          // 还给原出杆方重打，不偷走他的回合
  room.updatedAt = now;
  return [
    out.toast('上一杆没有结算完，已回到出杆方重打'),
    out.state(publicRoom(room)),
    out.turn(seat),
  ];
}

/** 受理自由球摆位（只有持球方且轮到自己时） */
export function acceptPlace(room, seat, msg) {
  if (room.phase !== 'aim') return { ok: false, reason: 'not-aiming' };
  if (room.turn !== seat) return { ok: false, reason: 'not-your-turn' };
  if (room.ballInHand !== seat) return { ok: false, reason: 'no-ball-in-hand' };
  const pos = normalizePlace(msg);
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return { ok: false, reason: 'bad-pos' };
  room.ballInHand = null;
  room.updatedAt = Date.now();
  return { ok: true, events: [out.place(seat, pos), out.toast('母球已摆好，出杆')] };
}

/**
 * 客户端算完这一杆后上报结果。服务端以此推进轮次/花色/胜负。
 * 只接受「当前 pending 那一杆」的上报，天然幂等。
 */
export function reportShot(room, seat, result) {
  if (!room.pending) return { ok: false, reason: 'no-pending' };
  if (room.pending.seat !== seat) return { ok: false, reason: 'not-shooter' };
  const events = [];
  const p = room.pending;
  room.pending = null;
  room.pendingAt = 0;

  if (Array.isArray(result.group)) room.group = result.group;
  if (typeof result.open === 'boolean') room.open = result.open;
  room.ballInHand = result.ballInHand ?? null;
  const snapshot = normalizeSnapshot(result.snapshot);
  if (snapshot) room.snapshot = snapshot;
  const shots = Number(result.shots);
  room.shots = Number.isFinite(shots) ? Math.max(0, Math.trunc(shots)) : room.shots + 1;

  if (result.over) {
    room.phase = 'over';
    room.winner = result.winner ?? null;
  } else {
    room.phase = 'aim';
    room.turn = result.turn ?? (1 - p.seat);
  }
  if (result.hint) events.push(out.toast(result.hint));
  // 这一杆的唯一权威结论：轮次、花色、胜负、停球快照一次发全。
  // 两端都按它落状态，不再各自从旧 turn 推算，避免慢帧一端算错。
  events.push(out.result({
    seat: p.seat,
    turn: room.turn,
    group: room.group,
    open: room.open,
    ballInHand: room.ballInHand,
    over: room.phase === 'over',
    winner: room.winner,
    shots: room.shots,
    snapshot: room.snapshot,
  }));
  events.push(out.groups(room.group, room.open));
  if (room.phase === 'over') events.push(out.over(room.winner));
  else events.push(out.turn(room.turn));
  room.updatedAt = Date.now();
  return { ok: true, events, seq: p.seq };
}

/** 再来一局：双方都点了才开始 */
export function requestRematch(room, seat) {
  if (room.phase !== 'over') return { ok: false, reason: 'not-over' };
  room.players.forEach((p) => { if (p.seat === seat) p.voted = true; });
  if (room.players.length < MAX_SEATS || !room.players.every((p) => p.voted)) {
    return { ok: true, events: [out.toast('等待对手确认再来一局…')] };
  }
  room.players.forEach((p) => { p.voted = false; });
  return { ok: true, events: startRound(room) };
}

/** 空闲回收判定 */
export function isExpired(room, now = Date.now(), ttlMs = 30 * 60 * 1000) {
  return room.players.length === 0 && now - room.updatedAt > ttlMs;
}
