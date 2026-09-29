/**
 * heist.js — rules for the "Heist" mode (cops & robbers), mixed into the
 * Game class (see the Object.assign at the bottom of game.js). Every
 * function runs with `this` = the Game instance.
 *
 * Team roles are reused: role 'seeker' = COPS, role 'hider' = ROBBERS, so
 * the lobby team toggle, curveballs (sound rings robber phones) and the
 * boundary machinery keep working unchanged. Phases are reused too:
 * `hide` = scatter (robbers disperse, cops frozen), `seek` = the heist.
 *
 * Robbers are tracked PER PLAYER (not per team like hide & seek):
 *   free → (caught) → jailed → (jailSeconds inside prison) → immune → free
 *
 * Tasks: the host places stations; only `activeStations` of them are live
 * at once. Finishing one retires it and lights up a random different one.
 * Station positions are robbers + referee only — cops never get them.
 *
 * GPS is ~5–15m fuzzy, so presence checks are generous: start within the
 * station radius, finish within radius + FINISH_SLACK_M (hysteresis).
 */

import { haversine } from './geo.js';

export const TASK_GAMES = ['wires', 'swipe', 'keypad', 'download', 'simon', 'dial'];

export const HEIST_SETTINGS = {
  targetScore: 100, // robbers' shared pool needed to win
  activeStations: 3, // live stations at once (rotating)
  stationRadiusM: 20, // must be this close to start a task
  prisonRadiusM: 25, // prison zone radius
  jailSeconds: 30, // time a caught robber must spend inside the prison
  immunitySeconds: 60, // post-release protection
};

const FRESH_POS_MS = 15_000; // presence checks ignore older fixes
const MAX_ACCURACY_M = 35; // worse than this = "step into the open"
const FINISH_SLACK_M = 15; // hysteresis: finish may drift a bit past start radius
const TASK_TIMEOUT_MS = 90_000; // abandoned task releases the station lock
const MIN_TASK_MS = { download: 10_000, default: 3_000 }; // no insta-finishes
const MAX_JAIL_STEP_MS = 5_000; // cap one tick's jail credit (server hiccups)

let nextStationNum = 1;

export function freshHeistState() {
  return {
    stations: new Map(), // stationId → station
    prison: null, // { lat, lng }
    score: 0,
    winner: null, // 'robbers' | 'cops' once over
    roundLive: false, // stations lit + statuses in play (hide/seek/over)
    lastTickAt: null,
  };
}

export const heistMethods = {
  isHeist() {
    return this.mode === 'heist';
  },

  setMode(mode) {
    if (this.phase !== 'lobby' || (mode !== 'hideseek' && mode !== 'heist')) return;
    this.mode = mode;
    this.logEvent('config', `mode → ${mode}`);
  },

  // ── Lobby setup ──────────────────────────────────────────────────────

  addStation({ lat, lng, points, game } = {}) {
    if (this.phase !== 'lobby' || !Number.isFinite(+lat) || !Number.isFinite(+lng)) return null;
    const n = nextStationNum++;
    const station = {
      id: `s${n}`,
      name: `Station ${this.heist.stations.size + 1}`,
      lat: +lat,
      lng: +lng,
      points: Number.isFinite(+points) && +points > 0 ? Math.round(+points) : 10,
      game: TASK_GAMES.includes(game) ? game : 'random',
      active: false,
      lockedBy: null, // playerId currently running it
      doneCount: 0,
    };
    this.heist.stations.set(station.id, station);
    this.logEvent('config', `${station.name} placed (${station.points} pts)`);
    return station;
  },

  updateStation(stationId, { name, points, game } = {}) {
    const s = this.heist.stations.get(stationId);
    if (!s || this.phase !== 'lobby') return null;
    if (name) s.name = String(name).slice(0, 24);
    if (Number.isFinite(+points) && +points > 0) s.points = Math.round(+points);
    if (game && (game === 'random' || TASK_GAMES.includes(game))) s.game = game;
    return s;
  },

  removeStation(stationId) {
    if (this.phase !== 'lobby') return false;
    return this.heist.stations.delete(stationId);
  },

  setPrison({ lat, lng } = {}) {
    if (this.phase !== 'lobby' || !Number.isFinite(+lat) || !Number.isFinite(+lng)) return;
    this.heist.prison = { lat: +lat, lng: +lng };
    this.logEvent('config', 'prison placed');
  },

  // ── Round lifecycle ──────────────────────────────────────────────────

  /** Fresh round: statuses cleared, score 0, a random set of stations live. */
  startHeistRound() {
    this.heist.score = 0;
    this.heist.winner = null;
    this.heist.lastTickAt = Date.now();
    for (const p of this.players.values()) resetRobber(p);
    for (const s of this.heist.stations.values()) {
      s.active = false;
      s.lockedBy = null;
      s.doneCount = 0;
    }
    const pool = shuffle([...this.heist.stations.values()]);
    for (const s of pool.slice(0, this.settings.activeStations)) s.active = true;
    this.heist.roundLive = true;
  },

  /** Back to lobby: everything goes dark, stations stay placed. */
  endHeistRound() {
    this.heist.roundLive = false;
    this.heist.winner = null;
    this.heist.score = 0;
    for (const p of this.players.values()) resetRobber(p);
    for (const s of this.heist.stations.values()) {
      s.active = false;
      s.lockedBy = null;
    }
  },

  isRobber(player) {
    return !!player && this.teams.get(player.teamId)?.role === 'hider';
  },

  // ── Catching & prison ────────────────────────────────────────────────

  /**
   * Honor system: the caught robber taps "I'm caught" (or the referee
   * marks them). Immune / already-jailed robbers can't be caught.
   */
  catchRobber(playerId, byPlayerId = null) {
    if (this.phase !== 'seek') return null;
    const p = this.players.get(playerId);
    if (!this.isRobber(p) || p.robber.status !== 'free') return null;
    this.cancelTask(p.id, 'caught');
    p.robber.status = 'jailed';
    p.robber.jailServedMs = 0;
    p.robber.timesCaught++;
    const by = byPlayerId && byPlayerId !== playerId
      ? `referee (${this.players.get(byPlayerId)?.name})`
      : 'self';
    this.logEvent('tag', `${p.name} caught [${by}] → go to prison`);
    this.emit('heist:caught', { playerId: p.id, name: p.name });
    this.broadcastState();
    return p;
  },

  /** Referee override: release a jailed robber straight into immunity. */
  releaseRobber(playerId, reason = 'referee', now = Date.now()) {
    const p = this.players.get(playerId);
    if (!this.isRobber(p) || p.robber.status !== 'jailed') return null;
    p.robber.status = 'immune';
    p.robber.immuneUntil = now + this.settings.immunitySeconds * 1000;
    this.logEvent('tag', `${p.name} released [${reason}] — immune ${this.settings.immunitySeconds}s`);
    this.emit('heist:released', { playerId: p.id }, { room: p.id });
    this.broadcastState();
    return p;
  },

  // ── Tasks ────────────────────────────────────────────────────────────

  /**
   * Robber wants to start a task. Returns { ok, game } or { error }.
   * Server-side presence check against the latest fresh GPS fix.
   */
  startTask(playerId, stationId) {
    if (!this.isHeist() || this.phase !== 'seek') return { error: 'The heist has not started' };
    const p = this.players.get(playerId);
    if (!this.isRobber(p)) return { error: 'Only robbers do tasks' };
    if (p.robber.status === 'jailed') return { error: 'You are jailed — get to the prison' };
    const s = this.heist.stations.get(stationId);
    if (!s || !s.active) return { error: 'That station is not active' };
    if (s.lockedBy && s.lockedBy !== p.id) return { error: 'Another robber is working this one' };
    const check = this.presence(p, s, this.settings.stationRadiusM);
    if (check.error) return check;
    if (p.robber.task) this.cancelTask(p.id, 'switched');
    const game = s.game === 'random' ? TASK_GAMES[Math.floor(Math.random() * TASK_GAMES.length)] : s.game;
    s.lockedBy = p.id;
    p.robber.task = { stationId: s.id, game, startedAt: Date.now() };
    this.logEvent('task', `${p.name} started ${s.name} (${game})`);
    this.broadcastState();
    return { ok: true, game };
  },

  completeTask(playerId, stationId) {
    if (!this.isHeist() || this.phase !== 'seek') return { error: 'The heist is not running' };
    const p = this.players.get(playerId);
    const task = p?.robber?.task;
    if (!task || task.stationId !== stationId) return { error: 'No task in progress there' };
    if (p.robber.status === 'jailed') return { error: 'You are jailed' };
    const s = this.heist.stations.get(stationId);
    if (!s || !s.active) {
      this.cancelTask(p.id, 'station gone');
      return { error: 'That station went dark' };
    }
    const minMs = MIN_TASK_MS[task.game] ?? MIN_TASK_MS.default;
    if (Date.now() - task.startedAt < minMs) return { error: 'Too fast — finish the task properly' };
    const check = this.presence(p, s, this.settings.stationRadiusM + FINISH_SLACK_M);
    if (check.error) return check;

    p.robber.task = null;
    s.lockedBy = null;
    this.creditStation(s, p);
    return { ok: true, points: s.points, score: this.heist.score };
  },

  cancelTask(playerId, reason = 'cancelled') {
    const p = this.players.get(playerId);
    const task = p?.robber?.task;
    if (!task) return;
    const s = this.heist.stations.get(task.stationId);
    if (s?.lockedBy === p.id) s.lockedBy = null;
    p.robber.task = null;
    this.logEvent('task', `${p.name} left ${s?.name ?? 'task'} (${reason})`);
  },

  /**
   * Score a station and rotate it out. Shared by real completions and the
   * referee "credit" override (`player` may be null for the latter).
   */
  creditStation(station, player = null) {
    this.heist.score += station.points;
    station.doneCount++;
    if (player) player.robber.points += station.points;
    this.logEvent(
      'score',
      `${player?.name ?? 'referee'} cracked ${station.name} +${station.points} → ` +
        `${this.heist.score}/${this.settings.targetScore}`,
    );
    this.rotateStation(station);
    this.emit('heist:score', {
      name: player?.name ?? null,
      points: station.points,
      score: this.heist.score,
    });
    this.checkHeistWin();
    this.broadcastState();
  },

  /** Retire a finished station and light up a random different one. */
  rotateStation(done) {
    const candidates = [...this.heist.stations.values()].filter((s) => !s.active && s !== done);
    if (!candidates.length) return; // not enough stations to rotate — it stays live
    done.active = false;
    if (done.lockedBy) this.cancelTask(done.lockedBy, 'station rotated');
    const next = candidates[Math.floor(Math.random() * candidates.length)];
    next.active = true;
  },

  /** Referee override: change the pool directly (+/−). */
  adjustScore(delta) {
    if (!this.isHeist() || this.phase !== 'seek' || !Number.isFinite(+delta)) return;
    this.heist.score = Math.max(0, this.heist.score + Math.round(+delta));
    this.logEvent('score', `referee adjusted score ${delta > 0 ? '+' : ''}${delta} → ${this.heist.score}`);
    this.checkHeistWin();
    this.broadcastState();
  },

  /** Presence check: fresh, accurate-enough fix within `radiusM` of `pt`. */
  presence(player, pt, radiusM) {
    const pos = player.pos;
    if (!pos || Date.now() - pos.at > FRESH_POS_MS) return { error: 'No recent GPS fix — hold still a moment' };
    if (pos.accuracy != null && pos.accuracy > MAX_ACCURACY_M) {
      return { error: `Weak GPS (±${Math.round(pos.accuracy)}m) — step into the open` };
    }
    const d = haversine(pos, pt);
    if (d > radiusM) return { error: `Too far — ${Math.round(d)}m away (need ${Math.round(radiusM)}m)` };
    return { ok: true, distanceM: d };
  },

  // ── Win ──────────────────────────────────────────────────────────────

  checkHeistWin() {
    if (this.phase !== 'seek' || this.heist.score < this.settings.targetScore) return;
    this.endHeist('robbers', 'score');
  },

  endHeist(winner, reason) {
    this.heist.winner = winner;
    this.phase = 'over';
    this.phaseEndsAt = null;
    this.activeEvent = null;
    for (const p of this.players.values()) if (p.robber?.task) this.cancelTask(p.id, 'game over');
    this.logEvent(
      'over',
      `GAME OVER — ${winner.toUpperCase()} win (${reason}), score ${this.heist.score}/${this.settings.targetScore}`,
    );
    this.emit('game:over', {
      winner,
      winnerTeamName: winner === 'robbers' ? 'Robbers' : 'Cops',
      reason,
    });
    this.broadcastState();
  },

  // ── Tick (seek phase) ────────────────────────────────────────────────

  heistTick(now) {
    const dt = Math.min(MAX_JAIL_STEP_MS, Math.max(0, now - (this.heist.lastTickAt ?? now)));
    this.heist.lastTickAt = now;
    if (this.phase !== 'seek') return;
    let changed = false;
    for (const p of this.players.values()) {
      if (!this.isRobber(p)) continue;
      const r = p.robber;
      if (r.status === 'jailed') {
        // Time only counts while a fresh fix puts them INSIDE the prison —
        // paused (not reset) when GPS blips out.
        const prison = this.heist.prison;
        const inside =
          prison &&
          p.pos &&
          now - p.pos.at <= FRESH_POS_MS &&
          haversine(p.pos, prison) <= this.settings.prisonRadiusM + this.settings.boundaryMarginM;
        if (inside) {
          r.jailServedMs += dt;
          changed = true;
          if (r.jailServedMs >= this.settings.jailSeconds * 1000) this.releaseRobber(p.id, 'served', now);
        }
      } else if (r.status === 'immune' && now >= r.immuneUntil) {
        r.status = 'free';
        r.immuneUntil = null;
        this.logEvent('tag', `${p.name} immunity over`);
        changed = true;
      }
      if (r.task && now - r.task.startedAt > TASK_TIMEOUT_MS) {
        this.cancelTask(p.id, 'timed out');
        changed = true;
      }
    }
    return changed;
  },

  /** index.js: broadcast every tick while someone's serving time. */
  hasJailed() {
    return this.isHeist() && [...this.players.values()].some((p) => p.robber?.status === 'jailed');
  },

  // ── Serialization ────────────────────────────────────────────────────

  /** Public robber roster: status is public (cops must know who's immune). */
  robberRoster() {
    return [...this.players.values()]
      .filter((p) => this.isRobber(p))
      .map((p) => ({
        id: p.id,
        name: p.name,
        status: p.robber.status,
        jailServedMs: p.robber.jailServedMs,
        immuneUntil: p.robber.immuneUntil,
        points: p.robber.points,
        timesCaught: p.robber.timesCaught,
      }));
  },

  stationPayload(s, viewerId = null) {
    return {
      id: s.id,
      name: s.name,
      lat: s.lat,
      lng: s.lng,
      points: s.points,
      active: s.active,
      busy: !!s.lockedBy && s.lockedBy !== viewerId,
    };
  },

  /**
   * Heist block for a player's state. PRIVACY: stations only for robbers
   * (and only the ACTIVE ones — no pre-scouting); cops get prison + score.
   */
  heistPlayerPayload(player) {
    if (!this.isHeist()) return null;
    const robber = this.isRobber(player);
    return {
      score: this.heist.score,
      winner: this.heist.winner,
      prison: this.heist.prison,
      robbers: this.robberRoster(),
      ...(robber && (this.phase === 'hide' || this.phase === 'seek')
        ? {
            stations: [...this.heist.stations.values()]
              .filter((s) => s.active)
              .map((s) => this.stationPayload(s, player.id)),
          }
        : {}),
      ...(robber ? { me: { ...player.robber } } : {}),
    };
  },

  /** Referee: every station, active or not, plus who's working it. */
  heistRefereePayload() {
    if (!this.isHeist()) return null;
    return {
      score: this.heist.score,
      winner: this.heist.winner,
      prison: this.heist.prison,
      robbers: this.robberRoster(),
      stations: [...this.heist.stations.values()].map((s) => ({
        ...this.stationPayload(s),
        game: s.game,
        doneCount: s.doneCount,
        lockedByName: s.lockedBy ? this.players.get(s.lockedBy)?.name ?? null : null,
      })),
    };
  },
};

export function resetRobber(p) {
  p.robber = {
    status: 'free', // 'free' | 'jailed' | 'immune'
    jailServedMs: 0,
    immuneUntil: null,
    task: null, // { stationId, game, startedAt }
    points: 0,
    timesCaught: 0,
  };
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
