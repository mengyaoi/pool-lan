/**
 * game.js — 状态机 + 输入 + HUD
 * 只认 transport.view 这一份接口，Local / Net 两种模式共用全部逻辑。
 */
import { createRenderer } from './render.js';
import { createAudio } from './audio.js';
import { createLocalTransport, createNetTransport } from './net.js';
import { predictAim, R, BALL_COLORS } from './physics.js';
import { GROUP_SOLID, GROUP_STRIPE, groupRemaining } from './rules.js';

// 文案直接写「光球 / 花球」，跟玩家口语一致，避免「实心/花色」看不懂
const GROUP_SHORT = { [GROUP_SOLID]: '光球 1-7', [GROUP_STRIPE]: '花球 9-15', null: '未定', undefined: '未定' };
const GROUP_LIST = {
  [GROUP_SOLID]: [1, 2, 3, 4, 5, 6, 7, 8],
  [GROUP_STRIPE]: [9, 10, 11, 12, 13, 14, 15, 8],
};

const $ = (s) => document.querySelector(s);

const canvas = $('#table');
const renderer = createRenderer(canvas);
const audio = createAudio();

/* 界面被 CSS 转过 90°（fake-landscape）时，getBoundingClientRect 得到的是外接矩形，
   不能直接拿来算触摸点。这里统一换算成元素自身坐标。 */
function elementPoint(el, clientX, clientY) {
  if (!document.body.classList.contains('fake-landscape')) {
    const r = el.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top, w: r.width, h: r.height };
  }
  // 局部坐标 (x,y) 旋转后落在屏幕 (W - y, x)
  let x = clientY, y = window.innerWidth - clientX;
  for (let n = el; n && n !== document.body; n = n.offsetParent) {
    x -= n.offsetLeft;
    y -= n.offsetTop;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

const el = {
  status: $('#status'), room: $('#room'),
  name0: $('#name0'), name1: $('#name1'),
  score0: $('#score0'), score1: $('#score1'),
  dots0: $('#dots0'), dots1: $('#dots1'),
  card0: $('#card0'), card1: $('#card1'),
  task0: $('#task0'), task1: $('#task1'),
  powerFill: $('#powerFill'), powerLabel: $('#powerLabel'),
  powerTrack: $('#powerTrack'),
  toast: $('#toast'), hint: $('#hint'),
  overlay: $('#overlay'), ovTitle: $('#ovTitle'), ovScore: $('#ovScore'), ovDesc: $('#ovDesc'),
  spinHint: $('#spinHint'),
  roomBar: $('#roomBar'), btnRoom: $('#btnRoom'),
  roomModal: $('#roomModal'), rmCode: $('#rmCode'), rmInvite: $('#rmInvite'),
  rmCreate: $('#rmCreate'), rmJoin: $('#rmJoin'), rmCopy: $('#rmCopy'),
  rmClose: $('#rmClose'), rmTip: $('#rmTip'),
};

/**
 * 找出触点附近最近的一颗目标球（不含母球/已落袋），用于「点球瞄准」。
 * 命中半径按「屏幕像素」算：手机横屏一颗球只有 10px，按物理半径算手指
 * 几乎点不中；按 28px 算才是正常人能稳定点中的大小。
 */
function nearestBall(balls, world, radiusPx = 28) {
  let best = null, bestD = Infinity;
  for (const b of balls) {
    if (b.potted || b.id === 0) continue;
    const sp = renderer.worldToScreen(b.x, b.y);
    const wp = renderer.worldToScreen(world.x, world.y);
    const d = Math.hypot(sp.x - wp.x, sp.y - wp.y);
    if (d <= radiusPx && d < bestD) { bestD = d; best = b; }
  }
  return best;
}

let transport = null;
let view = null;                      // 本帧缓存（getter 会推进物理，每帧只取一次）
let aim = { angle: 0, power: 0, spin: { a: 0, b: 0 }, pred: null, showCue: true };
let dragging = false;
let dragStart = { x: 0, y: 0 };
let dragMode = null;                  // 'aim' = 拖动改角度，'power' = 后拉蓄力
let aimLockedBallId = null;           // 最近一次点中的目标球（只用于提示）
let dragStartAngle = 0;               // 按下瞬间的球杆角度（相对旋转用）
let dragCueVec = { x: 0, y: 0 };      // 按下瞬间「手指相对母球」的向量
let dragTapWorld = null;              // 按下点（世界坐标），仅在「轻点」时用来瞄准
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
    const p = elementPoint(pad, clientX, clientY);
    let dx = (p.x / p.w) * S - M;
    let dy = (p.y / p.h) * S - M;
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
/** 力度滑杆：点一下就按这个力度出杆；按住拖动可先看力度，松手出杆 */
function initPowerSlider() {
  const track = el.powerTrack;
  if (!track) return;
  let active = false;
  let startPower = 0;

  // 用元素自身坐标算比例：界面被 CSS 转过 90° 时，外接矩形的宽高是反的
  const setFromClientX = (clientX, clientY) => {
    const p = elementPoint(track, clientX, clientY);
    if (!p.w) return;
    // 用元素局部坐标的 x 轴：被 CSS 转过 90° 时它仍然是滑轨方向
    aim.power = Math.min(1, Math.max(0, p.x / p.w));
    syncPowerHud();
  };

  track.addEventListener('pointerdown', (e) => {
    if (!view || !view.canShoot || view.phase !== 'aim') return;
    active = true;
    startPower = aim.power;
    audio.unlock();
    try { track.setPointerCapture(e.pointerId); } catch { }
    setFromClientX(e.clientX, e.clientY);
  });
  track.addEventListener('pointermove', (e) => {
    if (!active) return;
    setFromClientX(e.clientX, e.clientY);
  });
  track.addEventListener('pointercancel', () => {
    if (!active) return;
    active = false;
    aim.power = startPower;
    syncPowerHud();
  });
  // 只在这里出杆一次：手指抬起时可能已经离开细条本身，所以监听 window（捕获阶段）
  window.addEventListener('pointerup', () => {
    if (!active) return;
    active = false;
    // 点一下就出杆：手指落点已经决定力量，抬起立即击球
    fireShot();
  }, true);

  // 键盘：方向键调力量，回车出杆
  track.addEventListener('keydown', (e) => {
    if (!view || !view.canShoot) return;
    // 房间面板开着时，输入房间号的按键不能顺带触发「空格出杆」
    if (!el.roomModal?.classList.contains('hidden')) return;
    if (e.key === 'Enter' || e.key === ' ') { fireShot(); e.preventDefault(); return; }
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') aim.power = Math.min(1, aim.power + 0.05);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') aim.power = Math.max(0, aim.power - 0.05);
    else return;
    syncPowerHud();
    e.preventDefault();
  });
}

/** 把 aim.power 同步到力量条与无障碍属性 */
function syncPowerHud() {
  const pct = Math.round(aim.power * 100);
  if (el.powerFill) el.powerFill.style.width = pct + '%';
  if (el.powerLabel) el.powerLabel.textContent = pct + '%';
  if (el.powerTrack) el.powerTrack.setAttribute('aria-valuenow', String(pct));
}

/** 用当前力量和角度击球（由力量条触发） */
function fireShot() {
  if (!view || !transport) return;
  if (view.phase !== 'aim') return;
  if (!view.canShoot) { showToast('还没轮到你出杆'); return; }
  // 没设力量时给一个稳妥的默认值，别让人卡在「点半天没反应」
  if (aim.power < 0.05) aim.power = 0.5;
  const ok = transport.shoot({ angle: aim.angle, power: aim.power, spin: { ...aim.spin } });
  if (ok) { aim.power = 0; syncPowerHud(); }
  else showToast('这杆没能发出去，等这轮结束再试');
}

function bindInput() {
  const pos = (e) => elementPoint(canvas, e.clientX, e.clientY);

  canvas.addEventListener('pointerdown', (e) => {
    audio.unlock();
    if (!view) return;
    if (view.phase !== 'aim') return;
    const p = pos(e);

    // 自由球：按住母球即可拖到任意合法位置
    if (view.canPlace) {
      const w = renderer.screenToWorld(p.x, p.y);
      const cur = view.balls.find((b) => b.id === 0);
      // 自由球抓取同样按屏幕像素：球很小也要能一把抓住。
      const curSp = cur ? renderer.worldToScreen(cur.x, cur.y) : null;
      const pSp = renderer.worldToScreen(w.x, w.y);
      if (cur && Math.hypot(curSp.x - pSp.x, curSp.y - pSp.y) < 34) {
        placing = true;
        placePos = { x: cur.x, y: cur.y };
        try { canvas.setPointerCapture(e.pointerId); } catch { }
        return;
      }
    }

    if (!view.canShoot) return;
    const cue = view.balls.find((b) => b.id === 0 && !b.potted);
    if (!cue) return;
    const w = renderer.screenToWorld(p.x, p.y);
    dragTapWorld = w;                // 先记下按下的位置，抬起时若是「轻点」才用它瞄准
    // 关键：按下时绝不动角度。否则你刚瞄好、准备后拉出杆的那一下，杆会突然跳掉。
    // 角度只由「横滑」或「轻点球」改变，后拉只负责蓄力。
    const cs = renderer.worldToScreen(cue.x, cue.y);
    dragging = true;
    dragMode = 'pending';            // 先看手指往哪走：横向 = 转杆，后拉 = 蓄力
    dragStart = p;
    dragStartAngle = aim.angle;
    dragCueVec = { x: p.x - cs.x, y: p.y - cs.y };
    // 注意：这里不清空力量，也不改角度
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
      const maxD = Math.max(54, Math.min(renderer.size.w, renderer.size.h) * 0.4);
      const ax = Math.cos(aim.angle), ay = -Math.sin(aim.angle);   // 屏幕坐标的瞄准方向
      const dx = p.x - dragStart.x, dy = p.y - dragStart.y;
      const pull = dx * ax + dy * ay;                              // 沿瞄准方向（向前为正）
      const lateral = Math.abs(dx * ay - dy * ax);                 // 垂直方向偏移

      if (dragMode === 'pending') {
        if (-pull > 10) dragMode = 'power';
        else if (lateral > 12) dragMode = 'aim';
      }

      if (dragMode === 'aim') {
        // 相对旋转：按下的角度 + 手指绕母球扫过的角度差。
        // 不直接用「指向手指」，所以按下那一下不会跳杆。
        const cs = renderer.worldToScreen(cue.x, cue.y);
        const now = { x: p.x - cs.x, y: p.y - cs.y };
        const a0 = Math.atan2(-dragCueVec.y, dragCueVec.x);   // 屏幕 y 向下，取反成数学角
        const a1 = Math.atan2(-now.y, now.x);
        let delta = a1 - a0;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        aim.angle = dragStartAngle + delta;
        aimLockedBallId = null;
        aim.power = 0;
      } else if (dragMode === 'power') {
        // 后拉蓄力：只认「瞄准反方向」的位移，往前推不会误出杆
        aim.power = Math.min(1, Math.max(0, -pull) / maxD);
      }
    } else if (view.canShoot && e.pointerType === 'mouse') {
      // 桌面保留 hover 瞄准；触屏走 pointerdown 定方向
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
    const mode = dragMode;
    const pulled = mode === 'power';
    dragMode = null;
    // 只有真的向后拉过才算出杆；单击/滑动只是瞄准，不能把已设好的力量误打出去
    if (pulled && aim.power > 0.05 && view && view.canShoot && view.phase === 'aim') {
      transport.shoot({ angle: aim.angle, power: aim.power, spin: { ...aim.spin } });
      aim.power = 0;
      aimLockedBallId = null;
    } else if (mode === 'pending' && dragTapWorld && view.canShoot && view.phase === 'aim') {
      // 轻点：不改角度，纯瞄准（点了哪颗球就对准哪颗球）
      const cue = view.balls.find((b) => b.id === 0 && !b.potted);
      if (cue) {
        const target = nearestBall(view.balls, dragTapWorld, 30);
        const tx = target ? target.x : dragTapWorld.x;
        const ty = target ? target.y : dragTapWorld.y;
        const dx = tx - cue.x, dy = ty - cue.y;
        if (Math.hypot(dx, dy) > R * 0.6) {
          aim.angle = Math.atan2(dy, dx);
          aimLockedBallId = target ? target.id : null;
        }
      }
    }
    dragTapWorld = null;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  // 注意：不要在 pointerleave 里清 power。手机抬手后会紧跟 pointerleave，
  // 一清就把滑杆设好的力量抹掉了，「出杆」于是永远按不动。

  $('#btnRematch').addEventListener('click', () => transport && transport.rematch());
  $('#ovBtn').addEventListener('click', () => { transport && transport.rematch(); });

  $('#btnRotateGo').addEventListener('click', () => { enterLandscape(); });
  $('#btnRotateSkip').addEventListener('click', () => { dismissRotateGuide(); resize(); });
  $('#btnLandscape').addEventListener('click', () => {
    if (fakeLandscape) { setFakeLandscape(false); syncRotateGuide(); return; }
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
      // 再点一次回到联机：之前切到本地后没有回头路，只能手动改网址
      const u = new URL(location.href);
      u.searchParams.delete('local');
      location.href = u.toString();
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
/* ------------------------------------------------------------------ */
/* 房间：创建 / 加入 / 复制邀请链接                                    */
/* ------------------------------------------------------------------ */
const ROOM_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';   // 去掉 0/o/1/l/i，口述不容易听错

/** 生成一个 6 位短房间号；房间号只用于进同一个房间，不需要全局唯一 */
function makeRoomCode() {
  let s = '';
  const buf = new Uint8Array(6);
  (window.crypto || {}).getRandomValues?.(buf);
  for (let i = 0; i < 6; i++) {
    const r = buf[i] ?? Math.floor(Math.random() * 256);
    s += ROOM_CHARS[r % ROOM_CHARS.length];
  }
  return s;
}

/** 与服务端 normalizeRoom 保持同一规则，避免用户输入了「看起来一样」却进错房间 */
function cleanRoomCode(raw) {
  return String(raw || '').trim().slice(0, 24).replace(/[^A-Za-z0-9_-]/g, '');
}

function inviteUrl(code) {
  const u = new URL(location.href);
  u.searchParams.set('room', code);
  u.searchParams.delete('local');
  return u.toString();
}

function syncRoomPanel() {
  if (!el.rmCode || !el.rmInvite) return;
  const code = cleanRoomCode(view && view.roomId) || cleanRoomCode(new URLSearchParams(location.search).get('room'));
  el.rmCode.value = code;
  el.rmInvite.textContent = code ? inviteUrl(code) : '连接成功后生成邀请链接';
  const local = transport && transport.mode === 'local';
  // 满房时「加入」没有意义：房间还是那两个人，只能新建或等对方退出
  const full = transport && transport.view && transport.view.error && String(transport.view.error).includes('房间已满');
  el.rmCreate.disabled = local;
  el.rmJoin.disabled = local || !!full;
  el.rmCopy.disabled = !code;
  el.rmTip.textContent = local
    ? '当前是本地双人模式，点右下角「联机」回到房间模式。'
    : full
      ? '这个房间已经有两个人了。点「新建房间」换个号，把新链接发给对方。'
      : '房间号只能有字母、数字、下划线或横线；两人必须用同一个房间号。';
}

function openRoomPanel() {
  if (!el.roomModal) return;
  syncRoomPanel();
  el.roomModal.classList.remove('hidden');
  setTimeout(() => { try { el.rmCode.focus(); el.rmCode.select(); } catch { } }, 60);
}

function closeRoomPanel() {
  if (el.roomModal) el.roomModal.classList.add('hidden');
}

/** 真正切房间：改 URL 后重连，服务端按新 roomId 分配一个独立房间 */
function goRoom(code) {
  const c = cleanRoomCode(code);
  if (!c) { showToast('房间号不能为空'); return false; }
  // 联机模式优先原地重连：不用刷新整页，满房也能马上换下一个号
  if (transport && transport.mode === 'net' && typeof transport.reconnectTo === 'function') {
    closeRoomPanel();
    showToast(`正在进入房间 ${c}`);
    return transport.reconnectTo(c);
  }
  const u = new URL(location.href);
  u.searchParams.set('room', c);
  u.searchParams.delete('local');
  location.href = u.toString();
  return true;
}

async function copyInvite() {
  const code = cleanRoomCode(el.rmCode.value) || cleanRoomCode(view && view.roomId);
  if (!code) return;
  const link = inviteUrl(code);
  try {
    await navigator.clipboard.writeText(link);
    showToast('邀请链接已复制，发给对方即可');
  } catch {
    // 非 HTTPS / 老浏览器没有剪贴板权限：退回手动选中
    try {
      el.rmInvite.textContent = link;
      const range = document.createRange();
      range.selectNodeContents(el.rmInvite);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      showToast('已选中链接，长按复制');
    } catch { showToast('复制失败，请长按链接手动复制'); }
  }
}

function initRoomPanel() {
  if (!el.roomModal) return;
  el.roomBar?.addEventListener('click', openRoomPanel);
  el.btnRoom?.addEventListener('click', openRoomPanel);
  // 面板打开时停掉击球手势，避免点面板/输入房间号时误触台面
  el.roomModal.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.rmClose?.addEventListener('click', closeRoomPanel);
  el.rmCopy?.addEventListener('click', copyInvite);
  el.rmCreate?.addEventListener('click', () => {
    const code = makeRoomCode();
    el.rmCode.value = code;
    el.rmInvite.textContent = inviteUrl(code);
    goRoom(code);
  });
  el.rmJoin?.addEventListener('click', () => {
    const code = cleanRoomCode(el.rmCode.value);
    if (!code) { showToast('先输入房间号'); return; }
    if (code === cleanRoomCode(view && view.roomId)) { closeRoomPanel(); showToast('已经在这个房间了'); return; }
    goRoom(code);
  });
  // 点遮罩关闭；输入框回车直接加入
  el.roomModal.addEventListener('click', (e) => { if (e.target === el.roomModal) closeRoomPanel(); });
  el.rmCode?.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.rmJoin.click(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRoomPanel(); });
}

const portraitMQ = window.matchMedia('(max-aspect-ratio: 1/1)');
let rotateDismissed = false;
let fakeLandscape = false;

/** 系统不让锁方向时，把界面自己转 90°（CSS transform），保证一定能横过来 */
function setFakeLandscape(on) {
  fakeLandscape = on;
  document.body.classList.toggle('fake-landscape', on);
  const btn = $('#btnLandscape');
  if (btn) btn.textContent = on ? '退出横屏' : '横屏';
  [0, 60, 200, 420].forEach((ms) => setTimeout(resize, ms));
}

function syncRotateGuide() {
  const box = $('#rotate');
  if (!box) return;
  const portrait = portraitMQ.matches;
  // 应用内横屏时，屏幕物理上仍是竖屏，但界面已经是横屏布局，不能再弹引导
  if (fakeLandscape) { box.classList.add('hidden'); return; }
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

  // 关键兜底：没锁成功说明系统不给网页转屏权限，那就自己转
  if (!locked && portraitMQ.matches) {
    setFakeLandscape(true);
    if (tip) tip.textContent = '已把界面转成横屏；想换回来点下面的「退出横屏」。';
    return;
  }

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

/** 玩家卡片第二行：直接回答「我打哪一组、还剩几颗、下一颗打什么」 */
function renderTask(node, group, potted) {
  if (!node) return;
  if (!group) {
    node.textContent = '开放球台 · 先打进一颗定组';
    node.className = 'ptask open';
    return;
  }
  const left = groupRemaining(potted, group);
  const name = group === GROUP_SOLID ? '光球' : '花球';
  node.textContent = left.length ? `${name}剩 ${left.length} 颗` : '清台 · 打黑8';
  node.className = 'ptask ' + (group === GROUP_SOLID ? 'solid' : 'stripe') + (left.length ? '' : ' eight');
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
  renderTask(el.task0, g0, pottedAll);
  renderTask(el.task1, g1, pottedAll);
  el.name0.textContent = v.names[0] || '玩家 1';
  el.name1.textContent = v.names[1] || '玩家 2';
  renderDots(el.dots0, m.group ? m.group[0] : null, pottedAll);
  renderDots(el.dots1, m.group ? m.group[1] : null, pottedAll);

  el.room.textContent = transport.mode === 'net'
    ? (v.roomId ? `房间 ${v.roomId}` : '连接中…')
    : '本地双人 · 同屏';
  // 房间号只在这一个地方展示：桌面点它、手机点底部「房间」，都能改
  if (el.roomBar) el.roomBar.title = v.roomId ? `房间 ${v.roomId} · 点这里创建或换房` : '点这里创建或加入房间';

  const showTurn = v.phase === 'aim' || v.phase === 'run';
  el.card0.classList.toggle('active', showTurn && m.turn === 0);
  el.card1.classList.toggle('active', showTurn && m.turn === 1);

  const pct = Math.round(aim.power * 100);
  el.powerFill.style.width = pct + '%';
  el.powerLabel.textContent = pct + '%';
  if (el.powerTrack) el.powerTrack.setAttribute('aria-valuenow', String(pct));
  // 力量条只有在轮到自己时才可操作
  if (el.powerTrack) {
    el.powerTrack.classList.toggle('locked', !(v.phase === 'aim' && v.canShoot));
  }

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
    aim: { ...aim, targetId: aimLockedBallId },
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
  initPowerSlider();
  initRoomPanel();

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
        else if (s === 'full') {
          setStatus('房间已满 · 点「房间」新建一个');
          // 满房时直接把面板递到手上，别让人对着错误提示干瞪眼
          openRoomPanel();
        }
      },
    }), 'net');
  }
  resize();
  new ResizeObserver(resize).observe($('#stage'));
  // 旋转后 stage 可能在下一帧才拿到最终高度，直接观察画布自身尺寸。
  new ResizeObserver(resize).observe(document.querySelector('#table'));
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));

  syncRotateGuide();
  portraitMQ.addEventListener('change', () => {
    // 用户真的把手机横过来了，就撤掉软件旋转，回到原生横屏布局
    if (fakeLandscape && !portraitMQ.matches) setFakeLandscape(false);
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
