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

export const PHASES = ['lobby', 'hide', 'seek', 'over'];
export const EVENT_TYPES = ['sound', 'torch', 'shrink', 'reveal'];

const DEFAULT_SETTINGS = {
  hideSeconds: 180, // hiders get 3 min to hide
  seekSeconds: 1200, // 20 min round cap
  shrinkFactor: 0.6, // boundary radius multiplier per shrink event
  eventSeconds: 15, // how long sound/torch events stay active
  revealSeconds: 20, // how long the all-positions reveal lasts
  boundaryMarginM: 10, // GPS-noise margin added to the radius
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
    this.phase = 'lobby';
    this.phaseEndsAt = null;
    this.boundary = null; // { center: {lat,lng}, radiusM }
    this.settings = { ...DEFAULT_SETTINGS };
    this.players = new Map(); // playerId → player
    this.teams = new Map(); // teamId → team
    this.activeEvent = null; // { type, endsAt }
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
      this.players.set(player.id, player);
    }
    player.connected = true;
    player.lastSeenAt = Date.now();
    if (name) player.name = String(name).slice(0, 24);
    // Host is decided by credentials (checked in index.js), never by join order.
    player.isHost = !!isHost;
    if (teamName) this.joinTeam(player.id, teamName);
    this.logEvent(
      'join',
      `${player.name}${player.isHost ? ' (HOST)' : ''} joined` +
        (player.teamId ? ` team ${this.teams.get(player.teamId)?.name}` : ''),
    );
    return player;
  }

  /** Create team on demand; move player into it. */
  joinTeam(playerId, teamName) {
    const player = this.players.get(playerId);
    if (!player) return null;
    const cleanName = String(teamName || 'Team').slice(0, 24);
    let team = [...this.teams.values()].find(
      (t) => t.name.toLowerCase() === cleanName.toLowerCase(),
    );
    if (!team) {
      team = {
        id: genId('t'),
        name: cleanName,
        role: 'hider', // 'hider' | 'seeker'
        caughtAt: null, // set when converted during seek phase
        caughtBy: null, // stats label: self / referee (name) / boundary penalty
      };
      this.teams.set(team.id, team);
    }
    player.teamId = team.id;
    return team;
  }

  /**
   * Host kicks a player (lobby only — mid-game removals would mangle team
   * state; the referee force-tags a problem team instead). Not a ban: the
   * kicked phone can re-join. Empty shell teams left behind are harmless —
   * hiderTeams() ignores player-less teams.
   */
  removePlayer(playerId) {
    if (this.phase !== 'lobby') return null;
    const player = this.players.get(playerId);
    if (!player || player.isHost) return null; // hosts can't be kicked
    this.players.delete(playerId);
    this.logEvent('kick', `${player.name} removed from lobby`);
    return player;
  }

  /**
   * Host deletes a whole team (lobby only). Members are removed with it —
   * they get kicked back to the join screen and can re-join under a new
   * team. Returns { team, memberIds } or null.
   */
  removeTeam(teamId) {
    if (this.phase !== 'lobby') return null;
    const team = this.teams.get(teamId);
    if (!team) return null;
    const memberIds = [...this.players.values()]
      .filter((p) => p.teamId === teamId && !p.isHost)
      .map((p) => p.id);
    for (const id of memberIds) this.players.delete(id);
    this.teams.delete(teamId);
    this.logEvent('team', `team ${team.name} deleted (${memberIds.length} member(s) kicked)`);
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
  configure({ boundary, settings }) {
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
    } else if (phase === 'hide') {
      this.startedAt = Date.now();
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
    } else if (phase === 'over') {
      this.phaseEndsAt = null;
    }
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

  updatePosition(playerId, { lat, lng }) {
    const player = this.players.get(playerId);
    if (!player || !Number.isFinite(+lat) || !Number.isFinite(+lng)) return;
    player.pos = { lat: +lat, lng: +lng, at: Date.now() };
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
    if (this.phase !== 'seek') return;
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

    // Boundary enforcement — hide + seek phases, hider teams only
    if ((this.phase === 'hide' || this.phase === 'seek') && this.boundary) {
      for (const team of this.hiderTeams()) {
        const c = this.teamCentroid(team.id);
        if (!c) continue;
        const inside = insideBoundary(c, this.boundary, this.settings.boundaryMarginM);
        const members = [...this.players.values()].filter((p) => p.teamId === team.id);
        if (inside) {
          if (members.some((m) => m.outsideSince)) {
            this.logEvent('boundary', `team ${team.name} back inside — grace cleared`);
          }
          for (const m of members) m.outsideSince = null;
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
            `team ${team.name} OUTSIDE (${Math.round(distanceOutside(c, this.boundary))}m past) — warned`,
          );
          this.emit(
            'boundary:warning',
            {
              teamId: team.id,
              metersOutside: Math.round(distanceOutside(c, this.boundary)),
            },
            { room: team.id },
          );
          this.emit(
            'boundary:warning',
            { teamId: team.id, teamName: team.name },
            { room: 'referees' },
          );
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
    if (this.phase !== 'over' || !this.seekStartedAt) return null;
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
      phase: this.phase,
      phaseEndsAt: this.phaseEndsAt,
      serverNow: Date.now(),
      boundary: this.boundary,
      settings: this.settings,
      activeEvent: this.activeEvent,
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

  refereeState(playerId = null) {
    return {
      ...(playerId ? this.playerState(playerId) : this.baseState()),
      positions: this.positionsPayload(),
      teamCentroids: [...this.teams.keys()].map((id) => ({
        teamId: id,
        centroid: this.teamCentroid(id),
      })),
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
    return {
      ...this.baseState(),
      ...(revealed ? { positions: this.positionsPayload() } : {}),
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
