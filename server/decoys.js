/**
 * decoys.js — Hide & Seek V2 rules (mode 'hideseek2'), mixed into Game.
 *
 * Two additions on top of classic hide & seek:
 *  - DECOYS: hiders drop fake markers at their current position. Seekers see
 *    every live decoy on their map (never who dropped it).
 *  - PROXIMITY HEAT: each seeker gets a coarse "how close is the nearest
 *    target" level, where a target is a real hider OR a decoy. Computed
 *    here so raw hider positions never reach seeker phones — only a band.
 *
 * Privacy (CLAUDE.md #6): seekers still never receive hider coordinates.
 * V2 knowingly leaks a banded distance; that is the point of the mode.
 */

import { haversine } from './geo.js';

export const V2_SETTINGS = {
  decoysPerPlayer: 3, // charges each hider gets for the round
  decoyLifetimeSeconds: 150, // a dropped decoy vanishes after this long
  decoyCooldownSeconds: 20, // gap between one hider's drops
  proximityRangeM: 60, // beyond this a seeker reads "cold"
  closeRangeM: 20, // within this the haptic + sound cue fires
  outOfBoundsLimitSeconds: 120, // hiders outside this long become seekers (0 = off)
  outOfBoundsPingSeconds: 30, // ...but only if a member pinged this recently (not disconnected)
};

const FRESH_MS = 30_000; // positions older than this don't count as targets
// Heat levels: 0 cold (> range), 1 cool, 2 warm, 3 hot, 4 burning (≤ closeRangeM).
const HEAT_BANDS = [1, 0.6, 0.35]; // fractions of proximityRangeM for levels 1..3

const fresh = (pos, now) => pos && now - pos.at <= FRESH_MS;

export const decoyMethods = {
  isV2() {
    return this.mode === 'hideseek2';
  },

  /** Out-of-bounds limit in ms, or 0 when disabled / not V2 seek. */
  outOfBoundsLimitMs() {
    if (!this.isV2()) return 0;
    return Math.max(0, +this.settings.outOfBoundsLimitSeconds || 0) * 1000;
  },

  /**
   * V2: has this hider team been outside past the limit while at least one
   * outside member is still pinging? Disconnected phones never convert.
   */
  boundaryPenaltyDue(members, now = Date.now()) {
    const limit = this.outOfBoundsLimitMs();
    if (!limit || this.phase !== 'seek') return false;
    const since = members.filter((m) => m.outsideSince).map((m) => m.outsideSince);
    if (!since.length || now - Math.min(...since) < limit) return false;
    const pingMs = Math.max(0, +this.settings.outOfBoundsPingSeconds || 0) * 1000;
    return members.some((m) => m.connected && now - m.lastSeenAt <= pingMs);
  },

  /** Charges a player has left this round. */
  decoyChargesLeft(player) {
    return Math.max(0, this.settings.decoysPerPlayer - (this.decoyUsed.get(player.id) ?? 0));
  },

  /**
   * Hider drops a decoy at their current position. Returns `{ decoy }` or
   * `{ error }` — the phone shows the error as a toast.
   */
  dropDecoy(playerId, now = Date.now()) {
    const player = this.players.get(playerId);
    const team = player?.teamId ? this.teams.get(player.teamId) : null;
    if (!this.isV2()) return { error: 'Decoys are a Hide & Seek V2 feature' };
    if (!player || !team || team.role !== 'hider') return { error: 'Only hiders can drop decoys' };
    if (this.phase !== 'seek') return { error: 'Decoys unlock when the seek phase starts' };
    if (!fresh(player.pos, now)) return { error: 'Waiting for a GPS fix — try again in a moment' };
    if (this.decoyChargesLeft(player) <= 0) return { error: 'No decoys left' };
    const wait = (this.decoyCooldownUntil.get(playerId) ?? 0) - now;
    if (wait > 0) return { error: `Decoy recharging — ${Math.ceil(wait / 1000)}s` };

    const decoy = {
      id: `d${this.nextDecoyId++}`,
      playerId,
      teamId: team.id,
      lat: player.pos.lat,
      lng: player.pos.lng,
      droppedAt: now,
      expiresAt: now + this.settings.decoyLifetimeSeconds * 1000,
    };
    this.decoys.push(decoy);
    this.decoyUsed.set(playerId, (this.decoyUsed.get(playerId) ?? 0) + 1);
    this.decoyCooldownUntil.set(playerId, now + this.settings.decoyCooldownSeconds * 1000);
    this.logEvent('decoy', `${player.name} dropped a decoy (${this.decoyChargesLeft(player)} left)`);
    this.broadcastState();
    return { decoy };
  },

  /** True while seekers' heat needs a per-tick push (seek phase of V2). */
  heatLive() {
    return this.isV2() && this.phase === 'seek';
  },

  /** Remove expired decoys; true if anything changed (caller broadcasts). */
  expireDecoys(now = Date.now()) {
    const before = this.decoys.length;
    this.decoys = this.decoys.filter((d) => d.expiresAt > now);
    return this.decoys.length !== before;
  },

  /** Drop every decoy a team owns (it was caught — they're seekers now). */
  clearTeamDecoys(teamId) {
    this.decoys = this.decoys.filter((d) => d.teamId !== teamId);
  },

  clearDecoys() {
    this.decoys = [];
    this.decoyUsed = new Map();
    this.decoyCooldownUntil = new Map();
  },

  /**
   * Heat for one seeker: nearest of {fresh hider positions, live decoys}.
   * Returns { level 0..4, close } or null when it can't be judged.
   * Deliberately omits the raw distance and the target type.
   */
  heatFor(seekerId, now = Date.now()) {
    if (!this.isV2() || this.phase !== 'seek') return null;
    const seeker = this.players.get(seekerId);
    if (!seeker || this.teams.get(seeker.teamId)?.role !== 'seeker') return null;
    if (!fresh(seeker?.pos, now)) return null;

    let nearest = Infinity;
    for (const p of this.players.values()) {
      if (p.isHost || !fresh(p.pos, now) || !p.connected) continue;
      if (this.teams.get(p.teamId)?.role !== 'hider') continue;
      nearest = Math.min(nearest, haversine(seeker.pos, p.pos));
    }
    for (const d of this.decoys) {
      if (d.expiresAt > now) nearest = Math.min(nearest, haversine(seeker.pos, d));
    }

    const { proximityRangeM: range, closeRangeM: close } = this.settings;
    if (nearest <= close) return { level: 4, close: true };
    let level = 0;
    HEAT_BANDS.forEach((frac, i) => {
      if (nearest <= range * frac) level = i + 1;
    });
    return { level, close: false };
  },

  /** V2 slice of a player's state: decoy markers, charges, heat. */
  v2PlayerPayload(player, now = Date.now()) {
    const team = player?.teamId ? this.teams.get(player.teamId) : null;
    const base = { decoys: [], charges: 0, cooldownUntil: 0, heat: null };
    if (!player) return base;
    if (team?.role === 'seeker') {
      return {
        ...base,
        // Seekers see where decoys are — never whose they are.
        decoys: this.decoys.map(({ id, lat, lng, expiresAt }) => ({ id, lat, lng, expiresAt })),
        heat: this.heatFor(player.id, now),
      };
    }
    return {
      ...base,
      decoys: this.decoys
        .filter((d) => d.teamId === team?.id)
        .map(({ id, lat, lng, expiresAt }) => ({ id, lat, lng, expiresAt, mine: true })),
      charges: team?.role === 'hider' ? this.decoyChargesLeft(player) : 0,
      cooldownUntil: this.decoyCooldownUntil.get(player.id) ?? 0,
    };
  },

  /** Referee sees every decoy plus who dropped it. */
  v2RefereePayload() {
    return this.decoys.map((d) => ({
      id: d.id,
      lat: d.lat,
      lng: d.lng,
      expiresAt: d.expiresAt,
      playerName: this.players.get(d.playerId)?.name ?? '?',
    }));
  },
};
