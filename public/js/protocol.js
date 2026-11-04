/**
 * public/js/protocol.js — 确定性联机协议（服务端与客户端共用）
 *
 * 设计要点
 *   · 物理在两端各自推进：服务器不再以 40Hz 广播球位，只转发「击球指令」。
 *   · 服务器只做三件事：座位分配 / 权威裁判（犯规、花色、胜负）/ 指令转发。
 *   · 因此「自己出杆」的反馈是 0 延迟（本地立刻算），「对手出杆」只需单程 RTT。
 *   · 物理是确定性的（只有滑杆用了 Math.random，已改为种子随机），
 *     所以两端从同一 rack 种子 + 同一击球序列出发，必然得到同一局面。
 */

/** 每房间最多两人 */
export const MAX_SEATS = 2;

/** 协议版本：客户端与服务端不一致时拒绝连接，避免一方跑旧逻辑 */
export const PROTOCOL = 2;

/**
 * 房间号归一化：只保留字母数字下划线与横线，最长 24，空则 fallback。
 * 客户端与服务端必须用同一规则，否则两端会算出不同房间。
 */
export function normalizeRoom(raw, fallback = 'main') {
  const s = String(raw ?? '').slice(0, 24).replace(/[^A-Za-z0-9_-]/g, '');
  return s || fallback;
}

/**
 * 由房间号派生一个稳定的 rack 种子（开局球序）。
 * 用 FNV-1a：两端对同一房间号必然得到同一数值，不需要服务器下发。
 */
export function rackSeed(room, round = 0) {
  let h = 0x811c9dc5 >>> 0;
  const s = `${room}#${round}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 90000) + 3;
}

/**
 * 击球指令归一化。两端都用它清洗输入，保证「你发的」与「对手收的」逐字节一致。
 */
export function normalizeShot(msg) {
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const spin = msg && msg.spin;
  return {
    angle: num(msg && msg.angle),
    power: Math.min(1, Math.max(0, num(msg && msg.power))),
    spin: {
      a: spin ? Math.min(1, Math.max(-1, num(spin.a))) : 0,
      b: spin ? Math.min(1, Math.max(-1, num(spin.b))) : 0,
    },
  };
}

/** 自由球摆位归一化 */
export function normalizePlace(msg) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
  return { x: num(msg && msg.x), y: num(msg && msg.y) };
}

/** 服务端下行消息构造器：所有房间广播从这里出，改协议时一处生效 */
export const out = {
  welcome: (seat, room, name) => ({ t: 'welcome', seat, room, name, protocol: PROTOCOL }),
  room: (room) => ({ t: 'room', id: room.id, players: room.players, phase: room.phase }),
  start: (breaker, seed, round) => ({ t: 'start', breaker, seed, round }),
  turn: (p) => ({ t: 'turn', p }),
  groups: (group, open) => ({ t: 'groups', group, open }),
  over: (winner) => ({ t: 'over', winner }),
  toast: (text) => ({ t: 'toast', text }),
  evt: (type, extra) => ({ t: 'evt', type, ...(extra || {}) }),
  shot: (seat, shot) => ({ t: 'shot', seat, ...shot }),
  place: (seat, pos) => ({ t: 'place', seat, ...pos }),
  aim: (seat, angle, power) => ({ t: 'aim', seat, angle, power }),
  err: (code, msg) => ({ t: 'err', code, msg }),
  pong: (ts) => ({ t: 'pong', ts }),
  peer: (state) => ({ t: 'peer', state }),
};
