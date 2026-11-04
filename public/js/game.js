/**
 * game.js — 状态机 + 输入 + HUD
 * 只认 transport.view 这一份接口，Local / Net 两种模式共用全部逻辑。
 */
import { createRenderer } from './render.js';
import { createAudio } from './audio.js';
import { createLocalTransport, createNetTransport } from './net.js';
import { predictAim, R, BALL_COLORS } from './physics.js';
import { GROUP_SOLID, GROUP_STRIPE } from './rules.js';

const GROUP_SHORT = { [GROUP_SOLID]: '实心', [GROUP_STRIPE]: '花色', null: '未定', undefined: '未定' };
const GROUP_LIST = {
  [GROUP_SOLID]: [1, 2, 3, 4, 5, 6, 7, 8],
  [GROUP_STRIPE]: [9, 10, 11, 12, 13, 14, 15, 8],
};

const $ = (s) => document.querySelector(s);

const canvas = $('#table');
const renderer = createRenderer(canvas);
const audio = createAudio();

const el = {
  status: $('#status'), room: $('#room'),
  name0: $('#name0'), name1: $('#name1'),
  score0: $('#score0'), score1: $('#score1'),
  dots0: $('#dots0'), dots1: $('#dots1'),
  card0: $('#card0'), card1: $('#card1'),
  powerFill: $('#powerFill'), powerLabel: $('#powerLabel'),
  toast: $('#toast'), hint: $('#hint'),
  overlay: $('#overlay'), ovTitle: $('#ovTitle'), ovScore: $('#ovScore'), ovDesc: $('#ovDesc'),
  spinHint: $('#spinHint'),
};

let transport = null;
let view = null;                      // 本帧缓存（getter 会推进物理，每帧只取一次）
let aim = { angle: 0, power: 0, spin: { a: 0, b: 0 }, pred: null, showCue: true };
let dragging = false;
let dragStart = { x: 0, y: 0 };
let placing = false;                  // 自由球：正在拖动母球摆位
let placePos = { x: 0, y: 0 };
let toastTimer = null;
let spinPad = null;

/* ------------------------------------------------------------------ */
/* 杆法盘                                                              */
/* ------------------------------------------------------------------ */
function initSpinPad() {
  const pad = $('#spin-canvas');
  const g = pad.getContext('2d');
  const S = 132, M = S / 2, RAD = 52;
  let active = false;

  function pick(clientX, clientY) {
    const r = pad.getBoundingClientRect();
    let dx = ((clientX - r.left) / r.width) * S - M;
    let dy = ((clientY - r.top) / r.height) * S - M;
    const d = Math.hypot(dx, dy);
    if (d > RAD * 0.74) {                     // 超过安全区就贴边（滑杆风险区）
      dx = (dx / d) * RAD * 0.74;
      dy = (dy / d) * RAD * 0.74;
    }
    aim.spin.a = dx / RAD;       // 归一化：1 = 球半径
    aim.spin.b = -dy / RAD;
    draw();
  }

  function draw() {
    g.clearRect(0, 0, S, S);

    // 母球
    const grd = g.createRadialGradient(M - 16, M - 18, 4, M, M, RAD);
    grd.addColorStop(0, '#ffffff');
    grd.addColorStop(0.55, '#f0eee3');
    grd.addColorStop(1, '#9d9b90');
    g.beginPath(); g.arc(M, M, RAD, 0, 7); g.fillStyle = grd; g.fill();
    g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 2; g.stroke();

    // 十字
    g.strokeStyle = 'rgba(0,0,0,.13)'; g.lineWidth = 1;
    g.beginPath();
    g.moveTo(M - RAD, M); g.lineTo(M + RAD, M);
    g.moveTo(M, M - RAD); g.lineTo(M, M + RAD);
    g.stroke();

    // 滑杆危险圈
    g.beginPath(); g.arc(M, M, RAD * 0.74, 0, 7);
    g.setLineDash([3, 4]);
    g.strokeStyle = 'rgba(229,84,75,.45)'; g.lineWidth = 1.4; g.stroke();
    g.setLineDash([]);

    // 击球点
    const x = M + aim.spin.a * RAD, y = M - aim.spin.b * RAD;
    const risk = Math.hypot(aim.spin.a, aim.spin.b) > 0.74;
    g.beginPath(); g.arc(x, y, 8, 0, 7);
    g.fillStyle = risk ? '#e5544b' : '#1f6fb8';
    g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 2.2; g.stroke();

    el.spinHint.textContent = describeSpin();
  }

  function describeSpin() {
    const { a, b } = aim.spin;
    if (Math.hypot(a, b) < 0.06) return '中心';
    const parts = [];
    if (b > 0.12) parts.push('高杆');
    else if (b < -0.12) parts.push('低杆');
    if (a > 0.12) parts.push('右塞');
    else if (a < -0.12) parts.push('左塞');
    return parts.join(' · ') || '中心';
  }

  pad.addEventListener('pointerdown', (e) => {
    active = true;
    try { pad.setPointerCapture(e.pointerId); } catch { }
    pick(e.clientX, e.clientY);
  });
  pad.addEventListener('pointermove', (e) => { if (active) pick(e.clientX, e.clientY); });
  pad.addEventListener('pointerup', () => { active = false; });
  pad.addEventListener('pointercancel', () => { active = false; });

  draw();
  return { draw };
}

/* ------------------------------------------------------------------ */
/* 输入                                                               */
/* ------------------------------------------------------------------ */
function bindInput() {
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  canvas.addEventListener('pointerdown', (e) => {
    audio.unlock();
    if (!view) return;
    if (view.phase !== 'aim') return;
    const p = pos(e);

    // 自由球：按住母球即可拖到任意合法位置
    if (view.canPlace) {
      const w = renderer.screenToWorld(p.x, p.y);
      const cur = view.balls.find((b) => b.id === 0);
      if (cur && Math.hypot(w.x - cur.x, w.y - cur.y) < R * 5) {
        placing = true;
        placePos = { x: cur.x, y: cur.y };
        try { canvas.setPointerCapture(e.pointerId); } catch { }
        return;
      }
    }

    if (!view.canShoot) return;
    dragging = true;
    dragStart = p;
    aim.power = 0;
    try { canvas.setPointerCapture(e.pointerId); } catch { }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!view) return;
    const p = pos(e);

    if (placing) {
      const w = renderer.screenToWorld(p.x, p.y);
      placePos = { x: w.x, y: w.y };
      return;
    }

    const cue = view.balls.find((b) => b.id === 0 && !b.potted);
    if (!cue) return;

    if (dragging) {
      const d = Math.hypot(p.x - dragStart.x, p.y - dragStart.y);
      const maxD = Math.max(60, Math.min(renderer.size.w, renderer.size.h) * 0.42);
      aim.power = Math.min(1, d / maxD);
    } else if (view.canShoot) {
      const w = renderer.screenToWorld(p.x, p.y);
      const dx = w.x - cue.x, dy = w.y - cue.y;
      if (Math.hypot(dx, dy) > R * 0.9) aim.angle = Math.atan2(dy, dx);
    }
  });

  const release = (e) => {
    if (placing) {
      placing = false;
      const ok = transport.canPlaceCue ? transport.canPlaceCue(placePos) : true;
      if (ok && transport.placeCue) transport.placeCue(placePos);
      else showToast('这个位置放不了（压球或压袋口），换个地方');
      return;
    }
    if (!dragging) return;
    dragging = false;
    if (aim.power > 0.05 && view && view.canShoot && view.phase === 'aim') {
      transport.shoot({ angle: aim.angle, power: aim.power, spin: { ...aim.spin } });
      aim.power = 0;
    } else {
      aim.power = 0;
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', () => { if (!dragging && !placing) aim.power = 0; });

  $('#btnRematch').addEventListener('click', () => transport && transport.rematch());
  $('#ovBtn').addEventListener('click', () => { transport && transport.rematch(); });

  $('#btnRotateGo').addEventListener('click', () => { enterLandscape(); });
  $('#btnRotateSkip').addEventListener('click', () => { dismissRotateGuide(); resize(); });
  $('#btnLandscape').addEventListener('click', () => {
    if (portraitMQ.matches) {
      rotateDismissed = false;
      syncRotateGuide();
    } else {
      showToast('已经是横屏了');
    }
  });

  $('#btnSound').addEventListener('click', (e) => {
    const on = !audio.enabled;
    audio.setEnabled(on);
    e.currentTarget.textContent = on ? '音效 开' : '音效 关';
    e.currentTarget.classList.toggle('off', !on);
    if (on) audio.unlock();
  });

  $('#btnLocal').addEventListener('click', () => {
    if (transport && transport.mode === 'local') {
      showToast('当前已是本地双人模式');
      return;
    }
    switchTransport(createLocalTransport({ names: ['玩家 1', '玩家 2'] }), 'local');
    showToast('已切到本地同屏双人');
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && dragging) { dragging = false; aim.power = 0; }
  });
}

/* ------------------------------------------------------------------ */
/* 传输层切换                                                          */
/* ------------------------------------------------------------------ */
function switchTransport(t, kind) {
  if (transport && transport.dispose) transport.dispose();
  transport = t;
  aim.spin = { a: 0, b: 0 };
  aim.power = 0;
  if (kind === 'local') setStatus('本地双人对战 · 轮流出杆', true);
}

/* ------------------------------------------------------------------ */
/* HUD                                                                */
/* ------------------------------------------------------------------ */
function setStatus(text, live) {
  el.status.textContent = text;
  el.status.classList.toggle('live', !!live);
}

function showToast(text) {
  if (!text) return;
  el.toast.textContent = text;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
}

/* ------------------------------------------------------------------ */
/* 横屏引导                                                            */
/* ------------------------------------------------------------------ */
const portraitMQ = window.matchMedia('(max-aspect-ratio: 1/1)');
let rotateDismissed = false;

function syncRotateGuide() {
  const box = $('#rotate');
  if (!box) return;
  const portrait = portraitMQ.matches;
  // 转回横屏时清掉“先玩着”的状态，下次竖屏还会提醒
  if (!portrait) rotateDismissed = false;
  box.classList.toggle('hidden', !portrait || rotateDismissed);
}

function dismissRotateGuide() {
  rotateDismissed = true;
  syncRotateGuide();
}

/** 优先真正的全屏 + 屏幕方向锁定；不支持时退回“请手动横屏”提示 */
async function enterLandscape() {
  const tip = $('#rotateTip');
  let locked = false;

  try {
    const root = document.documentElement;
    if (!document.fullscreenElement && root.requestFullscreen) {
      await root.requestFullscreen({ navigationUI: 'hide' });
    }
  } catch { /* 全屏被拒不影响后面的尝试 */ }

  try {
    if (screen.orientation && typeof screen.orientation.lock === 'function') {
      await screen.orientation.lock('landscape');
      locked = true;
    }
  } catch { /* iOS Safari 等不支持锁定 */ }

  if (tip) {
    tip.textContent = locked
      ? '已切到横屏。要是没转过来，把手机横一下即可。'
      : '这台设备不支持自动转屏。请打开系统「自动旋转」，再把手机横过来。';
  }
  // 布局在旋转后会跳变几次，多补几次 resize 保证画布尺寸正确
  [0, 120, 320, 600].forEach((ms) => setTimeout(resize, ms));
}

function ballDotStyle(id) {
  const color = BALL_COLORS[id] || '#999';
  if (id === 8) return { background: 'radial-gradient(circle at 34% 28%, #3a3a40, #141417 70%)', color: '#fff' };
  const striped = id >= 9 && id <= 15;
  const bg = striped
    ? `linear-gradient(180deg, #f6f2e2 0 25%, ${color} 25% 75%, #f6f2e2 75% 100%)`
    : `radial-gradient(circle at 34% 28%, ${color}, ${color} 55%, rgba(0,0,0,.35) 130%)`;
  return { background: bg, color: '#fff' };
}

function renderDots(node, group, potted) {
  node.innerHTML = '';
  const list = GROUP_LIST[group];
  if (!list) {
    // 开放球台：花色未定，不堆 15 颗球，给个清爽提示
    const s = document.createElement('span');
    s.className = 'pdots-open';
    s.textContent = '开放球台';
    node.appendChild(s);
    return;
  }
  for (const id of list) {
    const i = document.createElement('i');
    const st = ballDotStyle(id);
    i.style.background = st.background;
    i.style.color = st.color;
    if (potted.includes(id)) i.classList.add('gone');
    if (id === 8) i.classList.add('eight');
    i.textContent = id;
    i.title = id + ' 号';
    node.appendChild(i);
  }
}

function updateHud(v) {
  const m = v.match;
  const pottedAll = m.potted || [];
  const g0 = m.group ? m.group[0] : null;
  const g1 = m.group ? m.group[1] : null;
  el.score0.textContent = GROUP_SHORT[g0] || '未定';
  el.score1.textContent = GROUP_SHORT[g1] || '未定';
  el.score0.className = 'pscore' + (g0 === GROUP_SOLID ? ' g-solid' : g0 === GROUP_STRIPE ? ' g-stripe' : '');
  el.score1.className = 'pscore' + (g1 === GROUP_SOLID ? ' g-solid' : g1 === GROUP_STRIPE ? ' g-stripe' : '');
  el.name0.textContent = v.names[0] || '玩家 1';
  el.name1.textContent = v.names[1] || '玩家 2';
  renderDots(el.dots0, m.group ? m.group[0] : null, pottedAll);
  renderDots(el.dots1, m.group ? m.group[1] : null, pottedAll);

  el.room.textContent = transport.mode === 'net'
    ? (v.roomId ? `房间 ${v.roomId} · ${location.host}` : '连接中…')
    : '本地双人 · 同屏';

  const showTurn = v.phase === 'aim' || v.phase === 'run';
  el.card0.classList.toggle('active', showTurn && m.turn === 0);
  el.card1.classList.toggle('active', showTurn && m.turn === 1);

  const pct = Math.round(aim.power * 100);
  el.powerFill.style.width = pct + '%';
  el.powerLabel.textContent = pct + '%';

  if (v.phase === 'over') {
    showOverlay(v);
    return;
  }
  el.overlay.classList.add('hidden');

  if (v.phase === 'wait') {
    setStatus(transport.mode === 'net'
      ? '等待对手加入 · 把本页地址发给对方，或点右下角「本地双人」自己先打'
      : '等待开局…');
  } else if (v.phase === 'run') setStatus('球在滚动…');
  else if (v.canPlace) {
    setStatus(`自由球 · ${v.names[m.turn]} 抓住白球拖到任意位置（也可直接出杆）`, true);
  } else if (transport.mode === 'net') {
    if (v.canShoot) setStatus('轮到你了 · 瞄准后按住拉杆', true);
    else setStatus('对手回合');
  } else {
    setStatus(`轮到 ${v.names[m.turn]} 出杆`, true);
  }
}

let overlayShown = false;
function showOverlay(v) {
  if (overlayShown) return;
  overlayShown = true;
  const m = v.match;
  const w = m.winner;
  el.ovTitle.textContent = w === 'draw' ? '平局！' : `${v.names[w] || '玩家'} 获胜`;
  el.ovScore.textContent = w === 'draw' ? '平局' : '黑8入袋';
  el.ovDesc.textContent = w === 'draw'
    ? '双方战平，再来一局分胜负'
    : `共 ${m.shots} 杆 · ${v.names[w] || '玩家'} 合法打进黑8`;
  el.overlay.classList.remove('hidden');

  // 同屏双人共用一个扬声器，一律播胜利；联机则按自己是不是赢家区分
  const isDraw = w === 'draw';
  const isMine = transport.mode === 'local' || v.mySeat === w;
  if (isDraw) audio.draw();
  else if (isMine) audio.win();
  else audio.lose();
  // 只有赢家（或平局）撒彩带，输的一方不撒
  renderer.celebrate(isDraw ? 'draw' : (isMine ? 'win' : null));
}

/* ------------------------------------------------------------------ */
/* 主循环                                                              */
/* ------------------------------------------------------------------ */
/* 特效预览队列（只给调试/自动化用，不参与游戏逻辑）。
   与 net.js 的 FX_LIFE 对齐成 0.9s，按时间戳算 t，不需要逐帧推进状态。 */
const FX_PREVIEW_MS = 900;
let debugBursts = [];
function collectEffects(nowMs) {
  if (!debugBursts.length) return view.effects;
  debugBursts = debugBursts.filter((b) => nowMs - b.born < FX_PREVIEW_MS);
  if (!debugBursts.length) return view.effects;
  return (view.effects || []).concat(debugBursts.map((b) => ({
    id: b.id, x: b.x, y: b.y, seed: b.seed, t: (nowMs - b.born) / FX_PREVIEW_MS,
  })));
}

let lastPhase = null;
function loop() {
  if (!transport) { requestAnimationFrame(loop); return; }

  view = transport.view;

  // 事件消费：音效 + 提示
  for (const ev of transport.drain()) {
    if (ev.kind === 'sfx' && typeof audio[ev.name] === 'function') {
      audio[ev.name](ev.v);
    } else if (ev.kind === 'toast') {
      showToast(ev.text);
    }
  }

  // 阶段切换：离开 over 时重置 overlay 并收掉残留彩带
  if (view.phase !== 'over') {
    if (lastPhase === 'over') renderer.celebrate(null);
    overlayShown = false;
  }
  lastPhase = view.phase;

  // 摆球状态失效（换手/重新开局/已摆好）就退出拖拽态
  if (placing && !view.canPlace) placing = false;

  const cue = view.balls.find((b) => b.id === 0 && !b.potted);
  // 持有自由球时先摆球：此时不显示球杆/瞄准线，避免让人误以为母球位置已确定
  const canAim = view.canShoot && view.phase === 'aim' && cue && !placing && !view.canPlace;

  if (canAim) {
    aim.pred = predictAim({ balls: view.balls }, aim.angle);
    aim.showCue = true;
    if (!dragging) transport.aim({ angle: aim.angle, power: aim.power, spin: aim.spin });
  } else {
    aim.pred = null;
    aim.showCue = false;
  }

  // 自由球摆放：把母球画成跟随指针的幽灵球（不改真实物理状态）
  // 注意要放到数组末尾——否则会被球堆盖住，用户看不见自己拖到哪了
  let drawBalls = view.balls;
  let placeHint = null;
  if (placing) {
    const ok = transport.canPlaceCue ? transport.canPlaceCue(placePos) : true;
    const ghost = view.balls
      .filter((b) => b.id !== 0)
      .concat([{ id: 0, x: placePos.x, y: placePos.y, potted: false, alpha: ok ? 0.9 : 0.6 }]);
    drawBalls = ghost;
    placeHint = { x: placePos.x, y: placePos.y, ok };
  }

  const nowMs = performance.now();
  renderer.render({
    balls: drawBalls,
    aim,
    opponentAim: view.opponentAim,
    isMyTurn: view.canShoot,
    effects: collectEffects(nowMs),
    placeHint,
    // 待摆放（还没开始拖）时，给母球一个脉冲"抓手"提示
    grabHint: view.canPlace && !placing ? cue : null,
    now: nowMs,
  });

  updateHud(view);
  if (spinPad) spinPad.draw();

  requestAnimationFrame(loop);
}

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */
function resize() { renderer.resize(); }

async function boot() {
  spinPad = initSpinPad();
  bindInput();

  const forcedLocal = new URLSearchParams(location.search).get('local') === '1';

  if (forcedLocal || location.protocol === 'file:') {
    switchTransport(createLocalTransport({ names: ['玩家 1', '玩家 2'] }), 'local');
  } else {
    // 探测联机服务。Vercel 上 /health 落到函数 api/ws.mjs，返回 { ok: true }。
    setStatus('连接服务端中…');
    switchTransport(createNetTransport(null, {
      onStatus: (s) => {
        if (s === 'connected') setStatus('已连接 · 等待双方就位');
        else if (s === 'closed') setStatus('连接断开，重连中…');
        else if (s === 'full') setStatus('房间已满 · 换房间号或稍后重试');
      },
    }), 'net');
  }
  resize();
  new ResizeObserver(resize).observe($('#stage'));
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));

  syncRotateGuide();
  portraitMQ.addEventListener('change', () => {
    syncRotateGuide();
    [0, 150, 400].forEach((ms) => setTimeout(resize, ms));
  });
  // 键盘/桌面窄窗口也能全屏查看
  document.addEventListener('fullscreenchange', () => {
    [0, 150, 400].forEach((ms) => setTimeout(resize, ms));
  });

  requestAnimationFrame(loop);
}

/* 只读调试句柄：方便控制台排查 / 自动化联调断言，不参与任何游戏逻辑 */
window.__pool = {
  get view() { return view; },
  get aim() { return aim; },
  get mode() { return transport && transport.mode; },
  get dragging() { return dragging; },
  get placing() { return placing; },
  toScreen: (x, y) => renderer.worldToScreen(x, y),
  /** 预览落袋粒子：__pool.fx(8, x, y) */
  fx(id = 8, x = 0, y = 0) {
    debugBursts.push({ id, x, y, born: performance.now(), seed: 1234 + id * 977 + Math.round(x * 1000) });
    audio.pocket(id);
  },
  /** 预览彩带：__pool.celebrate('win' | 'draw') */
  celebrate(w = 'win') { renderer.celebrate(w); if (w === 'win') audio.win(); },
  /** 清掉所有预览特效 */
  clearFx() { debugBursts = []; renderer.celebrate(null); },
  /** 直接试听某一层音效：__pool.sfx('ballHit', 3) */
  sfx(name, v) { if (typeof audio[name] === 'function') audio[name](v); },
  /** 分层增益：__pool.mix({ table: 0.8, cue: 1, ui: 0.6 }) */
  mix(v) { return audio.setMix(v); },
  get layers() { return audio.layers; },
};

boot();
