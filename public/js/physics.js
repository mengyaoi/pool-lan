/**
 * physics.js — 台球刚体物理内核（纯 ESM，无 DOM、无 Node API，浏览器 / Node 共用）
 *
 * 坐标系：数学坐标，x 向右、y 向上、z 向上（渲染层负责 y 翻转）。
 * 单位：米 / 秒 / 弧度，绝不出像素。
 *
 * 刚体模型：球心速度 v(vx,vy) + 角速度 ω(wx,wy,wz)。
 *   wx,wy —— 与平动耦合的滚动分量
 *   wz    —— 绕竖直轴的「塞」，只影响库边反弹与球球 throw
 *
 * 关键推导（勿改符号）：
 *   接触点 r_c = -R·ẑ
 *   接触点滑移速度  u = v + ω×r_c = (vx - R·wy, vy + R·wx)
 *   滑动摩擦        a = -μs·g·û
 *                   α = (5μs·g)/(2R)·(ẑ×û)      [I = 2/5 mR²]
 *                   u̇ = -(7/2)μs·g·û           [滑移归零时刻 t = 2|u₀|/(7μs·g)]
 *   滚动约束        ω = (ẑ×v)/R  ⇔  wx = -vy/R, wy = vx/R
 *   击球点 (a,b) →  ω₀ = (5v₀/(2R))·(b·ŷ - a·ẑ)   [a 左右塞, b 高低杆]
 */

export const R = 0.028575;      // 球半径 m（57.15mm 标准球）
export const M = 0.17;          // 球质量 kg
export const G = 9.81;

export const TW = 2.54;         // 台面长（库边内沿之间）
export const TH = 1.27;         // 台面宽
export const HX = TW / 2 - R;   // 球心可达 x 上限
export const HY = TH / 2 - R;   // 球心可达 y 上限

export const POCKET_CAP = 0.070; // 进袋判定半径
export const POCKETS = [
  { x: -TW / 2, y: -TH / 2 }, { x: 0, y: -TH / 2 }, { x: TW / 2, y: -TH / 2 },
  { x: -TW / 2, y: TH / 2 }, { x: 0, y: TH / 2 }, { x: TW / 2, y: TH / 2 },
];

const JAW = 0.078;    // 角袋开口半宽（球心投影落在此区间内不参与该段库边碰撞）
const MIDJAW = 0.064; // 中袋开口半宽

export const BALL_COLORS = {
  0: '#f8f6ee',
  1: '#f4c31c', 2: '#1257b8', 3: '#cf1c28', 4: '#6d2d92', 5: '#e8781e',
  6: '#0e8a3f', 7: '#7d3f1c', 8: '#17171a',
  9: '#f4c31c', 10: '#1257b8', 11: '#cf1c28', 12: '#6d2d92', 13: '#e8781e',
  14: '#0e8a3f', 15: '#7d3f1c',
};

export const CFG = {
  muSlide: 0.20,    // 滑动摩擦
  muRoll: 0.016,    // 滚动摩擦（呢绒）
  muSpin: 0.044,    // 自旋衰减
  eBall: 0.95,      // 球-球恢复系数
  muBall: 0.06,     // 球-球切向摩擦（throw）
  eWall: 0.75,      // 库边恢复系数
  muWall: 0.20,     // 库边切向摩擦
  stopV: 0.008,     // 休眠速度阈值 m/s
  stopW: 1.0,       // 休眠自旋阈值 rad/s
  maxSpeed: 9.0,    // 速度上限（防隧穿）
  miscueR: 0.72,    // 击球点偏心超过此值判滑杆
};

/* ------------------------------------------------------------------ */
/* 世界                                                                */
/* ------------------------------------------------------------------ */

export function createWorld(cfg = {}) {
  return {
    balls: [],
    pocketed: [],
    events: [],
    time: 0,
    // 确定性随机数发生器：滑杆的抖动必须两端一致，否则联机会分叉。
    rng: 1,
    seq: 0,
    cfg: Object.assign({}, CFG, cfg),
  };
}

export function addBall(world, { id, x, y }) {
  const b = {
    id, x, y,
    vx: 0, vy: 0,
    wx: 0, wy: 0, wz: 0,
    rz: 0,
    potted: false,
    color: BALL_COLORS[id] || '#888',
  };
  world.balls.push(b);
  return b;
}

export function removeBall(world, id) {
  const i = world.balls.findIndex((b) => b.id === id);
  if (i >= 0) world.balls.splice(i, 1);
}

/** 9 球菱形摆球：1 号顶点、9 号正中，2~8 洗牌 */
export function rack9(world, seed = 1) {
  world.balls.length = 0;
  world.pocketed.length = 0;
  world.time = 0;

  const footX = TW / 4;            // 摆球点在右半台中央
  const gap = 2 * R + 0.0004;
  const rowDx = gap * Math.sqrt(3) / 2;
  const rows = [1, 2, 3, 2, 1];    // 菱形

  const rest = shuffle([2, 3, 4, 5, 6, 7, 8], seed);
  let ri = 0;

  // 母球
  addBall(world, { id: 0, x: -TW / 4, y: 0 });

  for (let r = 0; r < rows.length; r++) {
    const n = rows[r];
    for (let j = 0; j < n; j++) {
      const x = footX + r * rowDx;
      const y = (j - (n - 1) / 2) * gap;
      let id;
      if (r === 0) id = 1;
      else if (r === 2 && j === 1) id = 9;
      else id = rest[ri++];
      addBall(world, { id, x, y });
    }
  }
  world.seq++;
  return world;
}

/** 15 球三角架：1 号顶点、8 号居中，后两底角一实一花，其余洗牌（标准八球摆法） */
export function rack15(world, seed = 1) {
  world.balls.length = 0;
  world.pocketed.length = 0;
  world.time = 0;
  world.firstContact = null;

  const footX = TW / 4;            // 球堆顶点在右半台中央（开球点对面）
  const gap = 2 * R + 0.0004;
  const rowDx = gap * Math.sqrt(3) / 2;
  const rows = [1, 2, 3, 4, 5];    // 三角：行球数 1/2/3/4/5

  // 分组：实心 2-7、花色 9-15，各自洗牌
  const solids = shuffle([2, 3, 4, 5, 6, 7], seed);
  const stripes = shuffle([9, 10, 11, 12, 13, 14, 15], (seed * 7 + 1) >>> 0);

  // 母球放开放球线左侧
  addBall(world, { id: 0, x: -TW / 4, y: 0 });

  // 后两底角必须一实一花（标准规则）
  const back = [solids.pop(), null, null, null, stripes.pop()];

  // 其余空位填剩余球，再洗一次
  const mid = [];
  while (solids.length) mid.push(solids.pop());
  while (stripes.length) mid.push(stripes.pop());
  const rest = shuffle(mid, (seed * 3 + 5) >>> 0);

  let ri = 0;
  for (let r = 0; r < rows.length; r++) {
    const n = rows[r];
    for (let j = 0; j < n; j++) {
      const x = footX + r * rowDx;
      const y = (j - (n - 1) / 2) * gap;
      let id;
      if (r === 0) id = 1;                  // 顶点
      else if (r === 2 && j === 1) id = 8;   // 正中（8 号）
      else if (r === 4 && j === 0) id = back[0];  // 后左底角（实心）
      else if (r === 4 && j === 4) id = back[4];  // 后右底角（花色）
      else id = rest[ri++];                  // 其余洗牌
      addBall(world, { id, x, y });
    }
  }
  world.seq++;
  return world;
}

function shuffle(arr, seed) {
  const a = arr.slice();
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ------------------------------------------------------------------ */
/* 击球                                                                */
/* ------------------------------------------------------------------ */

/**
 * @param {object} world
 * @param {{angle:number, power:number, spin?:{a:number,b:number}}} shot
 *        angle 弧度；power 0..1；spin.a 左右塞 -1..1，spin.b 高低杆 -1..1
 * @returns {{ok:boolean, miscue?:boolean, v0?:number}}
 */
export function applyShot(world, shot) {
  const cue = world.balls.find((b) => b.id === 0 && !b.potted);
  if (!cue) return { ok: false };
  world.firstContact = null;        // 本杆母球首次触碰的球（犯规判罚用）

  const angle = shot.angle;
  let a = shot.spin ? shot.spin.a : 0;
  let b = shot.spin ? shot.spin.b : 0;
  // 击球点不许出界
  const rr = Math.hypot(a, b);
  if (rr > 1) { a /= rr; b /= rr; }

  const miscue = rr > world.cfg.miscueR;
  if (miscue) {
    // 滑杆：极少量能量 + 方向随机偏移，不出正常球。
    // 抖动必须两端一致（联机时各自算同一杆），因此用 world 上的确定性 RNG，
    // 绝不能用 Math.random —— 否则两台机器会算出不同的球路。
    const off = (nextRandom(world) - 0.5) * 0.25;
    a = (nextRandom(world) - 0.5) * 1.4;
    b = (nextRandom(world) - 0.5) * 1.4;
    shot = { angle: angle + off, power: Math.min(0.12, shot.power * 0.1) };
  }
  const power = clamp(shot.power, 0, 1);
  const vc = 0.30 + 4.70 * power;                       // 杆速 m/s
  const r = Math.min(rr, 1) * R;
  const v0 = 1.20 * vc * Math.sqrt(Math.max(0, 1 - (r / R) * (r / R)));

  const dx = Math.cos(shot.angle), dy = Math.sin(shot.angle);
  cue.vx = v0 * dx;
  cue.vy = v0 * dy;

  const k = 5 * v0 / (2 * R);
  // 局部 ŷ = ẑ × x̂ = (-dy, dx)
  cue.wx = k * b * (-dy);
  cue.wy = k * b * (dx);
  cue.wz = -k * a;

  world.seq++;
  return { ok: true, miscue, v0 };
}

/**
 * 确定性 PRNG（xorshift32）。种子存在 world 上，随世界一起重建。
 * 联机两端从同一 seed 出发、按同一顺序消费，结果必然相同。
 */
function nextRandom(world) {
  let s = (world.rng | 0) || 0x9e3779b9;
  s ^= s << 13; s |= 0;
  s ^= s >>> 17;
  s ^= s << 5; s |= 0;
  world.rng = s >>> 0;
  return ((s >>> 0) % 1000000) / 1000000;
}

/* ------------------------------------------------------------------ */
/* 推进                                                                */
/* ------------------------------------------------------------------ */

export function stepWorld(world, dt) {
  world.events.length = 0;

  let maxV = 0;
  for (const b of world.balls) {
    if (b.potted) continue;
    const s = Math.hypot(b.vx, b.vy);
    if (s > maxV) maxV = s;
  }
  // 单步位移不得超过 0.4R，否则细分
  const sub = Math.min(12, Math.max(1, Math.ceil((maxV * dt) / (0.4 * R))));
  const h = dt / sub;

  for (let s = 0; s < sub; s++) substep(world, h);

  world.time += dt;
  world.seq++;
  return world.events;
}

function substep(world, h) {
  const balls = world.balls;

  for (const b of balls) {
    if (b.potted) continue;
    integrate(b, h, world.cfg);
    checkPocket(world, b);
  }

  // 球-球：多轮迭代处理堆叠
  for (let iter = 0; iter < 4; iter++) {
    let touched = false;
    for (let i = 0; i < balls.length; i++) {
      const A = balls[i];
      if (A.potted) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const B = balls[j];
        if (B.potted) continue;
        if (ballBall(world, A, B)) touched = true;
      }
    }
    if (!touched) break;
  }

  for (const b of balls) {
    if (b.potted) continue;
    collideWalls(world, b);
    clampBall(world, b);
    sleep(b, world.cfg);
  }
}

const SLIP_EPS = 5e-3; // 滑移小于 5mm/s 视为已滚动（否则一步摩擦就过冲，ω 永远收敛不到约束）

function integrate(b, h, cfg) {
  /* ---- 平动：按「滑移归零时刻」分段推进 ----
     滑动摩擦对 u 的衰减率是 (7/2)μs·g，若本步份额超过 |u| 必须截断，
     否则一步就把 u 打到反方向，ω 会来回振荡、永远落不到滚动约束上。 */
  let left = h;
  for (let guard = 0; guard < 6 && left > 1e-9; guard++) {
    const ux = b.vx - R * b.wy;
    const uy = b.vy + R * b.wx;
    const us = Math.hypot(ux, uy);

    if (us > SLIP_EPS) {
      const nx = ux / us, ny = uy / us;
      const aF = cfg.muSlide * G;
      const kk = (5 * cfg.muSlide * G) / (2 * R); // α = (5μg/2R)(ẑ×û)
      const tSlip = (2 * us) / (7 * cfg.muSlide * G);
      const dt = Math.min(left, tSlip);

      b.vx -= aF * nx * dt;
      b.vy -= aF * ny * dt;
      b.wx += kk * (-ny) * dt;
      b.wy += kk * (nx) * dt;
      left -= dt;

      if (dt >= tSlip) { // 本段内滑移归零 → 落到滚动约束
        b.wx = -b.vy / R;
        b.wy = b.vx / R;
      }
    } else {
      // 滚动：回溯约束，勿用接触摩擦推 α（会差 5/2 倍并破坏约束）
      b.wx = -b.vy / R;
      b.wy = b.vx / R;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 1e-9) {
        const drop = cfg.muRoll * G * left;
        const ns = sp - drop;
        if (ns <= 0) { b.vx = 0; b.vy = 0; }
        else { b.vx = (b.vx / sp) * ns; b.vy = (b.vy / sp) * ns; }
      }
      left = 0;
    }
  }

  // 自旋衰减
  if (b.wz !== 0) {
    const dw = ((5 * cfg.muSpin * G) / (2 * R)) * h;
    if (Math.abs(b.wz) <= dw) b.wz = 0;
    else b.wz -= Math.sign(b.wz) * dw;
  }

  // 位置
  const sp = Math.hypot(b.vx, b.vy);
  if (sp > cfg.maxSpeed) {
    b.vx = (b.vx / sp) * cfg.maxSpeed;
    b.vy = (b.vy / sp) * cfg.maxSpeed;
  }
  b.x += b.vx * h;
  b.y += b.vy * h;
  b.rz += (Math.hypot(b.vx, b.vy) / R) * h * 0.55; // 纯视觉
}

function ballBall(world, A, B) {
  const dx = B.x - A.x, dy = B.y - A.y;
  const d2 = dx * dx + dy * dy;
  const minD = 2 * R;
  if (d2 >= minD * minD || d2 < 1e-12) return false;

  const d = Math.sqrt(d2);
  const nx = dx / d, ny = dy / d;

  // 接触点相对速度： vrel = (vA - vB) - R(ωA + ωB)×n
  //   ω×n 的 z 分量用不到，xy 分量: (wx,wy,wz)×(nx,ny,0) = (-wz·ny, wz·nx, ...)
  const wzSum = A.wz + B.wz;
  const rvx = (A.vx - B.vx) - R * (-wzSum * ny);
  const rvy = (A.vy - B.vy) - R * (wzSum * nx);
  const vn = rvx * nx + rvy * ny; // > 0 表示相互接近

  let bounced = false;

  if (vn > 1e-6) {
    // 首碰追踪（犯规判罚）：母球本杆首次触碰的球 id
    if (world.firstContact === null) {
      if (A.id === 0) world.firstContact = B.id;
      else if (B.id === 0) world.firstContact = A.id;
    }

    const e = vn < 0.08 ? 0 : world.cfg.eBall; // 低速不弹，防抖
    const Jn = (1 + e) * (M / 2) * vn;

    // 切向（throw）
    const gtx = rvx - vn * nx, gty = rvy - vn * ny;
    const gt = Math.hypot(gtx, gty);
    let Jtx = 0, Jty = 0;
    if (gt > 1e-6) {
      const jt = Math.min(world.cfg.muBall * Jn, (M * gt) / 7); // 双球切向等价质量 m/7
      Jtx = (-jt * gtx) / gt;
      Jty = (-jt * gty) / gt;
    }

    // A 受 -(Jn·n) + 切向，B 相反
    const Jx = -Jn * nx + Jtx;
    const Jy = -Jn * ny + Jty;
    A.vx += Jx / M; A.vy += Jy / M;
    B.vx -= Jx / M; B.vy -= Jy / M;

    // Δωz = (r × J)_z / I ，rA = -Rn, rB = +Rn 且 J 反号 ⇒ 两球增量相同
    const I = 0.4 * M * R * R;
    const dwz = ((-R * nx) * Jy - (-R * ny) * Jx) / I;
    A.wz += dwz; B.wz += dwz;

    bounced = true;
    if (vn > 0.25) {
      world.events.push({
        type: 'hit', x: (A.x + B.x) / 2, y: (A.y + B.y) / 2,
        speed: vn, a: A.id, b: B.id,
      });
    }
  }

  // 位置分离
  const pen = minD - d;
  if (pen > 0) {
    A.x -= (nx * pen) / 2; A.y -= (ny * pen) / 2;
    B.x += (nx * pen) / 2; B.y += (ny * pen) / 2;
  }
  return bounced || pen > 0;
}

function collideWalls(world, b) {
  // 右侧库
  if (b.x > HX && Math.abs(b.y) < TH / 2 - JAW) {
    resolveWall(world, b, -1, 0, b.x - HX);
  }
  // 左侧库
  if (b.x < -HX && Math.abs(b.y) < TH / 2 - JAW) {
    resolveWall(world, b, 1, 0, -HX - b.x);
  }
  // 上侧库（数学坐标 y 向上）
  if (b.y > HY && Math.abs(b.x) < TW / 2 - JAW && Math.abs(b.x) > MIDJAW) {
    resolveWall(world, b, 0, -1, b.y - HY);
  }
  // 下侧库
  if (b.y < -HY && Math.abs(b.x) < TW / 2 - JAW && Math.abs(b.x) > MIDJAW) {
    resolveWall(world, b, 0, 1, -HY - b.y);
  }
}

/** n 指向台内 */
function resolveWall(world, b, nx, ny, pen) {
  if (pen > 0) { b.x += nx * pen; b.y += ny * pen; }

  const vn = b.vx * nx + b.vy * ny;
  if (vn >= 0) return;

  const sp = -vn;
  const e = sp < 0.06 ? 0 : world.cfg.eWall; // 贴库防抖
  const Jn = (1 + e) * M * sp;

  // 接触点切向速度： r = -R·n, ω×r = (wz·R·ny, -wz·R·nx)
  const tx = -ny, ty = nx;
  const cvx = b.vx + b.wz * R * ny;
  const cvy = b.vy - b.wz * R * nx;
  const gt = cvx * tx + cvy * ty;

  const jtMax = (2 / 7) * M * Math.abs(gt); // 单球对固定墙等价质量 2m/7
  const jt = Math.min(world.cfg.muWall * Jn, jtMax);
  const sg = gt === 0 ? 0 : Math.sign(gt);

  const Jx = Jn * nx - jt * sg * tx;
  const Jy = Jn * ny - jt * sg * ty;
  b.vx += Jx / M;
  b.vy += Jy / M;

  const I = 0.4 * M * R * R;
  b.wz += ((-R * nx) * Jy - (-R * ny) * Jx) / I;

  if (sp > 0.12) {
    world.events.push({ type: 'cushion', x: b.x, y: b.y, speed: sp });
  }
}

function clampBall(world, b) {
  const LIMX = TW / 2 + 0.09;
  const LIMY = TH / 2 + 0.09;
  if (b.x > LIMX) { b.x = LIMX; b.vx = -Math.abs(b.vx) * 0.25; }
  if (b.x < -LIMX) { b.x = -LIMX; b.vx = Math.abs(b.vx) * 0.25; }
  if (b.y > LIMY) { b.y = LIMY; b.vy = -Math.abs(b.vy) * 0.25; }
  if (b.y < -LIMY) { b.y = -LIMY; b.vy = Math.abs(b.vy) * 0.25; }
}

function checkPocket(world, b) {
  for (let i = 0; i < POCKETS.length; i++) {
    const p = POCKETS[i];
    const dx = b.x - p.x, dy = b.y - p.y;
    if (dx * dx + dy * dy < POCKET_CAP * POCKET_CAP) {
      b.potted = true;
      b.pocketIndex = i;
      const sp = Math.hypot(b.vx, b.vy);
      b.vx = 0; b.vy = 0; b.wx = 0; b.wy = 0; b.wz = 0;
      world.pocketed.push(b.id);
      world.events.push({ type: 'pocket', id: b.id, x: p.x, y: p.y, speed: sp, pocket: i });
      return true;
    }
  }
  return false;
}

/**
 * 休眠：只在「平动与滑移都极低」时才抹掉角速度。
 * 千万别在平动过零时无条件清 ω —— 低杆碰撞后母球正是靠那一刻的强倒旋往回走的。
 */
function sleep(b, cfg) {
  const sp = Math.hypot(b.vx, b.vy);
  if (sp < 0.012) {
    const ux = b.vx - R * b.wy;
    const uy = b.vy + R * b.wx;
    if (Math.hypot(ux, uy) < 0.02) {
      b.vx = 0; b.vy = 0; b.wx = 0; b.wy = 0;
    }
  }
  if (Math.abs(b.wz) < cfg.stopW) b.wz = 0;
}

export function settled(world) {
  for (const b of world.balls) {
    if (b.potted) continue;
    if (Math.hypot(b.vx, b.vy) > 0.004) return false;
    if (Math.abs(b.wz) > 2.0) return false;
  }
  return true;
}

/** 母球落袋后复位到开球点（若被占则沿中线往左找空位） */
export function respotCue(world) {
  const cue = world.balls.find((b) => b.id === 0);
  if (!cue) return;
  cue.potted = false;
  cue.vx = 0; cue.vy = 0; cue.wx = 0; cue.wy = 0; cue.wz = 0;
  const pi = world.pocketed.indexOf(0);
  if (pi >= 0) world.pocketed.splice(pi, 1);

  let x = -TW / 4;
  for (let tries = 0; tries < 60; tries++) {
    let free = true;
    for (const b of world.balls) {
      if (b === cue || b.potted) continue;
      if (Math.hypot(b.x - x, b.y) < 2 * R + 0.002) { free = false; break; }
    }
    if (free) { cue.x = x; cue.y = 0; return; }
    x -= 2 * R + 0.004;
    if (x < -HX + 0.02) x = -TW / 4;
  }
  cue.x = -TW / 4; cue.y = 0;
}

/* ---------------- 自由球摆放（ball-in-hand） ---------------- */

/**
 * 母球能否摆到 (x,y)：台面内、不压袋口、不与任何在台球重叠。
 * 只做几何校验，不改状态。
 */
export function canPlaceCue(world, x, y) {
  const cue = world.balls.find((b) => b.id === 0);
  if (!cue) return false;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  // 球心必须在库边内沿之内（球不能压库）
  if (Math.abs(x) > HX - 0.002 || Math.abs(y) > HY - 0.002) return false;
  // 不能压在袋口上（否则一摆就掉）
  for (const p of POCKETS) {
    if (Math.hypot(x - p.x, y - p.y) < R + 0.035) return false;
  }
  // 不能和其他球重叠（留 2mm 余量）
  for (const b of world.balls) {
    if (b === cue || b.potted) continue;
    if (Math.hypot(b.x - x, b.y - y) < 2 * R + 0.002) return false;
  }
  return true;
}

/** 把母球摆到 (x,y)。合法则落位并清掉落袋记录，返回 true */
export function placeCue(world, x, y) {
  const cue = world.balls.find((b) => b.id === 0);
  if (!cue || !canPlaceCue(world, x, y)) return false;
  cue.potted = false;
  cue.vx = 0; cue.vy = 0; cue.wx = 0; cue.wy = 0; cue.wz = 0;
  cue.x = x; cue.y = y;
  const pi = world.pocketed.indexOf(0);
  if (pi >= 0) world.pocketed.splice(pi, 1);
  return true;
}

/** 把某颗已落袋的球复位到球堆区空位（开球进黑8重摆用） */export function respotBall(world, id) {
  const b = world.balls.find((x) => x.id === id);
  if (!b) return;
  b.potted = false;
  b.vx = 0; b.vy = 0; b.wx = 0; b.wy = 0; b.wz = 0;
  const pi = world.pocketed.indexOf(id);
  if (pi >= 0) world.pocketed.splice(pi, 1);

  // 优先摆球点，沿 x 往台心方向找空位
  let bestX = TW / 4, bestY = 0;
  const footX = TW / 4;
  for (let tries = 0; tries < 80; tries++) {
    let free = true;
    for (const o of world.balls) {
      if (o === b || o.potted) continue;
      if (Math.hypot(o.x - bestX, o.y - bestY) < 2 * R + 0.002) { free = false; break; }
    }
    if (free) { b.x = bestX; b.y = bestY; return; }
    bestX -= 2 * R + 0.004;
    bestY = ((tries % 2) ? 1 : -1) * (R + 0.002) * Math.ceil(tries / 2);
    if (bestX < footX - 0.6) { bestX = footX; }
  }
  b.x = TW / 4; b.y = 0;
}

/* ------------------------------------------------------------------ */
/* 瞄准预测                                                            */
/* ------------------------------------------------------------------ */

/**
 * 直线射线求首次交点（供奉引线用，不做完整物理）
 * @returns {{ghost:{x,y}|null, targetId:number|null, hit:{x,y}, dist:number, cushion:boolean, bounce:{x,y}|null}}
 */
export function predictAim(world, angle) {
  const cue = world.balls.find((b) => b.id === 0 && !b.potted);
  if (!cue) return { ghost: null, targetId: null, hit: { x: 0, y: 0 }, dist: 0, cushion: false, bounce: null };

  const dx = Math.cos(angle), dy = Math.sin(angle);
  const r2 = (2 * R) * (2 * R);

  let bestT = Infinity, target = null;
  for (const b of world.balls) {
    if (b.potted || b.id === 0) continue;
    const ox = b.x - cue.x, oy = b.y - cue.y;
    const proj = ox * dx + oy * dy;
    if (proj <= 0) continue;
    const perp2 = ox * ox + oy * oy - proj * proj;
    if (perp2 > r2) continue;
    const t = proj - Math.sqrt(r2 - perp2);
    if (t > 1e-6 && t < bestT) { bestT = t; target = b; }
  }

  // 库边距离
  let wallT = Infinity;
  if (dx > 1e-9) wallT = Math.min(wallT, (HX - cue.x) / dx);
  if (dx < -1e-9) wallT = Math.min(wallT, (-HX - cue.x) / dx);
  if (dy > 1e-9) wallT = Math.min(wallT, (HY - cue.y) / dy);
  if (dy < -1e-9) wallT = Math.min(wallT, (-HY - cue.y) / dy);

  if (target && bestT <= wallT) {
    return {
      ghost: { x: cue.x + dx * bestT, y: cue.y + dy * bestT },
      targetId: target.id,
      targetPos: { x: target.x, y: target.y },
      hit: { x: cue.x + dx * bestT, y: cue.y + dy * bestT },
      dist: bestT,
      cushion: false,
      bounce: null,
    };
  }

  const hx = cue.x + dx * wallT, hy = cue.y + dy * wallT;
  let bx = dx, by = dy;
  if (Math.abs(hx) > HX - 1e-6) bx = -dx;
  if (Math.abs(hy) > HY - 1e-6) by = -dy;
  return {
    ghost: null, targetId: null,
    hit: { x: hx, y: hy }, dist: wallT, cushion: true,
    bounce: { x: hx + bx * 0.55, y: hy + by * 0.55, dir: { x: bx, y: by } },
  };
}

/* ------------------------------------------------------------------ */
/* 序列化                                                              */
/* ------------------------------------------------------------------ */

/** 坐标压成毫米整数，减小帧体积 */
export function serializeWorld(world) {
  return {
    seq: world.seq,
    time: Math.round(world.time * 1000),
    balls: world.balls.map((b) => ({
      i: b.id,
      x: Math.round(b.x * 1000),
      y: Math.round(b.y * 1000),
      p: b.potted ? 1 : 0,
      r: Math.round(b.rz * 100) / 100,
    })),
    potted: world.pocketed.slice(),
  };
}

/** 快照还原成渲染用状态（不含物理量，客户端只用它绘制） */
export function deserializeWorld(snap) {
  return {
    seq: snap.seq,
    time: (snap.time || 0) / 1000,
    balls: snap.balls.map((b) => ({
      id: b.i, x: b.x / 1000, y: b.y / 1000, potted: !!b.p, rz: b.r || 0,
      vx: 0, vy: 0, wx: 0, wy: 0, wz: 0,
      color: BALL_COLORS[b.i] || '#888',
    })),
    pocketed: (snap.potted || []).slice(),
  };
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
