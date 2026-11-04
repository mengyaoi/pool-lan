/**
 * eightball.smoke.mjs — 八球改造冒烟测试（Node 直接跑，不依赖浏览器）
 * 覆盖：rack15 摆球、首碰追踪、规则状态机（花色确定/犯规/黑8胜负/开球进8重摆）
 */
import * as P from '../public/js/physics.js';
import * as R from '../public/js/rules.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

console.log('== rack15 摆球 ==');
{
  const w = P.createWorld();
  P.rack15(w, 7);
  ok(w.balls.length === 16, `球数=16（母球+15），实际 ${w.balls.length}`);
  ok(Object.keys(P.BALL_COLORS).length === 16, `BALL_COLORS 含 0..15 共16，实际 ${Object.keys(P.BALL_COLORS).length}`);
  const byId = Object.fromEntries(w.balls.map(b => [b.id, b]));
  const footX = P.TW / 4;
  const gap = 2 * P.R + 0.0004;
  const rowDx = gap * Math.sqrt(3) / 2;
  ok(byId[1] && Math.abs(byId[1].x - footX) < 1e-9 && Math.abs(byId[1].y) < 1e-9, '1 号在顶点（摆球点正中）');
  ok(byId[8] && Math.abs(byId[8].x - (footX + 2 * rowDx)) < 1e-6 && Math.abs(byId[8].y) < 1e-6, '8 号在第三行正中');
  const backX = footX + 4 * rowDx;
  const back = w.balls.filter(b => Math.abs(b.x - backX) < 1e-9);
  ok(back.length === 5, `底行 5 颗，实际 ${back.length}`);
  ok(back.every(b => b.id !== 8), '8 号不在底行');
  // 底两底角一实一花
  const cornerY = (j) => (j - 2) * gap;
  const cs = back.filter(b => Math.abs(Math.abs(b.y) - 2 * gap) < 1e-6).map(b => b.id);
  const groups = cs.map(id => R.ballGroup(id));
  ok(groups.includes('solid') && groups.includes('stripe'), `后两底角一实一花：${cs}`);
  // 顶两底角不能是 8
  ok(!back.some(b => b.id === 8), '8 号不在底角');
  void cornerY;
}

console.log('== 首碰追踪 ==');
{
  const w = P.createWorld();
  // 手工摆：母球在左，目标球在右
  P.addBall(w, { id: 0, x: -0.5, y: 0 });
  P.addBall(w, { id: 3, x: 0.0, y: 0 });
  P.addBall(w, { id: 7, x: 0.0, y: 0.2 });
  w.firstContact = null;
  P.applyShot(w, { angle: 0, power: 0.9 });
  // 推进直到母球碰到球或停下
  let steps = 0;
  while (!P.settled(w) && steps < 240 * 6) { P.stepWorld(w, 1 / 240); steps++; }
  ok(w.firstContact !== null, `母球碰到了球，firstContact=${w.firstContact}`);
  ok(w.firstContact === 3 || w.firstContact === 7, '首碰是 3 或 7（正前方两颗之一）');
}

console.log('== 规则：开放表进球定花色 ==');
{
  const m = R.createMatch();
  const r = R.resolveShot(m, { newPotted: [3], cuePotted: false, firstHit: 3, anyHit: true, pottedAll: [3] });
  ok(m.group[0] === 'solid' && m.group[1] === 'stripe', `P0=实心 P1=花色，实际 ${m.group}`);
  ok(m.open === false, '开放表已关闭');
  ok(r.continueTurn === true, '进己方球继续');
}

console.log('== 规则：空杆犯规 ==');
{
  const m = R.createMatch();
  const r = R.resolveShot(m, { newPotted: [], cuePotted: false, firstHit: null, anyHit: false, pottedAll: [] });
  ok(r.foul === true, '空杆判犯规');
  ok(m.turn === 1, '换手到 P1');
  ok(r.continueTurn === false, '不继续');
}

console.log('== 规则：母球落袋犯规 ==');
{
  const m = R.createMatch();
  m.group = ['solid', 'stripe']; m.open = false;
  const r = R.resolveShot(m, { newPotted: [2], cuePotted: true, firstHit: 2, anyHit: true, pottedAll: [2] });
  ok(r.foul === true, '母球落袋判犯规');
  ok(m.turn === 1, '换手');
  ok(r.continueTurn === false, '犯规不继续（即使进了球）');
}

console.log('== 规则：先碰非法球犯规 ==');
{
  const m = R.createMatch();
  m.group = ['solid', 'stripe']; m.open = false;
  // 该碰实心却先碰花色
  const r = R.resolveShot(m, { newPotted: [], cuePotted: false, firstHit: 11, anyHit: true, pottedAll: [] });
  ok(r.foul === true, '先碰对方花色犯规');
  ok(m.turn === 1, '换手');
}

console.log('== 规则：未清完进8判负 ==');
{
  const m = R.createMatch();
  m.group = ['solid', 'stripe']; m.open = false;
  const r = R.resolveShot(m, { newPotted: [8], cuePotted: false, firstHit: 8, anyHit: true, pottedAll: [8] });
  ok(r.over === true && m.winner === 1, `进8但实心未清 → P1(对手)胜，winner=${m.winner}`);
}

console.log('== 规则：清完实心+进8且无犯规判胜 ==');
{
  const m = R.createMatch();
  m.group = ['solid', 'stripe']; m.open = false;
  const pottedAll = [1, 2, 3, 4, 5, 6, 7, 8]; // 实心全清 + 8
  const r = R.resolveShot(m, { newPotted: [7, 8], cuePotted: false, firstHit: 7, anyHit: true, pottedAll });
  ok(r.over === true && m.winner === 0, `清台打8胜，winner=${m.winner}`);
}

console.log('== 规则：进8同时母球落袋判负 ==');
{
  const m = R.createMatch();
  m.group = ['solid', 'stripe']; m.open = false;
  const pottedAll = [1, 2, 3, 4, 5, 6, 7, 8];
  const r = R.resolveShot(m, { newPotted: [8], cuePotted: true, firstHit: 8, anyHit: true, pottedAll });
  ok(r.over === true && m.winner === 1, `进8+母球落袋 → 负，winner=${m.winner}`);
}

console.log('== 规则：开球进8重摆（不判负）==');
{
  const m = R.createMatch(); // open=true
  const r = R.resolveShot(m, { newPotted: [8], cuePotted: false, firstHit: 8, anyHit: true, pottedAll: [8] });
  ok(r.over === false, '开球进8不结束');
  ok(r.respot.includes(8), '要求重摆 8 号');
  ok(m.open === true, '仍是开放表');
}

console.log('== 规则：开球进8+进球定花色 ==');
{
  const m = R.createMatch();
  const r = R.resolveShot(m, { newPotted: [8, 3], cuePotted: false, firstHit: 3, anyHit: true, pottedAll: [8, 3] });
  ok(r.over === false, '不结束');
  ok(m.group[0] === 'solid' && m.open === false, `开球进8同时进实心→P0=实心，group=${m.group}`);
  ok(r.respot.includes(8), '8 仍重摆');
}

console.log('== 规则：普通杆后 phase 回到 aim（防卡 run 死循环）==');
{
  const m = R.createMatch();
  m.phase = 'run'; // 模拟出杆时 shoot() 设为 run
  const r = R.resolveShot(m, { newPotted: [], cuePotted: false, firstHit: 1, anyHit: true, pottedAll: [] });
  ok(r.over === false, '未结束');
  ok(m.phase === 'aim', `普通杆后 phase=aim，实际 ${m.phase}`);
  ok(m.turn === 1, `空杆换手到 P1，实际 ${m.turn}`);
}
{
  const m = R.createMatch();
  m.phase = 'run';
  const r = R.resolveShot(m, { newPotted: [], cuePotted: false, firstHit: null, anyHit: false, pottedAll: [] });
  ok(r.foul === true && m.phase === 'aim', `空杆犯规后 phase 仍回到 aim（实际 ${m.phase}）`);
}

console.log('== 规则：犯规必须给对手「自由球」(ball-in-hand) ==');
{
  // ① 空杆（母球没碰到任何球）→ 对手自由球
  const m = R.createMatch();
  m.turn = 0; m.phase = 'run';
  const r = R.resolveShot(m, { newPotted: [], cuePotted: false, firstHit: null, anyHit: false, pottedAll: [] });
  ok(r.foul === true, '空杆判犯规');
  ok(m.ballInHand === 1, `空杆→对手(P1)获得自由球，实际 ${m.ballInHand}`);
  ok(m.turn === 1, `并且轮到 P1，实际 ${m.turn}`);
  ok(/自由球/.test(r.hint), `提示应含「自由球」，实际「${r.hint}」`);
}
{
  // ② 母球落袋 → 对手自由球
  const m = R.createMatch();
  m.turn = 0; m.phase = 'run';
  const r = R.resolveShot(m, { newPotted: [], cuePotted: true, firstHit: 1, anyHit: true, pottedAll: [] });
  ok(r.foul === true, '母球落袋判犯规');
  ok(m.ballInHand === 1, `母球落袋→对手(P1)获得自由球，实际 ${m.ballInHand}`);
}
{
  // ③ 先碰对方球 → 对手自由球
  const m = R.createMatch();
  m.open = false; m.group = [R.GROUP_SOLID, R.GROUP_STRIPE];
  m.turn = 1; m.phase = 'run';
  const r = R.resolveShot(m, { newPotted: [], cuePotted: false, firstHit: 1, anyHit: true, pottedAll: [] });
  ok(r.foul === true, 'P1(花色)先碰实心球判犯规');
  ok(m.ballInHand === 0, `犯规→对手(P0)获得自由球，实际 ${m.ballInHand}`);
}
{
  // ④ 合法进球不得白送自由球
  const m = R.createMatch();
  m.turn = 0; m.phase = 'run';
  const r = R.resolveShot(m, { newPotted: [3], cuePotted: false, firstHit: 3, anyHit: true, pottedAll: [3] });
  ok(r.foul === false, '合法进球不算犯规');
  ok(m.ballInHand === null, `合法杆不应有自由球，实际 ${m.ballInHand}`);
}
{
  // ⑤ 重新开局必须清掉残留的自由球
  const m = R.createMatch();
  m.ballInHand = 1;
  R.resetMatch(m);
  ok(m.ballInHand === null, `resetMatch 后 ballInHand 应为 null，实际 ${m.ballInHand}`);
}

console.log('== 物理：自由球摆放位置校验 ==');
{
  const w = P.createWorld();
  P.rack15(w);
  const cue = w.balls.find((b) => b.id === 0);
  // 台面中央空位应可放
  ok(P.canPlaceCue(w, 0, 0.3) === true, '中央空位可摆放');
  // 压在别的球上不可放
  const other = w.balls.find((b) => b.id !== 0 && !b.potted);
  ok(P.canPlaceCue(w, other.x, other.y) === false, '压在别的球上不可摆放');
  // 出台不可放
  ok(P.canPlaceCue(w, 0, 5) === false, '出台不可摆放');
  // 真放一次
  ok(P.placeCue(w, 0, 0.3) === true, 'placeCue 成功');
  ok(Math.abs(cue.x) < 1e-9 && Math.abs(cue.y - 0.3) < 1e-9, `母球落在 (0,0.3)，实际 (${cue.x},${cue.y})`);
  ok(cue.potted === false && !w.pocketed.includes(0), '母球不处于落袋态');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
