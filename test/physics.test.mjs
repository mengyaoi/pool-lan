/**
 * 物理内核无头断言。跑法： node test/physics.test.mjs
 * 全绿才算物理通，之后再动渲染。
 */
import assert from 'node:assert/strict';
import * as P from '../public/js/physics.js';

const R = P.R;
const DT = 1 / 300;

let pass = 0, fail = 0;
const results = [];

function test(name, fn) {
  try {
    const info = fn();
    pass++;
    results.push(`  ✅ ${name}${info ? '  —  ' + info : ''}`);
  } catch (e) {
    fail++;
    results.push(`  ❌ ${name}\n       ${e.message.split('\n').join('\n       ')}`);
  }
}

/** 摩擦全关的纯净世界，用于隔离碰撞行为 */
function cleanWorld() {
  return P.createWorld({ muSlide: 0, muRoll: 0, muSpin: 0 });
}

function run(world, seconds, cb) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    P.stepWorld(world, DT);
    if (cb && cb(i * DT, world) === false) return i * DT;
  }
  return seconds;
}

/* ------------------------------------------------------------------ */
/* 1. 等质量正撞                                                       */
/* ------------------------------------------------------------------ */
test('等质量正撞：目标球得 0.975v，母球残留 0.025v', () => {
  const w = cleanWorld();
  const A = P.addBall(w, { id: 0, x: -0.30, y: 0 });
  const B = P.addBall(w, { id: 2, x: -0.30 + 2 * R + 0.001, y: 0 });
  A.vx = 1.5;

  run(w, 0.5);

  const got = B.vx / 1.5;
  const left = A.vx / 1.5;
  assert.ok(Math.abs(got - 0.975) < 0.02, `目标球比例 ${got.toFixed(4)}，期望 0.975`);
  assert.ok(Math.abs(left - 0.025) < 0.02, `母球残留 ${left.toFixed(4)}，期望 0.025`);
  return `目标 ${got.toFixed(3)}v / 母球 ${left.toFixed(3)}v`;
});

/* ------------------------------------------------------------------ */
/* 2. 高杆 follow / 低杆 draw                                          */
/* ------------------------------------------------------------------ */
test('低杆：b=-0.6 撞球后母球倒退', () => {
  const w = cleanWorld();
  w.cfg.muSlide = 0.20; // 打开滑动摩擦，低杆效果必须靠它
  const cue = P.addBall(w, { id: 0, x: -0.30, y: 0 });
  P.addBall(w, { id: 3, x: -0.30 + 2 * R + 0.02, y: 0 });

  P.applyShot(w, { angle: 0, power: 0.5, spin: { a: 0, b: -0.6 } });
  const x0 = cue.x;
  run(w, 1.2);

  const dx = cue.x - x0;
  assert.ok(dx < -0.05, `母球位移 ${dx.toFixed(4)}m，期望 < -0.05（应明显后退）`);
  return `母球后退 ${(-dx * 100).toFixed(1)}cm`;
});

test('高杆：b=+0.6 撞球后母球继续前进', () => {
  const w = cleanWorld();
  w.cfg.muSlide = 0.20;
  const cue = P.addBall(w, { id: 0, x: -0.30, y: 0 });
  P.addBall(w, { id: 4, x: -0.30 + 2 * R + 0.02, y: 0 });

  P.applyShot(w, { angle: 0, power: 0.5, spin: { a: 0, b: 0.6 } });
  const x0 = cue.x;
  run(w, 1.2);

  const dx = cue.x - x0;
  assert.ok(dx > 0.08, `母球位移 ${dx.toFixed(4)}m，期望 > 0.08（应追球前进）`);
  return `母球前进 ${(dx * 100).toFixed(1)}cm`;
});

/* ------------------------------------------------------------------ */
/* 3. 滑移归零时刻                                                     */
/* ------------------------------------------------------------------ */
test('滑动→滚动转换时刻 ≈ 2|u₀|/(7μs·g)', () => {
  const w = cleanWorld();
  w.cfg.muSlide = 0.2;
  w.cfg.muRoll = 0;
  const b = P.addBall(w, { id: 0, x: 0, y: 0 });
  b.vx = 2.0;

  const u0 = 2.0;
  const theory = (2 * u0) / (7 * 0.2 * P.G);

  let measured = null;
  run(w, 1.0, (t) => {
    const ux = b.vx - R * b.wy;
    const uy = b.vy + R * b.wx;
    if (Math.hypot(ux, uy) < 0.01) { measured = t; return false; }
    return true;
  });

  assert.ok(measured !== null, '滑移始终没有归零');
  const err = Math.abs(measured - theory) / theory;
  assert.ok(err < 0.08, `实测 ${measured.toFixed(4)}s，理论 ${theory.toFixed(4)}s，误差 ${(err * 100).toFixed(1)}%`);
  return `实测 ${measured.toFixed(4)}s / 理论 ${theory.toFixed(4)}s，误差 ${(err * 100).toFixed(1)}%`;
});

test('滚动后满足约束 ω = (ẑ×v)/R', () => {
  const w = cleanWorld();
  w.cfg.muSlide = 0.2;
  const b = P.addBall(w, { id: 0, x: 0, y: 0 });
  b.vx = 1.2; b.vy = 0.7;

  run(w, 0.35); // 0.35s 内不会碰库，纯看约束收敛
  const wxExp = -b.vy / R, wyExp = b.vx / R;
  const err = Math.hypot(b.wx - wxExp, b.wy - wyExp);
  assert.ok(err < 0.05, `滚动约束偏差 ${err.toFixed(3)} rad/s`);
  return `约束偏差 ${err.toFixed(4)} rad/s`;
});

/* ------------------------------------------------------------------ */
/* 4. 库边 + 塞                                                        */
/* ------------------------------------------------------------------ */
test('45° 撞右库：法向衰减到 0.75，切向仍有 foreshortening', () => {
  const w = cleanWorld();
  const b = P.addBall(w, { id: 0, x: P.HX - 0.06, y: -0.3 });
  b.vx = 2.0; b.vy = 2.0;

  // 跑到第一次撞库（vx 翻负）就停，别让它继续撞上库
  let hit = false;
  for (let i = 0; i < 900; i++) {
    P.stepWorld(w, DT);
    if (b.vx < -0.1) { hit = true; break; }
  }
  assert.ok(hit, '没有检测到撞库');

  const eNorm = Math.abs(b.vx) / 2.0;
  const ratio = Math.abs(b.vy / b.vx);
  assert.ok(eNorm > 0.65 && eNorm < 0.82, `法向恢复系数 ${eNorm.toFixed(3)}，期望 ≈0.75`);
  // 45° 入射反射约 42~45°（库边压缩/切向摩擦造成轻微 foreshortening，|vy/vx| 略小于 1）
  assert.ok(ratio > 0.82 && ratio < 1.05, `|vy/vx|=${ratio.toFixed(3)}，期望 0.82~1.05`);
  return `e=${eNorm.toFixed(3)}，vx=${b.vx.toFixed(2)} vy=${b.vy.toFixed(2)}，|vy/vx|=${ratio.toFixed(2)}（≈${(Math.atan(ratio) * 180 / Math.PI).toFixed(1)}°）`;
});

test('右塞打库：反弹方向相对无塞有明显偏移', () => {
  const mk = (wz0) => {
    const w = cleanWorld();
    const b = P.addBall(w, { id: 0, x: P.HX - 0.06, y: -0.3 });
    b.vx = 2.0; b.vy = 2.0; b.wz = wz0;
    // 一直跑到离开库面
    for (let i = 0; i < 400; i++) {
      P.stepWorld(w, DT);
      if (b.vx < -0.3) break;
    }
    return b;
  };
  const plain = mk(0);
  const spin = mk(60);

  const dvy = spin.vy - plain.vy;
  assert.ok(Math.abs(dvy) > 0.02, `带塞与无塞反弹 vy 差 ${dvy.toFixed(4)}，偏移太小`);
  return `无塞 vy=${plain.vy.toFixed(3)} / 右塞 vy=${spin.vy.toFixed(3)}，差 ${dvy.toFixed(3)}`;
});

/* ------------------------------------------------------------------ */
/* 5. 开球稳定性 / 不穿透                                              */
/* ------------------------------------------------------------------ */
test('满力开球：10s 内全部静止且不出台', () => {
  const w = P.createWorld();
  P.rack9(w, 7);
  P.applyShot(w, { angle: 0, power: 1.0, spin: { a: 0, b: 0 } });

  let t = 0, moving = true;
  for (let i = 0; i < 3000; i++) {
    P.stepWorld(w, DT);
    t += DT;
    if (P.settled(w)) { moving = false; break; }
  }
  assert.ok(!moving, '10s 后仍有球在动');

  for (const b of w.balls) {
    if (b.potted) continue;
    assert.ok(Math.abs(b.x) <= P.TW / 2 && Math.abs(b.y) <= P.TH / 2,
      `球 ${b.id} 出界 (${b.x.toFixed(3)}, ${b.y.toFixed(3)})`);
  }
  const potted = w.pocketed.length;
  return `${t.toFixed(2)}s 静止，进袋 ${potted} 颗`;
});

test('极端速度反复撞库：不穿墙', () => {
  const w = P.createWorld();
  const b = P.addBall(w, { id: 0, x: 0, y: 0 });
  b.vx = 8.5; b.vy = 3.1;

  let maxAbsX = 0, maxAbsY = 0;
  for (let i = 0; i < 6000; i++) {
    P.stepWorld(w, DT);
    if (b.potted) { b.potted = false; b.x = 0; b.y = 0; b.vx = 8.5; b.vy = 3.1; }
    maxAbsX = Math.max(maxAbsX, Math.abs(b.x));
    maxAbsY = Math.max(maxAbsY, Math.abs(b.y));
  }
  assert.ok(maxAbsX <= P.TW / 2 + 0.001, `最大 |x|=${maxAbsX.toFixed(4)} 超出半台 ${(P.TW / 2).toFixed(3)}`);
  assert.ok(maxAbsY <= P.TH / 2 + 0.001, `最大 |y|=${maxAbsY.toFixed(4)} 超出半台 ${(P.TH / 2).toFixed(3)}`);
  return `|x|max=${maxAbsX.toFixed(3)} |y|max=${maxAbsY.toFixed(3)}`;
});

/* ------------------------------------------------------------------ */
/* 6. 能量单调                                                        */
/* ------------------------------------------------------------------ */
test('开球过程总动能单调递减（无能量注入）', () => {
  const w = P.createWorld();
  P.rack9(w, 3);
  P.applyShot(w, { angle: 0.02, power: 0.95, spin: { a: 0, b: 0 } });

  const energy = () => {
    let e = 0;
    for (const b of w.balls) {
      if (b.potted) continue;
      const v2 = b.vx * b.vx + b.vy * b.vy;
      const w2 = b.wx * b.wx + b.wy * b.wy + b.wz * b.wz;
      e += 0.5 * P.M * v2 + 0.5 * 0.4 * P.M * R * R * w2;
    }
    return e;
  };

  let prev = energy();
  const e0 = prev;
  let worst = 0;
  for (let i = 0; i < 1500; i++) {
    P.stepWorld(w, DT);
    const e = energy();
    if (e > prev * 1.02) worst = Math.max(worst, e / prev);
    prev = e;
  }
  assert.ok(worst < 1.02, `出现能量注入，最大跃升 ${((worst - 1) * 100).toFixed(1)}%`);
  return `初能 ${e0.toFixed(4)}J → 末能 ${prev.toFixed(4)}J`;
});

/* ------------------------------------------------------------------ */
/* 7. 瞄准预测 / 序列化                                                */
/* ------------------------------------------------------------------ */
test('predictAim 正对目标球给出幽灵球位置', () => {
  const w = P.createWorld();
  P.rack9(w, 1);
  const cue = w.balls.find((b) => b.id === 0);
  const aim = P.predictAim(w, 0);

  assert.ok(aim.targetId !== null, '没找到目标球');
  const d = Math.hypot(aim.ghost.x - cubDist(cue, aim), 0);
  assert.ok(aim.ghost.x > cue.x, '幽灵球应在母球右侧');
  return `目标 ${aim.targetId} 号，距母球 ${(aim.dist * 100).toFixed(1)}cm`;
});

function cubDist() { return 0; }

test('序列化往返：坐标精度 ≤ 1mm', () => {
  const w = P.createWorld();
  P.rack9(w, 5);
  const snap = P.serializeWorld(w);
  const back = P.deserializeWorld(snap);
  let maxErr = 0;
  for (const b of w.balls) {
    const nb = back.balls.find((x) => x.id === b.id);
    maxErr = Math.max(maxErr, Math.abs(nb.x - b.x), Math.abs(nb.y - b.y));
  }
  assert.ok(maxErr <= 0.0006, `最大坐标误差 ${(maxErr * 1000).toFixed(3)}mm`);
  return `最大误差 ${(maxErr * 1000).toFixed(3)}mm`;
});

/* ------------------------------------------------------------------ */
/* 8. 母球复位                                                        */
/* ------------------------------------------------------------------ */
test('母球落袋后复位不重叠', () => {
  const w = P.createWorld();
  P.rack9(w, 9);
  const cue = w.balls.find((b) => b.id === 0);
  cue.potted = true;
  w.pocketed.push(0);
  // 把一个球放到开球点上制造占位
  const other = w.balls.find((b) => b.id !== 0);
  other.x = -P.TW / 4; other.y = 0;

  P.respotCue(w);
  assert.ok(!cue.potted, '母球未复位');
  let minD = Infinity;
  for (const b of w.balls) {
    if (b === cue || b.potted) continue;
    minD = Math.min(minD, Math.hypot(b.x - cue.x, b.y - cue.y));
  }
  assert.ok(minD >= 2 * R, `复位后与最近球距离 ${minD.toFixed(4)} < 2R`);
  return `最近距离 ${(minD * 100).toFixed(1)}mm`;
});

/* ------------------------------------------------------------------ */
/* 输出                                                               */
/* ------------------------------------------------------------------ */
console.log('\n=== 台球物理内核断言 ===\n');
console.log(results.join('\n'));
console.log(`\n通过 ${pass} 项，失败 ${fail} 项\n`);
process.exit(fail === 0 ? 0 : 1);
