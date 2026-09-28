/**
 * game.js — authoritative in-memory game state + state machine.
 *
 * One game per server process (one-night ephemeral game, per CLAUDE.md —
 * no database). The Game class is transport-agnostic: it mutates state and
 * returns/emits domain events through an `emit(event, payload, scope)`
 * callback that server/index.js maps onto Socket.IO rooms.
 *
 * Phases: lobby → hide → seek → over  (host can reset back to lobby)
 */

import { haversine, centroid, insideBoundary, distanceOutside } from './geo.js';
import { heistMethods, freshHeistState, resetRobber, HEIST_SETTINGS } from './heist.js';

export const PHASES = ['lobby', 'hide', 'seek', 'over'];
export const EVENT_TYPES = ['sound', 'torch', 'shrink', 'reveal'];

const DEFAULT_SETTINGS = {
  hideSeconds: 180, // hiders get 3 min to hide
  seekSeconds: 1200, // 20 min round cap
  shrinkFactor: 0.6, // boundary radius multiplier per shrink event
  eventSeconds: 15, // how long sound/torch events stay active
  revealSeconds: 20, // how long the all-positions reveal lasts
  boundaryMarginM: 10, // GPS-noise margin added to the radius
  autoEvents: 0, // 1 = referee panel fires random curveballs on a timer
  autoEventIntervalSeconds: 90, // gap between auto-fired curveballs
  maxTeamSize: 0, // players per team; 0 = unlimited (host sets in the lobby)
  ...HEIST_SETTINGS, // heist-mode knobs (server/heist.js); ignored in hide & seek
};

let nextId = 1;
const genId = (prefix) => `${prefix}${nextId++}`;

export class Game {
  /**
   * @param {(event: string, payload: any, scope?: {room?: string}) => void} emit
   *   Transport hook. `scope.room` targets a Socket.IO room (team id,
   *   'referees', or a player id); omitted = broadcast to everyone.
   */
  constructor(emit = () => {}) {
    this.emit = emit;
    // Ring buffer of game events. Lives OUTSIDE reset() on purpose — it
    // must survive "back to lobby" so premature endings stay debuggable.
    this.log = [];
    this.reset();
  }

  /** Append to the game log (referee panel + server console). */
  logEvent(type, msg) {
    this.log.push({ at: Date.now(), type, msg });
    if (this.log.length > 200) this.log.shift();
    console.log(`[game] ${new Date().toISOString()} ${type}: ${msg}`);
  }

  reset() {
    this.mode = 'hideseek'; // 'hideseek' | 'heist' (cops & robbers, server/heist.js)
    this.heist = freshHeistState();
    this.phase = 'lobby';
    this.phaseEndsAt = null;
    this.boundary = null; // { center: {lat,lng}, radiusM }
    this.settings = { ...DEFAULT_SETTINGS };
    this.players = new Map(); // playerId → player
    this.teams = new Map(); // teamId → team
    this.activeEvent = null; // { type, endsAt }
    this.nextAutoEventAt = null; // when autoEvents is on: next curveball timestamp
    this.winnerTeamId = null;
    this.startedAt = null;
    this.seekStartedAt = null;
    this.initialHiderTeams = 0;
  }

  // ── Lobby ────────────────────────────────────────────────────────────

  /** Add (or re-add) a player. Returns the player record. */
  addPlayer({ playerId, name, teamName, isHost }) {
    let player = playerId ? this.players.get(playerId) : null;
    if (!player) {
      player = {
        id: playerId || genId('p'),
        name: String(name || 'Player').slice(0, 24),
        teamId: null,
        isHost: false,
        ready: false,
        connected: true,
        lastSeenAt: Date.now(),
        pos: null, // { lat, lng, at }
        outsideSince: null, // timestamp when their team left the boundary
      };
      resetRobber(player); // heist-mode status block (unused in hide & seek)
      this.players.set(player.id, player);
    }
    player.connected = true;
    player.lastSeenAt = Date.now();
    if (name) player.name = String(name).slice(0, 24);
    // Host is decided by credentials (checked in index.js), never by join order.
    player.isHost = !!isHost;
    // Mid-game, a typed team name only attaches to a team that already
    // exists (no spinning up a fresh hider/seeker team once boundary/roles
    // are locked in) — see joinTeam. Leaves teamId null otherwise so the
    // client falls back to the team-picker screen (App.jsx Router).
    if (teamName) this.joinTeam(player.id, teamName);
    this.logEvent(
      'join',
      `${player.name}${player.isHost ? ' (HOST)' : ''} joined` +
        (player.teamId
          ? ` team ${this.teams.get(player.teamId)?.name}`
          : this.phase !== 'lobby'
            ? ' — no team yet, picking'
            : ''),
    );
    return player;
  }

  /**
   * Move a player into a team, creating it on demand — LOBBY ONLY. Mid-game,
   * only an existing team name matches (returns null otherwise); creating
   * fresh hider/seeker teams once the round is live would mangle role and
   * win-condition bookkeeping. Mid-game team selection goes through this
   * same existing-team path, driven by the client's team-picker screen.
   */
  joinTeam(playerId, teamName) {
    const player = this.players.get(playerId);
    if (!player) return null;
    const cleanName = String(teamName || 'Team').slice(0, 24);
    let team = [...this.teams.values()].find(
      (t) => t.name.toLowerCase() === cleanName.toLowerCase(),
    );
    if (!team) {
      if (this.phase !== 'lobby') return null;
      team = this.makeTeam(cleanName);
    }
    if (team.id !== player.teamId && this.isTeamFull(team.id)) return null;
    const oldTeamId = player.teamId;
    player.teamId = team.id;
    if (oldTeamId && oldTeamId !== team.id) this.pruneEmptyTeams();
    return team;
  }

  /** True when the host's per-team cap (settings.maxTeamSize, 0 = off) is reached. */
  isTeamFull(teamId) {
    const max = this.settings.maxTeamSize;
    if (!(max > 0)) return false;
    return this.teamSize(teamId) >= max;
  }

  teamSize(teamId) {
    let n = 0;
    for (const p of this.players.values()) if (p.teamId === teamId && !p.isHost) n++;
    return n;
  }

  /**
   * Player creates a brand-new team and joins it — LOBBY ONLY. Returns
   * `{ team }` or `{ error }` (duplicate name, wrong phase, host).
   */
  createTeam(playerId, teamName) {
    const player = this.players.get(playerId);
    if (!player || player.isHost) return { error: 'Not allowed' };
    if (this.phase !== 'lobby') return { error: 'The round already started' };
    const cleanName = String(teamName ?? '').trim().slice(0, 24);
    if (!cleanName) return { error: 'Give your team a name' };
    if (this.findTeamByName(cleanName)) return { error: `A team named "${cleanName}" already exists` };
    const team = this.makeTeam(cleanName);
    const oldTeamId = player.teamId;
    player.teamId = team.id;
    if (oldTeamId) this.pruneEmptyTeams();
    this.logEvent('team', `${player.name} created team ${team.name}`);
    return { team };
  }

  /** Player picks a team by id (team list tap). Respects the size cap. */
  joinTeamById(playerId, teamId) {
    const player = this.players.get(playerId);
    const team = this.teams.get(teamId);
    if (!player || player.isHost || !team) return { error: 'Team not found' };
    if (player.teamId === team.id) return { team };
    if (this.isTeamFull(team.id)) return { error: `${team.name} is full` };
    const oldTeamId = player.teamId;
    player.teamId = team.id;
    if (oldTeamId) this.pruneEmptyTeams();
    this.logEvent('team', `${player.name} joined team ${team.name}`);
    return { team };
  }

  /**
   * Player leaves their team — LOBBY ONLY (mid-game the roster is locked;
   * a dropped connection never comes through here). Empty team → deleted.
   */
  leaveTeam(playerId) {
    const player = this.players.get(playerId);
    if (!player || !player.teamId || this.phase !== 'lobby') return false;
    player.teamId = null;
    player.ready = false;
    this.pruneEmptyTeams();
    return true;
  }

  /** Host moves a player into a team (or `null` = unassigned). Lobby only. */
  movePlayer(playerId, teamId) {
    const player = this.players.get(playerId);
    if (!player || player.isHost || this.phase !== 'lobby') return { error: 'Not allowed' };
    if (teamId != null) {
      if (!this.teams.has(teamId)) return { error: 'Team not found' };
      if (player.teamId !== teamId && this.isTeamFull(teamId)) {
        return { error: `${this.teams.get(teamId).name} is full` };
      }
    }
    player.teamId = teamId ?? null;
    this.pruneEmptyTeams();
    return {};
  }

  /**
   * Host shuffles every non-host player into teams. Keeps existing teams
   * (names/roles), adds "Team N" ones as needed so the size cap holds, and
   * deals round-robin so sizes differ by at most one. Lobby only.
   */
  randomizeTeams() {
    if (this.phase !== 'lobby') return false;
    const players = [...this.players.values()].filter((p) => !p.isHost);
    if (!players.length) return false;
    for (let i = players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [players[i], players[j]] = [players[j], players[i]];
    }
    const max = this.settings.maxTeamSize;
    let teams = [...this.teams.values()];
    const needed = Math.max(max > 0 ? Math.ceil(players.length / max) : 2, teams.length ? 1 : 0);
    for (let n = 1; teams.length < needed; n++) {
      const name = `Team ${n}`;
      if (!this.findTeamByName(name)) teams.push(this.makeTeam(name));
    }
    players.forEach((p, i) => {
      p.teamId = teams[i % teams.length].id;
    });
    this.pruneEmptyTeams();
    this.logEvent('team', `teams randomized (${players.length} players, ${teams.length} teams)`);
    return true;
  }

  findTeamByName(name) {
    const lower = String(name).toLowerCase();
    return [...this.teams.values()].find((t) => t.name.toLowerCase() === lower);
  }

  makeTeam(name) {
    const team = {
      id: genId('t'),
      name,
      role: 'hider', // 'hider' | 'seeker'
      caughtAt: null, // set when converted during seek phase
      caughtBy: null, // stats label: self / referee (name) / boundary penalty
    };
    this.teams.set(team.id, team);
    return team;
  }

  /** Lobby only: drop teams nobody is on. Mid-game empty shells are kept (harmless). */
  pruneEmptyTeams() {
    if (this.phase !== 'lobby') return;
    for (const t of [...this.teams.values()]) {
      if (![...this.players.values()].some((p) => p.teamId === t.id)) {
        this.teams.delete(t.id);
        this.logEvent('team', `team ${t.name} is empty — deleted`);
      }
    }
  }

  /**
   * Host kicks a player — any phase. Not a ban: the kicked phone can
   * re-join (mid-game it lands back in as a spectator-until-team-pick, see
   * addPlayer). Empty shell teams left behind are harmless — hiderTeams()
   * ignores player-less teams; removing the last hider on a team can end
   * the game, so we re-check the win condition after.
   */
  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player || player.isHost) return null; // hosts can't be kicked
    this.players.delete(playerId);
    this.logEvent(
      'kick',
      `${player.name} removed${this.phase === 'lobby' ? ' from lobby' : ' mid-game'}`,
    );
    if (this.isHeist()) {
      const stationId = player.robber?.task?.stationId;
      const s = stationId && this.heist.stations.get(stationId);
      if (s?.lockedBy === player.id) s.lockedBy = null;
    }
    this.pruneEmptyTeams();
    if (this.phase === 'seek') this.checkWin();
    return player;
  }

  /**
   * Host deletes a whole team (lobby only). Members are removed with it
   * (`kick`, default) or left teamless (`kick: false`). Returns { team, memberIds } or null.
   */
  removeTeam(teamId, { kick = true } = {}) {
    if (this.phase !== 'lobby') return null;
    const team = this.teams.get(teamId);
    if (!team) return null;
    const memberIds = [...this.players.values()]
      .filter((p) => p.teamId === teamId && !p.isHost)
      .map((p) => p.id);
    // kick:false → members just become teamless (they pick another team).
    for (const id of memberIds) {
      if (kick) this.players.delete(id);
      else this.players.get(id).teamId = null;
    }
    this.teams.delete(teamId);
    this.logEvent(
      'team',
      `team ${team.name} deleted (${memberIds.length} member(s) ${kick ? 'kicked' : 'unassigned'})`,
    );
    return { team, memberIds };
  }

  setReady(playerId, ready = true) {
    const player = this.players.get(playerId);
    if (player) player.ready = !!ready;
  }

  /** Host: mark a team as the starting seekers (or back to hiders). Lobby only. */
  setTeamRole(teamId, role) {
    if (this.phase !== 'lobby') return;
    const team = this.teams.get(teamId);
    if (team && (role === 'seeker' || role === 'hider')) {
      team.role = role;
      this.logEvent('team', `team ${team.name} set to ${role}`);
    }
  }

  /** Host: configure boundary and/or timers. Boundary is a circle, always. */
  configure({ boundary, settings, mode }) {
    if (mode) this.setMode(mode);
    if (boundary && boundary.center && boundary.radiusM > 0) {
      this.boundary = {
        center: { lat: +boundary.center.lat, lng: +boundary.center.lng },
        radiusM: Math.max(20, +boundary.radiusM),
      };
      this.logEvent('config', `boundary set: r=${this.boundary.radiusM}m`);
    }
    if (settings) {
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (settings[key] != null && Number.isFinite(+settings[key])) {
          this.settings[key] = +settings[key];
          if (key === 'autoEvents' || key === 'autoEventIntervalSeconds') {
            // Re-arm immediately so toggling mid-round takes effect now,
            // not after whatever countdown happened to be running before.
            this.scheduleNextAutoEvent(
              this.phase === 'hide' || this.phase === 'seek' ? Date.now() : null,
            );
          }
        }
      }
    }
  }

  // ── Phase machine ────────────────────────────────────────────────────

  startPhase(phase) {
    if (!PHASES.includes(phase)) return;
    this.phase = phase;
    this.activeEvent = null;
    if (phase === 'lobby') {
      this.phaseEndsAt = null;
      this.winnerTeamId = null;
      for (const t of this.teams.values()) {
        if (t.caughtAt) {
          t.role = 'hider';
          t.caughtAt = null;
        }
        t.caughtBy = null;
      }
      for (const p of this.players.values()) p.outsideSince = null;
      this.endHeistRound();
    } else if (phase === 'hide') {
      this.startedAt = Date.now();
      if (this.isHeist()) this.startHeistRound();
      this.phaseEndsAt = Date.now() + this.settings.hideSeconds * 1000;
    } else if (phase === 'seek') {
      this.phaseEndsAt = Date.now() + this.settings.seekSeconds * 1000;
      // Snapshot for the win rule: >1 hider team → end at 1 left; exactly
      // one hider team from the start → play until 0.
      this.initialHiderTeams = this.hiderTeams().length;
      this.seekStartedAt = Date.now(); // stats baseline: survival is measured from here
      // Fresh grace clocks: time spent outside during the HIDE phase must
      // not roll into the seek penalty (caused instant premature tags).
      for (const p of this.players.values()) p.outsideSince = null;
      // Host may skip scatter entirely — make sure a round exists.
      if (this.isHeist() && !this.heist.roundLive) this.startHeistRound();
    } else if (phase === 'over') {
      this.phaseEndsAt = null;
    }
    this.scheduleNextAutoEvent(phase === 'hide' || phase === 'seek' ? Date.now() : null);
    this.logEvent(
      'phase',
      `→ ${phase}` +
        (phase === 'seek'
          ? ` (${this.initialHiderTeams} hider team(s), win at ${this.initialHiderTeams > 1 ? 1 : 0} left)`
          : ''),
    );
    this.emit('phase:changed', { phase: this.phase, phaseEndsAt: this.phaseEndsAt });
    this.broadcastState();
  }

  // ── Positions & boundary ─────────────────────────────────────────────

  updatePosition(playerId, { lat, lng, accuracy }) {
    const player = this.players.get(playerId);
    if (!player || !Number.isFinite(+lat) || !Number.isFinite(+lng)) return;
    player.pos = {
      lat: +lat,
      lng: +lng,
      at: Date.now(),
      // Reported GPS error radius (m) — heist presence checks reject bad fixes.
      accuracy: Number.isFinite(+accuracy) && accuracy != null ? +accuracy : null,
    };
    player.lastSeenAt = Date.now();
  }

  setConnected(playerId, connected) {
    const player = this.players.get(playerId);
    if (!player) return;
    player.connected = connected;
    player.lastSeenAt = Date.now();
  }

  /**
   * Team centroid from members with a FRESH position (≤60s old). Stale
   * coords from dropped phones must not drag the centroid out of bounds —
   * that caused phantom boundary tags and premature game endings.
   */
  teamCentroid(teamId, maxAgeMs = 60_000) {
    const cutoff = Date.now() - maxAgeMs;
    const points = [...this.players.values()]
      .filter((p) => p.teamId === teamId && p.pos && p.pos.at >= cutoff)
      .map((p) => p.pos);
    return centroid(points);
  }

  // ── Tagging / conversion ─────────────────────────────────────────────

  /**
   * A hider is caught (seeker tapped "Tag" or hider tapped "I'm caught").
   * Converts the WHOLE team to seekers, then checks the win condition.
   */
  tagPlayer(targetPlayerId, byPlayerId = null, source = null) {
    // Heist: catching jails one robber — no team conversion.
    if (this.isHeist()) return this.catchRobber(targetPlayerId, byPlayerId);
    if (this.phase !== 'seek') return null;
    const target = this.players.get(targetPlayerId);
    if (!target || !target.teamId) return null;
    const team = this.teams.get(target.teamId);
    if (!team || team.role !== 'hider') return null;

    team.role = 'seeker';
    team.caughtAt = Date.now();
    team.caughtBy = null; // set below once the label is computed
    const by =
      source ??
      (byPlayerId === targetPlayerId
        ? 'self'
        : byPlayerId
          ? `referee (${this.players.get(byPlayerId)?.name})`
          : 'unknown');
    team.caughtBy = by;
    const left = this.hiderTeams().length;
    this.logEvent(
      'tag',
      `${target.name} caught [${by}] — team ${team.name} → seekers. ` +
        `Hider teams left: ${left}/${this.initialHiderTeams}`,
    );
    this.emit('team:converted', {
      teamId: team.id,
      teamName: team.name,
      caughtPlayerId: target.id,
      caughtPlayerName: target.name,
      byPlayerId,
    });
    this.checkWin();
    this.broadcastState();
    return team;
  }

  /** Hider teams that actually have players — empty shells don't count. */
  hiderTeams() {
    return [...this.teams.values()].filter(
      (t) =>
        t.role === 'hider' &&
        [...this.players.values()].some((p) => p.teamId === t.id),
    );
  }

  /**
   * Win rule: game ends the moment only ONE hider team remains — they win.
   * Exception: a game that STARTED with a single hider team would end at
   * kickoff under that rule, so it plays until 0 remain (seekers win).
   */
  checkWin() {
    if (this.phase !== 'seek' || this.isHeist()) return; // heist: checkHeistWin
    const hiders = this.hiderTeams();
    const endAt = this.initialHiderTeams > 1 ? 1 : 0;
    if (hiders.length <= endAt) {
      this.winnerTeamId = hiders[0]?.id ?? null; // null = seekers caught everyone
      this.phase = 'over';
      this.phaseEndsAt = null;
      this.logEvent(
        'over',
        `GAME OVER — ${hiders.length} hider team(s) left (end threshold ${endAt}). ` +
          `Winner: ${this.winnerTeamId ? this.teams.get(this.winnerTeamId).name : 'seekers (all caught)'}`,
      );
      this.emit('game:over', {
        winnerTeamId: this.winnerTeamId,
        winnerTeamName: this.winnerTeamId ? this.teams.get(this.winnerTeamId).name : null,
      });
      this.broadcastState();
    }
  }

  // ── Curveballs ───────────────────────────────────────────────────────

  /**
   * Host-triggered event: sound | torch | shrink | reveal.
   * Shrink accepts an amount: `opts.radiusM` (absolute target) beats
   * `opts.factor` (multiplier) beats the default `settings.shrinkFactor`.
   * Always clamped to [20m, current radius] — a "shrink" can never grow
   * the circle (the lobby radius controls handle resizing up).
   */
  trigger(type, opts = {}) {
    if (!EVENT_TYPES.includes(type)) return;
    if (this.phase !== 'seek' && this.phase !== 'hide') return;

    if (type === 'shrink') {
      if (!this.boundary) return;
      const oldR = this.boundary.radiusM;
      let newR;
      if (Number.isFinite(+opts.radiusM) && +opts.radiusM > 0) {
        newR = +opts.radiusM;
      } else {
        const factor =
          Number.isFinite(+opts.factor) && +opts.factor > 0 && +opts.factor < 1
            ? +opts.factor
            : this.settings.shrinkFactor;
        newR = oldR * factor;
      }
      this.boundary.radiusM = Math.min(oldR, Math.max(20, Math.round(newR)));
      this.logEvent('event', `SHRINK: radius ${oldR}m → ${this.boundary.radiusM}m`);
      this.emit('event:shrink', { boundary: this.boundary });
    } else {
      const seconds =
        type === 'reveal' ? this.settings.revealSeconds : this.settings.eventSeconds;
      this.activeEvent = {
        type,
        endsAt: Date.now() + seconds * 1000,
      };
      this.logEvent('event', `${type.toUpperCase()} fired (${seconds}s)`);
      this.emit(`event:${type}`, { endsAt: this.activeEvent.endsAt });
    }
    this.broadcastState();
  }

  /** (Re)arm the auto-curveball clock, or disarm it (pass `null`). */
  scheduleNextAutoEvent(from) {
    this.nextAutoEventAt =
      from && this.settings.autoEvents ? from + this.settings.autoEventIntervalSeconds * 1000 : null;
  }

  /** Fire one random curveball and re-arm the clock for the next one. */
  autoTrigger(now) {
    const type = EVENT_TYPES[Math.floor(Math.random() * EVENT_TYPES.length)];
    this.trigger(type);
    this.scheduleNextAutoEvent(now);
  }

  // ── Server tick (~2s): timers, boundary checks, event expiry ────────

  tick(now = Date.now()) {
    // Expire active event
    if (this.activeEvent && now >= this.activeEvent.endsAt) {
      this.activeEvent = null;
      this.broadcastState();
    }

    // Phase timer expiry
    if (this.phaseEndsAt && now >= this.phaseEndsAt) {
      if (this.phase === 'hide') {
        this.startPhase('seek');
      } else if (this.phase === 'seek' && this.isHeist()) {
        this.endHeist('cops', 'time'); // robbers didn't reach the target in time
      } else if (this.phase === 'seek') {
        // Time ran out: surviving hiders win. Pick the largest surviving team.
        const hiders = this.hiderTeams();
        this.winnerTeamId = hiders[0]?.id ?? null;
        this.phase = 'over';
        this.phaseEndsAt = null;
        this.logEvent(
          'over',
          `GAME OVER — seek timer expired, ${hiders.length} hider team(s) survived. ` +
            `Winner: ${this.winnerTeamId ? this.teams.get(this.winnerTeamId).name : 'seekers'}`,
        );
        this.emit('game:over', {
          winnerTeamId: this.winnerTeamId,
          winnerTeamName: this.winnerTeamId ? this.teams.get(this.winnerTeamId).name : null,
          reason: 'time',
        });
        this.broadcastState();
      }
      return;
    }

    // Auto-curveballs: fire a random event on a timer instead of waiting
    // on the referee. Skipped while one is already active so effects don't
    // stack (shrink is instant and has no activeEvent, so it's exempt).
    if (
      this.nextAutoEventAt &&
      now >= this.nextAutoEventAt &&
      (this.phase === 'hide' || this.phase === 'seek') &&
      !this.activeEvent
    ) {
      this.autoTrigger(now);
    }

    // Heist: prison time, immunity expiry, abandoned-task locks.
    if (this.isHeist() && this.heistTick(now)) this.broadcastState();

    // Boundary enforcement — hide + seek phases, hider teams only.
    // Heist robbers roam individually, so each robber is its own unit
    // (a team centroid of spread-out robbers would be meaningless).
    if ((this.phase === 'hide' || this.phase === 'seek') && this.boundary) {
      const units = this.isHeist()
        ? [...this.players.values()]
            .filter((p) => this.isRobber(p))
            .map((p) => ({ id: p.id, name: p.name, members: [p], room: p.id, label: p.name }))
        : this.hiderTeams().map((t) => ({
            id: t.id,
            name: t.name,
            members: [...this.players.values()].filter((p) => p.teamId === t.id),
            room: t.id,
            label: `team ${t.name}`,
          }));
      for (const unit of units) {
        const c = this.isHeist() ? freshPos(unit.members[0], now) : this.teamCentroid(unit.id);
        if (!c) continue;
        const inside = insideBoundary(c, this.boundary, this.settings.boundaryMarginM);
        const members = unit.members;
        if (inside) {
          if (members.some((m) => m.outsideSince)) {
            this.logEvent('boundary', `${unit.label} back inside — no longer exposed`);
            for (const m of members) m.outsideSince = null;
            this.broadcastState(); // pull their dots off everyone's maps NOW
          }
          continue;
        }
        // NO automatic penalty: GPS is too janky to auto-tag on (removed
        // 2026-07-09). Warnings only — once per excursion (outsideSince
        // dedupes). The referee sees offenders on the map + log and tags
        // manually if a team genuinely camps outside.
        const alreadyWarned = members.some((m) => m.outsideSince);
        if (!alreadyWarned) {
          for (const m of members) m.outsideSince = now;
          this.logEvent(
            'boundary',
            `${unit.label} OUTSIDE (${Math.round(distanceOutside(c, this.boundary))}m past) — warned`,
          );
          this.emit(
            'boundary:warning',
            {
              teamId: unit.id,
              metersOutside: Math.round(distanceOutside(c, this.boundary)),
            },
            { room: unit.room },
          );
          this.emit(
            'boundary:warning',
            { teamId: unit.id, teamName: unit.name },
            { room: 'referees' },
          );
          this.broadcastState(); // exposure penalty: their dots appear everywhere
        }
      }
    }
  }

  // ── Serialization ────────────────────────────────────────────────────

  /**
   * End-game stats: survival leaderboard + event timeline, derived from
   * data we already track (caughtAt/caughtBy, seekStartedAt, the log).
   * Meaningful only once the game is over.
   */
  statsPayload() {
    // Heist end screen reads the heist block (score + robber roster) instead.
    if (this.phase !== 'over' || !this.seekStartedAt || this.isHeist()) return null;
    const gameEnd = Math.max(
      this.seekStartedAt,
      ...[...this.teams.values()].map((t) => t.caughtAt ?? 0),
      this.log.findLast?.((e) => e.type === 'over')?.at ?? Date.now(),
    );
    const teams = [...this.teams.values()]
      .filter((t) => [...this.players.values()].some((p) => p.teamId === t.id))
      // Leaderboard = teams that HID this round: caught ones (caughtAt set)
      // or still-hiding survivors. Teams that started as seekers are
      // excluded — "survived" would be meaningless for them.
      .filter((t) => t.caughtAt !== null || t.role === 'hider')
      .map((t) => {
        const survivedTo = t.caughtAt ?? gameEnd;
        return {
          teamId: t.id,
          name: t.name,
          winner: t.id === this.winnerTeamId,
          survived: t.caughtAt === null, // never caught
          survivedSeconds: Math.max(0, Math.round((survivedTo - this.seekStartedAt) / 1000)),
          caughtBy: t.caughtBy ?? null,
        };
      })
      .sort((a, b) => b.survivedSeconds - a.survivedSeconds || (b.winner ? 1 : -1));
    const timeline = this.log.filter(
      (e) => e.at >= this.seekStartedAt && ['tag', 'event', 'over', 'boundary'].includes(e.type),
    );
    return { teams, timeline, seekStartedAt: this.seekStartedAt };
  }

  /** Shared, non-sensitive core of the state. */
  baseState() {
    return {
      ...(this.phase === 'over' ? { stats: this.statsPayload() } : {}),
      mode: this.mode,
      phase: this.phase,
      phaseEndsAt: this.phaseEndsAt,
      serverNow: Date.now(),
      boundary: this.boundary,
      settings: this.settings,
      activeEvent: this.activeEvent,
      nextAutoEventAt: this.nextAutoEventAt,
      winnerTeamId: this.winnerTeamId,
      winnerTeamName: this.winnerTeamId ? this.teams.get(this.winnerTeamId)?.name : null,
      teams: [...this.teams.values()].map((t) => ({
        id: t.id,
        name: t.name,
        role: t.role,
        caughtAt: t.caughtAt,
        players: [...this.players.values()]
          .filter((p) => p.teamId === t.id)
          .map((p) => ({
            id: p.id,
            name: p.name,
            ready: p.ready,
            connected: p.connected,
            isHost: p.isHost,
          })),
      })),
      // Joined but no team — mid-game joiners waiting at the team-picker
      // screen (see joinTeam). Surfaced so the referee can still see/kick
      // them; TeamList has no bucket for a null teamId otherwise.
      unassigned: [...this.players.values()]
        .filter((p) => !p.teamId && !p.isHost)
        .map((p) => ({ id: p.id, name: p.name, ready: p.ready, connected: p.connected, isHost: p.isHost })),
    };
  }

  /**
   * Referee/host view: everything, including live positions.
   * Positions NEVER appear in the player view (privacy constraint).
   * Pass the host's playerId so the payload keeps `you` — the client
   * routes on `game.you`, so a you-less state would bounce the host
   * back to the join screen.
   */
  /** All live positions, serialized. Referee always; players ONLY during reveal. */
  positionsPayload() {
    return [...this.players.values()]
      .filter((p) => p.pos)
      .map((p) => ({
        playerId: p.id,
        name: p.name,
        teamId: p.teamId,
        role: this.teams.get(p.teamId)?.role ?? 'host', // teamless = the referee
        lat: p.pos.lat,
        lng: p.pos.lng,
        at: p.pos.at,
        connected: p.connected,
        lastSeenAt: p.lastSeenAt,
      }));
  }

  /**
   * Positions of players currently flagged out-of-bounds (outsideSince
   * set). This is the boundary penalty since the forced tag was removed:
   * leave the circle and EVERYONE sees your dot until you're back inside.
   */
  exposedPositions() {
    return this.positionsPayload().filter(
      (pos) => this.players.get(pos.playerId)?.outsideSince,
    );
  }

  /** True while anyone is exposed — index.js broadcasts per tick then. */
  hasExposed() {
    return [...this.players.values()].some((p) => p.outsideSince);
  }

  refereeState(playerId = null) {
    return {
      ...(playerId ? this.playerState(playerId) : this.baseState()),
      positions: this.positionsPayload(),
      teamCentroids: [...this.teams.keys()].map((id) => ({
        teamId: id,
        centroid: this.teamCentroid(id),
      })),
      // Referee sees every station (active or not) — overrides the player block.
      ...(this.isHeist() ? { heist: this.heistRefereePayload() } : {}),
      // Referee-only game log (newest last); client renders it reversed.
      log: this.log.slice(-60),
    };
  }

  /**
   * Role-appropriate view for a player: NO live positions of anyone —
   * EXCEPT while a `reveal` curveball is active, when everyone (seekers
   * AND hiders) sees all dots. That's the one sanctioned privacy breach.
   */
  playerState(playerId) {
    const player = this.players.get(playerId);
    const team = player?.teamId ? this.teams.get(player.teamId) : null;
    const revealed = this.activeEvent?.type === 'reveal';
    // Two sanctioned position leaks: the reveal curveball (everyone), and
    // out-of-bounds offenders (their dots only) as the boundary penalty.
    const exposed = revealed ? [] : this.exposedPositions();
    return {
      ...this.baseState(),
      ...(revealed
        ? { positions: this.positionsPayload() }
        : exposed.length
          ? { positions: exposed }
          : {}),
      ...(this.isHeist() ? { heist: this.heistPlayerPayload(player) } : {}),
      you: player
        ? {
            id: player.id,
            name: player.name,
            teamId: player.teamId,
            teamName: team?.name ?? null,
            // Teamless host must not count as a hider (e.g. sound event
            // makes only hider phones ring).
            role: team?.role ?? (player.isHost ? 'host' : 'hider'),
            isHost: player.isHost,
            ready: player.ready,
          }
        : null,
    };
  }

  /** Push per-role state to everyone (index.js maps rooms → sockets). */
  broadcastState() {
    this.emit('game:state', null, { perPlayer: true });
  }
}

/** Latest position if fresh enough to judge boundary on, else null. */
function freshPos(player, now, maxAgeMs = 60_000) {
  return player?.pos && now - player.pos.at <= maxAgeMs ? player.pos : null;
}

// Heist-mode rules live in their own module; mixed in so they share state.
Object.assign(Game.prototype, heistMethods);
