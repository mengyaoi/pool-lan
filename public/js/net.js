/**
 * net.js — 传输层。两套实现产出同一形状的 view()，game.js 只认接口不认模式。
 *
 *   LocalTransport : 本机跑物理（同屏双人 / 没服务端时的降级）
 *   NetTransport   : 服务端权威，只做快照插值
 */
import {
  createWorld, rack15, stepWorld, applyShot, settled, respotCue, respotBall, deserializeWorld,
  canPlaceCue, placeCue as placeCueWorld,
} from './physics.js';
import { createMatch, resolveShot } from './rules.js';

const STEP = 1 / 240;        // 服务端与本地统一固定步长
const INTERP_DELAY = 90;     // 客户端插值缓冲下限 ms（跨境链路会按 RTT 自动放大）
const INTERP_DELAY_MAX = 260; // 插值缓冲上限 ms，避免高延迟下拖得太久
const INTERP_HEADROOM = 1.5;  // 缓冲 = RTT * 该系数，留出抖动余量
const FX_LIFE = 0.9;         // 落袋特效总时长（秒）：球缩入 0.3s，粒子继续飞到 0.9s

/** 由球号 + 袋口坐标算出确定性种子，渲染端据此生成一致的粒子，不必同步粒子状态 */
function fxSeed(id, x, y) {
  return (id + 1) * 977 + Math.round((x + 2) * 4000) + Math.round((y + 2) * 7000);
}

/* ================================================================== */
/* 本地：同屏双人                                                     */
/* ================================================================== */
export function createLocalTransport({ names = ['玩家 1', '玩家 2'] } = {}) {
  const world = createWorld();
  rack15(world, (Date.now() % 90000) + 7);
  const match = createMatch();

  let acc = 0;
  let lastT = performance.now();
  let markPotted = [];
  let effects = [];
  let queue = [];          // 待消费的事件（音效/提示）

  function push(ev) { queue.push(ev); }

  function handleStepEvents(evs) {
    for (const e of evs) {
      if (e.type === 'hit') push({ kind: 'sfx', name: 'ballHit', v: e.speed });
      else if (e.type === 'cushion') push({ kind: 'sfx', name: 'cushion', v: e.speed });
      else if (e.type === 'pocket') {
        push({ kind: 'sfx', name: 'pocket', v: e.id });
        effects.push({ id: e.id, x: e.x, y: e.y, t: 0, seed: fxSeed(e.id, e.x, e.y) });
      }
    }
  }

  function update() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;

    if (match.phase === 'run') {
      acc += dt;
      let guard = 0;
      while (acc >= STEP && guard++ < 24) {
        handleStepEvents(stepWorld(world, STEP));
        acc -= STEP;
      }
      if (settled(world)) finishShot();
    } else acc = 0;

    // 特效推进
    for (const e of effects) e.t = Math.min(1, e.t + dt / FX_LIFE);
    effects = effects.filter((e) => e.t < 1);
  }

  function finishShot() {
    const pottedNow = world.pocketed.slice();
    const newPotted = pottedNow.filter((id) => id !== 0 && !markPotted.includes(id));
    const cuePotted = pottedNow.includes(0);
    const firstHit = world.firstContact;
    const anyHit = firstHit !== null;
    const pottedAll = pottedNow.filter((id) => id !== 0);

    const r = resolveShot(match, { newPotted, cuePotted, firstHit, anyHit, pottedAll });
    if (cuePotted) respotCue(world);
    if (r.respot && r.respot.length) {
      for (const id of r.respot) respotBall(world, id);
    }
    match.potted = pottedAll.slice();
    // 注意：resolveShot 内部已写好 match.phase（aim/over）

    // 胜负音效由 game.js 的 showOverlay 统一播放（那边能区分自己赢/对手赢），此处不重复推
    if (!r.over && newPotted.length) push({ kind: 'sfx', name: 'score' });
    else if (!r.over) push({ kind: 'sfx', name: 'turn' });
    push({ kind: 'toast', text: r.hint });
  }

  return {
    mode: 'local',
    names,
    get view() {
      update();
      return {
        balls: world.balls,
        match,
        phase: match.phase,
        mySeat: match.turn,          // 同屏：永远轮到当前手
        canShoot: match.phase === 'aim',
        ballInHand: match.ballInHand,
        canPlace: match.phase === 'aim' && match.ballInHand != null,
        opponentAim: null,
        effects,
        names,
      };
    },
    /** 自由球摆放：同屏直接落到本地物理世界 */
    placeCue(pos) {
      if (match.phase !== 'aim' || match.ballInHand == null) return false;
      if (!placeCueWorld(world, pos.x, pos.y)) return false;
      match.ballInHand = null;
      push({ kind: 'toast', text: '母球已摆好，出杆' });
      return true;
    },
    /** 实时预判（拖动时问「这个位置能不能放」），不改状态 */
    canPlaceCue(pos) {
      return canPlaceCue(world, pos.x, pos.y);
    },
    shoot(shot) {
      if (match.phase !== 'aim') return false;
      markPotted = world.pocketed.slice();
      const r = applyShot(world, shot);
      if (!r.ok) return false;
      match.ballInHand = null;     // 直接开打 = 接受当前母球位置
      push({ kind: 'sfx', name: r.miscue ? 'miscue' : 'cue' });
      if (r.miscue) push({ kind: 'toast', text: '滑杆了！击球点太靠边' });
      match.phase = 'run';
      return true;
    },
    aim() {},
    rematch() {
      rack15(world, (Date.now() % 90000) + 11);
      Object.assign(match, createMatch());
      markPotted = [];
      effects = [];
      push({ kind: 'toast', text: '新一局开始' });
    },
    drain() { const q = queue; queue = []; return q; },
    dispose() {},
  };
}

/* ================================================================== */
/* 联机：服务端权威                                                   */
/* ================================================================== */
export function createNetTransport(url, { onStatus } = {}) {
  let ws = null;
  let seat = -1;
  let room = '';
  let players = [];
  let match = createMatch();
  match.phase = 'wait';        // 联机模式下没收到快照之前一律是「等待」，别让 UI 误报轮到你了
  let effects = [];
  let queue = [];
  let buffer = [];             // {ts, balls, potted}
  let lastAimSent = 0;
  let rtt = 0;                 // 平滑后的往返时延 ms
  let pingAt = 0;
  let pingTimer = null;
  let connected = false;
  let error = null;
  let disposed = false;
  let fatal = false;          // 致命错误（如房间满）：停止自动重连，避免刷屏

  const view = {
    balls: [],
    match,
    phase: 'wait',
    mySeat: 0,
    canShoot: false,
    opponentAim: null,
    effects,
    names: ['玩家 1', '玩家 2'],
    roomId: '',
    connected: false,
    error: null,
    latency: 0,
  };

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = url || `${proto}//${location.host}`;
    onStatus && onStatus('connecting');
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      connected = true;
      error = null;
      onStatus && onStatus('connected');
      const savedName = localStorage.getItem('pool_name') || '';
      send({ t: 'hello', name: savedName, room: new URLSearchParams(location.search).get('room') || 'main' });
      send({ t: 'join' });
      // 周期性测 RTT：插值缓冲按实测延迟自适应，跨境链路才不会频繁丢帧
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        pingAt = performance.now();
        send({ t: 'ping', ts: pingAt });
      }, 2000);
    };

    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      handle(m);
    };

    ws.onclose = () => {
      connected = false;
      clearInterval(pingTimer);
      if (!disposed && !fatal) {
        onStatus && onStatus('closed');
        setTimeout(() => { if (!disposed && !fatal) connect(); }, 1500);
      }
    };

    ws.onerror = () => { error = '无法连接服务端'; };
  }

  function handle(m) {
    switch (m.t) {
      case 'welcome':
        seat = m.seat;
        room = m.room;
        view.roomId = room;
        if (m.name) localStorage.setItem('pool_name', m.name);
        break;

      case 'room': {
        players = m.players || [];
        view.names = [0, 1].map((i) => {
          const p = players.find((x) => x.seat === i);
          return p ? p.name : `玩家 ${i + 1}`;
        });
        // 对手走了（或还没来）：本局作废，回到等待态，别继续拿旧球位显示「轮到你了」
        if (players.length < 2) {
          match.phase = 'wait';
          match.winner = null;
          view.phase = 'wait';
          view.opponentAim = null;
          view.canShoot = false;
          view.balls = [];
          buffer = [];
          effects = [];
        }
        break;
      }

      case 'start':
        Object.assign(match, createMatch());
        buffer = [];
        effects = [];
        view.phase = 'aim';
        queue.push({ kind: 'toast', text: '开局！' });
        break;

      case 'snap':
        applySnap(m);
        break;

      case 'groups':
        applyGroups(m);
        break;

      case 'evt':
        if (m.type === 'hit') queue.push({ kind: 'sfx', name: 'ballHit', v: m.speed });
        else if (m.type === 'cushion') queue.push({ kind: 'sfx', name: 'cushion', v: m.speed });
        else if (m.type === 'pocket') {
          queue.push({ kind: 'sfx', name: 'pocket', v: m.id });
          const x = m.x / 1000, y = m.y / 1000;
          effects.push({ id: m.id, x, y, t: 0, seed: fxSeed(m.id, x, y) });
        }
        else if (m.type === 'cue') queue.push({ kind: 'sfx', name: 'cue' });
        else if (m.type === 'score') queue.push({ kind: 'sfx', name: 'score' });
        else if (m.type === 'miscue') queue.push({ kind: 'sfx', name: 'miscue' });
        break;

      case 'oppAim':
        if (m.seat !== seat) {
          view.opponentAim = { angle: m.angle, power: m.power };
        }
        break;

      case 'turn':
        queue.push({ kind: 'sfx', name: 'turn' });
        break;

      case 'toast':
        queue.push({ kind: 'toast', text: m.text });
        break;

      case 'pong':
        if (pingAt) {
          const sample = performance.now() - pingAt;
          pingAt = 0;
          // 指数平滑，忽略明显异常的样本
          if (sample > 0 && sample < 5000) rtt = rtt ? rtt * 0.7 + sample * 0.3 : sample;
        }
        break;

      case 'over':
        match.phase = 'over';
        match.winner = m.winner;
        // 胜负音效/彩带由 showOverlay 统一触发（可按 mySeat 区分赢/输），此处不推
        break;

      case 'peer':
        queue.push({ kind: 'toast', text: m.state === 'left' ? '对手已离开' : '对手已回来' });
        break;

      case 'err':
        error = m.msg || m.code;
        if (m.code === 'ROOM_FULL') {
          fatal = true;   // 房间满：停止自动重连（否则满房→断开→1.5s 重连→满房 死循环）
          onStatus && onStatus('full');
        }
        queue.push({ kind: 'toast', text: '错误：' + (m.msg || m.code) });
        break;
    }
  }

  function applySnap(m) {
    const now = performance.now();
    buffer.push({ ts: now, balls: m.balls, potted: m.potted || [] });
    if (buffer.length > 24) buffer.shift();

    match.phase = m.phase;
    match.turn = m.turn;
    match.group = m.group || [null, null];
    match.open = m.open !== false;
    match.winner = m.winner ?? null;
    match.potted = m.potted ? m.potted.filter((id) => id !== 0) : match.potted;
    match.ballInHand = m.ballInHand ?? null;
    if (m.names) view.names = m.names;

    view.phase = m.phase;
    view.opponentAim = m.oppAim || null;
  }

  function applyGroups(m) {
    if (Array.isArray(m.group)) {
      match.group = m.group;
      match.open = !!m.open;
    }
  }

  /** 相邻两帧插值 */
  function interpolate() {
    if (!buffer.length) return [];
    const delay = Math.min(INTERP_DELAY_MAX, Math.max(INTERP_DELAY, rtt * INTERP_HEADROOM));
    const target = performance.now() - delay;

    let a = null, b = null;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i].ts <= target) a = buffer[i];
      else { b = buffer[i]; break; }
    }
    if (!a) a = buffer[0];
    if (!b) b = a;

    const span = b.ts - a.ts || 1;
    const k = Math.max(0, Math.min(1, (target - a.ts) / span));

    return a.balls.map((ab) => {
      const bb = b.balls.find((x) => x.i === ab.i) || ab;
      const ax = ab.x / 1000, ay = ab.y / 1000;
      const bx = bb.x / 1000, by = bb.y / 1000;
      // 大跳变（换局/复位）直接吸附，别插值出一条横穿台面的线
      const jump = Math.hypot(bx - ax, by - ay) > 0.15;
      const kk = jump ? 1 : k;
      return {
        id: ab.i,
        x: ax + (bx - ax) * kk,
        y: ay + (by - ay) * kk,
        potted: !!ab.p,
        rz: (ab.r || 0) + ((bb.r || 0) - (ab.r || 0)) * kk,
        color: undefined,
      };
    });
  }

  connect();

  return {
    mode: 'net',
    get names() { return view.names; },
    get view() {
      const dt = 1 / 60;
      for (const e of effects) e.t = Math.min(1, e.t + dt / FX_LIFE);
      effects = effects.filter((e) => e.t < 1);
      const balls = interpolate();
      view.balls = balls;
      view.match = match;
      view.mySeat = seat;
      view.canShoot = seat >= 0 && match.phase === 'aim' && match.turn === seat;
      view.ballInHand = match.ballInHand;
      view.canPlace = seat >= 0 && match.phase === 'aim' && match.ballInHand === seat;
      view.phase = match.phase;
      view.effects = effects;
      view.connected = connected;
      view.error = error;
      view.roomId = room;
      view.latency = Math.round(rtt);
      return view;
    },
    /** 自由球摆放：交给服务端权威落位 */
    placeCue(pos) {
      if (!(seat >= 0 && match.phase === 'aim' && match.ballInHand === seat)) return false;
      send({ t: 'place', x: pos.x, y: pos.y });
      return true;
    },
    /** 本地几何预判（服务端仍会二次校验） */
    canPlaceCue(pos) {
      return canPlaceCue({ balls: view.balls || [] }, pos.x, pos.y);
    },
    shoot(shot) {
      if (!(seat >= 0 && match.phase === 'aim' && match.turn === seat)) return false;
      send({ t: 'shot', angle: shot.angle, power: shot.power, spin: shot.spin });
      return true;
    },
    aim(shot) {
      const now = performance.now();
      if (now - lastAimSent < 100) return;
      lastAimSent = now;
      if (seat < 0) return;
      send({ t: 'aim', angle: shot.angle, power: shot.power });
    },
    rematch() { send({ t: 'rematch' }); },
    drain() { const q = queue; queue = []; return q; },
    dispose() {
      disposed = true;
      if (ws) ws.close();
    },
  };
}

/** 探测服务端是否可用；不可用就降级本地 */
export async function probeServer(timeout = 1200) {
  if (location.protocol === 'file:') return false;
  return new Promise((resolve) => {
    let done = false;
    let ws;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { ws && ws.close(); } catch { }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeout);
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}`);
      ws.onopen = () => { clearTimeout(timer); finish(true); };
      ws.onerror = () => { clearTimeout(timer); finish(false); };
    } catch { clearTimeout(timer); finish(false); }
  });
}
