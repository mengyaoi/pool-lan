/**
 * lib/room.mjs — 房间状态机（服务端裁判，无物理）
 *
 * 和旧版 server.js 的关键差别：这里不再持有一个 world、不再 40Hz 广播快照。
 * 服务器只记「谁轮到、花色、比分、这一杆是否合法」，球位由两端各自算出来。
 * 状态极小（几百字节），因此可以直接塞进 HTTP 响应/Redis，Vercel 无状态也能跑。
 */
import { MAX_SEATS, normalizeShot, normalizePlace, out } from './protocol.mjs';

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
    updatedAt: Date.now(),
  };
}

/** 房间对客户端可见的视图（不含 token） */
export function publicRoom(room) {
  return {
    id: room.id,
    players: room.players.map((p) => ({ seat: p.seat, name: p.name, online: true })),
    phase: room.phase,
    round: room.round,
    turn: room.turn,
    group: room.group,
    open: room.open,
    winner: room.winner,
    ballInHand: room.ballInHand,
  };
}

/**
 * 分配座位。重复连接（同一 token）视为重连，返回原座位。
 * @returns {{ room, seat, reconnected: boolean, full: boolean, events: object[] }}
 */
export function seatPlayer(room, { name, token }) {
  const events = [];
  const existing = token ? room.players.find((p) => p.token === token) : null;
  if (existing) {
    existing.name = name || existing.name;
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
  room.players.push({ seat, name: name || `玩家 ${seat + 1}`, token: token || '' });
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
  room.shotSeq = 0;
  room.updatedAt = Date.now();
  return [out.start(0, null, room.round), out.turn(0), out.groups(room.group, room.open)];
}

/**
 * 有人离开：只移除本人，绝不重排其他人的座位。
 * 重排会让还连着的人的 token 指向错位置，是房间卡「已满」的根因。
 */
export function leavePlayer(room, seat) {
  const before = room.players.length;
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
  room.phase = 'run';
  room.updatedAt = Date.now();
  return { ok: true, seq: room.shotSeq, events: [out.shot(seat, shot)] };
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

  if (Array.isArray(result.group)) room.group = result.group;
  if (typeof result.open === 'boolean') room.open = result.open;
  room.ballInHand = result.ballInHand ?? null;
  events.push(out.groups(room.group, room.open));

  if (result.over) {
    room.phase = 'over';
    room.winner = result.winner ?? null;
    events.push(out.over(room.winner));
  } else {
    room.phase = 'aim';
    room.turn = result.turn ?? (1 - p.seat);
    events.push(out.turn(room.turn));
  }
  if (result.hint) events.push(out.toast(result.hint));
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
