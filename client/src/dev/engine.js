/**
 * dev/engine.js — tiny in-browser replica of server/game.js for the dev
 * view. Pure functions over a plain state object: applyAction() handles
 * the same socket events the server does, tick() advances timers and
 * drifts bot positions, toGamePayload() serializes to the exact shape
 * screens receive in `game:state`. No network involved anywhere.
 *
 * Deliberately NOT shared with the server — this is a throwaway mimic;
 * server/game.js stays the single source of truth for real rules.
 */

let n = 1;
const id = (p) => `dev_${p}${n++}`;

const DEFAULT_SETTINGS = {
  hideSeconds: 90,
  seekSeconds: 600,
  graceSeconds: 30,
  shrinkFactor: 0.6,
  eventSeconds: 15,
  boundaryMarginM: 10,
};

const DEG_PER_M = 1 / 111_320; // good enough at game scale

/** Random point within `radiusM` of center. */
function scatter(center, radiusM) {
  const r = radiusM * Math.sqrt(Math.random());
  const theta = Math.random() * 2 * Math.PI;
  return {
    lat: center.lat + r * Math.sin(theta) * DEG_PER_M,
    lng: center.lng + (r * Math.cos(theta) * DEG_PER_M) / Math.cos((center.lat * Math.PI) / 180),
  };
}

function approxDistM(a, b) {
  const dLat = (a.lat - b.lat) / DEG_PER_M;
  const dLng = ((a.lng - b.lng) / DEG_PER_M) * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

/** Fresh scenario: 3 teams, 6 players, boundary in Central Park. */
export function makeScenario() {
  const center = { lat: 40.7812, lng: -73.9665 };
  const boundary = { center, radiusM: 180 };

  const mk = (name, isHost = false) => ({
    id: id('p'),
    name,
    ready: Math.random() > 0.4,
    connected: true,
    isHost,
  });

  const teams = [
    { id: id('t'), name: 'Rangers', role: 'seeker', caughtAt: null, players: [mk('Hosty', true), mk('Nia')] },
    { id: id('t'), name: 'Owls', role: 'hider', caughtAt: null, players: [mk('Alice'), mk('Bob')] },
    { id: id('t'), name: 'Foxes', role: 'hider', caughtAt: null, players: [mk('Cara'), mk('Dan')] },
  ];

  const positions = teams.flatMap((t) =>
    t.players.map((p) => ({
      playerId: p.id,
      name: p.name,
      teamId: t.id,
      ...scatter(center, boundary.radiusM * 0.8),
      at: Date.now(),
      connected: true,
      lastSeenAt: Date.now(),
    })),
  );
  // One bot looks "quiet" so the referee map's grey state is visible.
  positions[positions.length - 1].connected = false;

  return {
    phase: 'lobby',
    phaseEndsAt: null,
    boundary,
    settings: { ...DEFAULT_SETTINGS },
    activeEvent: null,
    winnerTeamId: null,
    teams,
    positions,
    youId: teams[0].players[0].id, // start as the host
  };
}

const findTeamOf = (s, playerId) => s.teams.find((t) => t.players.some((p) => p.id === playerId));
const you = (s) => s.teams.flatMap((t) => t.players).find((p) => p.id === s.youId);

function setPhase(s, phase) {
  s.phase = phase;
  s.activeEvent = null;
  if (phase === 'hide') s.phaseEndsAt = Date.now() + s.settings.hideSeconds * 1000;
  else if (phase === 'seek') s.phaseEndsAt = Date.now() + s.settings.seekSeconds * 1000;
  else s.phaseEndsAt = null;
  if (phase === 'lobby') {
    s.winnerTeamId = null;
    for (const t of s.teams) {
      if (t.caughtAt) {
        t.role = 'hider';
        t.caughtAt = null;
      }
    }
  }
}

function convertTeam(s, teamId) {
  const team = s.teams.find((t) => t.id === teamId);
  if (!team || team.role !== 'hider' || s.phase !== 'seek') return;
  team.role = 'seeker';
  team.caughtAt = Date.now();
  const hiders = s.teams.filter((t) => t.role === 'hider');
  if (hiders.length <= 1) {
    s.winnerTeamId = hiders[0]?.id ?? null;
    s.phase = 'over';
    s.phaseEndsAt = null;
  }
}

/**
 * Mirror of the server's socket handlers. `event` is the emitted name,
 * `payload` its first argument. Returns a NEW state (input untouched).
 */
export function applyAction(state, event, payload = {}) {
  const s = structuredClone(state);
  switch (event) {
    case 'player:ready': {
      const p = you(s);
      if (p) p.ready = !!payload.ready;
      break;
    }
    case 'join': {
      const p = you(s);
      if (p && payload.name) p.name = payload.name;
      break;
    }
    case 'tag:player': {
      const team = findTeamOf(s, payload.targetPlayerId);
      if (team) convertTeam(s, team.id);
      break;
    }
    case 'caught:self': {
      const team = findTeamOf(s, s.youId);
      if (team) convertTeam(s, team.id);
      break;
    }
    case 'host:startPhase':
      setPhase(s, payload.phase);
      break;
    case 'host:reset':
      setPhase(s, 'lobby');
      break;
    case 'host:trigger': {
      if (payload.type === 'shrink') {
        s.boundary.radiusM = Math.max(20, Math.round(s.boundary.radiusM * s.settings.shrinkFactor));
      } else if (payload.type === 'sound' || payload.type === 'torch') {
        s.activeEvent = { type: payload.type, endsAt: Date.now() + s.settings.eventSeconds * 1000 };
      }
      break;
    }
    case 'host:config': {
      if (payload.boundary?.center) {
        s.boundary = {
          center: payload.boundary.center,
          radiusM: Math.max(20, payload.boundary.radiusM ?? s.boundary.radiusM),
        };
      }
      if (payload.settings) Object.assign(s.settings, payload.settings);
      break;
    }
    case 'host:setTeamRole': {
      const t = s.teams.find((x) => x.id === payload.teamId);
      if (t && s.phase === 'lobby') t.role = payload.role;
      break;
    }
    case 'team:join': {
      const p = you(s);
      const from = findTeamOf(s, s.youId);
      let to = s.teams.find((t) => t.name.toLowerCase() === payload.teamName?.toLowerCase());
      if (!to) {
        to = { id: id('t'), name: payload.teamName, role: 'hider', caughtAt: null, players: [] };
        s.teams.push(to);
      }
      if (p && from && to !== from) {
        from.players = from.players.filter((x) => x.id !== p.id);
        to.players.push(p);
        const pos = s.positions.find((x) => x.playerId === p.id);
        if (pos) pos.teamId = to.id;
      }
      break;
    }
    case 'pos:update': {
      const pos = s.positions.find((x) => x.playerId === s.youId);
      if (pos && payload.lat) Object.assign(pos, { lat: payload.lat, lng: payload.lng, at: Date.now() });
      break;
    }
    default:
      break; // resync etc. — meaningless locally
  }
  return s;
}

/** 1s dev tick: timers, event expiry, bot drift. Returns a NEW state. */
export function tick(state) {
  const s = structuredClone(state);
  const now = Date.now();

  if (s.activeEvent && now >= s.activeEvent.endsAt) s.activeEvent = null;

  if (s.phaseEndsAt && now >= s.phaseEndsAt) {
    if (s.phase === 'hide') setPhase(s, 'seek');
    else if (s.phase === 'seek') {
      s.winnerTeamId = s.teams.find((t) => t.role === 'hider')?.id ?? null;
      s.phase = 'over';
      s.phaseEndsAt = null;
    }
  }

  // Bots wander during hide/seek; pulled back if they stray past the circle.
  if (s.phase === 'hide' || s.phase === 'seek') {
    for (const pos of s.positions) {
      if (pos.playerId === s.youId || !pos.connected) continue;
      const step = 4 * DEG_PER_M; // ~4 m/s shuffle
      pos.lat += (Math.random() - 0.5) * 2 * step;
      pos.lng += (Math.random() - 0.5) * 2 * step;
      if (approxDistM(pos, s.boundary.center) > s.boundary.radiusM * 0.95) {
        pos.lat += (s.boundary.center.lat - pos.lat) * 0.2;
        pos.lng += (s.boundary.center.lng - pos.lng) * 0.2;
      }
      pos.at = now;
      pos.lastSeenAt = now;
    }
  }
  return s;
}

/** Serialize to the exact `game:state` shape screens expect. */
export function toGamePayload(state) {
  const p = you(state);
  const team = findTeamOf(state, state.youId);
  const roleOf = (teamId) => state.teams.find((t) => t.id === teamId)?.role ?? 'hider';
  return {
    phase: state.phase,
    phaseEndsAt: state.phaseEndsAt,
    serverNow: Date.now(),
    boundary: state.boundary,
    settings: state.settings,
    activeEvent: state.activeEvent,
    winnerTeamId: state.winnerTeamId,
    winnerTeamName: state.teams.find((t) => t.id === state.winnerTeamId)?.name ?? null,
    teams: state.teams,
    // Dev view shows positions regardless of persona — it's a debugging tool.
    positions: state.positions.map((pos) => ({ ...pos, role: roleOf(pos.teamId) })),
    you: p
      ? {
          id: p.id,
          name: p.name,
          teamId: team?.id ?? null,
          teamName: team?.name ?? null,
          role: team?.role ?? 'hider',
          isHost: p.isHost,
          ready: p.ready,
        }
      : null,
  };
}

/** Selectable personas: one player per distinct vantage point. */
export function personas(state) {
  const list = [];
  for (const t of state.teams) {
    for (const p of t.players) {
      list.push({ id: p.id, label: `${p.isHost ? '👑 ' : ''}${p.name} (${t.role})` });
    }
  }
  return list;
}
