/**
 * net.det.mjs — 新架构（确定性双端同步）联机回归
 * 验证：座位分配 / start / 双方各自收到同一击球指令 / report 推进轮次
 */
const PORT = process.env.PORT || 3000;
const WS = `ws://127.0.0.1:${PORT}/api/ws`;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(room, token) {
  const ws = new WebSocket(`${WS}?room=${room}&token=${token}`);
  ws.msgs = [];
  ws.onmessage = (e) => { try { ws.msgs.push(JSON.parse(e.data)); } catch {} };
  return new Promise((res, rej) => {
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error('ws open failed'));
  });
}
const send = (ws, o) => ws.send(JSON.stringify(o));
const lastOf = (ws, t) => { for (let i = ws.msgs.length - 1; i >= 0; i--) if (ws.msgs[i].t === t) return ws.msgs[i]; return null; };

async function main() {
  const room = 'det' + Math.floor(Math.random() * 100000);
  const a = await open(room, 'ta');
  const b = await open(room, 'tb');
  send(a, { t: 'hello', name: 'A', room, token: 'ta' });
  send(b, { t: 'hello', name: 'B', room, token: 'tb' });
  await sleep(400);

  ok(lastOf(a, 'welcome')?.seat === 0, 'A 座位 0');
  ok(lastOf(b, 'welcome')?.seat === 1, 'B 座位 1');
  ok(!!lastOf(a, 'start'), 'A 收到 start');
  ok(!!lastOf(b, 'start'), 'B 收到 start');
  ok(lastOf(a, 'start')?.round === 1, 'start 带 round=1');

  // A 出杆：服务端应把同一 shot 广播给两端
  send(a, { t: 'shot', angle: 0.3, power: 0.7, spin: { a: 0.1, b: 0 } });
  await sleep(300);
  const sa = lastOf(a, 'shot'), sb = lastOf(b, 'shot');
  ok(!!sa, 'A 收到 shot 广播');
  ok(!!sb, 'B 收到 shot 广播');
  ok(sa && sb && sa.seat === 0 && sb.seat === 0, 'shot 标注出杆方 seat=0');
  ok(sa && sb && Math.abs(sa.angle - 0.3) < 1e-9 && sa.angle === sb.angle, '两端 angle 完全一致');

  // A 上报结算 → 轮次应切到 B
  send(a, { t: 'report', group: [null, null], open: true, ballInHand: null, turn: 1, over: false, hint: '没进球，换对手' });
  await sleep(300);
  const ta = lastOf(a, 'turn'), tb = lastOf(b, 'turn');
  ok(ta?.p === 1, 'A 收到 turn=1');
  ok(tb?.p === 1, 'B 收到 turn=1');

  // 越权：B 轮次未到，A 再出杆应被忽略
  const before = a.msgs.filter((m) => m.t === 'shot').length;
  send(a, { t: 'shot', angle: 1, power: 0.5 });
  await sleep(250);
  const after = a.msgs.filter((m) => m.t === 'shot').length;
  ok(after === before, '非本方轮次出杆被忽略');

  // 第三个人进同一房间应被拒
  const c = await open(room, 'tc');
  send(c, { t: 'hello', name: 'C', room, token: 'tc' });
  await sleep(300);
  ok(lastOf(c, 'err')?.code === 'ROOM_FULL', '第三人被拒 ROOM_FULL');

  a.close(); b.close(); c.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });