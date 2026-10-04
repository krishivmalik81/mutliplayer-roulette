'use strict';

/**
 * Royale Roulette — authoritative multiplayer server.
 *
 * Every piece of game state lives here: seats, bankrolls, bets, the phase
 * state machine, the spin result (crypto.randomInt) and payout settlement.
 * Clients only send intents ("place a $5 chip on split:17-20") and render
 * the snapshots this server broadcasts.
 *
 * Moderation model:
 *  - The host is whoever runs the table (first seated, or anyone on localhost).
 *  - "Admin" powers — removing players, approving rejoin requests, restoring
 *    frozen bankrolls and restarting the game — belong ONLY to a host who is
 *    connected from localhost. A host on any other machine cannot use them.
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
  bettingMs: 20_000,
  spinMs: 7_000,
  settleMs: 4_000,
  cleanupMs: 5_000,
  reconnectGraceMs: 10_000, // a dropped player keeps their seat this long
  ipLockMs: 10 * 60_000, // a network that left needs host approval to rejoin for this long
  minTotalBet: 5, // a player's total stake per round must reach this
  strikeLimit: 5, // rounds below the minimum (per match) before chips are frozen
  strikeStreakLimit: 3, // consecutive rounds below the minimum before chips are frozen
  voteKickMs: 60_000,
  maxBetPerSpot: 1_000,
  historySize: 14,
  maxNameLength: 16,
  adminLogSize: 30,
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

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

const reply = (ack, payload) => {
  if (typeof ack === 'function') ack(payload);
};
const ok = (extra) => ({ ok: true, ...extra });
const fail = (error, code, extra) => ({ ok: false, error, ...(code ? { code } : {}), ...extra });

const normalizeIp = (ip) => String(ip || '').trim().replace(/^::ffff:/i, '');
const isLoopback = (ip) => ip === '::1' || ip.startsWith('127.');
function isPrivateIp(ip) {
  if (isLoopback(ip)) return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip)) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return /^f[cd]/i.test(ip) || /^fe80:/i.test(ip);
}

/**
 * Work out where a socket really comes from.
 *  - `isLocal` is true only for a direct loopback connection with no proxy
 *    headers, so a tunnel (ngrok, cloudflared) or a hosted proxy can never
 *    make a remote visitor look like localhost.
 *  - Proxy headers are only trusted when the TCP peer itself is a private
 *    address (e.g. Render's load balancer or a tunnel running on this machine).
 */
function networkOf(socket) {
  const h = socket.handshake.headers || {};
  const peer = normalizeIp(socket.handshake.address);
  const forwarded = h['cf-connecting-ip'] || h['x-real-ip'] || h['x-forwarded-for'] || h.forwarded;
  const isLocal = isLoopback(peer) && !forwarded;
  let ip = peer;
  if (forwarded && isPrivateIp(peer)) {
    const raw = h['cf-connecting-ip'] || h['x-real-ip'] || String(h['x-forwarded-for'] || '').split(',')[0];
    if (raw) ip = normalizeIp(raw);
  }
  return { ip, isLocal };
}

/* -------------------------------------------------------------------------- */
/*  Table / game state machine                                                */
/* -------------------------------------------------------------------------- */

const REMOVAL_TEXT = {
  left: (n) => `${n} left the table.`,
  timeout: (n) => `${n} was removed after disconnecting.`,
  kicked: (n) => `${n} was removed by the host.`,
  votekick: (n) => `${n} was voted off the table.`,
};

class RouletteTable {
  constructor(io) {
    this.io = io;
    this.players = new Map(); // playerId -> player record
    this.tokenIndex = new Map(); // session token -> playerId
    this.bets = new Map(); // betKey -> Map<playerId, amount>
    this.betLog = new Map(); // playerId -> [{ key, amount }] (for undo)
    this.lastRoundBets = new Map(); // playerId -> [{ key, amount }] (for rebet)
    this.ipHistory = new Map(); // ip -> { names, removedAt, bankroll, confiscated, reason }
    this.pending = new Map(); // requestId -> rejoin request awaiting the admin
    this.kickVotes = new Map(); // targetId -> { voters: Set, startedAt, timer }
    this.adminLog = [];
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

  /** The host, but only while they are connected from localhost. */
  admin() {
    const host = this.players.get(this.hostId);
    return host && host.connected && host.isLocal ? host : null;
  }

  isAdmin(p) {
    const admin = this.admin();
    return Boolean(admin && p && admin.id === p.id);
  }

  socketOf(p) {
    return p && p.socketId ? this.io.sockets.sockets.get(p.socketId) || null : null;
  }

  tell(p, message, kind = 'info') {
    if (p && p.socketId) this.io.to(p.socketId).emit('toast', { kind, message });
  }

  publicState() {
    const now = Date.now();
    const adminId = this.admin()?.id || null;
    return {
      phase: this.phase,
      round: this.round,
      hostId: this.hostId,
      adminId,
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
          strikes: p.strikes,
          missStreak: p.missStreak,
          confiscated: p.confiscated,
          minRequired: this.requiredBetFor(p),
        })),
      votes: [...this.kickVotes.entries()].map(([targetId, vote]) => {
        const target = this.players.get(targetId);
        return {
          targetId,
          voters: [...vote.voters],
          required: target ? this.requiredVotes(target) : 0,
          expiresIn: Math.max(0, vote.startedAt + CONFIG.voteKickMs - now),
        };
      }),
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
    this.syncAdmin();
  }

  notifyAll(message, kind = 'info') {
    this.io.emit('toast', { kind, message });
  }

  /* ------------------------- admin data feed ------------------------- */

  logAdmin(text, kind = 'info') {
    this.adminLog.push({ at: Date.now(), kind, text });
    if (this.adminLog.length > CONFIG.adminLogSize) this.adminLog.shift();
  }

  /** Rejoin requests and the moderation log go only to the localhost host. */
  syncAdmin() {
    const admin = this.admin();
    if (!admin) return;
    const now = Date.now();
    this.io.to(admin.socketId).emit('admin:feed', {
      pending: [...this.pending.values()].map((r) => ({
        id: r.id,
        name: r.name,
        pastNames: r.pastNames,
        bankroll: r.bankroll,
        confiscated: r.confiscated,
        reason: r.reason,
        leftAgo: now - r.removedAt,
        requestedAgo: now - r.requestedAt,
        unlocksIn: Math.max(0, r.removedAt + CONFIG.ipLockMs - now),
      })),
      log: this.adminLog.slice(-20).map((e) => ({ ...e, ago: now - e.at })),
    });
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
    const { ip, isLocal } = socket.data;
    // A "waiting for players" notice is stale once someone sits down.
    if (this.phase === PHASE.WAITING_FOR_HOST && !this.gameOver) this.notice = null;

    const current = this.playerFor(socket);
    if (current) return ok({ playerId: current.id, token: current.token });

    // 1. Reclaim a seat inside its reconnect window with the session token.
    const byToken = token ? this.players.get(this.tokenIndex.get(token)) : null;
    if (byToken && !byToken.connected) return this.reattach(byToken, socket, name);

    // 2. One seat per network. A dropped seat from the same address is simply
    //    handed back (e.g. the tab was closed and reopened within the window).
    if (!isLocal) {
      const sameNetwork = [...this.players.values()].find((p) => !p.isLocal && p.ip === ip);
      if (sameNetwork && !sameNetwork.connected) return this.reattach(sameNetwork, socket, name);
      if (sameNetwork) return fail('Someone on your network is already seated at this table.', 'IP_IN_USE');
    }

    // Automatic reconnects may only reclaim an existing seat; if it's gone the
    // player goes back to the join screen instead of being silently re-seated.
    if (payload?.resumeOnly === true) return fail('Your previous seat is no longer available.', 'SEAT_GONE');

    // 3. This network left recently: the localhost host decides.
    if (!isLocal) {
      const record = this.recentRecord(ip);
      if (record) return this.requestRejoin(socket, name, record);
    }

    return this.seatPlayer(socket, { name, chips: CONFIG.startingChips });
  }

  reattach(p, socket, name) {
    clearTimeout(p.graceTimer);
    p.graceTimer = null;
    p.connected = true;
    p.socketId = socket.id;
    p.isLocal = socket.data.isLocal;
    p.ip = socket.data.ip;
    if (name) p.name = name;
    socket.data.playerId = p.id;
    this.claimHost(p);
    this.broadcast();
    return ok({ playerId: p.id, token: p.token, resumed: true });
  }

  seatPlayer(socket, { name, chips, confiscated = 0 }) {
    const seat = this.freeSeat();
    if (seat === -1) return fail(`The table is full (${CONFIG.maxSeats} seats). Please try again shortly.`);
    const style = SEAT_STYLES[seat];
    const player = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(18).toString('base64url'),
      name: name || `Player ${seat + 1}`,
      color: style.color,
      avatarIcon: style.avatarIcon,
      currentChips: chips,
      seat,
      joinOrder: ++this.joinCounter,
      ready: false,
      connected: true,
      socketId: socket.id,
      graceTimer: null,
      ip: socket.data.ip,
      isLocal: socket.data.isLocal,
      strikes: 0,
      missStreak: 0,
      confiscated,
      roundStartChips: chips,
      // Joining mid-betting: no minimum-bet strike this round.
      exemptRound: this.phase === PHASE.BETTING_OPEN ? this.round : null,
    };
    this.players.set(player.id, player);
    this.tokenIndex.set(player.token, player.id);
    socket.data.playerId = player.id;

    this.claimHost(player);
    this.notifyAll(`${player.name} took a seat.`);
    this.logAdmin(`${player.name} joined with ${money(chips)}.`, 'join');
    this.broadcast();
    return ok({ playerId: player.id, token: player.token });
  }

  /** First seated player hosts; a localhost player always takes over hosting. */
  claimHost(p) {
    const host = this.players.get(this.hostId);
    if (!host || !host.connected) {
      this.hostId = p.id;
    } else if (p.isLocal && !host.isLocal) {
      this.hostId = p.id;
      this.notifyAll(`${p.name} (localhost) is now the host.`);
    }
  }

  recentRecord(ip) {
    const record = this.ipHistory.get(ip);
    if (!record) return null;
    if (Date.now() - record.removedAt > CONFIG.ipLockMs) {
      this.ipHistory.delete(ip);
      return null;
    }
    return record;
  }

  requestRejoin(socket, name, record) {
    for (const [id, r] of this.pending) if (r.socketId === socket.id || r.ip === record.ip) this.pending.delete(id);
    const req = {
      id: crypto.randomBytes(6).toString('hex'),
      ip: record.ip,
      name: name || record.names[record.names.length - 1],
      pastNames: [...record.names],
      bankroll: record.bankroll,
      confiscated: record.confiscated,
      reason: record.reason,
      removedAt: record.removedAt,
      requestedAt: Date.now(),
      socketId: socket.id,
    };
    this.pending.set(req.id, req);
    this.logAdmin(`${req.name} asked to rejoin (was ${req.pastNames.join(', ')}).`, 'request');
    const admin = this.admin();
    if (admin) {
      this.io.to(admin.socketId).emit('admin:request', { name: req.name, pastNames: req.pastNames });
      this.syncAdmin();
    }
    return fail(
      admin
        ? 'You left this table recently. Waiting for the host to let you back in…'
        : 'You left this table recently. Only the host on localhost can let you back in — waiting for them…',
      'PENDING',
      { unlocksIn: Math.max(0, record.removedAt + CONFIG.ipLockMs - Date.now()) },
    );
  }

  dropRequestsFrom(socketId) {
    let changed = false;
    for (const [id, r] of this.pending) {
      if (r.socketId === socketId) {
        this.pending.delete(id);
        changed = true;
      }
    }
    if (changed) this.syncAdmin();
  }

  handleDisconnect(socket) {
    this.dropRequestsFrom(socket.id);
    const p = this.playerFor(socket);
    if (!p) return;
    p.connected = false;
    p.socketId = null;
    p.ready = false;
    // Everyone has left: wipe the table so the next visitors start a fresh game.
    if (this.connectedPlayers().length === 0) {
      this.resetTable();
      return;
    }
    if (this.hostId === p.id) this.migrateHost();
    p.graceTimer = setTimeout(() => this.removePlayer(p.id, 'timeout'), CONFIG.reconnectGraceMs);
    this.evaluateVotes();
    this.broadcast();
    this.checkAllReady();
  }

  /** Explicit "Leave table" — gives up the seat immediately, no grace period. */
  leave(p, socket) {
    socket.data.playerId = null;
    this.removePlayer(p.id, 'left');
    return ok();
  }

  migrateHost() {
    // Prefer a localhost player, then whoever has been seated longest.
    const next = this.connectedPlayers().sort((a, b) => b.isLocal - a.isLocal || a.joinOrder - b.joinOrder)[0];
    const previous = this.hostId;
    this.hostId = next ? next.id : null;
    if (next && next.id !== previous) this.notifyAll(`${next.name} is now the host.`);
  }

  removePlayer(playerId, reason = 'left') {
    const p = this.players.get(playerId);
    if (!p) return;
    clearTimeout(p.graceTimer);

    // Live bets go back into the balance while betting is open; once the
    // wheel is spinning they are forfeited.
    let refund = 0;
    for (const [key, spot] of this.bets) {
      const amount = spot.get(playerId);
      if (!amount) continue;
      if (this.phase === PHASE.BETTING_OPEN) refund += amount;
      spot.delete(playerId);
      if (spot.size === 0) this.bets.delete(key);
    }

    // Remember this network so a quick rejoin needs the host's approval and
    // can't be used to reset a bankroll.
    if (!p.isLocal && p.ip) {
      const previous = this.recentRecord(p.ip);
      const names = [...new Set([...(previous ? previous.names : []), p.name])];
      this.ipHistory.set(p.ip, {
        ip: p.ip,
        names,
        removedAt: Date.now(),
        bankroll: p.currentChips + refund,
        confiscated: p.confiscated,
        reason,
      });
    }

    this.betLog.delete(playerId);
    this.lastRoundBets.delete(playerId);
    this.tokenIndex.delete(p.token);
    this.players.delete(playerId);
    this.clearVote(playerId);
    for (const vote of this.kickVotes.values()) vote.voters.delete(playerId);
    if (this.hostId === playerId) this.migrateHost();

    if (this.connectedPlayers().length === 0) {
      this.resetTable();
      return;
    }
    const text = (REMOVAL_TEXT[reason] || REMOVAL_TEXT.left)(p.name);
    this.notifyAll(text, reason === 'left' || reason === 'timeout' ? 'info' : 'error');
    this.logAdmin(text, reason);
    this.evaluateVotes();
    this.broadcast();
    this.checkAllReady();
  }

  resetTable() {
    this.clearSchedule();
    for (const p of this.players.values()) clearTimeout(p.graceTimer);
    for (const vote of this.kickVotes.values()) clearTimeout(vote.timer);
    // Anyone waiting for approval can simply join the fresh table.
    for (const r of this.pending.values()) {
      this.io.to(r.socketId).emit('join:retry', { message: 'The table was reset — you can join now.' });
    }
    this.players.clear();
    this.tokenIndex.clear();
    this.pending.clear();
    this.ipHistory.clear();
    this.kickVotes.clear();
    this.adminLog = [];
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
      for (const player of this.players.values()) {
        player.currentChips = CONFIG.startingChips;
        player.confiscated = 0;
      }
      this.lastRoundBets.clear();
      this.history = [];
      this.gameOver = false;
    }
    for (const player of this.players.values()) {
      player.strikes = 0;
      player.missStreak = 0;
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

  /* -------------------- localhost-host (admin) powers ----------------- */

  requireAdmin(p) {
    return this.isAdmin(p) ? null : fail('Only the host playing on localhost can do that.', 'NOT_ADMIN');
  }

  kickByAdmin(p, payload) {
    const denied = this.requireAdmin(p);
    if (denied) return denied;
    const target = this.players.get(payload?.targetId);
    if (!target) return fail('That player is no longer at the table.');
    if (target.id === p.id) return fail("You can't remove yourself — use Leave instead.");
    this.kick(target, 'kicked');
    return ok();
  }

  kick(target, reason) {
    const socket = this.socketOf(target);
    if (socket) {
      socket.emit('kicked', {
        message: reason === 'votekick' ? 'The other players voted you off the table.' : 'The host removed you from the table.',
      });
      socket.data.playerId = null;
    }
    this.removePlayer(target.id, reason);
  }

  resolveRequest(p, payload) {
    const denied = this.requireAdmin(p);
    if (denied) return denied;
    const req = this.pending.get(payload?.requestId);
    if (!req) return fail('That request is no longer pending.');
    this.pending.delete(req.id);
    const socket = this.io.sockets.sockets.get(req.socketId);
    if (!socket || socket.data.playerId) {
      this.syncAdmin();
      return fail(`${req.name} is no longer waiting.`);
    }
    if (!payload.allow) {
      socket.emit('join:denied', { message: 'The host declined your request to rejoin.' });
      this.logAdmin(`Declined ${req.name}.`, 'deny');
      this.syncAdmin();
      return ok();
    }
    const result = this.seatPlayer(socket, { name: req.name, chips: req.bankroll, confiscated: req.confiscated });
    if (!result.ok) {
      socket.emit('join:denied', { message: result.error });
      this.syncAdmin();
      return result;
    }
    this.ipHistory.delete(req.ip);
    this.logAdmin(`Let ${req.name} back in with ${money(req.bankroll)}.`, 'allow');
    socket.emit('join:approved', { playerId: result.playerId, token: result.token });
    this.syncAdmin();
    return ok();
  }

  restoreChips(p, payload) {
    const denied = this.requireAdmin(p);
    if (denied) return denied;
    const target = this.players.get(payload?.targetId);
    if (!target) return fail('That player is no longer at the table.');
    if (!target.confiscated) return fail(`${target.name} has no frozen chips.`);
    const amount = target.confiscated;
    target.currentChips += amount;
    target.confiscated = 0;
    target.strikes = 0;
    target.missStreak = 0;
    this.notifyAll(`The host restored ${money(amount)} to ${target.name}.`, 'success');
    this.logAdmin(`Restored ${money(amount)} to ${target.name}.`, 'restore');
    this.broadcast();
    return ok();
  }

  restartGame(p) {
    const denied = this.requireAdmin(p);
    if (denied) return denied;
    this.clearSchedule();
    for (const vote of this.kickVotes.values()) clearTimeout(vote.timer);
    this.kickVotes.clear();
    this.bets.clear();
    this.betLog.clear();
    this.lastRoundBets.clear();
    for (const player of this.players.values()) {
      player.currentChips = CONFIG.startingChips;
      player.confiscated = 0;
      player.strikes = 0;
      player.missStreak = 0;
      player.ready = false;
    }
    this.round = 0;
    this.history = [];
    this.spin = null;
    this.lastResult = null;
    this.gameOver = false;
    this.phase = PHASE.WAITING_FOR_HOST;
    this.notice = `The host restarted the game — everyone is back to ${money(CONFIG.startingChips)}.`;
    this.notifyAll(this.notice, 'success');
    this.logAdmin('Restarted the game.', 'restart');
    this.broadcast();
    return ok();
  }

  /* ----------------------------- vote kick ---------------------------- */

  votersFor(target) {
    return this.connectedPlayers().filter((p) => p.id !== target.id);
  }

  /** More than half of the other players, and never fewer than two votes. */
  requiredVotes(target) {
    return Math.max(2, Math.floor(this.votersFor(target).length / 2) + 1);
  }

  voteKick(voter, payload) {
    const target = this.players.get(payload?.targetId);
    if (!target || !target.connected) return fail('That player is not at the table.');
    if (target.id === voter.id) return fail("You can't vote to kick yourself.");
    if (this.isAdmin(target)) return fail("The host on localhost can't be vote-kicked.");
    if (this.votersFor(target).length < 2) return fail('Vote-kick needs at least 3 players at the table.');

    let vote = this.kickVotes.get(target.id);
    if (!vote) {
      vote = {
        voters: new Set(),
        startedAt: Date.now(),
        timer: setTimeout(() => {
          if (!this.kickVotes.has(target.id)) return;
          this.clearVote(target.id);
          this.notifyAll(`The vote to kick ${target.name} failed.`);
          this.broadcast();
        }, CONFIG.voteKickMs),
      };
      this.kickVotes.set(target.id, vote);
      this.notifyAll(`${voter.name} started a vote to kick ${target.name}.`, 'error');
    }
    if (vote.voters.has(voter.id)) vote.voters.delete(voter.id);
    else vote.voters.add(voter.id);
    if (vote.voters.size === 0) this.clearVote(target.id);

    this.evaluateVotes();
    this.broadcast();
    return ok();
  }

  clearVote(targetId) {
    const vote = this.kickVotes.get(targetId);
    if (!vote) return;
    clearTimeout(vote.timer);
    this.kickVotes.delete(targetId);
  }

  evaluateVotes() {
    for (const [targetId, vote] of [...this.kickVotes]) {
      const target = this.players.get(targetId);
      for (const id of vote.voters) if (!this.players.get(id)?.connected) vote.voters.delete(id);
      if (!target || vote.voters.size === 0) {
        this.clearVote(targetId);
        continue;
      }
      if (vote.voters.size >= this.requiredVotes(target)) {
        this.clearVote(targetId);
        this.kick(target, 'votekick');
      }
    }
  }

  /* ----------------------------- betting ----------------------------- */

  /** Minimum total stake this round: $5, or everything a short-stacked player has. */
  requiredBetFor(p) {
    return Math.min(CONFIG.minTotalBet, Math.max(0, p.roundStartChips || 0));
  }

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
    if (p.currentChips < amount) return fail(`Not enough chips — you have ${money(p.currentChips)} left.`);

    const spot = this.bets.get(key) || new Map();
    const existing = spot.get(p.id) || 0;
    if (existing + amount > CONFIG.maxBetPerSpot) return fail(`Table limit is ${money(CONFIG.maxBetPerSpot)} per spot.`);

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

  /** Refund every chip a player has on the table. Returns the amount refunded. */
  refundAll(p) {
    let refund = 0;
    for (const [key, spot] of this.bets) {
      const amount = spot.get(p.id);
      if (!amount) continue;
      refund += amount;
      spot.delete(p.id);
      if (spot.size === 0) this.bets.delete(key);
    }
    p.currentChips += refund;
    this.betLog.set(p.id, []);
    return refund;
  }

  clearBets(p) {
    const blocked = this.ensureCanBet(p);
    if (blocked) return fail(blocked);
    if (!this.refundAll(p)) return fail('You have no bets on the table.');
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
    if (total > p.currentChips) return fail(`Rebet needs ${money(total)}, but you only have ${money(p.currentChips)}.`);
    for (const { key, amount } of previous) {
      const existing = this.bets.get(key)?.get(p.id) || 0;
      if (existing + amount > CONFIG.maxBetPerSpot) return fail(`Rebet would exceed the ${money(CONFIG.maxBetPerSpot)} spot limit.`);
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

  /** Players with no money (and nothing on the table) are never waited for. */
  checkAllReady() {
    if (this.phase !== PHASE.BETTING_OPEN) return;
    const eligible = this.connectedPlayers().filter((p) => p.currentChips > 0 || this.totalBetOf(p.id) > 0);
    if (eligible.length > 0 && eligible.every((p) => p.ready)) {
      this.notifyAll('All players locked in — no more bets!');
      this.closeBetting();
    }
  }

  /**
   * Applied when betting closes. A stake below the minimum is refunded and
   * doesn't count; it also earns a strike. Too many strikes in a match, or
   * too many in a row, freezes the player's bankroll until the host restores it.
   */
  enforceMinimumBets() {
    for (const p of this.players.values()) {
      const required = this.requiredBetFor(p);
      if (required <= 0) continue; // broke or frozen: sitting out is fine
      const total = this.totalBetOf(p.id);
      const exempt = !p.connected || p.exemptRound === this.round;
      if (total >= required) {
        if (!exempt) p.missStreak = 0;
        continue;
      }
      if (total > 0) this.refundAll(p);
      if (exempt) {
        if (total > 0) this.tell(p, `Your ${money(total)} was below the ${money(required)} minimum and was returned.`);
        continue;
      }
      p.strikes += 1;
      p.missStreak += 1;
      const why = total > 0 ? `Your ${money(total)} was below the ${money(required)} minimum and didn't count` : `You didn't bet the ${money(required)} minimum`;
      if (p.strikes >= CONFIG.strikeLimit || p.missStreak >= CONFIG.strikeStreakLimit) {
        p.confiscated += p.currentChips;
        p.currentChips = 0;
        p.missStreak = 0;
        this.notifyAll(`${p.name} kept skipping the ${money(CONFIG.minTotalBet)} minimum — their ${money(p.confiscated)} is frozen until the host restores it.`, 'error');
        this.logAdmin(`Froze ${money(p.confiscated)} from ${p.name} (missed the minimum).`, 'freeze');
      } else {
        this.tell(
          p,
          `${why}. Strike ${p.strikes}/${CONFIG.strikeLimit} (${p.missStreak}/${CONFIG.strikeStreakLimit} in a row) — at the limit your chips get frozen.`,
          'error',
        );
      }
    }
  }

  /* --------------------------- round flow ---------------------------- */

  openBetting() {
    this.bets.clear();
    this.betLog.clear();
    this.spin = null;
    this.lastResult = null;
    this.notice = null;
    for (const p of this.players.values()) {
      p.ready = false;
      p.roundStartChips = p.currentChips;
    }
    this.round += 1;
    this.phase = PHASE.BETTING_OPEN;
    this.schedule(CONFIG.bettingMs, () => this.closeBetting());
    this.broadcast();
  }

  closeBetting() {
    if (this.phase !== PHASE.BETTING_OPEN) return;
    this.enforceMinimumBets();
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
  minTotalBet: CONFIG.minTotalBet,
  strikeLimit: CONFIG.strikeLimit,
  strikeStreakLimit: CONFIG.strikeStreakLimit,
  reconnectGraceMs: CONFIG.reconnectGraceMs,
  ipLockMs: CONFIG.ipLockMs,
  voteKickMs: CONFIG.voteKickMs,
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
  Object.assign(socket.data, networkOf(socket));
  socket.emit('welcome', {
    config: PUBLIC_CONFIG,
    wheelOrder: WHEEL_ORDER,
    legalBets: [...LEGAL_BETS.values()],
    isLocal: socket.data.isLocal,
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
  action('player:leave', (p) => table.leave(p, socket));
  action('vote:kick', (p, data) => table.voteKick(p, data));
  // Localhost-host only (enforced inside each method).
  action('admin:kick', (p, data) => table.kickByAdmin(p, data));
  action('admin:resolve', (p, data) => table.resolveRequest(p, data));
  action('admin:restore', (p, data) => table.restoreChips(p, data));
  action('admin:restart', (p) => table.restartGame(p));

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
