/**
 * rules.js — 经典八球规则状态机（纯函数，无 DOM，两端共用）
 *
 * 15 球：1~7 实心(solid)、8 黑(eight)、9~15 花色(stripe)。
 * 开局「开放表(open)」，谁先合法进球谁定花色；清完己方花色后打 8 胜。
 *
 * 犯规(foul)：
 *   ① 母球空杆未碰任何球(anyHit=false)
 *   ② 母球先碰的球不是「合法目标」（开放表先碰 8 即犯规；已定花色先碰对方球/8 犯规；已清台先碰非 8 犯规）
 *   ③ 母球落袋(scratch)
 * 犯规 → 一定换手（进球也不继续），且**对手获得全台自由球(ball-in-hand)**：
 *   可把母球拖到台面任意合法位置（不压球、不压袋口、不出台）后再出杆。
 *
 * 黑 8 结算：
 *   己方花色全清 + 未犯规 + 母球未落袋 → 进 8 胜；否则进 8 负（含进 8 同时犯规/落袋）。
 *   开放表开球进 8 → 重摆 8，不判负（休闲友好规则）。
 */

export const GROUP_SOLID = 'solid';   // 1~7
export const GROUP_STRIPE = 'stripe'; // 9~15
export const GROUP_EIGHT = 'eight';   // 8

export const SOLID_BALLS = [1, 2, 3, 4, 5, 6, 7];
export const STRIPE_BALLS = [9, 10, 11, 12, 13, 14, 15];
export const OBJECT_BALLS = [...SOLID_BALLS, 8, ...STRIPE_BALLS];

/** 球号 → 分组 */
export function ballGroup(id) {
  if (id >= 1 && id <= 7) return GROUP_SOLID;
  if (id >= 9 && id <= 15) return GROUP_STRIPE;
  if (id === 8) return GROUP_EIGHT;
  return null;
}

export function groupName(g) {
  if (g === GROUP_SOLID) return '实心球(1-7)';
  if (g === GROUP_STRIPE) return '花色球(9-15)';
  if (g === GROUP_EIGHT) return '黑8';
  return '未定';
}

export function createMatch() {
  return {
    turn: 0,                 // 当前出杆方 0 | 1
    phase: 'aim',            // aim | run | over
    group: [null, null],     // 双方花色：null(未定) | solid | stripe
    open: true,              // 开放表（花色未定）
    winner: null,            // null | 0 | 1
    shots: 0,
    ballInHand: null,        // null | 0 | 1 —— 谁获得自由球（可任意摆放母球）
    last: null,              // 上一杆摘要，供 HUD
    rematchVotes: [false, false],
  };
}

/** 某花色是否已全部进袋（基于累计 pottedAll 列表） */
export function groupCleared(pottedAll, group) {
  const list = group === GROUP_SOLID ? SOLID_BALLS : STRIPE_BALLS;
  return list.every((id) => pottedAll.includes(id));
}

/** 某花色还剩哪些球 */
export function groupRemaining(pottedAll, group) {
  const list = group === GROUP_SOLID ? SOLID_BALLS : STRIPE_BALLS;
  return list.filter((id) => !pottedAll.includes(id));
}

/**
 * 结算一杆（会就地修改 match）。
 * @param {object} match
 * @param {{newPotted:number[], cuePotted:boolean, firstHit:number|null, anyHit:boolean, pottedAll:number[]}} res
 *        newPotted  本杆新落袋的目标球 id（不含母球、不含之前已进的）
 *        cuePotted  母球是否落袋
 *        firstHit   母球本杆首次触碰的球 id（null = 没碰球）
 *        anyHit     母球是否碰到了任意球
 *        pottedAll  累计已进袋球 id（含本杆，不含母球），用于判断清台
 * @returns {{over:boolean, winner:0|1|null, foul:boolean, continueTurn:boolean, hint:string, respot:number[]}}
 */
export function resolveShot(match, res) {
  const me = match.turn;
  const opp = 1 - me;
  const newPotted = (res.newPotted || []).filter((id) => id !== 0 && id !== 8);
  const eight = (res.newPotted || []).includes(8);
  const cuePotted = !!res.cuePotted;
  const firstHit = res.firstHit != null ? res.firstHit : null;
  const anyHit = !!res.anyHit;
  const pottedAll = res.pottedAll || [];

  // 本杆开始前己方花色是否已清完（用于「是否该打 8」的判断）
  // 必须基于「本杆之前」的进袋集合，否则清最后一颗己方球同时进 8 的那一杆会被误判犯规。
  const pottedBefore = pottedAll.filter((id) => !(newPotted.includes(id) || (eight && id === 8)));
  const clearedBefore = match.group[me] && groupCleared(pottedBefore, match.group[me]);
  const wasOpen = match.open;   // 本杆开始时的开放表状态（定花色会改变它，八球结算需用旧值）

  let foul = false;
  let reason = '';

  // —— 犯规判定 ——
  if (!anyHit) {
    foul = true; reason = '空杆：母球未碰到任何球';
  } else if (match.open) {
    // 开放表：不能先碰 8（除非仅剩 8，休闲局忽略该极端情形）
    if (firstHit === 8) { foul = true; reason = '开放表先碰黑8犯规'; }
  } else {
    const myGroup = match.group[me];
    const onEight = clearedBefore;
    if (onEight) {
      if (firstHit !== 8) { foul = true; reason = '应先碰黑8'; }
    } else {
      const hitG = ballGroup(firstHit);
      if (hitG !== myGroup) { foul = true; reason = `应先碰${groupName(myGroup)}`; }
    }
  }
  if (cuePotted) { foul = true; reason = reason || '母球落袋'; }

  // —— 开放表进球定花色（无犯规才定）——
  if (match.open && !foul && newPotted.length) {
    const g = ballGroup(newPotted[0]);
    if (g === GROUP_SOLID || g === GROUP_STRIPE) {
      match.group[me] = g;
      match.group[opp] = g === GROUP_SOLID ? GROUP_STRIPE : GROUP_SOLID;
      match.open = false;
    }
  }

  // —— 黑 8 结算 ——
  let over = false;
  let respot = [];
  if (eight) {
    if (wasOpen) {
      // 开放表（通常是开球）进 8：重摆，不判负
      respot = [8];
      if (!foul && newPotted.length) {
        // 同时进了彩球且无犯规 → 定花色并继续
        const g = ballGroup(newPotted[0]);
        if (g === GROUP_SOLID || g === GROUP_STRIPE) {
          match.group[me] = g;
          match.group[opp] = g === GROUP_SOLID ? GROUP_STRIPE : GROUP_SOLID;
          match.open = false;
        }
      }
    } else {
      const myGroup = match.group[me];
      const cleared = myGroup && groupCleared(pottedAll, myGroup);
      if (cleared && !foul && !cuePotted) {
        over = true; match.phase = 'over'; match.winner = me;
      } else {
        over = true; match.phase = 'over'; match.winner = opp;
      }
    }
  }

  // —— 换手 / 继续 ——
  let continueTurn = false;
  if (!over) {
    if (!foul) {
      if (match.open) {
        continueTurn = newPotted.length > 0;
      } else {
        const myGroup = match.group[me];
        const pottedOwn = newPotted.filter((id) => ballGroup(id) === myGroup).length;
        continueTurn = pottedOwn > 0;
      }
    }
    if (!continueTurn) match.turn = opp;
  }
  // 关键：非结束杆必须把 phase 落回 aim，否则会永远停在 run（反复结算/音效狂响/无法继续）
  if (!over) match.phase = 'aim';

  // 自由球：犯规后由对手自由摆放母球（ball-in-hand）；未犯规则清空
  match.ballInHand = (!over && foul) ? opp : null;

  match.shots++;

  // —— 提示文案 ——
  let hint;
  if (over) {
    const wname = match.winner === 0 ? '玩家1' : '玩家2';
    if (eight && match.open) hint = '开球进黑8，重摆继续';
    else if (cuePotted && eight) hint = `进黑8但母球落袋，${wname} 落败`;
    else if (foul && eight) hint = `进黑8犯规，${wname} 落败`;
    else hint = `合法打进黑8，${wname} 获胜！`;
  } else if (foul) {
    hint = `${reason} · 自由球`;
  } else if (continueTurn) {
    hint = newPotted.length
      ? `进 ${newPotted.join('、')} 号，继续`
      : '继续';
  } else if (newPotted.length) {
    hint = `进 ${newPotted.join('、')} 号，但轮到对手`;
  } else {
    hint = '空杆，换手';
  }

  match.last = { by: me, foul, newPotted, cuePotted, eight, hint };
  return { over, winner: match.winner, foul, continueTurn, hint, respot };
}

export function resetMatch(match) {
  match.turn = 0;
  match.phase = 'aim';
  match.group = [null, null];
  match.open = true;
  match.winner = null;
  match.shots = 0;
  match.ballInHand = null;
  match.last = null;
  match.rematchVotes = [false, false];
  return match;
}
