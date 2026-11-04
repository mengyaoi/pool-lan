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

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);