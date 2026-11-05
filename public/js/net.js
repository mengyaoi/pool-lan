/**
 * net.js — 传输层。两套实现产出同一形状的 view()，game.js 只认接口不认模式。
 *
 *   LocalTransport : 本机跑物理（同屏双人 / 没服务端时的降级）
 *   NetTransport   : 服务端权威，只做快照插值
 */
import {
  createWorld, rack15, stepWorld, applyShot, settled, respotCue, respotBall, deserializeWorld,
  canPlaceCue, placeCue as placeCueWorld, serializeWorld,
} from './physics.js';
import { createMatch, resolveShot } from './rules.js';
import { normalizeShot, normalizePlace, rackSeed } from './protocol.js';

const STEP = 1 / 240;        // 服务端与本地统一固定步长
const PHYS_MAX_STEPS_PER_FRAME = 920; // 单帧最多补算步数（约 3.8s 物理时间），防止后台标签回来时卡死
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

    // resolveShot 会从「当前 turn」推进到下一手。非出杆方的 turn 可能已经被
    // 服务端的 turn 广播改成了下一手，此时再推进一次就会跳过一个人，
    // 表现为双方都出不了杆。所以先记住推进前的值。
    const priorTurn = match.turn;
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
/* 联机：确定性双端同步                                                */
/* ================================================================== */
/**
 * 与旧版「服务端权威 + 40Hz 快照」的区别（延迟从 2xRTT 降到接近 0）
 *
 *   旧版：出杆 → 服务器算物理 → 把球位推回来。看到球动要等一个来回，
 *         跨境链路下 200ms RTT 就是 400ms 以上的体感延迟。
 *   新版：出杆 → 本地立刻算 → 同时把「击球参数」发给服务器 → 对手收到后自己算。
 *         服务器不碰物理，只转发指令并做裁判（轮次/花色/胜负）。
 *         自己出杆 0 延迟；对手出杆只剩单程 RTT。
 *
 * 成立的前提是物理确定性：同一 rack 种子 + 同一击球序列 = 同一结果。
 * 因此 physics.js 中滑杆的随机抖动已改为 world 上的种子 RNG。
 */
export function createNetTransport(url, { onStatus } = {}) {
  let ws = null;
  let seat = -1;
  let room = '';
  let players = [];
  let match = createMatch();
  match.phase = 'wait';
  let effects = [];
  let queue = [];
  let world = null;            // 本地物理世界（两端各算一份）
  let roundNo = 0;
  let seed = 1;
  let acc = 0;
  let lastT = 0;
  let markPotted = [];         // 本杆开始前已进袋的球
  let settling = false;        // 本地物理是否在跑
  let pendingReport = null;    // 结算完待上报的结果
  let shotBackup = null;       // 出杆前局面：服务器拒绝这一杆时原地回滚
  let shotSentAt = 0;          // 自己出杆的时间：超时没回执就 resync
  let shotAckPending = false;
  let reportSentAt = 0;        // 结算上报时间：result 丢了也要能重同步
  let lastSyncAt = 0;          // 空闲时的周期性权威对账
  let resolvedShots = 0;       // 本局已由服务器确认的最大 shots（挡住迟到旧包）
  let lastAimSent = 0;
  let rtt = 0;
  let pingAt = 0;
  let pingTimer = null;
  let connected = false;
  let error = null;
  let disposed = false;
  let fatal = false;
  // 座位凭据必须在第一次连接前就生成：服务器按 URL/hello 里的 token 认人，
  // 如果等 welcome 才生成，首次连接存下的是空 token，刷新后就认不回原座位。
  let token = '';
  try {
    token = sessionStorage.getItem('pool_token') || '';
    if (!token) {
      token = 't' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('pool_token', token);
    }
  } catch { token = 't' + Math.random().toString(36).slice(2) + Date.now().toString(36); }

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

  /** 满房后自助换房：直接重连到新房间，不必整页刷新 */
  function reconnectTo(roomId) {
    const r = String(roomId || '').trim().slice(0, 24).replace(/[^A-Za-z0-9_-]/g, '');
    if (!r) return false;
    const u = new URL(location.href);
    u.searchParams.set('room', r);
    u.searchParams.delete('local');
    history.replaceState(null, '', u.toString());
    // roomId 由 welcome 填；换房期间先显示新号，别让面板还挂着旧房间
    view.roomId = r;
    room = r;
    fatal = false;
    error = null;
    players = [];
    world = null;
    settling = false;
    seat = -1;
    Object.assign(match, createMatch());
    match.phase = 'wait';
    view.phase = 'wait';
    view.balls = [];
    view.error = null;
    try { if (ws) ws.close(); } catch { }
    connect();
    return true;
  }

  /* ---------- 物理 ---------- */

  function buildWorld(round) {
    world = createWorld();
    seed = rackSeed(room, round);
    world.rng = (seed ^ 0x5bf03635) >>> 0;
    rack15(world, seed);
    acc = 0;
    lastT = performance.now();
    markPotted = [];
    settling = false;
    pendingReport = null;
    resolvedShots = 0;
    Object.assign(match, createMatch());
    match.phase = 'aim';
    effects = [];
    queue.push({ kind: 'toast', text: '开局！' });
  }

  /** 用服务端/出杆方的停球快照对齐本地世界（只用于对手端） */
  function applySnapshot(snap) {
    if (!world || !snap || !Array.isArray(snap.balls)) return false;
    const byId = new Map(snap.balls.map((b) => [b.i, b]));
    for (const b of world.balls) {
      const s = byId.get(b.id);
      if (!s) continue;
      b.x = s.x / 1000; b.y = s.y / 1000;
      b.vx = 0; b.vy = 0; b.wx = 0; b.wy = 0; b.wz = 0;
      b.rz = s.r || 0;
      b.potted = !!s.p;
    }
    world.pocketed = (snap.potted || []).slice();
    world.firstContact = null;
    world.seq = snap.seq || world.seq;
    world.time = (snap.time || 0) / 1000;
    world.events = [];
    acc = 0;
    settling = false;
    markPotted = world.pocketed.slice();
    // 记分牌跟着权威快照走：母球(0)不算进袋球。
    match.potted = world.pocketed.filter((id) => id > 0);
    return true;
  }

  /** 服务器拒收这一杆：撤回本地已经打出去的球，回到出杆前 */
  function rollbackShot(why) {
    if (!shotBackup || !world) return false;
    applySnapshot(shotBackup.snap);
    // 只恢复花色/进袋/自由球这些规则状态；turn/phase 一定以服务器为准，
    // 否则会把刚收到的权威轮次又覆盖回出杆前的旧值（两端显示不同轮次）。
    const keepTurn = match.turn;
    const keepPhase = match.phase;
    Object.assign(match, shotBackup.match);
    match.turn = keepTurn;
    match.phase = keepPhase;
    shotBackup = null;
    settling = false;
    wasMyShot = false;
    shotAckPending = false;
    shotSentAt = 0;
    reportSentAt = 0;
    aim.power = 0;
    if (why) queue.push({ kind: 'toast', text: why });
    return true;
  }

  /** 用服务端 publicRoom 全量落状态（拒收/超时/重连都走这里） */
  function applyRoomState(r) {
    if (!r) return;
    if (Array.isArray(r.players)) {
      players = r.players;
      view.names = [0, 1].map((i) => {
        const p = players.find((x) => x.seat === i);
        return p ? p.name : `玩家 ${i + 1}`;
      });
    }
    if (typeof r.round === 'number' && r.round > 0 && (!world || roundNo !== r.round)) {
      roundNo = r.round || 1;
      buildWorld(roundNo);
    }
    const activeShot = settling || wasMyShot;
    const localShots = Number.isFinite(match.shots) ? match.shots : 0;
    const serverShots = typeof r.shots === 'number' ? r.shots : localShots;
    // 旧房间快照（例如 shots=0）晚到，不能把已经落地的 result（shots=1,
    // group=["solid","stripe"]）重新冲回「开放球台」。
    const stale = serverShots < localShots && serverShots < resolvedShots;
    if (stale || activeShot) return;

    if (Array.isArray(r.group)) { match.group = r.group; match.open = !!r.open; }
    match.ballInHand = r.ballInHand ?? null;
    if (typeof r.shots === 'number') match.shots = r.shots;
    // run 表示这一杆的最终球位还没上报，room.snapshot 仍是上一杆的旧位置；
    // 此时套用会把本地正在结算的台面倒回去。等 result 的停球快照。
    if (r.snapshot && r.phase !== 'run') applySnapshot(r.snapshot);
    if (r.phase === 'over') {
      match.phase = 'over';
      match.winner = r.winner ?? null;
      view.phase = 'over';
    } else if (r.phase === 'wait') {
      match.phase = 'wait';
      view.phase = 'wait';
    } else if (r.phase === 'run') {
      // 服务器已受理这一杆、还没收到结算：保持 run，不能再允许出杆。
      match.turn = r.turn;
      match.phase = 'run';
      view.phase = 'run';
    } else {
      match.turn = r.turn;
      match.phase = 'aim';
      view.phase = 'aim';
    }
  }

  /** 应用一杆（自己发起或对手发起，走同一路径，保证两边算得一样） */
  function applyShotLocal(shot, mine) {
    if (!world) return false;
    if (mine) {
      // 记下出杆前局面。若服务器拒收（例如上一杆 pending 挂着），
      // 必须回到这里，否则本地会继续算出一个对手根本没有的局面。
      shotBackup = { snap: serializeWorld(world), match: JSON.parse(JSON.stringify(match)) };
    }
    markPotted = world.pocketed.slice();
    const r = applyShot(world, shot);
    if (!r.ok) return false;
    match.phase = 'run';
    settling = true;
    acc = 0;
    lastT = performance.now();
    queue.push({ kind: 'sfx', name: r.miscue ? 'miscue' : 'cue' });
    if (r.miscue) queue.push({ kind: 'toast', text: '滑杆了！击球点太靠边' });
    return true;
  }

  /** 停稳后做规则结算；轮到自己出杆的那端负责把结果上报 */
  function settleShot() {
    const pottedNow = world.pocketed.slice();
    const newPotted = pottedNow.filter((id) => id !== 0 && !markPotted.includes(id));
    const cuePotted = pottedNow.includes(0);
    const firstHit = world.firstContact;
    const anyHit = firstHit !== null;
    const pottedAll = pottedNow.filter((id) => id !== 0);

    if (cuePotted) respotCue(world);
    match.potted = pottedAll.slice();
    settling = false;

    // 只有出杆方能结算规则；对手端只负责播放物理，等 result 同步。
    if (!wasMyShot) return null;

    const r = resolveShot(match, { newPotted, cuePotted, firstHit, anyHit, pottedAll });
    // 只做「重摆」这类物理修正；轮次/花色在 resolveShot 里已算好，随 report 上报。
    if (r.respot && r.respot.length) for (const id of r.respot) respotBall(world, id);
    match.potted = pottedAll.slice();

    if (!r.over && newPotted.length) queue.push({ kind: 'sfx', name: 'score' });
    else if (!r.over) queue.push({ kind: 'sfx', name: 'turn' });
    queue.push({ kind: 'toast', text: r.hint });

    return {
      t: 'report',
      group: match.group,
      open: match.open,
      ballInHand: match.ballInHand,
      turn: match.turn,
      shots: match.shots,
      over: !!r.over,
      winner: match.winner ?? null,
      hint: r.hint,
      // 停球后的权威球位。对手收到后直接对齐，不再赌两边补帧完全一致。
      snapshot: serializeWorld(world),
    };
  }

  /**
   * 每帧推进本地物理。
   *
   * 一致性来自「固定步长 + 确定性的 stepWorld」，与推进速率无关：
   * 每一步的输入状态完全相同，所以无论分几次跑完，停稳后的局面逐字节一致。
   * 因此这里按真实时间补算步数——后台标签被节流回 1fps 时也能一次追平，
   * 不会出现两边一格一格慢慢错开的问题。
   */
  function physicsTick() {
    if (!world || !settling) return;
    const now = performance.now();
    const elapsed = Math.min(now - lastT, 5000);
    lastT = now;
    acc += elapsed / 1000;
    let steps = Math.floor(acc / STEP);
    if (steps > PHYS_MAX_STEPS_PER_FRAME) steps = PHYS_MAX_STEPS_PER_FRAME;
    acc -= steps * STEP;
    if (acc < 0) acc = 0;
    for (let i = 0; i < steps && !settled(world); i++) stepWorld(world, STEP);
    if (settled(world)) {
      const rep = settleShot();
      // 只有出杆方上报，避免两端同时改服务端状态
      if (rep) {
        send(rep);
        reportSentAt = Date.now();
        pendingReport = null;
      }
      wasMyShot = false;
    }
  }

  let waitWarnTimer = null;
  let wasMyShot = false;

  /* ---------- 连接 ---------- */

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // 用变量 room 而不是每次从 URL 读：换房时先定位到新房间再重连
    const wantRoom = room || new URLSearchParams(location.search).get('room') || 'main';
    const base = url || `${proto}//${location.host}/api/ws`;
    const wsUrl = `${base}?room=${encodeURIComponent(wantRoom)}&token=${encodeURIComponent(token)}`;
    onStatus && onStatus('connecting');
    // 每次连接持有自己的 socket 引用：换房时旧连接的 onclose 不会污染新房状态
    const myWs = new WebSocket(wsUrl);
    ws = myWs;

    myWs.onopen = () => {
      if (ws !== myWs) return;
      connected = true;
      error = null;
      onStatus && onStatus('connected');
      const savedName = localStorage.getItem('pool_name') || '';
      send({ t: 'hello', name: savedName, room: wantRoom, token });
      send({ t: 'join' });
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        pingAt = performance.now();
        send({ t: 'ping', ts: pingAt });
      }, 2000);
    };

    myWs.onmessage = (ev) => {
      if (ws !== myWs) return;
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      handle(m);
    };

    myWs.onclose = () => {
      if (ws !== myWs) return;   // 被换房主动关掉的旧连接，忽略
      connected = false;
      clearInterval(pingTimer);
      if (!disposed && !fatal) {
        onStatus && onStatus('closed');
        setTimeout(() => { if (!disposed && !fatal) connect(); }, 1500);
      }
    };

    myWs.onerror = () => { if (ws === myWs) error = '无法连接服务端'; };
  }

  function handle(m) {
    switch (m.t) {
      case 'welcome':
        seat = m.seat;
        room = m.room;
        view.roomId = room;
        if (m.name) { localStorage.setItem('pool_name', m.name); }
        break;

      case 'room': {
        players = m.players || [];
        // Vercel 的连接可能落到不同实例，此时两人各看到一个「只有自己」的房间。
        // 超过 10s 仍未凑齐两人，就明说这个问题，别让用户对着空白球桌干等。
        if (players.length < 2 && !waitWarnTimer) {
          waitWarnTimer = setTimeout(() => {
            if (players.length < 2 && connected) {
              error = '对手未出现：可能被调度到了不同实例';
              queue.push({ kind: 'toast', text: '等了 10 秒仍只有你一人 —— 双方可能落在不同实例，刷新重试' });
            }
          }, 10000);
        } else if (players.length >= 2 && waitWarnTimer) {
          clearTimeout(waitWarnTimer);
          waitWarnTimer = null;
        }
        view.names = [0, 1].map((i) => {
          const p = players.find((x) => x.seat === i);
          return p ? p.name : `玩家 ${i + 1}`;
        });
        if (players.length < 2) {
          match.phase = 'wait';
          match.winner = null;
          view.phase = 'wait';
          view.opponentAim = null;
          view.canShoot = false;
          view.balls = [];
          effects = [];
          world = null;
          settling = false;
        } else if (m.turn !== undefined) {
          // 重连/刷新后恢复服务端当前局面。
          // 断网期间本地可能已经打完一杆，而服务器根本没收到：
          // 这里先用出杆前快照撤回，再整体对齐服务端，避免两端分叉。
          const localAhead = typeof m.shots === 'number' && match.shots > m.shots;
          const sameRound = m.round === roundNo;
          if (sameRound && m.phase === 'aim' && (shotAckPending || localAhead)) {
            rollbackShot('');
            queue.push({ kind: 'toast', text: '连接恢复，已按服务器局面重新同步' });
          }
          applyRoomState(m);
        }
        break;
      }

      case 'start':
        roundNo = m.round || 1;
        buildWorld(roundNo);
        view.phase = 'aim';
        break;

      case 'shot':
        // 自己这条是服务器「已受理」的回执；对手这条才需要本地开跑。
        if (m.seat === seat) {
          shotAckPending = false;
        } else {
          applyShotLocal(normalizeShot(m), false);
          wasMyShot = false;
        }
        break;

      case 'state':
        // 服务器发来的权威局面：拒收一杆、结算丢失、僵死重开都走这里。
        // 本地已经算完的这杆必须整段撤回，否则就会出现「一边定组、一边没定」。
        if (m.room) {
          const serverRun = m.room.phase === 'run';
          const localAhead = typeof m.room.shots === 'number' && match.shots > m.room.shots;
          const rejected = m.reason === 'no-pending' || m.reason === 'not-shooter'
            || m.reason === 'not-your-turn' || m.reason === 'not-aiming';
          // 服务端在 run 说明这杆已被受理，不能回滚；反之服务端已回到
          // aim/wait 而本地还领先，才是「这杆没算上」，必须撤回。
          // 明确的拒收原因无条件回滚：哪怕服务器正在跑上一杆（not-aiming），
          // 这一杆也确实没被受理，不回滚就会出现两端球位永久分叉。
          const wasMidShot = rejected || (!serverRun && (shotAckPending || localAhead));
          // 若这一杆正是本地刚打完、服务器没受理的：先用出杆前快照撤回球位，
          // 再用服务器状态对齐轮次/花色。room.snapshot 只保存「上一杆」的结果，
          // 第一杆被拒时它还是 null，光靠它会留下打飞后的球位。
          if (wasMidShot) rollbackShot('');
          applyRoomState(m.room);
          if (wasMidShot) queue.push({ kind: 'toast', text: m.reason === 'no-pending' || m.reason === 'not-shooter'
            ? '这一杆服务器没算上，已同步回当前局面'
            : '已按服务器局面重新同步' });
        }
        break;

      case 'place':
        if (world && Number.isFinite(m.x) && Number.isFinite(m.y)) {
          placeCueWorld(world, m.x, m.y);
          if (match.ballInHand === m.seat) match.ballInHand = null;
        }
        break;

      case 'groups':
        if (Array.isArray(m.group)) {
          match.group = m.group;
          match.open = !!m.open;
        }
        break;

      case 'turn':
        // 对手端本地物理可能还在跑：先别改 turn，否则它会按错误出杆人结算。
        // 真正的落状态统一走 result（服务端在停球后才发）。
        if (!settling) {
          match.turn = m.p;
          match.phase = 'aim';
          view.phase = 'aim';
        }
        break;

      case 'result': {
        // 服务端裁定的唯一结果：轮次 / 花色 / 自由球 / 胜负 / 停球快照。
        // shots 更旧的重复 result 直接丢弃，避免迟到消息把新局面改回旧局面。
        if (typeof m.shots === 'number' && m.shots < resolvedShots) break;
        if (typeof m.shots === 'number') resolvedShots = Math.max(resolvedShots, m.shots);
        shotAckPending = false;
        reportSentAt = 0;
        shotSentAt = 0;
        shotBackup = null;
        if (m.seat !== seat && m.snapshot) applySnapshot(m.snapshot);
        if (Array.isArray(m.group)) {
          match.group = m.group;
          match.open = !!m.open;
        }
        match.ballInHand = m.ballInHand ?? null;
        if (typeof m.shots === 'number') match.shots = m.shots;
        if (m.over) {
          match.phase = 'over';
          match.winner = m.winner ?? null;
          view.phase = 'over';
        } else {
          match.turn = m.turn;
          match.phase = 'aim';
          view.phase = 'aim';
        }
        break;
      }

      case 'aim':
        if (m.seat !== seat) view.opponentAim = { angle: m.angle, power: m.power };
        break;

      case 'toast':
        queue.push({ kind: 'toast', text: m.text });
        break;

      case 'pong':
        if (pingAt) {
          const sample = performance.now() - pingAt;
          pingAt = 0;
          if (sample > 0 && sample < 5000) rtt = rtt ? rtt * 0.7 + sample * 0.3 : sample;
        }
        // 出杆后迟迟没等到服务器回执：主动要一次权威局面。
        // 否则「服务器没收到这一杆」时，两边会一直各显示各的。
        if (shotAckPending && shotSentAt && Date.now() - shotSentAt > 6000) {
          shotSentAt = 0;
          send({ t: 'resync' });
        }
        // 结算已经发出但没等到 result（例如广播丢失）：同样要权威重同步。
        if (reportSentAt && Date.now() - reportSentAt > 6000) {
          reportSentAt = Date.now();
          send({ t: 'resync' });
        }
        // 空闲时定期对账：掉一条 result 也能自动收敛，不会永久分叉。
        if (!settling && !shotAckPending && !shotBackup && match.phase === 'aim'
          && Date.now() - lastSyncAt > 8000) {
          lastSyncAt = Date.now();
          send({ t: 'resync' });
        }
        break;

      case 'over':
        match.phase = 'over';
        match.winner = m.winner;
        view.phase = 'over';
        break;

      case 'peer':
        queue.push({ kind: 'toast', text: m.state === 'left' ? '对手已离开' : '对手已回来' });
        break;

      case 'err':
        error = m.msg || m.code;
        if (m.code === 'ROOM_FULL') {
          fatal = true;
          onStatus && onStatus('full');
        }
        queue.push({ kind: 'toast', text: '错误：' + (m.msg || m.code) });
        break;
    }
  }

  connect();

  return {
    mode: 'net',
    get names() { return view.names; },
    get view() {
      physicsTick();
      const dt = 1 / 60;
      for (const e of effects) e.t = Math.min(1, e.t + dt / FX_LIFE);
      effects = effects.filter((e) => e.t < 1);

      view.balls = world ? world.balls : [];
      view.match = match;
      view.mySeat = seat;
      view.canShoot = seat >= 0 && match.phase === 'aim' && match.turn === seat && !settling;
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
    placeCue(pos) {
      if (!(seat >= 0 && match.phase === 'aim' && match.ballInHand === seat)) return false;
      // 本地先落位（0 延迟），服务端确认后广播给对手
      if (world && placeCueWorld(world, pos.x, pos.y)) {
        match.ballInHand = null;
        send({ t: 'place', x: pos.x, y: pos.y });
        queue.push({ kind: 'toast', text: '母球已摆好，出杆' });
        return true;
      }
      return false;
    },
    canPlaceCue(pos) {
      if (!world) return false;
      return canPlaceCue(world, pos.x, pos.y);
    },
    shoot(shot) {
      if (!(seat >= 0 && match.phase === 'aim' && match.turn === seat && !settling)) return false;
      const s = normalizeShot(shot);
      // 本地立刻开打，同时把参数发给对手
      if (!applyShotLocal(s, true)) return false;
      wasMyShot = true;
      shotAckPending = true;
      shotSentAt = Date.now();
      send({ t: 'shot', ...s });
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
    reconnectTo,
    drain() { const q = queue; queue = []; return q; },
    dispose() {
      disposed = true;
      clearTimeout(waitWarnTimer);
      waitWarnTimer = null;
      if (ws) ws.close();
    },
  };
}

/** 探测服务端是否可用；不可用就降级本地 */
/** 探测服务端是否可用；不可用就降级本地 */
export async function probeServer(timeout = 1200) {
  if (location.protocol === 'file:') return false;
  return new Promise((resolve) => {
    let done = false;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => { ctl.abort(); finish(false); }, timeout);
      function finish(ok) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(ok);
      }
      fetch('/health', { signal: ctl.signal, cache: 'no-store' })
        .then((r) => finish(r.ok))
        .catch(() => finish(false));
    } catch { resolve(false); }
  });
}
