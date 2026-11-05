/**
 * shot.reject.mjs — 出杆被服务器拒收时的同步回归
 *
 * 线上真实事故：一边本地打完并定了球，另一边完全没变。
 * 根因：acceptShot 拒绝时服务器什么都不回，客户端仍在本地算完，
 * 对手也从没收到那一杆 → 两端永久分叉。
 */
import {
  createRoom, seatPlayer, acceptShot, reportShot, publicRoom, recoverStalled,
} from '../lib/room.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };

// 1. 不是自己回合：拒收，并且房间状态必须能被客户端拿来回滚
{
  const room = createRoom('rej1');
  seatPlayer(room, { name: 'A', token: 'ta' });
  seatPlayer(room, { name: 'B', token: 'tb' });
  const r = acceptShot(room, 1, { angle: 0, power: 0.5 });
  ok(r.ok === false && r.reason === 'not-your-turn', 'B 抢杆被拒（not-your-turn）');
  const view = publicRoom(room);
  ok(view.turn === 0 && view.phase === 'aim', '权威局面仍是 A 出杆 / aim');
  ok(room.pending === null, '拒收没有留下 pending');
}

// 2. 上一杆还没结算：第二杆必须拒收，且不能覆盖 pending
{
  const room = createRoom('rej2');
  seatPlayer(room, { name: 'A', token: 'ta' });
  seatPlayer(room, { name: 'B', token: 'tb' });
  const first = acceptShot(room, 0, { angle: 0, power: 0.5 });
  ok(first.ok === true, '第一杆受理');
  const second = acceptShot(room, 0, { angle: 1, power: 0.8 });
  ok(second.ok === false && second.reason === 'not-aiming', 'run 阶段重复出杆被拒');
  ok(room.pending && room.pending.seq === first.seq, '原有 pending 未被覆盖');
}

// 3. report 对不上（例如服务端重启后 pending 丢了）要能被识别
{
  const room = createRoom('rej3');
  seatPlayer(room, { name: 'A', token: 'ta' });
  seatPlayer(room, { name: 'B', token: 'tb' });
  const r = reportShot(room, 0, { turn: 1, over: false });
  ok(r.ok === false && r.reason === 'no-pending', '无 pending 的 report 被拒（可触发客户端 resync）');
}

// 4. 僵死一杆：出杆方没上报，超时后回合还给他，房间不能永久 run
{
  const room = createRoom('rej4');
  seatPlayer(room, { name: 'A', token: 'ta' });
  seatPlayer(room, { name: 'B', token: 'tb' });
  acceptShot(room, 0, { angle: 0, power: 0.6 });
  ok(room.phase === 'run', '受理后进入 run');

  const fresh = recoverStalled(room, 25000, Date.now());
  ok(fresh.length === 0, '未超时不回收（球可能还在滚）');

  const later = Date.now() + 30000;
  const events = recoverStalled(room, 25000, later);
  ok(events.length > 0, '超时后回收僵死一杆');
  ok(room.phase === 'aim' && room.turn === 0 && room.pending === null, '回到出杆方 aim，不再永久 run');
  ok(events.some((e) => e.t === 'state'), '回收时广播权威 state 供两端对齐');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
