/* Royale Roulette — browser client.
 *
 * Renders the table on a single HTML5 canvas, synthesises every sound with
 * the Web Audio API and forwards player intents to the authoritative server.
 * Nothing about the outcome of a round is decided here.
 */
(() => {
  'use strict';

  /* ======================================================================== */
  /*  Utilities                                                               */
  /* ======================================================================== */

  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const mod = (a, n) => ((a % n) + n) % n;
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
  const signedMoney = (n) => (n > 0 ? `+${money(n)}` : n < 0 ? `−${money(-n)}` : '$0');
  const byId = (id) => document.getElementById(id);

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function storageGet(kind, key) {
    try {
      return window[kind].getItem(key);
    } catch {
      return null;
    }
  }
  function storageSet(kind, key, value) {
    try {
      if (value === null) window[kind].removeItem(key);
      else window[kind].setItem(key, value);
    } catch {
      /* storage unavailable (private mode etc.) — non-critical */
    }
  }

  function hexToRgb(hex) {
    let h = String(hex || '#888888').replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const shade = (hex, f) => {
    const [r, g, b] = hexToRgb(hex);
    return `rgb(${Math.round(r * f)},${Math.round(g * f)},${Math.round(b * f)})`;
  };
  const tint = (hex, f) => {
    const [r, g, b] = hexToRgb(hex);
    return `rgb(${Math.round(r + (255 - r) * f)},${Math.round(g + (255 - g) * f)},${Math.round(b + (255 - b) * f)})`;
  };
  const rgba = (hex, a) => {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r},${g},${b},${a})`;
  };

  /* ======================================================================== */
  /*  Constants & table geometry (logical 1700 × 920 canvas space)            */
  /* ======================================================================== */

  const W = 1700;
  const H = 920;
  const FONT_D = "'Cinzel', Georgia, 'Times New Roman', serif";
  const FONT_U = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif";

  const PHASE = {
    WAITING: 'WAITING_FOR_HOST',
    BETTING: 'BETTING_OPEN',
    SPINNING: 'SPINNING',
    PAYOUT: 'PAYOUT_SETTLEMENT',
    CLEANUP: 'ROUND_CLEANUP',
  };
  const PHASE_LABEL = {
    WAITING_FOR_HOST: 'Waiting for host',
    BETTING_OPEN: 'Betting open',
    SPINNING: 'Spinning',
    PAYOUT_SETTLEMENT: 'Payout',
    ROUND_CLEANUP: 'Round summary',
  };

  // Stadium table: [left semicircle] + [centre rectangle] + [right semicircle]
  const TABLE = { xL: 380, xR: 1160, cy: 460, R: 320, rail: 36 };
  const WHEEL = {
    cx: TABLE.xL,
    cy: TABLE.cy,
    R: 245,
    trackOuter: 228,
    trackInner: 196,
    rotorR: 168,
    numberInner: 142,
    pocketInner: 112,
    coneInner: 52,
  };
  const BALL = { r: 6.5, trackR: 212, pocketR: 127 };

  const G = (() => {
    const g = { x: 655, y: 329, zeroW: 48, cw: 53, ch: 58, dh: 44, oh: 44 };
    g.nx = g.x + g.zeroW;
    g.numEnd = g.nx + 12 * g.cw;
    g.right = g.numEnd + g.cw;
    g.numBottom = g.y + 3 * g.ch;
    g.dozBottom = g.numBottom + g.dh;
    g.bottom = g.dozBottom + g.oh;
    g.cx = (g.x + g.right) / 2;
    return g;
  })();

  // Perimeter seat stations, clockwise from top-left.
  const SEATS = [
    { x: 620, y: 74 },
    { x: 880, y: 74 },
    { x: 1140, y: 74 },
    { x: 1552, y: 285 },
    { x: 1552, y: 635 },
    { x: 1140, y: 846 },
    { x: 880, y: 846 },
    { x: 620, y: 846 },
  ];
  const SEAT_W = 188;
  const SEAT_H = 72;
  const DEALER_POINT = { x: G.x - 30, y: G.y - 70 };

  const WHEEL_ORDER = [
    0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10,
    5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
  ];
  const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const colorOf = (n) => (n === 0 ? 'green' : RED.has(n) ? 'red' : 'black');
  const POCKET = TAU / 37;
  const POCKET_COLORS = {
    red: { base: '#b81d27', deep: '#6e0f16', disc: '#c9252f' },
    black: { base: '#18181c', deep: '#09090b', disc: '#1b1b20' },
    green: { base: '#0f8a4b', deep: '#07502b', disc: '#0e7a43' },
  };

  const CHIP_VALUES = [1, 5, 10, 25, 100];
  const DENOM = {
    1: { base: '#f1ede2', edge: '#2453b8', side: '#b9b4a6' },
    5: { base: '#c8202f', edge: '#ffffff', side: '#7c111b' },
    10: { base: '#1f5fd1', edge: '#ffffff', side: '#123b85' },
    25: { base: '#138a4c', edge: '#ffffff', side: '#0a5430' },
    100: { base: '#1b1b20', edge: '#d6b35a', side: '#050507' },
  };

  // Avatar badges (24×24 viewBox) — rendered in SVG for the DOM and Path2D on canvas.
  const ICON_PATHS = {
    circle: 'M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 1 1 0-17z',
    triangle: 'M12 3L21.5 19.5H2.5z',
    square: 'M4.5 4.5h15v15h-15z',
    diamond: 'M12 2L22 12L12 22L2 12z',
    star: 'M12 2.5L14.47 9.1L21.51 9.41L15.99 13.8L17.88 20.59L12 16.7L6.12 20.59L8.01 13.8L2.49 9.41L9.53 9.1z',
    hexagon: 'M12 2.5L20.23 7.25V16.75L12 21.5L3.77 16.75V7.25z',
    cross: 'M9 3h6v6h6v6h-6v6H9v-6H3V9h6z',
    bolt: 'M13.5 1.5L4.5 13.5h6L9 22.5l10-12.5h-6.2z',
  };
  const CROWN_PATH = 'M2.5 8l5 4.2L12 4.5l4.5 7.7 5-4.2-1.8 10.5H4.3z';
  const pathCache = new Map();
  const path2d = (d) => {
    if (!pathCache.has(d)) pathCache.set(d, new Path2D(d));
    return pathCache.get(d);
  };

  function drawIcon(c, name, x, y, size, color) {
    c.save();
    c.translate(x - size / 2, y - size / 2);
    c.scale(size / 24, size / 24);
    c.fillStyle = color;
    c.fill(path2d(ICON_PATHS[name] || ICON_PATHS.circle));
    c.restore();
  }

  function avatarEl(player, extraClass = '') {
    const span = document.createElement('span');
    span.className = `avatar ${extraClass}`.trim();
    span.style.background = `radial-gradient(circle at 35% 30%, ${tint(player.color, 0.35)}, ${player.color} 58%, ${shade(player.color, 0.55)})`;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', ICON_PATHS[player.avatarIcon] || ICON_PATHS.circle);
    path.setAttribute('fill', '#fff');
    svg.appendChild(path);
    span.appendChild(svg);
    return span;
  }

  /* ======================================================================== */
  /*  Audio synthesiser — Web Audio API only, no sample files                 */
  /* ======================================================================== */

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.muted = storageGet('localStorage', 'rr-muted') === '1';
      this.lastParamUpdate = 0;
    }

    unlock() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        try {
          this.ctx = new AC();
        } catch {
          return;
        }
        this.build();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    }

    get ready() {
      return Boolean(this.ctx) && this.ctx.state === 'running';
    }

    build() {
      const c = this.ctx;
      this.master = c.createGain();
      this.master.gain.value = this.muted ? 0 : 0.9;
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;
      this.master.connect(comp);
      comp.connect(c.destination);

      const len = c.sampleRate * 2;
      this.noise = c.createBuffer(1, len, c.sampleRate);
      const white = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) white[i] = Math.random() * 2 - 1;

      this.brown = c.createBuffer(1, len, c.sampleRate);
      const brown = this.brown.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        brown[i] = last * 3.5;
      }

      // Wheel whirl: filtered brown noise + a low triangle drone, both tracking rotor speed.
      this.humSrc = this.loopSource(this.brown);
      this.humFilter = c.createBiquadFilter();
      this.humFilter.type = 'bandpass';
      this.humFilter.frequency.value = 200;
      this.humFilter.Q.value = 0.9;
      this.humGain = c.createGain();
      this.humGain.gain.value = 0;
      this.humSrc.connect(this.humFilter).connect(this.humGain).connect(this.master);

      this.humOsc = c.createOscillator();
      this.humOsc.type = 'triangle';
      this.humOsc.frequency.value = 45;
      this.humOscGain = c.createGain();
      this.humOscGain.gain.value = 0;
      const humLow = c.createBiquadFilter();
      humLow.type = 'lowpass';
      humLow.frequency.value = 260;
      this.humOsc.connect(humLow).connect(this.humOscGain).connect(this.master);

      // Ball roll: airy band-passed white noise under the discrete clicks.
      this.rollSrc = this.loopSource(this.noise);
      this.rollFilter = c.createBiquadFilter();
      this.rollFilter.type = 'bandpass';
      this.rollFilter.frequency.value = 2500;
      this.rollFilter.Q.value = 1.4;
      this.rollGain = c.createGain();
      this.rollGain.gain.value = 0;
      this.rollSrc.connect(this.rollFilter).connect(this.rollGain).connect(this.master);

      const t = c.currentTime;
      this.humSrc.start(t);
      this.humOsc.start(t);
      this.rollSrc.start(t);
    }

    loopSource(buffer) {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      return src;
    }

    setMuted(muted) {
      this.muted = muted;
      storageSet('localStorage', 'rr-muted', muted ? '1' : '0');
      if (this.master) this.master.gain.setTargetAtTime(muted ? 0 : 0.9, this.ctx.currentTime, 0.05);
    }

    /** Continuous layers, called every frame; parameter writes are throttled. */
    update(now, wheelSpeed, rollLevel) {
      if (!this.ctx || now - this.lastParamUpdate < 50) return;
      this.lastParamUpdate = now;
      const t = this.ctx.currentTime;
      const s = clamp(wheelSpeed, 0, 1);
      const v = Math.pow(s, 1.4);
      this.humFilter.frequency.setTargetAtTime(150 + s * 950, t, 0.12);
      this.humGain.gain.setTargetAtTime(v * 0.32, t, 0.15);
      this.humOsc.frequency.setTargetAtTime(36 + s * 78, t, 0.12);
      this.humOscGain.gain.setTargetAtTime(v * 0.07, t, 0.15);
      const r = clamp(rollLevel, 0, 1);
      this.rollFilter.frequency.setTargetAtTime(1600 + r * 3200, t, 0.08);
      this.rollGain.gain.setTargetAtTime(r * 0.05, t, 0.08);
    }

    burst(t, { freq, endFreq, q = 5, dur = 0.03, gain = 0.3, type = 'bandpass' }) {
      const c = this.ctx;
      const src = c.createBufferSource();
      src.buffer = this.noise;
      const f = c.createBiquadFilter();
      f.type = type;
      f.frequency.setValueAtTime(freq, t);
      if (endFreq) f.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
      f.Q.value = q;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.0015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f).connect(g).connect(this.master);
      src.start(t, Math.random() * 1.8, dur + 0.05);
    }

    tone(t, { freq, endFreq, dur = 0.1, gain = 0.1, type = 'sine', attack = 0.002 }) {
      const c = this.ctx;
      const osc = c.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }

    /** Rapid metallic tick of the ball riding the outer track. */
    ballTick(intensity, offset = 0) {
      if (!this.ready) return;
      const t = this.ctx.currentTime + offset;
      const k = clamp(intensity, 0.05, 1);
      this.burst(t, { freq: 4600 + Math.random() * 2200, q: 7, dur: 0.012, gain: 0.04 + 0.09 * k });
      this.tone(t, { freq: 3100 + Math.random() * 1100, dur: 0.02, gain: 0.012 + 0.025 * k, type: 'triangle' });
    }

    /** Hollow click of the ball skipping over a pocket fret. */
    fretClick(intensity, offset = 0) {
      if (!this.ready) return;
      const t = this.ctx.currentTime + offset;
      const k = clamp(intensity, 0.1, 1);
      this.burst(t, { freq: 2000 + Math.random() * 1200, q: 6, dur: 0.024, gain: 0.08 + 0.16 * k });
      this.tone(t, { freq: 1000 + Math.random() * 600, endFreq: 760, dur: 0.04, gain: 0.04 + 0.06 * k, type: 'triangle' });
    }

    /** Ball striking a diamond deflector / dropping into the rotor. */
    bounce(intensity, offset = 0) {
      if (!this.ready) return;
      const t = this.ctx.currentTime + offset;
      const k = clamp(intensity, 0.1, 1);
      const f = 480 + Math.random() * 220;
      this.tone(t, { freq: f, endFreq: f * 0.42, dur: 0.1, gain: 0.14 + 0.22 * k });
      this.burst(t, { freq: 1300 + Math.random() * 500, q: 3, dur: 0.05, gain: 0.12 + 0.22 * k });
      this.burst(t + 0.004, { freq: 3600, q: 9, dur: 0.016, gain: 0.08 + 0.12 * k });
    }

    settle() {
      if (!this.ready) return;
      this.bounce(0.4);
      this.fretClick(0.55, 0.07);
      this.fretClick(0.3, 0.14);
      const t = this.ctx.currentTime + 0.02;
      this.tone(t, { freq: 170, endFreq: 90, dur: 0.14, gain: 0.16 });
    }

    /** Crisp layered ceramic chip click. */
    chip(intensity = 1, offset = 0) {
      if (!this.ready) return;
      const t = this.ctx.currentTime + offset;
      const k = clamp(intensity, 0.1, 1);
      this.burst(t, { freq: 3300 + Math.random() * 300, q: 9, dur: 0.03, gain: 0.3 * k });
      this.burst(t + 0.017, { freq: 2400 + Math.random() * 300, q: 7, dur: 0.032, gain: 0.2 * k });
      this.burst(t + 0.032, { freq: 4300, q: 11, dur: 0.02, gain: 0.12 * k });
      this.tone(t, { freq: 2850 + Math.random() * 400, endFreq: 2500, dur: 0.045, gain: 0.05 * k });
      this.tone(t, { freq: 900, endFreq: 600, dur: 0.03, gain: 0.04 * k, type: 'triangle' });
    }

    /** Harmonious dual-frequency payout chime (perfect fifths, two strikes). */
    chime() {
      if (!this.ready) return;
      const t = this.ctx.currentTime + 0.02;
      const strikes = [
        [880, 1318.51],
        [1108.73, 1661.22],
      ];
      strikes.forEach(([a, b], i) => {
        const st = t + i * 0.16;
        for (const f of [a, b]) {
          this.tone(st, { freq: f, dur: 1.9, gain: 0.1, attack: 0.006 });
          this.tone(st, { freq: f * 2, dur: 0.9, gain: 0.022, attack: 0.004 });
          this.tone(st, { freq: f * 3.01, dur: 0.35, gain: 0.01, attack: 0.003 });
        }
      });
    }

    sweep() {
      if (!this.ready) return;
      const t = this.ctx.currentTime;
      this.burst(t, { freq: 1800, endFreq: 320, q: 0.8, dur: 0.45, gain: 0.07, type: 'lowpass' });
    }

    countdownTick(final) {
      if (!this.ready) return;
      this.tone(this.ctx.currentTime, { freq: final ? 1650 : 1250, dur: 0.06, gain: 0.05 });
    }
  }

  const audio = new AudioEngine();

  /* ======================================================================== */
  /*  Client state                                                            */
  /* ======================================================================== */

  const store = {
    config: { maxSeats: 8, minPlayersToStart: 2, chipValues: CHIP_VALUES, cleanupMs: 5000, maxBetPerSpot: 1000 },
    legal: new Map(),
    spots: new Map(),
    state: null,
    players: new Map(),
    betsByKey: new Map(),
    me: null,
    token: storageGet('sessionStorage', 'rr-token'),
    name: storageGet('sessionStorage', 'rr-name') || '',
    joining: false,
    selectedChip: 5,
    deadline: 0,
    duration: 0,
    phaseChangedAt: 0,
    lastSpinId: null,
    result: null,
    appliedResultId: null,
    lastCountdownSec: null,
  };

  const fx = {
    pops: new Map(), // betKey -> timestamp of last chip placement
    sweeps: [],
    floaters: [],
    dispChips: new Map(),
  };

  const getMe = () => (store.me ? store.players.get(store.me) || null : null);
  const isPhase = (...phases) => Boolean(store.state) && phases.includes(store.state.phase);
  const canBet = () => {
    const me = getMe();
    return Boolean(me && me.connected && !me.ready && isPhase(PHASE.BETTING));
  };
  const activeResult = () =>
    store.result && isPhase(PHASE.PAYOUT, PHASE.CLEANUP) ? store.result : null;

  /* ======================================================================== */
  /*  Betting spot geometry & hit testing                                     */
  /* ======================================================================== */

  function cellRect(n) {
    if (n === 0) return { x: G.x, y: G.y, w: G.zeroW, h: 3 * G.ch };
    const c = Math.floor((n - 1) / 3);
    const r = 2 - ((n - 1) % 3);
    return { x: G.nx + c * G.cw, y: G.y + r * G.ch, w: G.cw, h: G.ch };
  }
  const cellCenter = (n) => {
    const r = cellRect(n);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  };

  const OUTSIDE_RECTS = {
    'column:3': { x: G.numEnd, y: G.y, w: G.cw, h: G.ch },
    'column:2': { x: G.numEnd, y: G.y + G.ch, w: G.cw, h: G.ch },
    'column:1': { x: G.numEnd, y: G.y + 2 * G.ch, w: G.cw, h: G.ch },
    'dozen:1': { x: G.nx, y: G.numBottom, w: 4 * G.cw, h: G.dh },
    'dozen:2': { x: G.nx + 4 * G.cw, y: G.numBottom, w: 4 * G.cw, h: G.dh },
    'dozen:3': { x: G.nx + 8 * G.cw, y: G.numBottom, w: 4 * G.cw, h: G.dh },
    low: { x: G.nx, y: G.dozBottom, w: 2 * G.cw, h: G.oh },
    even: { x: G.nx + 2 * G.cw, y: G.dozBottom, w: 2 * G.cw, h: G.oh },
    red: { x: G.nx + 4 * G.cw, y: G.dozBottom, w: 2 * G.cw, h: G.oh },
    black: { x: G.nx + 6 * G.cw, y: G.dozBottom, w: 2 * G.cw, h: G.oh },
    odd: { x: G.nx + 8 * G.cw, y: G.dozBottom, w: 2 * G.cw, h: G.oh },
    high: { x: G.nx + 10 * G.cw, y: G.dozBottom, w: 2 * G.cw, h: G.oh },
  };

  function spotPosition(def) {
    const rect = OUTSIDE_RECTS[def.key];
    if (rect) return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    const nums = def.numbers;
    if (def.type === 'straight') {
      return nums[0] === 0 ? { x: G.x + G.zeroW / 2 + 3, y: G.y + 1.5 * G.ch } : cellCenter(nums[0]);
    }
    const pts = nums.filter((n) => n > 0).map(cellCenter);
    const ax = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const ay = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    if (nums[0] === 0) return def.type === 'corner' ? { x: G.nx, y: G.numBottom } : { x: G.nx, y: ay };
    if (def.type === 'street' || def.type === 'line') return { x: ax, y: G.numBottom };
    return { x: ax, y: ay };
  }

  const keyOf = (type, nums) => `${type}:${[...nums].sort((a, b) => a - b).join('-')}`;
  const streetOf = (c) => [3 * c + 1, 3 * c + 2, 3 * c + 3];
  const numAt = (c, r) => 3 * c + (3 - r);
  const inRect = (x, y, r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

  /** Map a logical canvas point to a canonical bet key (or null). */
  function hitTest(x, y) {
    const e = 0.22;
    const u = (x - G.nx) / G.cw;
    const v = (y - G.y) / G.ch;
    let key = null;

    if (u >= -e && u < 12 && v >= 0 && v <= 3 + e * 0.9) {
      const vi = Math.round(u);
      const hj = Math.round(v);
      const nearV = Math.abs(u - vi) < e && vi <= 11;
      const nearH = Math.abs(v - hj) < e && hj >= 1;
      const c = clamp(Math.floor(u), 0, 11);
      const r = clamp(Math.floor(v), 0, 2);

      if (v > 3 && !nearH) key = null;
      else if (nearV && nearH) {
        if (hj === 3) key = vi === 0 ? keyOf('corner', [0, 1, 2, 3]) : keyOf('line', [...streetOf(vi - 1), ...streetOf(vi)]);
        else if (vi === 0) key = keyOf('street', [0, numAt(0, hj), numAt(0, hj - 1)]);
        else key = keyOf('corner', [numAt(vi - 1, hj - 1), numAt(vi - 1, hj), numAt(vi, hj - 1), numAt(vi, hj)]);
      } else if (nearV) {
        key = vi === 0 ? keyOf('split', [0, numAt(0, r)]) : keyOf('split', [numAt(vi - 1, r), numAt(vi, r)]);
      } else if (nearH) {
        key = hj === 3 ? keyOf('street', streetOf(c)) : keyOf('split', [numAt(c, hj - 1), numAt(c, hj)]);
      } else if (u >= 0) {
        key = keyOf('straight', [numAt(c, r)]);
      }
      if (key) return store.legal.size === 0 || store.legal.has(key) ? key : null;
    }

    if (inRect(x, y, cellRect(0))) return 'straight:0';
    for (const [k, rect] of Object.entries(OUTSIDE_RECTS)) if (inRect(x, y, rect)) return k;
    return null;
  }

  /* ======================================================================== */
  /*  Canvas, scaling and pre-rendered layers                                 */
  /* ======================================================================== */

  const canvas = byId('table');
  const ctx = canvas.getContext('2d');
  const stage = byId('stage');
  const view = { scale: 1, S: 1 };
  const layers = { table: null, wheelBase: null, rotor: null, light: null, wb: WHEEL.R + 16, rr: WHEEL.rotorR + 2 };

  const noiseTexture = (() => {
    const size = 160;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const x = c.getContext('2d');
    const img = x.createImageData(size, size);
    const rnd = mulberry32(7);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = rnd() > 0.5 ? 255 : 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = Math.floor(rnd() * 26);
    }
    x.putImageData(img, 0, 0);
    return c;
  })();

  function setSpacing(c, px) {
    if ('letterSpacing' in c) c.letterSpacing = `${px}px`;
  }

  function roundRectPath(c, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  function pillPath(c, inset) {
    const r = TABLE.R - inset;
    const { xL, xR, cy } = TABLE;
    c.beginPath();
    c.moveTo(xL, cy - r);
    c.lineTo(xR, cy - r);
    c.arc(xR, cy, r, -Math.PI / 2, Math.PI / 2);
    c.lineTo(xL, cy + r);
    c.arc(xL, cy, r, Math.PI / 2, Math.PI * 1.5);
    c.closePath();
  }

  function disc(c, x, y, r) {
    c.beginPath();
    c.arc(x, y, r, 0, TAU);
  }

  function annulus(c, r0, r1) {
    c.beginPath();
    c.arc(0, 0, r1, 0, TAU);
    c.arc(0, 0, r0, 0, TAU, true);
  }

  function makeLayer(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w * view.S));
    c.height = Math.max(1, Math.ceil(h * view.S));
    const x = c.getContext('2d');
    x.scale(view.S, view.S);
    draw(x);
    return c;
  }

  function resize() {
    const rect = stage.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    const scale = Math.min(rect.width / W, rect.height / H);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    view.scale = scale;
    view.S = scale * dpr;
    canvas.style.width = `${Math.floor(W * scale)}px`;
    canvas.style.height = `${Math.floor(H * scale)}px`;
    canvas.width = Math.round(W * view.S);
    canvas.height = Math.round(H * view.S);
    buildLayers();
  }

  function buildLayers() {
    const wb = layers.wb;
    const rr = layers.rr;
    layers.table = makeLayer(W, H, drawTableLayer);
    layers.wheelBase = makeLayer(wb * 2, wb * 2, (c) => {
      c.translate(wb, wb);
      drawWheelBase(c);
    });
    layers.rotor = makeLayer(rr * 2, rr * 2, (c) => {
      c.translate(rr, rr);
      drawRotor(c);
    });
    layers.light = makeLayer(wb * 2, wb * 2, (c) => {
      c.translate(wb, wb);
      drawWheelLight(c);
    });
  }

  /* ----------------------------- textures ------------------------------- */

  function drawLinearGrain(c, x0, y0, x1, y1, seed) {
    const rnd = mulberry32(seed);
    for (let y = y0; y < y1; y += 1.4 + rnd() * 2.4) {
      const amp = 0.8 + rnd() * 3.2;
      const freq = 0.003 + rnd() * 0.012;
      const ph = rnd() * TAU;
      c.beginPath();
      for (let x = x0; x <= x1 + 24; x += 24) {
        const yy = y + Math.sin(x * freq + ph) * amp + Math.sin(x * freq * 3.1 + ph) * amp * 0.25;
        if (x === x0) c.moveTo(x, yy);
        else c.lineTo(x, yy);
      }
      const light = rnd() > 0.6;
      c.strokeStyle = light ? `rgba(255,205,160,${0.03 + rnd() * 0.05})` : `rgba(25,9,2,${0.08 + rnd() * 0.16})`;
      c.lineWidth = 0.5 + rnd() * 1.5;
      c.stroke();
    }
  }

  function drawRingGrain(c, r0, r1, seed, count) {
    const rnd = mulberry32(seed);
    for (let i = 0; i < count; i++) {
      const r = lerp(r0, r1, rnd());
      const a0 = rnd() * TAU;
      c.beginPath();
      c.arc(0, 0, r, a0, a0 + 0.3 + rnd() * 2.4);
      const light = rnd() > 0.6;
      c.strokeStyle = light ? `rgba(255,210,165,${0.04 + rnd() * 0.06})` : `rgba(25,9,2,${0.1 + rnd() * 0.18})`;
      c.lineWidth = 0.4 + rnd() * 1.1;
      c.stroke();
    }
  }

  function goldGradient(c, y0, y1) {
    const g = c.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, '#f6e3a1');
    g.addColorStop(0.3, '#c9a03a');
    g.addColorStop(0.55, '#f3d98a');
    g.addColorStop(1, '#8a6a1c');
    return g;
  }

  function silverGradient(c, r) {
    const g = c.createLinearGradient(-r, -r, r, r);
    g.addColorStop(0, '#fbfbfd');
    g.addColorStop(0.35, '#a3a3ab');
    g.addColorStop(0.6, '#ececf0');
    g.addColorStop(1, '#68686f');
    return g;
  }

  /* --------------------------- table + grid ----------------------------- */

  function drawTableLayer(c) {
    const { xL, xR, cy, R, rail } = TABLE;
    const S = view.S;

    // Ambient drop shadow under the whole table.
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.72)';
    c.shadowBlur = 55 * S;
    c.shadowOffsetY = 24 * S;
    pillPath(c, 0);
    c.fillStyle = '#1c0d05';
    c.fill();
    c.restore();

    // Mahogany rail with grain.
    const wood = c.createLinearGradient(0, cy - R, 0, cy + R);
    wood.addColorStop(0, '#74401f');
    wood.addColorStop(0.1, '#4d2611');
    wood.addColorStop(0.5, '#5e2f15');
    wood.addColorStop(0.9, '#3a1b0a');
    wood.addColorStop(1, '#261106');
    pillPath(c, 0);
    c.fillStyle = wood;
    c.fill();
    c.save();
    pillPath(c, 0);
    c.clip();
    drawLinearGrain(c, xL - R, cy - R, xR + R, cy + R, 1337);
    c.restore();

    // Rounded rail profile.
    c.lineWidth = 2;
    c.strokeStyle = 'rgba(255,214,170,0.3)';
    pillPath(c, 1.5);
    c.stroke();
    c.lineWidth = 12;
    c.strokeStyle = 'rgba(255,225,190,0.055)';
    pillPath(c, 12);
    c.stroke();
    c.lineWidth = 4;
    c.strokeStyle = 'rgba(0,0,0,0.38)';
    pillPath(c, rail - 5);
    c.stroke();

    // Gold trim.
    c.lineWidth = 3;
    c.strokeStyle = goldGradient(c, cy - R, cy + R);
    pillPath(c, rail - 1.5);
    c.stroke();

    // Felt.
    const fx0 = xL + (xR - xL) * 0.62;
    const felt = c.createRadialGradient(fx0, cy - 30, 30, fx0, cy, R + (xR - xL) * 0.7);
    felt.addColorStop(0, '#167650');
    felt.addColorStop(0.42, '#0e5838');
    felt.addColorStop(0.8, '#083b25');
    felt.addColorStop(1, '#042618');
    pillPath(c, rail);
    c.fillStyle = felt;
    c.fill();

    c.save();
    pillPath(c, rail);
    c.clip();
    const pattern = c.createPattern(noiseTexture, 'repeat');
    if (pattern && pattern.setTransform && typeof DOMMatrix !== 'undefined') {
      pattern.setTransform(new DOMMatrix().scale(1 / S));
    }
    c.fillStyle = pattern;
    c.globalAlpha = 0.6;
    c.fillRect(xL - R, cy - R, xR - xL + 2 * R, 2 * R);
    c.globalAlpha = 1;
    // Inner shadow where the felt meets the rail.
    c.shadowColor = 'rgba(0,0,0,0.8)';
    c.shadowBlur = 28 * S;
    c.lineWidth = 30;
    c.strokeStyle = '#000';
    pillPath(c, rail - 15);
    c.stroke();
    c.restore();

    c.lineWidth = 1.2;
    c.strokeStyle = 'rgba(232,206,130,0.26)';
    pillPath(c, rail + 12);
    c.stroke();

    // Recessed wheel well.
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.65)';
    c.shadowBlur = 30 * S;
    c.shadowOffsetY = 8 * S;
    disc(c, WHEEL.cx, WHEEL.cy, WHEEL.R + 6);
    c.fillStyle = 'rgba(0,0,0,0.4)';
    c.fill();
    c.restore();
    c.lineWidth = 1.2;
    c.strokeStyle = 'rgba(232,206,130,0.32)';
    disc(c, WHEEL.cx, WHEEL.cy, WHEEL.R + 15);
    c.stroke();

    drawGrid(c);

    // Felt lettering.
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = 'rgba(232,215,160,0.3)';
    c.font = `600 13px ${FONT_D}`;
    setSpacing(c, 6);
    c.fillText('EUROPEAN ROULETTE  ·  SINGLE ZERO', G.cx, G.bottom + 108);
    c.font = `500 10.5px ${FONT_U}`;
    setSpacing(c, 3);
    c.fillStyle = 'rgba(232,215,160,0.24)';
    c.fillText(`TABLE LIMITS  $1 – ${money(store.config.maxBetPerSpot)} PER SPOT`, G.cx, G.bottom + 128);
    setSpacing(c, 0);
  }

  function zeroPath(c, inset = 0) {
    const { x, y, ch } = G;
    const top = y + inset;
    const bottom = G.numBottom - inset;
    c.beginPath();
    c.moveTo(G.nx - inset, top);
    c.lineTo(x + 16 + inset * 0.6, top);
    c.lineTo(x + inset * 1.4, y + 1.5 * ch);
    c.lineTo(x + 16 + inset * 0.6, bottom);
    c.lineTo(G.nx - inset, bottom);
    c.closePath();
  }

  function cellShapePath(c, n) {
    if (n === 0) zeroPath(c, 0);
    else {
      const r = cellRect(n);
      c.beginPath();
      c.rect(r.x, r.y, r.w, r.h);
    }
  }

  function drawDiamond(c, x, y, w, h, fill) {
    c.beginPath();
    c.moveTo(x, y - h / 2);
    c.lineTo(x + w / 2, y);
    c.lineTo(x, y + h / 2);
    c.lineTo(x - w / 2, y);
    c.closePath();
    c.fillStyle = fill;
    c.fill();
    c.lineWidth = 1.2;
    c.strokeStyle = 'rgba(236,222,176,0.7)';
    c.stroke();
  }

  function drawGrid(c) {
    const { x, y, cw, ch, nx, numEnd, numBottom, dozBottom, bottom, right } = G;
    const line = 'rgba(236,222,176,0.88)';

    c.fillStyle = 'rgba(0,0,0,0.12)';
    c.fillRect(x, y, right - x, bottom - y);

    // Number cells.
    for (let n = 1; n <= 36; n++) {
      const r = cellRect(n);
      const red = RED.has(n);
      const grad = c.createLinearGradient(0, r.y, 0, r.y + r.h);
      grad.addColorStop(0, red ? '#d42f3a' : '#2c2c31');
      grad.addColorStop(1, red ? '#951520' : '#0d0d10');
      roundRectPath(c, r.x + 5, r.y + 5, r.w - 10, r.h - 10, 6);
      c.fillStyle = grad;
      c.fill();
      c.lineWidth = 1;
      c.strokeStyle = 'rgba(255,255,255,0.1)';
      c.stroke();
    }

    // Zero.
    zeroPath(c, 5);
    const zg = c.createLinearGradient(0, y, 0, numBottom);
    zg.addColorStop(0, '#16a05a');
    zg.addColorStop(1, '#0a5c33');
    c.fillStyle = zg;
    c.fill();

    // Lines.
    c.strokeStyle = line;
    c.lineWidth = 1.6;
    c.beginPath();
    for (let i = 1; i < 3; i++) {
      c.moveTo(nx, y + i * ch);
      c.lineTo(right, y + i * ch);
    }
    for (let j = 0; j <= 12; j++) {
      c.moveTo(nx + j * cw, y);
      c.lineTo(nx + j * cw, numBottom);
    }
    c.moveTo(nx, dozBottom);
    c.lineTo(numEnd, dozBottom);
    for (let k = 1; k < 3; k++) {
      c.moveTo(nx + 4 * k * cw, numBottom);
      c.lineTo(nx + 4 * k * cw, dozBottom);
    }
    for (let k = 1; k < 6; k++) {
      c.moveTo(nx + 2 * k * cw, dozBottom);
      c.lineTo(nx + 2 * k * cw, bottom);
    }
    c.stroke();

    // Outer frame.
    c.lineWidth = 2.6;
    c.strokeStyle = goldGradient(c, y, bottom);
    c.beginPath();
    c.moveTo(x + 16, y);
    c.lineTo(right, y);
    c.lineTo(right, numBottom);
    c.lineTo(numEnd, numBottom);
    c.lineTo(numEnd, bottom);
    c.lineTo(nx, bottom);
    c.lineTo(nx, numBottom);
    c.lineTo(x + 16, numBottom);
    c.lineTo(x, y + 1.5 * ch);
    c.closePath();
    c.stroke();
    c.beginPath();
    c.moveTo(nx, numBottom);
    c.lineTo(numEnd, numBottom);
    c.stroke();

    // Numbers.
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.6)';
    c.shadowBlur = 3 * view.S;
    c.shadowOffsetY = 1 * view.S;
    c.fillStyle = '#fbf6e6';
    c.font = `700 21px ${FONT_D}`;
    for (let n = 1; n <= 36; n++) {
      const p = cellCenter(n);
      c.fillText(String(n), p.x, p.y + 1);
    }
    c.font = `700 26px ${FONT_D}`;
    c.fillText('0', x + G.zeroW / 2 + 4, y + 1.5 * ch + 1);

    c.fillStyle = 'rgba(244,236,210,0.92)';
    c.font = `700 12.5px ${FONT_D}`;
    for (let r = 0; r < 3; r++) {
      c.save();
      c.translate(numEnd + cw / 2, y + r * ch + ch / 2);
      c.rotate(-Math.PI / 2);
      c.fillText('2 to 1', 0, 1);
      c.restore();
    }
    c.font = `700 16px ${FONT_D}`;
    setSpacing(c, 2);
    ['1st 12', '2nd 12', '3rd 12'].forEach((label, i) => {
      c.fillText(label, nx + (4 * i + 2) * cw, numBottom + G.dh / 2 + 1);
    });
    c.font = `700 14px ${FONT_D}`;
    setSpacing(c, 1);
    const oy = dozBottom + G.oh / 2 + 1;
    c.fillText('1–18', nx + cw, oy);
    c.fillText('EVEN', nx + 3 * cw, oy);
    c.fillText('ODD', nx + 9 * cw, oy);
    c.fillText('19–36', nx + 11 * cw, oy);
    setSpacing(c, 0);
    c.restore();
    drawDiamond(c, nx + 5 * cw, oy - 1, cw * 1.05, G.oh * 0.62, '#c9252f');
    drawDiamond(c, nx + 7 * cw, oy - 1, cw * 1.05, G.oh * 0.62, '#141417');
  }

  /* ------------------------------ wheel --------------------------------- */

  function drawWheelBase(c) {
    const { R, trackOuter, trackInner, rotorR } = WHEEL;
    const S = view.S;

    c.save();
    c.shadowColor = 'rgba(0,0,0,0.8)';
    c.shadowBlur = 26 * S;
    c.shadowOffsetY = 9 * S;
    disc(c, 0, 0, R);
    c.fillStyle = '#2a1408';
    c.fill();
    c.restore();

    // Outer wooden bowl.
    const wood = c.createRadialGradient(-R * 0.3, -R * 0.35, R * 0.15, 0, 0, R);
    wood.addColorStop(0, '#8f5127');
    wood.addColorStop(0.62, '#5f3013');
    wood.addColorStop(0.92, '#3d1c09');
    wood.addColorStop(1, '#271105');
    disc(c, 0, 0, R);
    c.fillStyle = wood;
    c.fill();
    c.save();
    annulus(c, trackOuter, R);
    c.clip();
    drawRingGrain(c, trackOuter, R, 99, 170);
    c.restore();
    c.lineWidth = 2.4;
    c.strokeStyle = goldGradient(c, -R, R);
    disc(c, 0, 0, R - 1.2);
    c.stroke();

    // Polished ball track.
    const track = c.createRadialGradient(0, 0, trackInner, 0, 0, trackOuter);
    track.addColorStop(0, '#0f0805');
    track.addColorStop(0.35, '#2a190f');
    track.addColorStop(0.62, '#4b311f');
    track.addColorStop(0.86, '#26160c');
    track.addColorStop(1, '#0d0603');
    annulus(c, trackInner, trackOuter);
    c.fillStyle = track;
    c.fill();
    c.lineWidth = 9;
    c.strokeStyle = 'rgba(255,236,210,0.09)';
    c.beginPath();
    c.arc(0, 0, (trackOuter + trackInner) / 2 + 2, -2.65, -1.05);
    c.stroke();
    c.lineWidth = 5;
    c.strokeStyle = 'rgba(255,236,210,0.05)';
    c.beginPath();
    c.arc(0, 0, (trackOuter + trackInner) / 2, 0.6, 1.6);
    c.stroke();
    c.lineWidth = 2;
    c.strokeStyle = '#c9a24a';
    disc(c, 0, 0, trackOuter);
    c.stroke();

    // Deflector cone.
    const cone = c.createRadialGradient(0, 0, rotorR, 0, 0, trackInner);
    cone.addColorStop(0, '#2f1a0b');
    cone.addColorStop(0.45, '#7a5130');
    cone.addColorStop(1, '#55361c');
    annulus(c, rotorR, trackInner);
    c.fillStyle = cone;
    c.fill();
    c.lineWidth = 1.5;
    c.strokeStyle = 'rgba(0,0,0,0.55)';
    disc(c, 0, 0, trackInner);
    c.stroke();

    // Brass diamond deflectors.
    for (let k = 0; k < 8; k++) {
      c.save();
      c.rotate((k * TAU) / 8 + TAU / 16);
      c.translate((trackInner + rotorR) / 2 + 1, 0);
      if (k % 2) c.rotate(Math.PI / 2);
      const len = k % 2 ? 12 : 18;
      const wid = k % 2 ? 9 : 7;
      c.beginPath();
      c.moveTo(-len / 2, 0);
      c.lineTo(0, -wid / 2);
      c.lineTo(len / 2, 0);
      c.lineTo(0, wid / 2);
      c.closePath();
      const dg = c.createLinearGradient(-len / 2, -wid / 2, len / 2, wid / 2);
      dg.addColorStop(0, '#fff1bf');
      dg.addColorStop(0.5, '#c9a03a');
      dg.addColorStop(1, '#7a5a14');
      c.fillStyle = dg;
      c.shadowColor = 'rgba(0,0,0,0.6)';
      c.shadowBlur = 3 * S;
      c.shadowOffsetY = 1.5 * S;
      c.fill();
      c.restore();
    }

    c.lineWidth = 3.5;
    c.strokeStyle = 'rgba(0,0,0,0.7)';
    disc(c, 0, 0, rotorR + 1.5);
    c.stroke();
  }

  function drawRotor(c) {
    const { rotorR, numberInner, pocketInner, coneInner } = WHEEL;
    const half = POCKET / 2;

    // Number ring + pocket floors.
    for (let i = 0; i < 37; i++) {
      const n = WHEEL_ORDER[i];
      const col = POCKET_COLORS[colorOf(n)];
      const a = i * POCKET;
      c.beginPath();
      c.arc(0, 0, rotorR, a - half, a + half);
      c.arc(0, 0, numberInner, a + half, a - half, true);
      c.closePath();
      c.fillStyle = col.base;
      c.fill();
      c.beginPath();
      c.arc(0, 0, numberInner, a - half, a + half);
      c.arc(0, 0, pocketInner, a + half, a - half, true);
      c.closePath();
      c.fillStyle = col.deep;
      c.fill();
    }

    const bevel = c.createRadialGradient(0, 0, numberInner, 0, 0, rotorR);
    bevel.addColorStop(0, 'rgba(0,0,0,0.35)');
    bevel.addColorStop(0.55, 'rgba(255,255,255,0.1)');
    bevel.addColorStop(1, 'rgba(0,0,0,0.3)');
    annulus(c, numberInner, rotorR);
    c.fillStyle = bevel;
    c.fill();

    const depth = c.createRadialGradient(0, 0, pocketInner, 0, 0, numberInner);
    depth.addColorStop(0, 'rgba(0,0,0,0.55)');
    depth.addColorStop(0.5, 'rgba(0,0,0,0.08)');
    depth.addColorStop(1, 'rgba(0,0,0,0.5)');
    annulus(c, pocketInner, numberInner);
    c.fillStyle = depth;
    c.fill();

    // Separators and metallic frets.
    for (let i = 0; i < 37; i++) {
      const a = i * POCKET + half;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      c.beginPath();
      c.moveTo(ca * numberInner, sa * numberInner);
      c.lineTo(ca * rotorR, sa * rotorR);
      c.lineWidth = 1.1;
      c.strokeStyle = 'rgba(240,215,140,0.75)';
      c.stroke();
      c.beginPath();
      c.moveTo(ca * pocketInner, sa * pocketInner);
      c.lineTo(ca * numberInner, sa * numberInner);
      c.lineWidth = 3.4;
      c.strokeStyle = '#55555b';
      c.stroke();
      c.lineWidth = 1.4;
      c.strokeStyle = '#f0f0f4';
      c.stroke();
    }

    const silver = silverGradient(c, rotorR);
    c.lineWidth = 3;
    c.strokeStyle = silver;
    disc(c, 0, 0, numberInner);
    c.stroke();
    disc(c, 0, 0, pocketInner);
    c.stroke();
    c.lineWidth = 2;
    c.strokeStyle = goldGradient(c, -rotorR, rotorR);
    disc(c, 0, 0, rotorR - 1);
    c.stroke();

    // Numbers, reading outward.
    c.fillStyle = '#ffffff';
    c.font = `700 14px ${FONT_D}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let i = 0; i < 37; i++) {
      c.save();
      c.rotate(i * POCKET);
      c.translate((rotorR + numberInner) / 2, 0);
      c.rotate(Math.PI / 2);
      c.fillText(String(WHEEL_ORDER[i]), 0, 1);
      c.restore();
    }

    // Wooden centre cone.
    const cone = c.createRadialGradient(-20, -20, coneInner * 0.6, 0, 0, pocketInner);
    cone.addColorStop(0, '#b77a3e');
    cone.addColorStop(0.5, '#7d471b');
    cone.addColorStop(1, '#4a240b');
    annulus(c, coneInner, pocketInner);
    c.fillStyle = cone;
    c.fill();
    c.save();
    annulus(c, coneInner, pocketInner);
    c.clip();
    drawRingGrain(c, coneInner, pocketInner, 4242, 90);
    c.restore();

    // Turret crosshead.
    for (let k = 0; k < 4; k++) {
      c.save();
      c.rotate((k * Math.PI) / 2 + Math.PI / 4);
      const ag = c.createLinearGradient(0, -4, 0, 4);
      ag.addColorStop(0, '#fdfdfd');
      ag.addColorStop(0.5, '#a4a4ac');
      ag.addColorStop(1, '#55555c');
      c.shadowColor = 'rgba(0,0,0,0.55)';
      c.shadowBlur = 4 * view.S;
      c.shadowOffsetY = 2 * view.S;
      roundRectPath(c, 12, -3.6, 72, 7.2, 3.6);
      c.fillStyle = ag;
      c.fill();
      const kg = c.createRadialGradient(84, -2.5, 1, 86, 0, 7.5);
      kg.addColorStop(0, '#ffffff');
      kg.addColorStop(0.5, '#c4c4cb');
      kg.addColorStop(1, '#5d5d64');
      disc(c, 87, 0, 7);
      c.fillStyle = kg;
      c.fill();
      c.restore();
    }
    const dome = c.createRadialGradient(-8, -9, 2, 0, 0, 27);
    dome.addColorStop(0, '#ffffff');
    dome.addColorStop(0.45, '#cfcfd5');
    dome.addColorStop(1, '#5f5f66');
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.6)';
    c.shadowBlur = 8 * view.S;
    disc(c, 0, 0, 26);
    c.fillStyle = dome;
    c.fill();
    c.restore();
    disc(c, 0, 0, 9);
    c.fillStyle = goldGradient(c, -9, 9);
    c.fill();
  }

  function drawWheelLight(c) {
    const R = WHEEL.R;
    const g = c.createRadialGradient(-R * 0.45, -R * 0.5, 8, -R * 0.25, -R * 0.3, R * 1.15);
    g.addColorStop(0, 'rgba(255,248,230,0.22)');
    g.addColorStop(0.35, 'rgba(255,248,230,0.06)');
    g.addColorStop(0.7, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.3)');
    disc(c, 0, 0, R);
    c.fillStyle = g;
    c.fill();
    c.lineWidth = 3;
    c.strokeStyle = 'rgba(255,240,220,0.2)';
    c.beginPath();
    c.arc(0, 0, R - 4, -2.75, -1.45);
    c.stroke();
  }

  /* ======================================================================== */
  /*  Wheel + ball motion                                                     */
  /* ======================================================================== */

  const ROTOR = { angle: 0, speed: 0.35, idle: 0.35, max: 3.4 };
  const ball = { visible: false, pocketIndex: 0, angle: 0, r: BALL.pocketR };
  let spinAnim = null;
  let rollLevel = 0;

  // Rotor angle offset after t seconds of a spin lasting D seconds (continuous velocity).
  function rotorDelta(t, D) {
    const q = 1 - Math.min(t, D) / D;
    return ROTOR.idle * t + ((ROTOR.max - ROTOR.idle) * D * (1 - q * q * q)) / 3;
  }
  function rotorSpeed(t, D) {
    const q = Math.max(0, 1 - t / D);
    return ROTOR.idle + (ROTOR.max - ROTOR.idle) * q * q;
  }

  /**
   * Starts the deterministic spin animation. The ball's angle is expressed
   * relative to the rotor and eases exactly onto the winning pocket, so every
   * client lands precisely where the server said, whatever the frame rate.
   */
  function beginSpin(spin) {
    if (!spin || store.lastSpinId === spin.id) return;
    store.lastSpinId = spin.id;
    const now = performance.now();
    const D = spin.duration / 1000;
    const el = clamp((spin.elapsed || 0) / 1000, 0, D);
    const rnd = mulberry32(spin.seed || 1);
    const idx = Math.max(0, WHEEL_ORDER.indexOf(spin.winningNumber));
    const theta0 = ROTOR.angle - rotorDelta(el, D);
    const psiEnd = idx * POCKET;
    const phiStart = ball.visible ? ball.angle : -Math.PI / 2 + (rnd() - 0.5) * 0.6;
    const Kmin = 38 + rnd() * 5;
    spinAnim = {
      id: spin.id,
      idx,
      D,
      T: D * 0.9,
      tDrop: D * (0.5 + rnd() * 0.07),
      p: 2.3,
      theta0,
      psiEnd,
      K: Kmin + mod(phiStart - theta0 - psiEnd - Kmin, TAU),
      rStart: ball.visible ? ball.r : BALL.trackR,
      start: now - el * 1000,
      jitter: (0.16 + rnd() * 0.22) * (rnd() < 0.5 ? -1 : 1),
      jphase: rnd() * TAU,
      lastPhi: null,
      lastPsi: null,
      lastT: el,
      rollAcc: 0,
      bounces: 0,
      lastFret: null,
      settled: el >= D * 0.9,
    };
    ball.visible = true;
  }

  function updateSpin(now) {
    const a = spinAnim;
    const t = (now - a.start) / 1000;
    if (t >= a.D) {
      ROTOR.angle = a.theta0 + rotorDelta(a.D, a.D);
      ROTOR.speed = ROTOR.idle;
      ball.pocketIndex = a.idx;
      ball.angle = ROTOR.angle + a.psiEnd;
      ball.r = BALL.pocketR;
      if (!a.settled) audio.settle();
      spinAnim = null;
      rollLevel = 0;
      return;
    }

    ROTOR.angle = a.theta0 + rotorDelta(t, a.D);
    ROTOR.speed = rotorSpeed(t, a.D);

    let psi;
    let r;
    if (t >= a.T) {
      psi = a.psiEnd;
      r = BALL.pocketR;
      if (!a.settled) {
        a.settled = true;
        audio.settle();
      }
    } else {
      const q = 1 - t / a.T;
      psi = a.psiEnd + a.K * Math.pow(q, a.p);
      if (t < a.tDrop) {
        r = BALL.trackR + Math.sin(t * 19) * 0.7;
        if (t < 0.35) r = lerp(a.rStart, r, easeOutCubic(t / 0.35));
      } else {
        // Drop phase: damped bounces off the deflectors and frets.
        const s = (t - a.tDrop) / (a.T - a.tDrop);
        const g = Math.pow(1 - s, 2) * Math.abs(Math.cos(3.5 * Math.PI * s));
        r = BALL.pocketR + (BALL.trackR - BALL.pocketR) * g;
        psi += a.jitter * Math.sin(TAU * 3 * s + a.jphase) * 4 * s * (1 - s) * (1 - s);
        while (a.bounces < 3 && s >= (2 * a.bounces + 1) / 7) {
          audio.bounce(Math.pow(1 - (2 * a.bounces + 1) / 7, 1.4));
          a.bounces += 1;
        }
        if (r < WHEEL.numberInner + 3) {
          const fret = Math.floor((psi + POCKET / 2) / POCKET);
          if (a.lastFret !== null && fret !== a.lastFret) {
            const relSpeed = a.lastPsi === null ? 2 : Math.abs(psi - a.lastPsi) / Math.max(1e-3, t - a.lastT);
            audio.fretClick(clamp(relSpeed / 5, 0.15, 1));
          }
          a.lastFret = fret;
        } else {
          a.lastFret = null;
        }
      }
    }

    const phi = ROTOR.angle + psi;
    if (a.lastPhi !== null) {
      const dt = Math.max(1e-3, t - a.lastT);
      const travel = Math.abs(phi - a.lastPhi);
      const speed = travel / dt;
      if (t < a.tDrop) {
        a.rollAcc += travel;
        const step = TAU / 26;
        let n = 0;
        while (a.rollAcc >= step && n < 4) {
          a.rollAcc -= step;
          audio.ballTick(clamp(speed / 12, 0.1, 1), n * 0.007);
          n += 1;
        }
        if (a.rollAcc >= step) a.rollAcc = 0;
        rollLevel = clamp(speed / 12, 0, 1);
      } else {
        rollLevel = 0;
      }
    }
    a.lastPhi = phi;
    a.lastPsi = psi;
    a.lastT = t;
    ball.angle = phi;
    ball.r = r;
  }

  function updateWheel(now, dt) {
    if (spinAnim) updateSpin(now);
    else {
      ROTOR.angle = mod(ROTOR.angle + ROTOR.idle * dt, TAU);
      ROTOR.speed = ROTOR.idle;
      rollLevel = 0;
      if (ball.visible) {
        ball.angle = ROTOR.angle + ball.pocketIndex * POCKET;
        ball.r = BALL.pocketR;
      }
    }
    audio.update(now, ROTOR.speed / ROTOR.max, rollLevel);
  }

  /* ======================================================================== */
  /*  Per-frame drawing                                                       */
  /* ======================================================================== */

  function drawBall(x, y, r) {
    ctx.beginPath();
    ctx.ellipse(x + 2.4, y + 3, r * 1.05, r * 0.9, 0, 0, TAU);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fill();
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.45, '#ececf0');
    g.addColorStop(1, '#8a8a92');
    disc(ctx, x, y, r);
    ctx.fillStyle = g;
    ctx.fill();
  }

  function drawWheel(now) {
    const { cx, cy } = WHEEL;
    const { wb, rr } = layers;
    if (!layers.wheelBase) return;
    ctx.drawImage(layers.wheelBase, cx - wb, cy - wb, wb * 2, wb * 2);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ROTOR.angle);
    ctx.drawImage(layers.rotor, -rr, -rr, rr * 2, rr * 2);
    ctx.restore();

    if (ball.visible) {
      const bx = cx + Math.cos(ball.angle) * ball.r;
      const by = cy + Math.sin(ball.angle) * ball.r;
      if (activeResult() && !spinAnim) {
        const pulse = 0.5 + 0.5 * Math.sin(now / 200);
        ctx.save();
        ctx.shadowColor = 'rgba(255,220,120,0.95)';
        ctx.shadowBlur = (12 + 10 * pulse) * view.S;
        disc(ctx, bx, by, BALL.r + 4);
        ctx.strokeStyle = `rgba(255,225,140,${0.5 + 0.4 * pulse})`;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }
      drawBall(bx, by, BALL.r);
    }
    ctx.drawImage(layers.light, cx - wb, cy - wb, wb * 2, wb * 2);
  }

  function numberTraits(n) {
    if (n === 0) return ['ZERO'];
    return [
      n % 2 ? 'ODD' : 'EVEN',
      n <= 18 ? 'LOW' : 'HIGH',
      `${['1ST', '2ND', '3RD'][Math.floor((n - 1) / 12)]} DOZEN`,
      `COLUMN ${((n - 1) % 3) + 1}`,
    ];
  }

  function fitText(c, text, maxW) {
    if (c.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && c.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
    return `${t}…`;
  }

  function drawTitle(text, x, y, size) {
    ctx.save();
    ctx.font = `800 ${size}px ${FONT_D}`;
    setSpacing(ctx, 5);
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 8 * view.S;
    ctx.shadowOffsetY = 2 * view.S;
    ctx.fillStyle = goldGradient(ctx, y - size / 2, y + size / 2);
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function drawMarquee(now) {
    const s = store.state;
    if (!s) return;
    const x = G.cx;
    const y = 232;
    ctx.save();
    ctx.globalAlpha = clamp((now - store.phaseChangedAt) / 450, 0, 1);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const res = activeResult();
    if (res) {
      drawResultMarquee(res, x, y);
      ctx.restore();
      return;
    }

    const connected = s.players.filter((p) => p.connected);
    const me = getMe();
    let title = '';
    let sub = '';
    let sub2 = '';
    let progress = null;

    if (s.phase === PHASE.WAITING) {
      title = s.gameOver ? 'GAME OVER' : 'WAITING FOR HOST';
      const host = s.players.find((p) => p.isHost);
      const min = store.config.minPlayersToStart;
      if (s.notice) sub = s.notice;
      if (connected.length < min) sub2 = `${connected.length} / ${min} players seated — share this page's link to invite friends`;
      else if (me && me.isHost) sub2 = `You are the host — press ${s.gameOver ? 'NEW MATCH' : 'START MATCH'} when ready`;
      else sub2 = `Waiting for ${host ? host.name : 'the host'} to start the match`;
      if (!sub) [sub, sub2] = [sub2, ''];
    } else if (s.phase === PHASE.BETTING) {
      title = 'PLACE YOUR BETS';
      const remaining = Math.max(0, store.deadline - now);
      const eligible = connected.filter((p) => p.currentChips > 0 || p.totalBet > 0);
      const locked = eligible.filter((p) => p.ready).length;
      sub = `${Math.ceil(remaining / 1000)}s remaining  ·  ${locked}/${eligible.length} locked in`;
      progress = store.duration ? remaining / store.duration : 0;
    } else if (s.phase === PHASE.SPINNING) {
      title = 'NO MORE BETS';
      sub = `The ball is rolling${'.'.repeat(1 + (Math.floor(now / 400) % 3))}`;
    } else {
      title = 'SETTLING';
    }

    drawTitle(title, x, y, 32);
    ctx.font = `500 14px ${FONT_U}`;
    ctx.fillStyle = 'rgba(239,233,216,0.82)';
    ctx.fillText(fitText(ctx, sub, 640), x, y + 34);
    if (sub2) {
      ctx.fillStyle = 'rgba(239,233,216,0.6)';
      ctx.font = `500 12.5px ${FONT_U}`;
      ctx.fillText(fitText(ctx, sub2, 640), x, y + 54);
    }
    if (progress !== null) {
      const bw = 340;
      roundRectPath(ctx, x - bw / 2, y + 52, bw, 5, 2.5);
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fill();
      if (progress > 0) {
        roundRectPath(ctx, x - bw / 2, y + 52, bw * progress, 5, 2.5);
        ctx.fillStyle = store.deadline - now < 5500 ? '#f87171' : goldGradient(ctx, y + 52, y + 57);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawResultMarquee(res, x, y) {
    const n = res.winningNumber;
    const col = POCKET_COLORS[res.color];
    const dx = x - 170;
    const dy = y + 16;

    ctx.save();
    ctx.shadowColor = 'rgba(255,215,100,0.55)';
    ctx.shadowBlur = 22 * view.S;
    disc(ctx, dx, dy, 40);
    const g = ctx.createRadialGradient(dx - 12, dy - 14, 4, dx, dy, 42);
    g.addColorStop(0, tint(col.disc, 0.25));
    g.addColorStop(1, shade(col.disc, 0.6));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = goldGradient(ctx, dy - 40, dy + 40);
    disc(ctx, dx, dy, 40);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `800 34px ${FONT_D}`;
    ctx.fillText(String(n), dx, dy + 2);

    ctx.textAlign = 'left';
    const tx = dx + 58;
    ctx.save();
    ctx.font = `800 30px ${FONT_D}`;
    setSpacing(ctx, 4);
    ctx.fillStyle = goldGradient(ctx, y - 16, y + 16);
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 8 * view.S;
    ctx.fillText(`${n}  ${res.color.toUpperCase()}`, tx, y - 2);
    ctx.restore();
    ctx.font = `600 12px ${FONT_U}`;
    setSpacing(ctx, 2);
    ctx.fillStyle = 'rgba(239,233,216,0.7)';
    ctx.fillText(numberTraits(n).join('  ·  '), tx, y + 26);
    setSpacing(ctx, 0);

    const winners = res.players.filter((p) => p.returned > 0).sort((a, b) => b.net - a.net);
    const bettors = res.players.filter((p) => p.wagered > 0);
    let line;
    if (!bettors.length) line = 'No bets this round';
    else if (!winners.length) line = 'The house takes every bet';
    else line = `Paid: ${winners.map((p) => `${p.name} ${signedMoney(p.returned)}`).join('  ·  ')}`;
    ctx.font = `600 13.5px ${FONT_U}`;
    ctx.fillStyle = winners.length ? '#a7f3c0' : 'rgba(239,233,216,0.6)';
    ctx.fillText(fitText(ctx, line, 400), tx, y + 50);
  }

  function drawRecent() {
    const hist = store.state ? store.state.history : [];
    const y = G.bottom + 52;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (!hist.length) {
      ctx.font = `500 11px ${FONT_U}`;
      setSpacing(ctx, 3);
      ctx.fillStyle = 'rgba(232,215,160,0.3)';
      ctx.fillText('NO SPINS YET', G.cx, y);
      setSpacing(ctx, 0);
      return;
    }
    const count = Math.min(hist.length, 12);
    const gap = 34;
    const x0 = G.cx - ((count - 1) * gap) / 2;
    for (let i = count - 1; i >= 0; i--) {
      const h = hist[i];
      const x = x0 + i * gap;
      const r = i === 0 ? 15 : 12;
      const col = POCKET_COLORS[h.color];
      ctx.globalAlpha = i === 0 ? 1 : 0.9 - i * 0.04;
      disc(ctx, x, y, r);
      ctx.fillStyle = col.disc;
      ctx.fill();
      ctx.lineWidth = i === 0 ? 2.2 : 1;
      ctx.strokeStyle = i === 0 ? '#f3d98a' : 'rgba(236,222,176,0.45)';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = `700 ${i === 0 ? 13 : 11}px ${FONT_U}`;
      ctx.fillText(String(h.number), x, y + 0.5);
    }
    ctx.globalAlpha = 1;
  }

  function drawWinningHighlight(now) {
    const res = activeResult();
    if (!res) return;
    const pulse = 0.55 + 0.45 * Math.sin(now / 210);
    ctx.save();
    for (const key of res.winningKeys) {
      const rect = OUTSIDE_RECTS[key];
      if (!rect) continue;
      ctx.fillStyle = `rgba(255,229,138,${0.1 + 0.08 * pulse})`;
      ctx.fillRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);
    }
    ctx.shadowColor = 'rgba(255,215,100,0.95)';
    ctx.shadowBlur = (10 + 14 * pulse) * view.S;
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffe58a';
    cellShapePath(ctx, res.winningNumber);
    ctx.stroke();
    ctx.fillStyle = `rgba(255,236,170,${0.12 + 0.12 * pulse})`;
    ctx.fill();
    ctx.restore();
  }

  function drawHover() {
    const key = input.hoverKey;
    if (!key || !isPhase(PHASE.BETTING, PHASE.WAITING)) return;
    const spot = store.spots.get(key);
    if (!spot) return;
    ctx.save();
    ctx.fillStyle = 'rgba(255,236,170,0.2)';
    const rect = OUTSIDE_RECTS[key];
    if (rect) {
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,229,138,0.8)';
      ctx.strokeRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);
    }
    for (const n of spot.def.numbers) {
      cellShapePath(ctx, n);
      ctx.fill();
    }
    ctx.restore();

    const me = getMe();
    if (canBet() && me && me.currentChips >= store.selectedChip) {
      ctx.save();
      ctx.globalAlpha = 0.6;
      drawChip(ctx, spot.x, spot.y, 14, DENOM[store.selectedChip], me.color, me.avatarIcon);
      ctx.restore();
    } else if (!rect && spot.def.type !== 'straight') {
      disc(ctx, spot.x, spot.y, 5);
      ctx.fillStyle = 'rgba(255,229,138,0.85)';
      ctx.fill();
    }
  }

  /* ------------------------------- chips -------------------------------- */

  function breakdown(amount) {
    const out = [];
    let rest = Math.round(amount);
    for (const v of [100, 25, 10, 5, 1]) {
      while (rest >= v && out.length < 6) {
        out.push(v);
        rest -= v;
      }
    }
    return out.length ? out : [1];
  }

  function drawChip(c, x, y, r, denom, inlay, icon) {
    disc(c, x, y + r * 0.17, r);
    c.fillStyle = denom.side;
    c.fill();
    disc(c, x, y, r);
    c.fillStyle = denom.base;
    c.fill();
    c.save();
    c.setLineDash([r * 0.36, r * 0.52]);
    c.lineWidth = r * 0.26;
    c.strokeStyle = denom.edge;
    disc(c, x, y, r * 0.84);
    c.stroke();
    c.restore();
    disc(c, x, y, r * 0.6);
    c.fillStyle = inlay || denom.base;
    c.fill();
    c.lineWidth = Math.max(0.8, r * 0.07);
    c.strokeStyle = 'rgba(255,255,255,0.75)';
    c.stroke();
    if (icon) drawIcon(c, icon, x, y, r * 0.72, '#fff');
    const gloss = c.createRadialGradient(x - r * 0.4, y - r * 0.5, 0, x - r * 0.2, y - r * 0.3, r * 1.1);
    gloss.addColorStop(0, 'rgba(255,255,255,0.32)');
    gloss.addColorStop(0.5, 'rgba(255,255,255,0.04)');
    gloss.addColorStop(1, 'rgba(255,255,255,0)');
    disc(c, x, y, r);
    c.fillStyle = gloss;
    c.fill();
    c.lineWidth = 0.8;
    c.strokeStyle = 'rgba(0,0,0,0.5)';
    c.stroke();
  }

  function playerDenom(color) {
    return { base: color, edge: '#ffffff', side: shade(color, 0.45) };
  }

  function drawStack(c, x, y, amount, player, r = 14) {
    const chips = breakdown(amount); // largest denomination at the bottom
    for (let i = 0; i < chips.length; i++) {
      const top = i === chips.length - 1;
      drawChip(c, x, y - i * 3, r, DENOM[chips[i]], player ? shade(player.color, 0.85) : '#555', top && player ? player.avatarIcon : null);
    }
    return y - (chips.length - 1) * 3;
  }

  function drawPill(c, x, y, text, border) {
    c.font = `700 11px ${FONT_U}`;
    const w = c.measureText(text).width + 10;
    roundRectPath(c, x - w / 2, y - 8, w, 16, 8);
    c.fillStyle = 'rgba(7,11,20,0.9)';
    c.fill();
    c.lineWidth = 1;
    c.strokeStyle = border || 'rgba(236,222,176,0.6)';
    c.stroke();
    c.fillStyle = '#fff';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, x, y + 0.5);
  }

  function clusterOffsets(n) {
    if (n === 1) return [{ x: 0, y: 0 }];
    const rad = n === 2 ? 9 : n <= 4 ? 11 : 13;
    return Array.from({ length: n }, (_, i) => {
      const a = -Math.PI / 2 + (i * TAU) / n + (n === 2 ? Math.PI / 2 : 0);
      return { x: Math.cos(a) * rad, y: Math.sin(a) * rad * 0.8 };
    });
  }

  function drawSpotChips(spot, bet, opts) {
    const contribs = bet.contributions;
    if (!contribs.length) return;
    const def = spot.def;
    ctx.save();
    const popAt = fx.pops.get(bet.key);
    if (popAt) {
      const t = (opts.now - popAt) / 220;
      if (t < 1) {
        const s = 1 + 0.28 * Math.sin(t * Math.PI);
        ctx.translate(spot.x, spot.y);
        ctx.scale(s, s);
        ctx.translate(-spot.x, -spot.y);
      } else fx.pops.delete(bet.key);
    }

    if (opts.win) {
      const pulse = 0.5 + 0.5 * Math.sin(opts.now / 180);
      ctx.save();
      ctx.shadowColor = 'rgba(255,215,100,1)';
      ctx.shadowBlur = (14 + 10 * pulse) * view.S;
      disc(ctx, spot.x, spot.y, contribs.length > 1 ? 24 : 18);
      ctx.strokeStyle = `rgba(255,229,138,${0.6 + 0.4 * pulse})`;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.restore();
    }

    if (contribs.length === 1) {
      const c = contribs[0];
      const p = store.players.get(c.playerId);
      const topY = drawStack(ctx, spot.x, spot.y, c.amount, p);
      if (opts.win) {
        const paid = c.amount * def.payout;
        drawStack(ctx, spot.x + 20, spot.y - 2, paid, p, 11);
      }
      drawPill(ctx, spot.x + 13, topY + 14, money(c.amount), p ? p.color : null);
    } else {
      const offsets = clusterOffsets(contribs.length);
      contribs.forEach((c, i) => {
        const p = store.players.get(c.playerId);
        const color = p ? p.color : '#777';
        const o = offsets[i];
        const layersN = Math.min(3, breakdown(c.amount).length);
        for (let k = 0; k < layersN; k++) {
          drawChip(ctx, spot.x + o.x, spot.y + o.y - k * 2.5, 10, playerDenom(color), shade(color, 0.6), k === layersN - 1 && p ? p.avatarIcon : null);
        }
      });
      drawPill(ctx, spot.x, spot.y + 24, money(bet.total), opts.win ? '#ffe58a' : null);
    }
    ctx.restore();
  }

  function drawBets(now) {
    const s = store.state;
    if (!s) return;
    const res = activeResult();
    const winSet = res ? new Set(res.winningKeys) : null;
    for (const bet of s.bets) {
      const spot = store.spots.get(bet.key);
      if (!spot) continue;
      if (winSet && !winSet.has(bet.key)) continue; // losing chips are drawn by the sweep animation
      drawSpotChips(spot, bet, { now, win: Boolean(winSet) });
    }
  }

  function drawSweeps(now) {
    fx.sweeps = fx.sweeps.filter((sw) => now - sw.start < sw.dur);
    for (const sw of fx.sweeps) {
      const t = clamp((now - sw.start) / sw.dur, 0, 1);
      const e = easeInOutCubic(t);
      const x = lerp(sw.x0, DEALER_POINT.x, e);
      const y = lerp(sw.y0, DEALER_POINT.y, e) - Math.sin(e * Math.PI) * 30;
      ctx.save();
      ctx.globalAlpha = 1 - t * t;
      const s = 1 - 0.45 * e;
      ctx.translate(x, y);
      ctx.scale(s, s);
      if (sw.mini) drawChip(ctx, 0, 0, 10, playerDenom(sw.color), shade(sw.color, 0.6), sw.icon);
      else drawStack(ctx, 0, 0, sw.amount, sw.player);
      ctx.restore();
    }
  }

  function drawFloaters(now) {
    fx.floaters = fx.floaters.filter((f) => now - f.start < f.dur);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of fx.floaters) {
      const t = (now - f.start) / f.dur;
      if (t < 0) continue;
      ctx.save();
      ctx.globalAlpha = t < 0.15 ? t / 0.15 : 1 - Math.pow((t - 0.15) / 0.85, 2);
      ctx.font = `800 ${f.size || 17}px ${FONT_U}`;
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 6 * view.S;
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y - easeOutCubic(t) * 42);
      ctx.restore();
    }
  }

  /* ------------------------------- seats -------------------------------- */

  function drawTag(text, x, y, bg, fg) {
    ctx.font = `800 9.5px ${FONT_U}`;
    setSpacing(ctx, 1);
    const w = ctx.measureText(text).width + 12;
    roundRectPath(ctx, x - w, y - 8, w, 16, 8);
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x - w / 2 + 0.5, y + 0.5);
    setSpacing(ctx, 0);
    return w;
  }

  function drawSeat(i, p, dt) {
    const { x, y } = SEATS[i];
    const left = x - SEAT_W / 2;
    const top = y - SEAT_H / 2;
    ctx.save();

    if (!p) {
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(232,215,160,0.22)';
      roundRectPath(ctx, left, top, SEAT_W, SEAT_H, 14);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `600 11px ${FONT_U}`;
      setSpacing(ctx, 3);
      ctx.fillStyle = 'rgba(232,215,160,0.32)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('OPEN SEAT', x, y);
      setSpacing(ctx, 0);
      ctx.restore();
      return;
    }

    const isMe = p.id === store.me;
    if (!p.connected) ctx.globalAlpha = 0.5;

    ctx.save();
    ctx.shadowColor = isMe ? 'rgba(243,217,138,0.5)' : 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = (isMe ? 20 : 14) * view.S;
    ctx.shadowOffsetY = (isMe ? 0 : 5) * view.S;
    roundRectPath(ctx, left, top, SEAT_W, SEAT_H, 14);
    const bg = ctx.createLinearGradient(0, top, 0, top + SEAT_H);
    bg.addColorStop(0, 'rgba(24,32,52,0.96)');
    bg.addColorStop(1, 'rgba(9,13,23,0.96)');
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.restore();
    roundRectPath(ctx, left, top, SEAT_W, SEAT_H, 14);
    ctx.lineWidth = isMe ? 2.2 : 1.5;
    ctx.strokeStyle = isMe ? '#f3d98a' : rgba(p.color, 0.75);
    ctx.stroke();

    // Avatar badge.
    const ax = left + 34;
    const ag = ctx.createRadialGradient(ax - 7, y - 8, 2, ax, y, 24);
    ag.addColorStop(0, tint(p.color, 0.35));
    ag.addColorStop(0.6, p.color);
    ag.addColorStop(1, shade(p.color, 0.5));
    disc(ctx, ax, y, 22);
    ctx.fillStyle = ag;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.stroke();
    drawIcon(ctx, p.avatarIcon, ax, y, 22, '#fff');

    if (p.isHost) {
      ctx.save();
      ctx.translate(ax - 10, top - 13);
      ctx.scale(20 / 24, 20 / 24);
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = 4 * view.S;
      ctx.fillStyle = goldGradient(ctx, 4, 19);
      ctx.fill(path2d(CROWN_PATH));
      ctx.restore();
    }

    // Name + numbers.
    const tx = left + 66;
    let tagW = 0;
    if (isMe) tagW += drawTag('YOU', left + SEAT_W - 8, top + 15, 'rgba(243,217,138,0.95)', '#1b1406') + 4;
    if (!p.connected) tagW += drawTag('AWAY', left + SEAT_W - 8 - tagW, top + 15, 'rgba(148,163,184,0.9)', '#0b1020') + 4;
    else if (p.ready && isPhase(PHASE.BETTING)) tagW += drawTag('LOCKED', left + SEAT_W - 8 - tagW, top + 15, 'rgba(74,222,128,0.92)', '#052e16') + 4;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `700 15px ${FONT_U}`;
    ctx.fillStyle = '#f5f0e2';
    ctx.fillText(fitText(ctx, p.name, SEAT_W - 76 - tagW), tx, top + 17);

    const target = p.currentChips;
    const prev = fx.dispChips.has(p.id) ? fx.dispChips.get(p.id) : target;
    // Time-based easing so the value still converges after the tab was throttled.
    const next = Math.abs(target - prev) < 0.5 ? target : lerp(prev, target, 1 - Math.exp(-dt * 8));
    fx.dispChips.set(p.id, next);

    ctx.font = `600 9.5px ${FONT_U}`;
    setSpacing(ctx, 1.5);
    ctx.fillStyle = 'rgba(151,160,179,0.95)';
    ctx.fillText('BANK', tx, top + 39);
    ctx.fillText('ON TABLE', tx + 62, top + 39);
    setSpacing(ctx, 0);
    ctx.font = `700 16px ${FONT_U}`;
    ctx.fillStyle = target > prev + 0.5 ? '#86efac' : '#f3d98a';
    ctx.fillText(money(next), tx, top + 56);
    ctx.fillStyle = p.totalBet ? '#ffffff' : 'rgba(255,255,255,0.45)';
    ctx.fillText(money(p.totalBet), tx + 62, top + 56);
    ctx.restore();
  }

  function drawSeats(dt) {
    const s = store.state;
    const bySeat = new Map();
    if (s) for (const p of s.players) bySeat.set(p.seat, p);
    for (let i = 0; i < SEATS.length; i++) drawSeat(i, bySeat.get(i), dt);
  }

  function draw(now, dt) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (layers.table) ctx.drawImage(layers.table, 0, 0);
    ctx.setTransform(view.S, 0, 0, view.S, 0, 0);
    drawWheel(now);
    drawMarquee(now);
    drawRecent();
    drawWinningHighlight(now);
    drawHover();
    drawBets(now);
    drawSweeps(now);
    drawFloaters(now);
    drawSeats(dt);
  }

  let lastFrame = performance.now();
  function frame(now) {
    const elapsed = Math.max(0, (now - lastFrame) / 1000);
    lastFrame = now;
    updateWheel(now, Math.min(0.05, elapsed));
    updateTimerUI(now);
    draw(now, elapsed);
    requestAnimationFrame(frame);
  }

  /* ======================================================================== */
  /*  Networking                                                              */
  /* ======================================================================== */

  const socket = window.io();

  function emit(event, payload) {
    if (!socket.connected) {
      toast('Not connected to the table.', 'error');
      return;
    }
    socket.emit(event, payload || {});
  }

  function join(name, silent) {
    if (store.joining) return;
    store.joining = true;
    const btn = byId('joinBtn');
    btn.disabled = true;
    // Silent (automatic) joins may only reclaim the seat we already had.
    const resumeOnly = Boolean(silent && store.token);
    socket.emit('player:join', { name, token: store.token, resumeOnly }, (res) => {
      store.joining = false;
      btn.disabled = false;
      if (res && res.code === 'SEAT_GONE') {
        clearIdentity();
        byId('joinError').textContent = 'That game has ended — join again to start fresh.';
        showJoin();
        return;
      }
      if (!res || !res.ok) {
        const msg = (res && res.error) || 'Could not join the table.';
        byId('joinError').textContent = msg;
        showJoin();
        if (!silent) toast(msg, 'error');
        return;
      }
      store.me = res.playerId;
      store.token = res.token;
      store.name = name;
      storageSet('sessionStorage', 'rr-token', res.token);
      storageSet('sessionStorage', 'rr-name', name);
      storageSet('localStorage', 'rr-last-name', name);
      byId('joinModal').hidden = true;
      byId('joinError').textContent = '';
      renderHUD();
    });
  }

  /** Forget this tab's seat so nothing auto-rejoins on reload. */
  function clearIdentity() {
    store.me = null;
    store.token = null;
    storageSet('sessionStorage', 'rr-token', null);
    storageSet('sessionStorage', 'rr-name', null);
  }

  function leaveTable() {
    if (!getMe()) return;
    if (!window.confirm('Leave the table? Your seat and chips will be given up.')) return;
    emit('player:leave');
    clearIdentity();
    hideModal('summaryModal');
    byId('joinError').textContent = '';
    showJoin();
    renderHUD();
  }

  socket.on('connect', () => {
    setConnection(true);
    if (store.name && (store.token || store.me)) join(store.name, true);
  });

  socket.on('disconnect', () => {
    setConnection(false);
    toast('Connection lost — reconnecting…', 'error');
  });

  socket.on('welcome', ({ config, legalBets }) => {
    store.config = { ...store.config, ...config };
    store.legal = new Map(legalBets.map((b) => [b.key, b]));
    store.spots = new Map(legalBets.map((b) => [b.key, { def: b, ...spotPosition(b) }]));
    buildLayers();
    renderHUD();
  });

  socket.on('state', onState);

  socket.on('bet:placed', ({ playerId, key, rebet }) => {
    const mine = playerId === store.me;
    if (rebet) {
      for (let i = 0; i < 3; i++) audio.chip(mine ? 0.9 : 0.5, i * 0.05);
    } else {
      audio.chip(mine ? 1 : 0.5);
    }
    fx.pops.set(key, performance.now());
  });

  socket.on('bet:removed', ({ playerId }) => {
    audio.chip(playerId === store.me ? 0.45 : 0.25);
  });

  socket.on('spin:start', (spin) => beginSpin(spin));
  socket.on('round:result', (result) => applyResult(result, false));
  socket.on('toast', ({ message, kind }) => toast(message, kind));

  function onState(s) {
    const prev = store.state;
    store.state = s;
    store.players = new Map(s.players.map((p) => [p.id, p]));
    store.betsByKey = new Map(s.bets.map((b) => [b.key, b]));
    const now = performance.now();
    if (s.phaseEndsIn !== null && s.phaseEndsIn !== undefined) {
      store.deadline = now + s.phaseEndsIn;
      store.duration = s.phaseDuration || s.phaseEndsIn;
    }

    if (!ball.visible && !spinAnim && s.history.length) {
      ball.visible = true;
      ball.pocketIndex = Math.max(0, WHEEL_ORDER.indexOf(s.history[0].number));
    }
    if (s.phase === PHASE.SPINNING && s.spin) beginSpin(s.spin);
    if (s.lastResult && store.appliedResultId !== s.lastResult.id) applyResult(s.lastResult, true);

    if (!prev || prev.phase !== s.phase) onPhaseChange(prev ? prev.phase : null, s.phase, s);

    if (store.me && !store.players.has(store.me) && !store.joining) {
      // Our seat expired or the table was reset — ask the player to rejoin.
      clearIdentity();
      showJoin();
    }

    renderHUD();
    renderLobby();
    tooltipState.dirty = true;
    refreshTooltip();
  }

  function onPhaseChange(prevPhase, phase, s) {
    store.phaseChangedAt = performance.now();
    store.lastCountdownSec = null;
    if (phase === PHASE.BETTING) {
      store.result = null;
      fx.sweeps = [];
      hideModal('summaryModal');
    } else if (phase === PHASE.CLEANUP) {
      if (store.result) showSummary(store.result, s.phaseEndsIn || store.config.cleanupMs);
    } else if (phase === PHASE.WAITING) {
      store.result = null;
      hideModal('summaryModal');
      if (prevPhase && s.notice) toast(s.notice, s.gameOver ? 'error' : 'info');
    }
  }

  function applyResult(result, late) {
    if (!result || store.appliedResultId === result.id) return;
    store.appliedResultId = result.id;
    store.result = result;
    store.phaseChangedAt = performance.now();
    if (!spinAnim) {
      ball.visible = true;
      ball.pocketIndex = Math.max(0, WHEEL_ORDER.indexOf(result.winningNumber));
    }
    if (late || !store.state) return;

    const now = performance.now();
    const winSet = new Set(result.winningKeys);
    let lostSomething = false;
    let stagger = 0;
    for (const bet of store.state.bets) {
      const spot = store.spots.get(bet.key);
      if (!spot) continue;
      const def = spot.def;
      if (winSet.has(bet.key)) {
        for (const c of bet.contributions) {
          const p = store.players.get(c.playerId);
          fx.floaters.push({
            text: `+${money(c.amount * (def.payout + 1))}`,
            x: spot.x,
            y: spot.y - 20,
            color: p ? tint(p.color, 0.3) : '#fff',
            start: now + 450,
            dur: 2000,
          });
        }
        continue;
      }
      lostSomething = true;
      const offsets = clusterOffsets(bet.contributions.length);
      bet.contributions.forEach((c, i) => {
        const p = store.players.get(c.playerId);
        fx.sweeps.push({
          x0: spot.x + (bet.contributions.length > 1 ? offsets[i].x : 0),
          y0: spot.y + (bet.contributions.length > 1 ? offsets[i].y : 0),
          amount: c.amount,
          player: p,
          color: p ? p.color : '#777',
          icon: p ? p.avatarIcon : null,
          mini: bet.contributions.length > 1,
          start: now + 900 + stagger,
          dur: 750,
        });
        stagger += 22;
      });
    }

    for (const row of result.players) {
      if (!row.wagered) continue;
      const seat = SEATS[store.players.get(row.id)?.seat ?? -1];
      if (!seat) continue;
      fx.floaters.push({
        text: signedMoney(row.net),
        x: seat.x,
        y: seat.y - 44,
        color: row.net > 0 ? '#86efac' : row.net < 0 ? '#fca5a5' : '#e5e7eb',
        start: now + 700,
        dur: 2400,
        size: 18,
      });
    }

    const mine = result.players.find((p) => p.id === store.me);
    if (mine && mine.returned > 0) setTimeout(() => audio.chime(), 300);
    if (lostSomething) setTimeout(() => audio.sweep(), 900);
  }

  /* ======================================================================== */
  /*  Input                                                                   */
  /* ======================================================================== */

  const input = { hoverKey: null, clientX: 0, clientY: 0 };

  function toLogical(e) {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height };
  }

  canvas.addEventListener('pointermove', (e) => {
    const p = toLogical(e);
    const key = hitTest(p.x, p.y);
    input.clientX = e.clientX;
    input.clientY = e.clientY;
    if (key !== input.hoverKey) {
      input.hoverKey = key;
      tooltipState.dirty = true;
    }
    canvas.style.cursor = key && canBet() ? 'pointer' : 'default';
    refreshTooltip();
  });

  canvas.addEventListener('pointerleave', () => {
    input.hoverKey = null;
    hideTooltip();
  });

  canvas.addEventListener('click', (e) => {
    audio.unlock();
    const p = toLogical(e);
    const key = hitTest(p.x, p.y);
    if (key) placeBetAt(key);
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const p = toLogical(e);
    const key = hitTest(p.x, p.y);
    if (!key) return;
    const bet = store.betsByKey.get(key);
    if (bet && bet.contributions.some((c) => c.playerId === store.me)) {
      if (canBet()) emit('bet:remove', { key });
      else explainCannotBet();
    }
  });

  function explainCannotBet() {
    const me = getMe();
    const s = store.state;
    if (!me) return toast('Take a seat to place bets.', 'error');
    if (!s) return;
    if (s.phase === PHASE.WAITING) return toast('Waiting for the host to start the match.');
    if (s.phase !== PHASE.BETTING) return toast('No more bets — wait for the next round.');
    if (me.ready) return toast('Your bets are locked. Unlock to change them.');
    return null;
  }

  function placeBetAt(key) {
    if (!canBet()) return explainCannotBet();
    const me = getMe();
    if (me.currentChips < store.selectedChip) {
      if (me.currentChips <= 0) return toast('You are out of chips for this round.', 'error');
      return toast(`Not enough for a ${money(store.selectedChip)} chip — you have ${money(me.currentChips)}.`, 'error');
    }
    emit('bet:place', { key, amount: store.selectedChip });
    return null;
  }

  function selectChip(value) {
    if (!CHIP_VALUES.includes(value)) return;
    store.selectedChip = value;
    for (const btn of document.querySelectorAll('#chipRack .chip')) {
      const on = Number(btn.dataset.value) === value;
      btn.classList.toggle('selected', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    tooltipState.dirty = true;
    refreshTooltip();
  }

  function toggleReady() {
    const me = getMe();
    if (!me || !isPhase(PHASE.BETTING)) return;
    emit('player:ready', { ready: !me.ready });
  }

  document.querySelectorAll('#chipRack .chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      audio.unlock();
      selectChip(Number(btn.dataset.value));
      audio.chip(0.6);
    });
  });

  byId('btnUndo').addEventListener('click', () => emit('bet:undo'));
  byId('btnClear').addEventListener('click', () => emit('bet:clear'));
  byId('btnRebet').addEventListener('click', () => emit('bet:rebet'));
  byId('btnReady').addEventListener('click', toggleReady);
  byId('btnStart').addEventListener('click', () => emit('game:start'));
  byId('btnCloseBets').addEventListener('click', () => emit('game:closeBets'));
  byId('btnInfo').addEventListener('click', () => toggleModal('rulesModal'));
  byId('btnLeave').addEventListener('click', leaveTable);
  byId('btnMute').addEventListener('click', () => {
    audio.unlock();
    audio.setMuted(!audio.muted);
    renderMute();
  });

  byId('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    audio.unlock();
    const name = byId('nameInput').value.replace(/\s+/g, ' ').trim().slice(0, 16);
    if (!name) {
      byId('joinError').textContent = 'Please enter a name.';
      return;
    }
    join(name, false);
  });

  document.querySelectorAll('.modal').forEach((modal) => {
    modal.addEventListener('click', (e) => {
      if (modal.id === 'joinModal') return;
      if (e.target === modal || e.target.closest('[data-close]')) hideModal(modal.id);
    });
  });

  document.addEventListener('pointerdown', () => audio.unlock(), { passive: true });

  document.addEventListener('keydown', (e) => {
    audio.unlock();
    const typing = e.target instanceof HTMLElement && e.target.matches('input, textarea, select');
    if (e.key === 'Escape') {
      hideModal('rulesModal');
      hideModal('summaryModal');
      return;
    }
    if (typing || e.altKey) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') {
      e.preventDefault();
      if (getMe()) emit('bet:undo');
      return;
    }
    if (e.ctrlKey || e.metaKey) return;
    if (k === 'i') toggleModal('rulesModal');
    else if (k === 'm') {
      audio.setMuted(!audio.muted);
      renderMute();
    } else if (!getMe()) return;
    else if (/^[1-5]$/.test(k)) selectChip(CHIP_VALUES[Number(k) - 1]);
    else if (k === 'r') emit('bet:rebet');
    else if (k === 'l') toggleReady();
    else if (k === 'u') emit('bet:undo');
  });

  /* ======================================================================== */
  /*  HUD, tooltip, modals, toasts                                            */
  /* ======================================================================== */

  const strip = byId('outcomeStrip');
  const stripCells = Array.from({ length: 37 }, (_, n) => {
    const i = document.createElement('i');
    i.style.setProperty('--k', colorOf(n) === 'black' ? '#6b7280' : POCKET_COLORS[colorOf(n)].disc);
    strip.appendChild(i);
    return i;
  });

  function myExposure() {
    const returns = new Array(37).fill(0);
    let wagered = 0;
    const s = store.state;
    if (!s || !store.me) return { returns, wagered };
    for (const bet of s.bets) {
      const mine = bet.contributions.find((c) => c.playerId === store.me);
      const def = store.legal.get(bet.key);
      if (!mine || !def) continue;
      wagered += mine.amount;
      for (const n of def.numbers) returns[n] += mine.amount * (def.payout + 1);
    }
    return { returns, wagered };
  }

  function setConnection(online) {
    const dot = byId('connDot');
    dot.classList.toggle('online', online);
    dot.title = online ? 'Connected' : 'Disconnected';
    if (!online) byId('phaseLabel').textContent = 'Reconnecting…';
  }

  function renderMute() {
    byId('iconSound').hidden = audio.muted;
    byId('iconMuted').hidden = !audio.muted;
    byId('btnMute').setAttribute('aria-label', audio.muted ? 'Unmute sound' : 'Mute sound');
  }

  function renderHUD() {
    const s = store.state;
    const me = getMe();
    byId('btnLeave').hidden = !me;
    if (!s) return;
    const pill = byId('phasePill');
    pill.dataset.phase = s.phase;
    if (socket.connected) byId('phaseLabel').textContent = `${PHASE_LABEL[s.phase] || s.phase}${s.round ? ` · R${s.round}` : ''}`;
    byId('playerCount').textContent = `${s.players.length}/${store.config.maxSeats}`;

    const { returns, wagered } = myExposure();
    byId('statBank').textContent = money(me ? me.currentChips : 0);
    byId('statBet').textContent = money(wagered);
    let best = 0;
    let bestN = null;
    let covered = 0;
    returns.forEach((v, n) => {
      if (v > 0) covered += 1;
      if (v > best) {
        best = v;
        bestN = n;
      }
    });
    byId('statBest').textContent = best ? `${money(best)} · #${bestN}` : '—';
    byId('statBest').title = best ? `If ${bestN} hits you receive ${money(best)} (net ${signedMoney(best - wagered)})` : '';
    byId('statCover').textContent = `${covered}/37`;
    byId('statCover').title = `${((covered / 37) * 100).toFixed(1)}% chance at least one of your bets wins`;

    const res = activeResult();
    stripCells.forEach((cell, n) => {
      const v = returns[n];
      cell.style.setProperty('--h', best ? `${Math.max(v ? 8 : 0, (v / best) * 100)}%` : '0%');
      cell.title = v ? `#${n}: returns ${money(v)} (net ${signedMoney(v - wagered)})` : `#${n}: ${wagered ? `lose ${money(wagered)}` : 'no exposure'}`;
      cell.classList.toggle('hit', Boolean(res && res.winningNumber === n));
    });

    const betting = canBet();
    for (const btn of document.querySelectorAll('#chipRack .chip')) {
      btn.disabled = !betting || !me || Number(btn.dataset.value) > me.currentChips;
    }
    byId('btnUndo').disabled = !betting || wagered === 0;
    byId('btnClear').disabled = !betting || wagered === 0;
    byId('btnRebet').disabled = !betting;

    const readyBtn = byId('btnReady');
    readyBtn.disabled = !me || !me.connected || s.phase !== PHASE.BETTING;
    const locked = Boolean(me && me.ready && s.phase === PHASE.BETTING);
    readyBtn.textContent = locked ? 'Locked ✓ Unlock' : 'Lock Bets';
    readyBtn.classList.toggle('locked', locked);
    readyBtn.classList.toggle('gold', !locked);

    const host = Boolean(me && me.isHost);
    const startBtn = byId('btnStart');
    startBtn.hidden = !(host && s.phase === PHASE.WAITING);
    const connected = s.players.filter((p) => p.connected).length;
    startBtn.disabled = connected < store.config.minPlayersToStart;
    startBtn.textContent = s.gameOver ? 'New Match' : 'Start Match';
    startBtn.title = startBtn.disabled ? `Needs at least ${store.config.minPlayersToStart} seated players` : 'Open betting for everyone';
    byId('btnCloseBets').hidden = !(host && s.phase === PHASE.BETTING);
  }

  function updateTimerUI(now) {
    const s = store.state;
    const timer = byId('timer');
    const show = Boolean(s && s.phase === PHASE.BETTING && store.duration);
    if (timer.hidden === show) timer.hidden = !show;
    if (!show) return;
    const remaining = Math.max(0, store.deadline - now);
    const frac = clamp(remaining / store.duration, 0, 1);
    byId('timerBar').style.strokeDashoffset = String(97.4 * (1 - frac));
    const sec = Math.ceil(remaining / 1000);
    const text = byId('timerText');
    if (text.textContent !== String(sec)) text.textContent = String(sec);
    timer.classList.toggle('urgent', remaining < 5500);
    if (sec !== store.lastCountdownSec) {
      if (store.lastCountdownSec !== null && sec <= 5 && sec >= 1) audio.countdownTick(sec === 1);
      store.lastCountdownSec = sec;
    }
  }

  const tooltipEl = byId('tooltip');
  const tooltipState = { key: null, dirty: true };

  function hideTooltip() {
    tooltipEl.hidden = true;
    tooltipState.key = null;
  }

  function refreshTooltip() {
    const key = input.hoverKey;
    const spot = key ? store.spots.get(key) : null;
    if (!spot) return hideTooltip();
    if (tooltipState.dirty || tooltipState.key !== key) {
      buildTooltip(spot);
      tooltipState.key = key;
      tooltipState.dirty = false;
    }
    tooltipEl.hidden = false;
    const sr = stage.getBoundingClientRect();
    const tw = tooltipEl.offsetWidth;
    const th = tooltipEl.offsetHeight;
    let left = input.clientX - sr.left + 18;
    let top = input.clientY - sr.top + 18;
    if (left + tw > sr.width - 8) left = input.clientX - sr.left - tw - 18;
    if (top + th > sr.height - 8) top = input.clientY - sr.top - th - 18;
    tooltipEl.style.left = `${Math.max(8, left)}px`;
    tooltipEl.style.top = `${Math.max(8, top)}px`;
    return null;
  }

  function buildTooltip(spot) {
    const def = spot.def;
    const bet = store.betsByKey.get(def.key);
    tooltipEl.replaceChildren();
    const h = document.createElement('h4');
    h.textContent = def.label;
    const pays = document.createElement('div');
    pays.className = 'pays';
    pays.textContent = `Pays ${def.payout} : 1 · covers ${def.numbers.length} number${def.numbers.length > 1 ? 's' : ''} · ${((def.numbers.length / 37) * 100).toFixed(1)}%`;
    tooltipEl.append(h, pays);

    let mine = 0;
    if (bet) {
      for (const c of bet.contributions) {
        const p = store.players.get(c.playerId);
        if (!p) continue;
        if (c.playerId === store.me) mine = c.amount;
        const row = document.createElement('div');
        row.className = 'row';
        const name = document.createElement('span');
        name.textContent = c.playerId === store.me ? `${p.name} (you)` : p.name;
        const amt = document.createElement('span');
        amt.className = 'amt';
        amt.textContent = money(c.amount);
        row.append(avatarEl(p), name, amt);
        tooltipEl.appendChild(row);
      }
    }
    if (mine) {
      const m = document.createElement('div');
      m.className = 'mine';
      m.textContent = `Your ${money(mine)} returns ${money(mine * (def.payout + 1))} if it wins`;
      tooltipEl.appendChild(m);
    }
    if (canBet()) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      const chip = store.selectedChip;
      hint.textContent = `Click: add ${money(chip)} (returns ${money(chip * (def.payout + 1))})${mine ? ' · Right-click: remove yours' : ''}`;
      tooltipEl.appendChild(hint);
    }
  }

  function showModal(id) {
    byId(id).hidden = false;
  }
  function hideModal(id) {
    byId(id).hidden = true;
  }
  function toggleModal(id) {
    const el = byId(id);
    el.hidden = !el.hidden;
  }

  function showJoin() {
    const field = byId('nameInput');
    if (!field.value) field.value = store.name || storageGet('localStorage', 'rr-last-name') || '';
    showModal('joinModal');
    renderLobby();
    setTimeout(() => field.focus(), 50);
  }

  function renderLobby() {
    if (byId('joinModal').hidden) return;
    const s = store.state;
    const list = byId('lobbyList');
    const meta = byId('lobbyMeta');
    list.replaceChildren();
    if (!s) {
      meta.textContent = socket.connected ? 'Loading table…' : 'Connecting to the table…';
      return;
    }
    for (const p of s.players) {
      const chip = document.createElement('span');
      chip.className = 'who';
      const label = document.createElement('span');
      label.textContent = `${p.name}${p.isHost ? ' · host' : ''}`;
      chip.append(avatarEl(p), label);
      list.appendChild(chip);
    }
    const full = s.players.length >= store.config.maxSeats;
    meta.textContent = full
      ? 'The table is full right now.'
      : s.players.length === 0
        ? 'The table is empty — you will be the host.'
        : `${s.players.length}/${store.config.maxSeats} seated · ${PHASE_LABEL[s.phase]}`;
  }

  function showSummary(result, ms) {
    const disc = byId('summaryDisc');
    disc.textContent = String(result.winningNumber);
    disc.className = `result-disc ${result.color}`;
    byId('summaryTitle').textContent = `Round ${result.round} Results`;
    byId('summaryTags').textContent = `${result.color.toUpperCase()} · ${numberTraits(result.winningNumber).join(' · ')}`;
    const body = byId('summaryBody');
    body.replaceChildren();
    const rows = [...result.players].sort((a, b) => b.net - a.net || b.bankroll - a.bankroll);
    for (const r of rows) {
      const tr = document.createElement('tr');
      if (r.id === store.me) tr.className = 'me';
      const nameTd = document.createElement('td');
      nameTd.className = 'name';
      const nm = document.createElement('span');
      nm.textContent = r.id === store.me ? `${r.name} (you)` : r.name;
      nameTd.append(avatarEl(r), nm);
      const cells = [money(r.wagered), money(r.returned), signedMoney(r.net), money(r.bankroll)].map((text, i) => {
        const td = document.createElement('td');
        td.textContent = text;
        if (i === 2) td.className = r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : 'zero';
        return td;
      });
      tr.append(nameTd, ...cells);
      body.appendChild(tr);
    }
    const bar = byId('summaryBar');
    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(1)';
    void bar.offsetWidth;
    bar.style.transition = `transform ${Math.max(200, ms)}ms linear`;
    bar.style.transform = 'scaleX(0)';
    const mine = result.players.find((p) => p.id === store.me);
    byId('summaryFoot').textContent =
      mine && mine.wagered
        ? `You ${mine.net >= 0 ? 'won' : 'lost'} ${money(Math.abs(mine.net))} this round · next round starting…`
        : 'Next round starting…';
    showModal('summaryModal');
  }

  function toast(message, kind = 'info', ms = 3200) {
    if (!message) return;
    const box = byId('toasts');
    while (box.children.length >= 4) box.firstElementChild.remove();
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 400);
    }, ms);
  }

  /* ======================================================================== */
  /*  Boot                                                                    */
  /* ======================================================================== */

  renderMute();
  selectChip(store.selectedChip);
  if (store.name && store.token) {
    byId('joinModal').hidden = true;
  } else {
    showJoin();
  }

  let resizeQueued = false;
  const queueResize = () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      resize();
    });
  };
  if ('ResizeObserver' in window) new ResizeObserver(queueResize).observe(stage);
  window.addEventListener('resize', queueResize);
  resize();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => buildLayers());
  requestAnimationFrame(frame);
})();
