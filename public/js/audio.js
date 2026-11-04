/**
 * audio.js — WebAudio 程序合成音效，不引任何外部音频文件（离线可用）
 *
 * 分层结构：
 *   [table] 球撞球 / 撞库 / 落袋   → ┐
 *   [cue]   出杆 / 滑杆            → ├→ [master] → destination
 *   [ui]    换手 / 得分 / 胜负     → ┘
 * 每条总线独立增益，可运行时用 setMix({ table, cue, ui, master }) 调平衡。
 * 每个事件自身也由「瞬态 + 主体共鸣 + 低频/尾音」多层叠加，不是单薄的一声。
 */
export function createAudio() {
  let ac = null;
  let noiseBuf = null;
  let enabled = true;

  const levels = { table: 0.9, cue: 1.0, ui: 0.8, master: 0.85 };
  const buses = {};

  function ensure() {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ac = new AC();

      const master = ac.createGain();
      master.gain.value = levels.master;
      master.connect(ac.destination);
      buses.master = master;

      for (const k of ['table', 'cue', 'ui']) {
        const g = ac.createGain();
        g.gain.value = levels[k];
        g.connect(master);
        buses[k] = g;
      }
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }

  /** 每条音效链挂到指定总线；总线还没建立时退到 master */
  const out = (bus) => buses[bus] || buses.master || (ac && ac.destination);

  function noise() {
    if (!noiseBuf) {
      const n = ac.sampleRate * 1.0;
      noiseBuf = ac.createBuffer(1, n, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }

  function burst({ dur = 0.05, freq = 2600, q = 1.6, gain = 0.3, type = 'bandpass', sweepTo = null, bus = 'table', delay = 0 }) {
    const c = ensure();
    if (!c || !enabled) return;
    const t0 = c.currentTime + delay;
    const src = c.createBufferSource();
    src.buffer = noise();
    src.playbackRate.value = 1;

    const flt = c.createBiquadFilter();
    flt.type = type;
    flt.frequency.setValueAtTime(freq, t0);
    flt.Q.value = q;
    if (sweepTo) flt.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);

    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(flt).connect(g).connect(out(bus));
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  function tone({ f0 = 400, f1 = 400, dur = 0.12, gain = 0.2, type = 'sine', bus = 'table', delay = 0 }) {
    const c = ensure();
    if (!c || !enabled) return;
    const t0 = c.currentTime + delay;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(out(bus));
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  return {
    unlock() { ensure(); },
    setEnabled(v) {
      enabled = v;
      if (buses.master && ac) {
        buses.master.gain.setTargetAtTime(v ? levels.master : 0, ac.currentTime, 0.02);
      }
    },
    get enabled() { return enabled; },

    /** 运行时调各层增益，返回当前混音；值域 0~2 */
    setMix(v) {
      if (v && typeof v === 'object') {
        for (const k of Object.keys(levels)) {
          if (typeof v[k] !== 'number' || !Number.isFinite(v[k])) continue;
          levels[k] = Math.max(0, Math.min(2, v[k]));
          if (buses[k] && ac) buses[k].gain.setTargetAtTime(levels[k], ac.currentTime, 0.02);
        }
      }
      return { ...levels };
    },
    get layers() { return { ...levels }; },

    /** 球撞球：高频脆响 + 球体共鸣 + 低频撞击体 */
    ballHit(speed) {
      const k = Math.min(1, (speed || 0) / 5);
      burst({ dur: 0.035 + k * 0.03, freq: 2400 + k * 1800, q: 2.4, gain: 0.10 + k * 0.24, sweepTo: 1400 });
      tone({ f0: 700 + k * 500, f1: 420, dur: 0.05, gain: 0.05 + k * 0.09, type: 'triangle' });
      tone({ f0: 190, f1: 110, dur: 0.045, gain: 0.03 + k * 0.06, type: 'sine' });
    },

    /** 撞库：木质低噪 + 库边弹性 + 短促木 click */
    cushion(speed) {
      const k = Math.min(1, (speed || 0) / 5);
      burst({ dur: 0.05 + k * 0.05, freq: 520, q: 0.9, gain: 0.09 + k * 0.18, type: 'lowpass', sweepTo: 240 });
      tone({ f0: 150, f1: 95, dur: 0.07, gain: 0.09 + k * 0.10, type: 'sine' });
      burst({ dur: 0.02, freq: 1200, q: 1.2, gain: 0.03 + k * 0.05, delay: 0.004 });
    },

    /** 进袋：落袋 whoosh + 空腔回声 + 袋底闷响；白球落袋（犯规）音色更低沉 */
    pocket(id = 1) {
      const foul = id === 0;
      burst({ dur: 0.14, freq: foul ? 640 : 900, q: 0.8, gain: 0.20, type: 'lowpass', sweepTo: foul ? 180 : 260 });
      tone({ f0: foul ? 220 : 320, f1: foul ? 65 : 90, dur: 0.22, gain: 0.14, type: 'sine' });
      tone({ f0: foul ? 90 : 110, f1: 62, dur: 0.30, gain: 0.08, type: 'sine', delay: 0.05 });
      if (!foul) {
        tone({ f0: 880 + (id % 8) * 65, f1: 620, dur: 0.07, gain: 0.035, type: 'sine', bus: 'ui', delay: 0.02 });
      }
    },

    /** 出杆：皮头脆响 + 杆身共振 + 低频推力 */
    cue() {
      burst({ dur: 0.05, freq: 1800, q: 3, gain: 0.16, bus: 'cue' });
      tone({ f0: 260, f1: 160, dur: 0.06, gain: 0.07, type: 'triangle', bus: 'cue' });
      tone({ f0: 120, f1: 88, dur: 0.09, gain: 0.04, type: 'sine', bus: 'cue', delay: 0.008 });
    },

    /** 滑杆：擦杆噪声 + 破音 */
    miscue() {
      burst({ dur: 0.12, freq: 5200, q: 0.7, gain: 0.14, type: 'highpass', bus: 'cue' });
      tone({ f0: 300, f1: 170, dur: 0.10, gain: 0.05, type: 'sawtooth', bus: 'cue' });
    },

    /** 换手提示 */
    turn() {
      tone({ f0: 620, f1: 880, dur: 0.10, gain: 0.08, type: 'sine', bus: 'ui' });
      tone({ f0: 880, f1: 1100, dur: 0.09, gain: 0.06, type: 'sine', bus: 'ui', delay: 0.09 });
    },

    /** 得分：双音上行 + 亮片层 */
    score() {
      tone({ f0: 700, f1: 1050, dur: 0.09, gain: 0.09, type: 'sine', bus: 'ui' });
      tone({ f0: 1050, f1: 1500, dur: 0.13, gain: 0.07, type: 'sine', bus: 'ui', delay: 0.08 });
      burst({ dur: 0.08, freq: 5200, q: 0.8, gain: 0.025, type: 'highpass', bus: 'ui', delay: 0.10 });
    },

    /** 胜利：大三和弦琶音 + 低频鼓点 + 高频 shimmer，与彩带同步 */
    win() {
      const notes = [523, 659, 784, 1046];
      notes.forEach((f, i) => {
        const d = i * 0.13;
        tone({ f0: f, f1: f, dur: 0.30, gain: 0.09, type: 'triangle', bus: 'ui', delay: d });
        tone({ f0: f * 2, f1: f * 2, dur: 0.18, gain: 0.025, type: 'sine', bus: 'ui', delay: d });
      });
      tone({ f0: 130, f1: 58, dur: 0.30, gain: 0.12, type: 'sine', bus: 'ui', delay: 0.02 });
      burst({ dur: 0.55, freq: 6200, q: 0.6, gain: 0.035, type: 'highpass', bus: 'ui', delay: 0.22 });
      tone({ f0: 1046, f1: 1568, dur: 0.42, gain: 0.07, type: 'triangle', bus: 'ui', delay: 0.52 });
    },

    /** 失败（联机时输的一方）：下行小调 + 低沉尾音 */
    lose() {
      [440, 349, 262].forEach((f, i) => {
        tone({ f0: f, f1: f * 0.97, dur: 0.24, gain: 0.075, type: 'triangle', bus: 'ui', delay: i * 0.17 });
      });
      tone({ f0: 165, f1: 78, dur: 0.55, gain: 0.07, type: 'sine', bus: 'ui', delay: 0.36 });
    },

    /** 平局：平缓的中性双音 */
    draw() {
      tone({ f0: 494, f1: 523, dur: 0.22, gain: 0.08, type: 'sine', bus: 'ui' });
      tone({ f0: 494, f1: 523, dur: 0.22, gain: 0.06, type: 'triangle', bus: 'ui', delay: 0.16 });
    },
  };
}
