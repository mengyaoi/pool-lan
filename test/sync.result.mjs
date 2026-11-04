/**
 * sync.result.mjs — 一杆结算的双端一致性回归
 *
 * 复现过的真实事故：A 出杆后 A 显示轮到 B，B 仍显示轮到 A。
 * 根因是两端各自从「本地旧 turn」推算结果。现在服务端只发一份 result，
 * 两端都以它为准，且带上出杆方的停球快照。
 */
import {
  createRoom, seatPlayer, acceptShot, reportShot, publicRoom,
} from '../lib/room.mjs';
import { normalizeSnapshot } from '../lib/protocol.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };

function snapshotAt(x) {
  return {
    seq: 7, time: 1234,
    balls: [
      { i: 0, x, y: 0, p: 0, r: 0 },
      { i: 1, x: x + 1000, y: 120, p: 0, r: 0 },
      { i: 8, x: 9000, y: 300, p: 0, r: 0 },
    ],
    potted: [3, 5],
  };
}

// 1. 快照清洗：量化到毫米、过滤非法球、去重
{
  const s = normalizeSnapshot({
    seq: 1.9, time: -5,
    balls: [
      { i: 0, x: 12.3456, y: -7.89, p: 0 },
      { i: 0, x: 99, y: 99, p: 0 },
      { i: 99, x: 0, y: 0 },
      { i: 8, x: NaN, y: 0 },
    ],
    potted: [1, 1, 99, 8],
  });
  ok(s && s.balls.length === 1, '非法/重复球被过滤');
  ok(s.balls[0].x === 12 && s.balls[0].y === -8, '坐标压成毫米');
  ok(JSON.stringify(s.potted) === '[1,8]', 'potted 去重并剔除越界');
}

// 2. A 出杆 → 服务端广播的 result 对双方完全一致
{
  const room = createRoom('sync');
  const a = seatPlayer(room, { name: 'A', token: 'ta' });
  const b = seatPlayer(room, { name: 'B', token: 'tb' });
  ok(a.seat === 0 && b.seat === 1, 'A/B 落座 0/1');
  ok(room.phase === 'aim' && room.turn === 0, '开局轮到 A');

  const shot = acceptShot(room, 0, { angle: 0, power: 0.7, spin: { a: 0, b: 0 } });
  ok(shot.ok === true, 'A 的 shot 被受理');
  ok(acceptShot(room, 1, { angle: 0, power: 0.7 }).ok === false, 'B 抢杆被拒');

  const r = reportShot(room, 0, {
    turn: 1, group: ['solid', 'stripe'], open: false,
    ballInHand: null, shots: 2, over: false, winner: null,
    hint: '进 1 号，但轮到对手', snapshot: snapshotAt(500),
  });
  ok(r.ok === true, 'A 的 report 被受理');

  const results = r.events.filter((e) => e.t === 'result');
  ok(results.length === 1, '一次 report 只广播一条 result');
  const res = results[0];
  ok(res.turn === 1 && room.turn === 1, '双方权威轮次都是 1');
  ok(res.over === false && room.phase === 'aim', '非结束杆回到 aim');
  ok(JSON.stringify(res.group) === '["solid","stripe"]', '花色随 result 一起下发');
  ok(res.snapshot && res.snapshot.balls.length === 3, 'result 带停球快照');
  ok(res.snapshot.balls.find((x) => x.i === 0).x === 500, '快照球位与出杆方一致');

  // 双方都按同一条 result 落状态，不可能再各算各的
  const views = [publicRoom(room), publicRoom(room)];
  ok(views[0].turn === views[1].turn, '两名玩家读到的 turn 相同');
  ok(JSON.stringify(views[0].group) === JSON.stringify(views[1].group), '两名玩家读到的花色相同');
  ok(JSON.stringify(views[0].snapshot) === JSON.stringify(views[1].snapshot), '两名玩家读到的球位快照相同');
}

// 3. 重复 report 幂等：不会第二次推进轮次
{
  const room = createRoom('dup');
  seatPlayer(room, { name: 'A', token: 'ta' });
  seatPlayer(room, { name: 'B', token: 'tb' });
  acceptShot(room, 0, { angle: 0, power: 0.5 });
  reportShot(room, 0, { turn: 1, group: [null, null], open: true, over: false });
  const again = reportShot(room, 0, { turn: 0, group: [null, null], open: true, over: false });
  ok(again.ok === false && again.reason === 'no-pending', '重复 report 被忽略');
  ok(room.turn === 1, '重复 report 没有把轮次翻回去');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
