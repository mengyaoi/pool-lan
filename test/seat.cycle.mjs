/**
 * test/seat.cycle.mjs — 座位生命周期回归（纯逻辑，不需要起服务）
 *
 * 覆盖两个真实事故：
 *   1) 有人离开后座位被重排 → 新玩家继承别人的座位号 → 房间永久「已满」
 *   2) 重连时旧连接没被踢掉 → 座位上挂两个连接 → 广播发不到真人
 */
import {
  createRoom, seatPlayer, leavePlayer, publicRoom,
} from '../lib/room.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };

// 1. 座位号不因他人离开而改变
{
  const room = createRoom('r1');
  const a = seatPlayer(room, { name: 'A', token: 'ta' });
  const b = seatPlayer(room, { name: 'B', token: 'tb' });
  ok(a.seat === 0 && b.seat === 1, '开场座位 0/1');

  leavePlayer(room, a.seat);
  ok(room.players.length === 1, 'A 离开后剩 1 人');
  ok(room.players[0].seat === 1, 'B 的座位仍是 1（不重排）');
  ok(room.players[0].token === 'tb', 'B 的 token 未被改动');

  // 新人进来应拿到空出来的 0，而不是抢 B 的 1
  const c = seatPlayer(room, { name: 'C', token: 'tc' });
  ok(c.seat === 0, 'C 拿到空出的座位 0');
  ok(room.players.length === 2, '房间恢复 2 人');
  ok(!room.players.some((p) => p.seat === 1 && p.token === 'tc'), 'C 没抢走 B 的座位');

  // 满员时第三人被拒
  const d = seatPlayer(room, { name: 'D', token: 'td' });
  ok(d.full === true, '2 人时第三人被拒');
}

// 2. 房间清空后可以重新进人（不会残留幽灵座位）
{
  const room = createRoom('r2');
  const a = seatPlayer(room, { name: 'A', token: 'ta' });
  const b = seatPlayer(room, { name: 'B', token: 'tb' });
  leavePlayer(room, a.seat);
  leavePlayer(room, b.seat);
  ok(room.players.length === 0, '两人都离开后房间为空');

  const c = seatPlayer(room, { name: 'C', token: 'tc' });
  const d = seatPlayer(room, { name: 'D', token: 'td' });
  ok(c.seat === 0 && d.seat === 1, '空房间能重新坐满 0/1');
  ok(!c.full && !d.full, '重建时没有任何一个被判满员');
}

// 3. 同 token 重连复用原座位，且不额外占位
{
  const room = createRoom('r3');
  const a = seatPlayer(room, { name: 'A', token: 'ta' });
  const again = seatPlayer(room, { name: 'A2', token: 'ta' });
  ok(again.reconnected === true, '同 token 视为重连');
  ok(again.seat === a.seat, '重连回到原座位');
  ok(room.players.length === 1, '重连没有新增座位');
}

// 4. 离开一个不存在的座位不应产生假广播
{
  const room = createRoom('r4');
  seatPlayer(room, { name: 'A', token: 'ta' });
  const ev = leavePlayer(room, 7);
  ok(Array.isArray(ev) && ev.length === 0, '离开不存在的座位不广播');
  ok(room.players.length === 1, '无效离开不影响在场玩家');
}

// 5. 座位占着但服务器上已经没有活连接 → 立刻回收，不能报「房间已满」
//    线上真实事故：旧标签页/崩溃的连接没走 close，goneAt=0，满房永远解不开。
{
  const room = createRoom('r5');
  seatPlayer(room, { name: 'GhostA', token: 'ghost-a' });
  seatPlayer(room, { name: 'GhostB', token: 'ghost-b' });
  ok(room.players.length === 2, '两个幽灵座位已占满');
  // 让它们看起来是 30 秒前就断了的僵尸座位
  for (const p of room.players) { p.goneAt = Date.now() - 30000; p.lastSeen = Date.now() - 30000; }

  // 新玩家进来时，服务器报告没有任何活连接（liveSeats 为空）
  const c = seatPlayer(room, { name: 'C', token: 'tc', liveSeats: [] });
  ok(c.full === false, '死座被回收，新人不再被判满房');
  ok(c.seat === 0 || c.seat === 1, `新人拿到可用座位（实际 ${c.seat}）`);
  ok(room.players.length === 1 && room.players[0].token === 'tc', '只剩真实新玩家，幽灵座位已清除');
}

// 6. 活连接仍占座时必须照常拒绝第三人（回收逻辑不能误伤真人）
{
  const room = createRoom('r6');
  const a = seatPlayer(room, { name: 'A', token: 'ta', liveSeats: [] });
  const b = seatPlayer(room, { name: 'B', token: 'tb', liveSeats: [a.seat] });
  ok(a.seat === 0 && b.seat === 1, 'A/B 正常入座');
  const c = seatPlayer(room, { name: 'C', token: 'tc', liveSeats: [a.seat, b.seat] });
  ok(c.full === true, '两个活连接在座时第三人仍被拒');
  ok(room.players.length === 2, '拒绝第三人后座位数没有变化');
}

// 7. 切后台超过 8 秒再回来：本人座位和整局进度必须还在
//    线上真实事故：旧逻辑先回收「过期座位」再按 token 认人，
//    把自己删掉后重连被当成新人，房间凑满两人 → startRound 把局面清零。
{
  const room = createRoom('r7');
  const a = seatPlayer(room, { name: 'A', token: 'ta' });
  const b = seatPlayer(room, { name: 'B', token: 'tb' });
  room.shots = 7;
  room.turn = 1;
  room.group = ['solid', 'stripe'];
  room.open = false;
  room.snapshot = { seq: 7, time: 900, balls: [], potted: [] };

  // 两人先后切后台，都超过宽限
  leavePlayer(room, a.seat, { keepSeat: true });
  leavePlayer(room, b.seat, { keepSeat: true });
  for (const p of room.players) { p.goneAt = Date.now() - 30000; p.lastSeen = Date.now() - 30000; }

  const a2 = seatPlayer(room, { name: 'A', token: 'ta', liveSeats: [] });
  ok(a2.reconnected === true, '超时归来仍按 token 认回（A）');
  ok(a2.seat === 0, `超时归来座位仍是 0（实际 ${a2.seat}）`);

  const b2 = seatPlayer(room, { name: 'B', token: 'tb', liveSeats: [0] });
  ok(b2.reconnected === true, '超时归来仍按 token 认回（B）');
  ok(b2.seat === 1, `超时归来座位仍是 1（实际 ${b2.seat}）`);

  ok(room.shots === 7, `整局杆数保留（实际 ${room.shots}）`);
  ok(room.turn === 1, `轮次保留（实际 ${room.turn}）`);
  ok(room.group[0] === 'solid' && room.group[1] === 'stripe', '定组保留');
  ok(room.open === false, '开球状态保留');
  ok(room.snapshot && room.snapshot.seq === 7, '快照保留');
  ok(room.players.length === 2, '没有产生重复座位');

  // 真离开的死座仍然要能被回收，不能因为这次修复永久占位
  leavePlayer(room, a.seat); leavePlayer(room, b.seat);
  ok(room.players.length === 0, '真离开后座位被释放');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
