'use strict';

/**
 * Royale Roulette — authoritative multiplayer server.
 *
 * Every piece of game state lives here: seats, bankrolls, bets, the phase
 * state machine, the spin result (crypto.randomInt) and payout settlement.
 * Clients only send intents ("place a $5 chip on split:17-20") and render
 * the snapshots this server broadcasts.
 */

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;

const CONFIG = Object.freeze({
  startingChips: 100,
  minPlayersToStart: 2,
  maxSeats: 8,
  chipValues: Object.freeze([1, 5, 10, 25, 100]),
  bettingMs: 30_000,
  spinMs: 7_000,
  settleMs: 4_000,
  cleanupMs: 5_000,
  reconnectGraceMs: 45_000,
  maxBetPerSpot: 1_000,
  historySize: 14,
  maxNameLength: 16,
});

const PHASE = Object.freeze({
  WAITING_FOR_HOST: 'WAITING_FOR_HOST',
  BETTING_OPEN: 'BETTING_OPEN',
  SPINNING: 'SPINNING',
  PAYOUT_SETTLEMENT: 'PAYOUT_SETTLEMENT',
  ROUND_CLEANUP: 'ROUND_CLEANUP',
});

const WHEEL_ORDER = Object.freeze([
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10,
  5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
]);
const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const pocketColor = (n) => (n === 0 ? 'green' : RED_NUMBERS.has(n) ? 'red' : 'black');

// One style per seat so every player at the table is visually distinct.
const SEAT_STYLES = Object.freeze([
  { color: '#3b82f6', avatarIcon: 'circle' },
  { color: '#f97316', avatarIcon: 'triangle' },
  { color: '#a855f7', avatarIcon: 'square' },
  { color: '#22d3ee', avatarIcon: 'diamond' },
  { color: '#ec4899', avatarIcon: 'star' },
  { color: '#facc15', avatarIcon: 'hexagon' },
  { color: '#84cc16', avatarIcon: 'cross' },
  { color: '#ef4444', avatarIcon: 'bolt' },
]);

// Payout multipliers ("X to 1"). A winning bet returns stake * (payout + 1).
const PAYOUTS = Object.freeze({
  straight: 35,
  split: 17,
  street: 11, // includes the 0-1-2 / 0-2-3 trios
  corner: 8, // includes the 0-1-2-3 first four
  line: 5, // six line
  column: 2,
  dozen: 2,
  low: 1,
  high: 1,
  even: 1,
  odd: 1,
  red: 1,
  black: 1,
});

/* -------------------------------------------------------------------------- */
/*  Legal bet catalogue                                                       */
/* -------------------------------------------------------------------------- */

function insideLabel(type, n) {
  switch (type) {
    case 'straight':
      return `Straight ${n[0]}`;
    case 'split':
      return `Split ${n.join(' / ')}`;
    case 'street':
      return n[0] === 0 ? `Trio ${n.join('-')}` : `Street ${n[0]}–${n[2]}`;
    case 'corner':
      return n[0] === 0 ? 'First Four 0-1-2-3' : `Corner ${n.join('-')}`;
    case 'line':
      return `Six Line ${n[0]}–${n[5]}`;
    default:
      return type;
  }
}

function buildLegalBets() {
  const bets = new Map();
  const define = (key, type, numbers, label) => {
    bets.set(key, Object.freeze({ key, type, numbers: Object.freeze(numbers), payout: PAYOUTS[type], label }));
  };
  const inside = (type, nums) => {
    const sorted = [...nums].sort((a, b) => a - b);
    define(`${type}:${sorted.join('-')}`, type, sorted, insideLabel(type, sorted));
  };
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const all = range(1, 36);

  for (let n = 0; n <= 36; n++) inside('straight', [n]);
  for (let n = 1; n <= 36; n++) {
    if (n + 3 <= 36) inside('split', [n, n + 3]); // neighbours along a row
    if (n % 3 !== 0) inside('split', [n, n + 1]); // neighbours within a column
  }
  inside('split', [0, 1]);
  inside('split', [0, 2]);
  inside('split', [0, 3]);
  for (let c = 0; c < 12; c++) {
    const b = c * 3 + 1;
    inside('street', [b, b + 1, b + 2]);
    if (c < 11) inside('line', range(b, b + 5));
  }
  inside('street', [0, 1, 2]);
  inside('street', [0, 2, 3]);
  for (let n = 1; n <= 32; n++) {
    if (n % 3 !== 0) inside('corner', [n, n + 1, n + 3, n + 4]);
  }
  inside('corner', [0, 1, 2, 3]);

  define('dozen:1', 'dozen', range(1, 12), '1st Dozen (1–12)');
  define('dozen:2', 'dozen', range(13, 24), '2nd Dozen (13–24)');
  define('dozen:3', 'dozen', range(25, 36), '3rd Dozen (25–36)');
  define('column:1', 'column', all.filter((n) => n % 3 === 1), 'Column 1 (1, 4 … 34)');
  define('column:2', 'column', all.filter((n) => n % 3 === 2), 'Column 2 (2, 5 … 35)');
  define('column:3', 'column', all.filter((n) => n % 3 === 0), 'Column 3 (3, 6 … 36)');
  define('low', 'low', range(1, 18), 'Low (1–18)');
  define('high', 'high', range(19, 36), 'High (19–36)');
  define('even', 'even', all.filter((n) => n % 2 === 0), 'Even');
  define('odd', 'odd', all.filter((n) => n % 2 === 1), 'Odd');
  define('red', 'red', all.filter((n) => RED_NUMBERS.has(n)), 'Red');
  define('black', 'black', all.filter((n) => !RED_NUMBERS.has(n)), 'Black');
  return bets;
}

const LEGAL_BETS = buildLegalBets();

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CONFIG.maxNameLength);
}

const reply = (ack, payload) => {
  if (typeof ack === 'function') ack(payload);
};
const ok = (extra) => ({ ok: true, ...extra });
const fail = (error) => ({ ok: false, error });

/* -------------------------------------------------------------------------- */
/*  Table / game state machine                                                */
/* -------------------------------------------------------------------------- */

class RouletteTable {
  constructor(io) {
    this.io = io;
    this.players = new Map(); // playerId -> player record
    this.tokenIndex = new Map(); // session token -> playerId
    this.bets = new Map(); // betKey -> Map<playerId, amount>
    this.betLog = new Map(); // playerId -> [{ key, amount }] (for undo)
    this.lastRoundBets = new Map(); // playerId -> [{ key, amount }] (for rebet)
    this.phase = PHASE.WAITING_FOR_HOST;
    this.phaseEndsAt = null;
    this.phaseDuration = null;
    this.phaseTimer = null;
    this.hostId = null;
    this.round = 0;
    this.history = [];
    this.spin = null;
    this.lastResult = null;
    this.gameOver = false;
    this.notice = null;
    this.joinCounter = 0;
  }

  /* ----------------------------- queries ----------------------------- */

  playerFor(socket) {
    const p = this.players.get(socket.data.playerId);
    return p && p.socketId === socket.id ? p : null;
  }

  connectedPlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  totalBetOf(playerId) {
    let total = 0;
    for (const spot of this.bets.values()) total += spot.get(playerId) || 0;
    return total;
  }

  freeSeat() {
    const taken = new Set([...this.players.values()].map((p) => p.seat));
    for (let s = 0; s < CONFIG.maxSeats; s++) if (!taken.has(s)) return s;
    return -1;
  }

  publicState() {
    const now = Date.now();
    return {
      phase: this.phase,
      round: this.round,
      hostId: this.hostId,
      phaseEndsIn: this.phaseEndsAt ? Math.max(0, this.phaseEndsAt - now) : null,
      phaseDuration: this.phaseDuration,
      gameOver: this.gameOver,
      notice: this.notice,
      history: this.history,
      players: [...this.players.values()]
        .sort((a, b) => a.seat - b.seat)
        .map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          avatarIcon: p.avatarIcon,
          currentChips: p.currentChips,
          seat: p.seat,
          isHost: p.id === this.hostId,
          ready: p.ready,
          connected: p.connected,
          totalBet: this.totalBetOf(p.id),
        })),
      bets: [...this.bets.entries()].map(([key, spot]) => {
        const contributions = [...spot.entries()].map(([playerId, amount]) => ({ playerId, amount }));
        return { key, contributions, total: contributions.reduce((s, c) => s + c.amount, 0) };
      }),
      spin:
        this.phase === PHASE.SPINNING && this.spin
          ? { ...this.spin, elapsed: now - this.spin.startedAt }
          : null,
      lastResult:
        this.phase === PHASE.PAYOUT_SETTLEMENT || this.phase === PHASE.ROUND_CLEANUP ? this.lastResult : null,
    };
  }

  broadcast() {
    this.io.emit('state', this.publicState());
  }

  notifyAll(message, kind = 'info') {
    this.io.emit('toast', { kind, message });
  }

  /* --------------------------- phase timing -------------------------- */

  schedule(ms, fn) {
    clearTimeout(this.phaseTimer);
    this.phaseEndsAt = Date.now() + ms;
    this.phaseDuration = ms;
    this.phaseTimer = setTimeout(() => {
      this.phaseTimer = null;
      try {
        fn();
      } catch (err) {
        console.error('[table] phase transition failed:', err);
      }
    }, ms);
  }

  clearSchedule() {
    clearTimeout(this.phaseTimer);
    this.phaseTimer = null;
    this.phaseEndsAt = null;
    this.phaseDuration = null;
  }

  /* ----------------------------- lobby ------------------------------- */

  join(socket, payload) {
    const token = typeof payload?.token === 'string' ? payload.token.slice(0, 64) : null;
    const name = sanitizeName(payload?.name);
    // A "waiting for players" notice is stale once someone sits down.
    if (this.phase === PHASE.WAITING_FOR_HOST && !this.gameOver) this.notice = null;

    const current = this.playerFor(socket);
    if (current) return ok({ playerId: current.id, token: current.token });

    // Resume a seat that is inside its reconnect grace window.
    const resumeId = token ? this.tokenIndex.get(token) : null;
    const resume = resumeId ? this.players.get(resumeId) : null;
    if (resume && !resume.connected) {
      clearTimeout(resume.graceTimer);
      resume.graceTimer = null;
      resume.connected = true;
      resume.socketId = socket.id;
      if (name) resume.name = name;
      socket.data.playerId = resume.id;
      if (!this.hostId) this.hostId = resume.id;
      this.broadcast();
      return ok({ playerId: resume.id, token: resume.token, resumed: true });
    }

    const seat = this.freeSeat();
    if (seat === -1) return fail(`The table is full (${CONFIG.maxSeats} seats). Please try again shortly.`);

    const style = SEAT_STYLES[seat];
    const player = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(18).toString('base64url'),
      name: name || `Player ${seat + 1}`,
      color: style.color,
      avatarIcon: style.avatarIcon,
      currentChips: CONFIG.startingChips,
      seat,
      joinOrder: ++this.joinCounter,
      ready: false,
      connected: true,
      socketId: socket.id,
      graceTimer: null,
    };
    this.players.set(player.id, player);
    this.tokenIndex.set(player.token, player.id);
    socket.data.playerId = player.id;

    if (!this.hostId) this.hostId = player.id;
    this.notifyAll(`${player.name} took a seat.`);
    this.broadcast();
    return ok({ playerId: player.id, token: player.token });
  }

  handleDisconnect(socket) {
    const p = this.playerFor(socket);
    if (!p) return;
    p.connected = false;
    p.socketId = null;
    p.ready = false;
    if (this.hostId === p.id) this.migrateHost();
    p.graceTimer = setTimeout(() => this.removePlayer(p.id), CONFIG.reconnectGraceMs);
    this.broadcast();
    this.checkAllReady();
  }

  migrateHost() {
    const next = this.connectedPlayers().sort((a, b) => a.joinOrder - b.joinOrder)[0];
    const previous = this.hostId;
    this.hostId = next ? next.id : null;
    if (next && next.id !== previous) this.notifyAll(`${next.name} is now the host.`);
  }

  removePlayer(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    clearTimeout(p.graceTimer);
    for (const [key, spot] of this.bets) {
      spot.delete(playerId);
      if (spot.size === 0) this.bets.delete(key);
    }
    this.betLog.delete(playerId);
    this.lastRoundBets.delete(playerId);
    this.tokenIndex.delete(p.token);
    this.players.delete(playerId);
    if (this.hostId === playerId) this.migrateHost();

    if (this.players.size === 0) {
      this.resetTable();
      return;
    }
    this.notifyAll(`${p.name} left the table.`);
    this.broadcast();
    this.checkAllReady();
  }

  resetTable() {
    this.clearSchedule();
    this.phase = PHASE.WAITING_FOR_HOST;
    this.bets.clear();
    this.betLog.clear();
    this.lastRoundBets.clear();
    this.hostId = null;
    this.round = 0;
    this.history = [];
    this.spin = null;
    this.lastResult = null;
    this.gameOver = false;
    this.notice = null;
    this.broadcast();
  }

  /* --------------------------- host controls ------------------------- */

  startMatch(p) {
    if (p.id !== this.hostId) return fail('Only the host can start the match.');
    if (this.phase !== PHASE.WAITING_FOR_HOST) return fail('The match is already running.');
    if (this.connectedPlayers().length < CONFIG.minPlayersToStart) {
      return fail(`At least ${CONFIG.minPlayersToStart} players must be seated to start.`);
    }
    if (this.gameOver) {
      for (const player of this.players.values()) player.currentChips = CONFIG.startingChips;
      this.lastRoundBets.clear();
      this.history = [];
      this.gameOver = false;
    }
    this.notifyAll(`${p.name} started the match. Good luck!`, 'success');
    this.openBetting();
    return ok();
  }

  closeBetsByHost(p) {
    if (p.id !== this.hostId) return fail('Only the host can close betting.');
    if (this.phase !== PHASE.BETTING_OPEN) return fail('Betting is not open.');
    this.notifyAll(`${p.name} closed the bets.`);
    this.closeBetting();
    return ok();
  }

  /* ----------------------------- betting ----------------------------- */

  ensureCanBet(p) {
    if (this.phase !== PHASE.BETTING_OPEN) return 'Betting is closed right now.';
    if (p.ready) return 'Your bets are locked. Unlock them to make changes.';
    return null;
  }

  placeBet(p, payload) {
    const blocked = this.ensureCanBet(p);
    if (blocked) return fail(blocked);
    const key = typeof payload?.key === 'string' ? payload.key : '';
    const def = LEGAL_BETS.get(key);
    if (!def) return fail('That is not a valid betting spot.');
    const amount = Number(payload?.amount);
    if (!CONFIG.chipValues.includes(amount)) return fail('Invalid chip denomination.');
    if (p.currentChips < amount) return fail(`Not enough chips — you have $${p.currentChips} left.`);

    const spot = this.bets.get(key) || new Map();
    const existing = spot.get(p.id) || 0;
    if (existing + amount > CONFIG.maxBetPerSpot) return fail(`Table limit is $${CONFIG.maxBetPerSpot} per spot.`);

    p.currentChips -= amount;
    spot.set(p.id, existing + amount);
    this.bets.set(key, spot);
    this.logBet(p.id, key, amount);
    this.io.emit('bet:placed', { playerId: p.id, key, amount });
    this.broadcast();
    return ok();
  }

  logBet(playerId, key, amount) {
    const log = this.betLog.get(playerId) || [];
    log.push({ key, amount });
    this.betLog.set(playerId, log);
  }

  removeBet(p, payload) {
    const blocked = this.ensureCanBet(p);
    if (blocked) return fail(blocked);
    const key = typeof payload?.key === 'string' ? payload.key : '';
    const spot = this.bets.get(key);
    const amount = spot ? spot.get(p.id) : 0;
    if (!amount) return fail('You have no chips on that spot.');
    spot.delete(p.id);
    if (spot.size === 0) this.bets.delete(key);
    p.currentChips += amount;
    const log = this.betLog.get(p.id);
    if (log) this.betLog.set(p.id, log.filter((entry) => entry.key !== key));
    this.io.emit('bet:removed', { playerId: p.id, key });
    this.broadcast();
    return ok();
  }

  undoBet(p) {
    const blocked = this.ensureCanBet(p);
    if (blocked) return fail(blocked);
    const log = this.betLog.get(p.id);
    const last = log && log.pop();
    if (!last) return fail('Nothing to undo.');
    const spot = this.bets.get(last.key);
    const current = spot ? spot.get(p.id) || 0 : 0;
    const refund = Math.min(current, last.amount);
    if (refund > 0) {
      const remaining = current - refund;
      if (remaining > 0) spot.set(p.id, remaining);
      else spot.delete(p.id);
      if (spot.size === 0) this.bets.delete(last.key);
      p.currentChips += refund;
    }
    this.io.emit('bet:removed', { playerId: p.id, key: last.key });
    this.broadcast();
    return ok();
  }

  clearBets(p) {
    const blocked = this.ensureCanBet(p);
    if (blocked) return fail(blocked);
    let refund = 0;
    for (const [key, spot] of this.bets) {
      const amount = spot.get(p.id);
      if (!amount) continue;
      refund += amount;
      spot.delete(p.id);
      if (spot.size === 0) this.bets.delete(key);
    }
    if (!refund) return fail('You have no bets on the table.');
    p.currentChips += refund;
    this.betLog.set(p.id, []);
    this.io.emit('bet:removed', { playerId: p.id, key: null });
    this.broadcast();
    return ok();
  }

  rebet(p) {
    const blocked = this.ensureCanBet(p);
    if (blocked) return fail(blocked);
    const previous = this.lastRoundBets.get(p.id);
    if (!previous || previous.length === 0) return fail('No previous bets to repeat.');
    const total = previous.reduce((s, b) => s + b.amount, 0);
    if (total > p.currentChips) return fail(`Rebet needs $${total}, but you only have $${p.currentChips}.`);
    for (const { key, amount } of previous) {
      const existing = this.bets.get(key)?.get(p.id) || 0;
      if (existing + amount > CONFIG.maxBetPerSpot) return fail(`Rebet would exceed the $${CONFIG.maxBetPerSpot} spot limit.`);
    }
    for (const { key, amount } of previous) {
      const spot = this.bets.get(key) || new Map();
      spot.set(p.id, (spot.get(p.id) || 0) + amount);
      this.bets.set(key, spot);
      this.logBet(p.id, key, amount);
    }
    p.currentChips -= total;
    this.io.emit('bet:placed', { playerId: p.id, key: previous[0].key, amount: previous[0].amount, rebet: true });
    this.broadcast();
    return ok();
  }

  setReady(p, payload) {
    if (this.phase !== PHASE.BETTING_OPEN) return fail('Betting is closed right now.');
    p.ready = Boolean(payload?.ready);
    this.broadcast();
    this.checkAllReady();
    return ok();
  }

  checkAllReady() {
    if (this.phase !== PHASE.BETTING_OPEN) return;
    const eligible = this.connectedPlayers().filter((p) => p.currentChips > 0 || this.totalBetOf(p.id) > 0);
    if (eligible.length > 0 && eligible.every((p) => p.ready)) {
      this.notifyAll('All players locked in — no more bets!');
      this.closeBetting();
    }
  }

  /* --------------------------- round flow ---------------------------- */

  openBetting() {
    this.bets.clear();
    this.betLog.clear();
    this.spin = null;
    this.lastResult = null;
    this.notice = null;
    for (const p of this.players.values()) p.ready = false;
    this.round += 1;
    this.phase = PHASE.BETTING_OPEN;
    this.schedule(CONFIG.bettingMs, () => this.closeBetting());
    this.broadcast();
  }

  closeBetting() {
    if (this.phase !== PHASE.BETTING_OPEN) return;
    this.startSpin();
  }

  startSpin() {
    const winningNumber = crypto.randomInt(0, 37);
    this.spin = {
      id: crypto.randomBytes(6).toString('hex'),
      round: this.round,
      winningNumber,
      duration: CONFIG.spinMs,
      seed: crypto.randomInt(1, 2 ** 31 - 1),
      startedAt: Date.now(),
    };
    this.phase = PHASE.SPINNING;
    this.schedule(CONFIG.spinMs + 250, () => this.settle());
    this.io.emit('spin:start', { ...this.spin, elapsed: 0 });
    this.broadcast();
  }

  settle() {
    const winningNumber = this.spin.winningNumber;
    const ledger = new Map(); // playerId -> { wagered, returned }
    const winningKeys = [];

    for (const [key, spot] of this.bets) {
      const def = LEGAL_BETS.get(key);
      const wins = def.numbers.includes(winningNumber);
      if (wins) winningKeys.push(key);
      for (const [playerId, amount] of spot) {
        const row = ledger.get(playerId) || { wagered: 0, returned: 0 };
        row.wagered += amount;
        if (wins) row.returned += amount * (def.payout + 1);
        ledger.set(playerId, row);
      }
    }

    // Remember each bettor's layout for "Rebet" next round.
    const layouts = new Map();
    for (const [key, spot] of this.bets) {
      for (const [playerId, amount] of spot) {
        if (!layouts.has(playerId)) layouts.set(playerId, []);
        layouts.get(playerId).push({ key, amount });
      }
    }
    for (const [playerId, layout] of layouts) this.lastRoundBets.set(playerId, layout);

    const players = [...this.players.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((p) => {
        const row = ledger.get(p.id) || { wagered: 0, returned: 0 };
        p.currentChips += row.returned;
        return {
          id: p.id,
          name: p.name,
          color: p.color,
          avatarIcon: p.avatarIcon,
          wagered: row.wagered,
          returned: row.returned,
          net: row.returned - row.wagered,
          bankroll: p.currentChips,
        };
      });

    this.history = [{ number: winningNumber, color: pocketColor(winningNumber) }, ...this.history].slice(
      0,
      CONFIG.historySize,
    );
    this.lastResult = {
      id: this.spin.id,
      round: this.round,
      winningNumber,
      color: pocketColor(winningNumber),
      winningKeys,
      players,
    };
    this.phase = PHASE.PAYOUT_SETTLEMENT;
    this.schedule(CONFIG.settleMs, () => this.cleanup());
    this.io.emit('round:result', this.lastResult);
    this.broadcast();
  }

  cleanup() {
    this.phase = PHASE.ROUND_CLEANUP;
    this.schedule(CONFIG.cleanupMs, () => this.endRound());
    this.broadcast();
  }

  endRound() {
    this.bets.clear();
    this.betLog.clear();
    this.spin = null;
    const everyone = [...this.players.values()];
    if (everyone.length > 0 && everyone.every((p) => p.currentChips <= 0)) {
      this.gameOver = true;
      this.toWaiting('Every bankroll is empty — game over. The host can start a fresh match.');
      return;
    }
    if (this.connectedPlayers().length < CONFIG.minPlayersToStart) {
      this.toWaiting(`Waiting for at least ${CONFIG.minPlayersToStart} players to continue.`);
      return;
    }
    this.openBetting();
  }

  toWaiting(notice) {
    this.clearSchedule();
    this.phase = PHASE.WAITING_FOR_HOST;
    this.lastResult = null;
    this.notice = notice;
    for (const p of this.players.values()) p.ready = false;
    this.broadcast();
  }
}

/* -------------------------------------------------------------------------- */
/*  HTTP + Socket.io wiring                                                   */
/* -------------------------------------------------------------------------- */

const app = express();
app.disable('x-powered-by');
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);
app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 16 * 1024 });
const table = new RouletteTable(io);

const PUBLIC_CONFIG = Object.freeze({
  startingChips: CONFIG.startingChips,
  minPlayersToStart: CONFIG.minPlayersToStart,
  maxSeats: CONFIG.maxSeats,
  chipValues: CONFIG.chipValues,
  bettingMs: CONFIG.bettingMs,
  spinMs: CONFIG.spinMs,
  settleMs: CONFIG.settleMs,
  cleanupMs: CONFIG.cleanupMs,
  maxBetPerSpot: CONFIG.maxBetPerSpot,
});

// Simple token bucket per socket so a misbehaving client cannot flood the table.
function allowAction(socket) {
  const now = Date.now();
  const bucket = socket.data.bucket;
  bucket.tokens = Math.min(25, bucket.tokens + ((now - bucket.last) / 1000) * 12);
  bucket.last = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

io.on('connection', (socket) => {
  socket.data.bucket = { tokens: 25, last: Date.now() };
  socket.emit('welcome', {
    config: PUBLIC_CONFIG,
    wheelOrder: WHEEL_ORDER,
    legalBets: [...LEGAL_BETS.values()],
  });
  socket.emit('state', table.publicState());

  socket.on('player:join', (payload, ack) => {
    try {
      if (!allowAction(socket)) return reply(ack, fail('Slow down a little.'));
      reply(ack, table.join(socket, payload));
    } catch (err) {
      console.error('[join]', err);
      reply(ack, fail('Server error while joining.'));
    }
  });

  const action = (event, handler) => {
    socket.on(event, (payload, ack) => {
      try {
        if (!allowAction(socket)) {
          socket.emit('toast', { kind: 'error', message: 'Slow down a little.' });
          return reply(ack, fail('rate-limited'));
        }
        const player = table.playerFor(socket);
        if (!player) return reply(ack, fail('Join the table first.'));
        const result = handler(player, payload || {}) || ok();
        if (!result.ok && result.error) socket.emit('toast', { kind: 'error', message: result.error });
        reply(ack, result);
      } catch (err) {
        console.error(`[${event}]`, err);
        reply(ack, fail('Server error.'));
      }
    });
  };

  action('game:start', (p) => table.startMatch(p));
  action('game:closeBets', (p) => table.closeBetsByHost(p));
  action('bet:place', (p, data) => table.placeBet(p, data));
  action('bet:remove', (p, data) => table.removeBet(p, data));
  action('bet:undo', (p) => table.undoBet(p));
  action('bet:clear', (p) => table.clearBets(p));
  action('bet:rebet', (p) => table.rebet(p));
  action('player:ready', (p, data) => table.setReady(p, data));

  socket.on('disconnect', () => {
    try {
      table.handleDisconnect(socket);
    } catch (err) {
      console.error('[disconnect]', err);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Royale Roulette running at http://localhost:${PORT}`);
});

const shutdown = () => {
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
