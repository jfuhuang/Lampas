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
  shrinkFactor: 0.6,
  eventSeconds: 15,
  boundaryMarginM: 10,
  // heist mode (mirrors server/heist.js HEIST_SETTINGS)
  targetScore: 50,
  activeStations: 3,
  stationRadiusM: 20,
  prisonRadiusM: 25,
  jailSeconds: 30,
  immunitySeconds: 60,
};

const TASK_GAMES = ['wires', 'swipe', 'keypad', 'download', 'simon', 'dial'];

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

/** Fresh scenario: 3 teams, 6 players, boundary at Iowa State University, Ames, IA. */
export function makeScenario() {
  const center = { lat: 42.0267, lng: -93.6465 };
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
    mode: 'hideseek',
    heist: { stations: [], prison: null, score: 0, winner: null, robbers: {} },
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

/** Heist mimic: a ready-made layout — 5 stations on a ring + prison near center. */
export function seedHeist(state) {
  const s = structuredClone(state);
  const c = s.boundary.center;
  s.mode = 'heist';
  s.heist.prison = offset(c, -40, 30);
  s.heist.stations = Array.from({ length: 5 }, (_, i) => {
    const a = (i / 5) * 2 * Math.PI;
    return {
      id: id('s'),
      name: `Station ${i + 1}`,
      ...offset(c, Math.sin(a) * 120, Math.cos(a) * 120),
      points: 10,
      game: 'random',
      active: false,
      lockedBy: null,
    };
  });
  return s;
}

/** Point `northM` / `eastM` meters from `c`. */
function offset(c, northM, eastM) {
  return {
    lat: c.lat + northM * DEG_PER_M,
    lng: c.lng + (eastM * DEG_PER_M) / Math.cos((c.lat * Math.PI) / 180),
  };
}

const freshRobber = () => ({
  status: 'free',
  jailServedMs: 0,
  immuneUntil: null,
  task: null,
  points: 0,
  timesCaught: 0,
});
const robberOf = (s, playerId) => (s.heist.robbers[playerId] ??= freshRobber());
const isRobber = (s, playerId) => findTeamOf(s, playerId)?.role === 'hider';

function heistStartRound(s) {
  s.heist.score = 0;
  s.heist.winner = null;
  s.heist.robbers = {};
  const pool = [...s.heist.stations].sort(() => Math.random() - 0.5);
  for (const st of s.heist.stations) {
    st.active = pool.indexOf(st) < s.settings.activeStations;
    st.lockedBy = null;
  }
  s.heist.roundLive = true;
}

function heistCatch(s, playerId) {
  if (s.phase !== 'seek' || !isRobber(s, playerId)) return;
  const r = robberOf(s, playerId);
  if (r.status !== 'free') return;
  if (r.task) heistCancel(s, playerId);
  Object.assign(r, { status: 'jailed', jailServedMs: 0 });
  r.timesCaught++;
}

function heistCancel(s, playerId) {
  const r = robberOf(s, playerId);
  const st = s.heist.stations.find((x) => x.id === r.task?.stationId);
  if (st?.lockedBy === playerId) st.lockedBy = null;
  r.task = null;
}

function heistCredit(s, st, playerId = null) {
  s.heist.score += st.points;
  if (playerId) robberOf(s, playerId).points += st.points;
  const next = s.heist.stations.filter((x) => !x.active && x !== st);
  if (next.length) {
    st.active = false;
    next[Math.floor(Math.random() * next.length)].active = true;
  }
  st.lockedBy = null;
  if (s.heist.score >= s.settings.targetScore) heistEnd(s, 'robbers');
}

function heistEnd(s, winner) {
  s.heist.winner = winner;
  s.phase = 'over';
  s.phaseEndsAt = null;
}

const findTeamOf = (s, playerId) => s.teams.find((t) => t.players.some((p) => p.id === playerId));
const you = (s) => s.teams.flatMap((t) => t.players).find((p) => p.id === s.youId);

function setPhase(s, phase) {
  s.phase = phase;
  s.activeEvent = null;
  if (phase === 'hide') s.phaseEndsAt = Date.now() + s.settings.hideSeconds * 1000;
  else if (phase === 'seek') {
    s.phaseEndsAt = Date.now() + s.settings.seekSeconds * 1000;
    s.initialHiderTeams = s.teams.filter((t) => t.role === 'hider' && t.players.length).length;
    s.seekStartedAt = Date.now();
  } else s.phaseEndsAt = null;
  if (s.mode === 'heist' && (phase === 'hide' || (phase === 'seek' && !s.heist.roundLive))) {
    heistStartRound(s);
  }
  if (phase === 'lobby') {
    s.heist.roundLive = false;
    s.heist.score = 0;
    s.heist.robbers = {};
    for (const st of s.heist.stations) st.active = false;
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
  if (s.mode === 'heist') return; // heist catches jail one robber instead
  const team = s.teams.find((t) => t.id === teamId);
  if (!team || team.role !== 'hider' || s.phase !== 'seek') return;
  team.role = 'seeker';
  team.caughtAt = Date.now();
  // Same win rule as the server: end at 1 hider team left (them = winner),
  // unless the game started with a single hider team — then play to 0.
  const hiders = s.teams.filter((t) => t.role === 'hider' && t.players.length);
  if (hiders.length <= (s.initialHiderTeams > 1 ? 1 : 0)) {
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
  s.lastAck = undefined; // acked events (task:*) set this; DevApp hands it to the ack

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
      if (s.mode === 'heist') {
        heistCatch(s, payload.targetPlayerId);
        break;
      }
      const team = findTeamOf(s, payload.targetPlayerId);
      if (team) convertTeam(s, team.id);
      break;
    }
    case 'caught:self': {
      if (s.mode === 'heist') {
        heistCatch(s, s.youId);
        break;
      }
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
        const oldR = s.boundary.radiusM;
        const newR = Number.isFinite(+payload.radiusM)
          ? +payload.radiusM
          : oldR * (Number.isFinite(+payload.factor) ? +payload.factor : s.settings.shrinkFactor);
        s.boundary.radiusM = Math.min(oldR, Math.max(20, Math.round(newR)));
      } else if (['sound', 'torch', 'reveal'].includes(payload.type)) {
        const secs =
          payload.type === 'reveal' ? (s.settings.revealSeconds ?? 20) : s.settings.eventSeconds;
        s.activeEvent = { type: payload.type, endsAt: Date.now() + secs * 1000 };
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
      if (payload.mode && s.phase === 'lobby') s.mode = payload.mode;
      break;
    }
    // ── Heist mimic (no GPS presence checks — dev has a "go to" button) ──
    case 'host:station:add':
      if (s.phase === 'lobby') {
        s.heist.stations.push({
          id: id('s'),
          name: `Station ${s.heist.stations.length + 1}`,
          lat: payload.lat,
          lng: payload.lng,
          points: 10,
          game: 'random',
          active: false,
          lockedBy: null,
        });
      }
      break;
    case 'host:station:update': {
      const st = s.heist.stations.find((x) => x.id === payload.stationId);
      if (st) Object.assign(st, payload.points ? { points: payload.points } : {}, payload.game ? { game: payload.game } : {});
      break;
    }
    case 'host:station:remove':
      s.heist.stations = s.heist.stations.filter((x) => x.id !== payload.stationId);
      break;
    case 'host:prison':
      s.heist.prison = { lat: payload.lat, lng: payload.lng };
      break;
    case 'host:heist': {
      if (payload.action === 'catch') heistCatch(s, payload.playerId);
      else if (payload.action === 'release') {
        const r = robberOf(s, payload.playerId);
        if (r.status === 'jailed') {
          Object.assign(r, { status: 'immune', immuneUntil: Date.now() + s.settings.immunitySeconds * 1000 });
        }
      } else if (payload.action === 'credit') {
        const st = s.heist.stations.find((x) => x.id === payload.stationId && x.active);
        if (st && s.phase === 'seek') heistCredit(s, st);
      } else if (payload.action === 'score' && s.phase === 'seek') {
        s.heist.score = Math.max(0, s.heist.score + payload.delta);
        if (s.heist.score >= s.settings.targetScore) heistEnd(s, 'robbers');
      }
      break;
    }
    case 'task:start': {
      const r = robberOf(s, s.youId);
      const st = s.heist.stations.find((x) => x.id === payload.stationId);
      if (s.phase !== 'seek' || !st?.active || r.status === 'jailed') {
        s.lastAck = { error: 'Not now (dev)' };
        break;
      }
      const game = st.game === 'random' ? TASK_GAMES[Math.floor(Math.random() * TASK_GAMES.length)] : st.game;
      st.lockedBy = s.youId;
      r.task = { stationId: st.id, game, startedAt: Date.now() };
      s.lastAck = { ok: true, game };
      break;
    }
    case 'task:complete': {
      const r = robberOf(s, s.youId);
      const st = s.heist.stations.find((x) => x.id === r.task?.stationId);
      if (!st?.active || s.phase !== 'seek') {
        s.lastAck = { error: 'Station went dark (dev)' };
        break;
      }
      r.task = null;
      heistCredit(s, st, s.youId);
      s.lastAck = { ok: true, points: st.points, score: s.heist.score };
      break;
    }
    case 'task:cancel':
      heistCancel(s, s.youId);
      break;
    case 'host:setTeamRole': {
      const t = s.teams.find((x) => x.id === payload.teamId);
      if (t && s.phase === 'lobby') t.role = payload.role;
      break;
    }
    case 'team:create':
    case 'team:join': {
      const p = you(s);
      const from = findTeamOf(s, s.youId);
      let to = s.teams.find((t) => t.id === payload.teamId);
      if (!to && payload.name) {
        to = { id: id('t'), name: payload.name, role: 'hider', caughtAt: null, players: [] };
        s.teams.push(to);
      }
      if (p && from && to && to !== from) {
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
    else if (s.phase === 'seek' && s.mode === 'heist') heistEnd(s, 'cops');
    else if (s.phase === 'seek') {
      s.winnerTeamId = s.teams.find((t) => t.role === 'hider')?.id ?? null;
      s.phase = 'over';
      s.phaseEndsAt = null;
    }
  }

  // Heist: bots serve jail time anywhere; YOU must stand in the prison.
  if (s.mode === 'heist' && s.phase === 'seek') {
    for (const [pid, r] of Object.entries(s.heist.robbers)) {
      if (r.status === 'jailed') {
        const pos = s.positions.find((x) => x.playerId === pid);
        const inside =
          pid !== s.youId ||
          (pos && s.heist.prison && approxDistM(pos, s.heist.prison) <= s.settings.prisonRadiusM);
        if (inside) r.jailServedMs += 1000;
        if (r.jailServedMs >= s.settings.jailSeconds * 1000) {
          Object.assign(r, { status: 'immune', immuneUntil: now + s.settings.immunitySeconds * 1000 });
        }
      } else if (r.status === 'immune' && now >= r.immuneUntil) {
        Object.assign(r, { status: 'free', immuneUntil: null });
      }
    }
  }

  // Bots wander during hide/seek; pulled back if they stray past the circle.
  if (s.phase === 'hide' || s.phase === 'seek') {
    for (const pos of s.positions) {
      if (pos.playerId === s.youId || !pos.connected) continue;
      // Jailed heist bots shuffle inside the prison instead.
      if (s.heist.robbers[pos.playerId]?.status === 'jailed' && s.heist.prison) {
        Object.assign(pos, scatter(s.heist.prison, s.settings.prisonRadiusM * 0.5), { at: now });
        continue;
      }
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
  const heistView = () => {
    const h = state.heist;
    const robberView = team?.role === 'hider';
    const robbers = state.teams
      .filter((t) => t.role === 'hider')
      .flatMap((t) => t.players)
      .map((pl) => ({ id: pl.id, name: pl.name, ...(h.robbers[pl.id] ?? freshRobber()) }));
    const stationView = (st) => ({ ...st, busy: !!st.lockedBy && st.lockedBy !== state.youId });
    return {
      score: h.score,
      winner: h.winner,
      prison: h.prison,
      robbers,
      // Same privacy as the server: referee = all; robbers = live only; cops = none.
      ...(p?.isHost
        ? { stations: h.stations.map((st) => ({ ...stationView(st), lockedByName: st.lockedBy ? 'someone' : null })) }
        : robberView && (state.phase === 'hide' || state.phase === 'seek')
          ? { stations: h.stations.filter((st) => st.active).map(stationView) }
          : {}),
      ...(robberView ? { me: h.robbers[state.youId] ?? freshRobber() } : {}),
    };
  };
  return {
    mode: state.mode,
    ...(state.mode === 'heist' ? { heist: heistView() } : {}),
    phase: state.phase,
    phaseEndsAt: state.phaseEndsAt,
    serverNow: Date.now(),
    boundary: state.boundary,
    settings: state.settings,
    activeEvent: state.activeEvent,
    winnerTeamId: state.winnerTeamId,
    winnerTeamName: state.teams.find((t) => t.id === state.winnerTeamId)?.name ?? null,
    teams: state.teams,
    // Match production privacy: dots for the host persona, or for everyone
    // while a reveal curveball is active.
    positions:
      p?.isHost || state.activeEvent?.type === 'reveal'
        ? state.positions.map((pos) => ({ ...pos, role: roleOf(pos.teamId) }))
        : undefined,
    // Minimal stats mimic so the dev `over` screen previews GameStats.
    stats:
      state.phase === 'over' && state.seekStartedAt && state.mode !== 'heist'
        ? {
            seekStartedAt: state.seekStartedAt,
            timeline: [],
            teams: state.teams
              .filter((t) => t.players.length && (t.caughtAt !== null || t.role === 'hider'))
              .map((t) => ({
                teamId: t.id,
                name: t.name,
                winner: t.id === state.winnerTeamId,
                survived: t.caughtAt === null,
                survivedSeconds: Math.max(
                  0,
                  Math.round(((t.caughtAt ?? Date.now()) - state.seekStartedAt) / 1000),
                ),
                caughtBy: t.caughtAt ? 'self' : null,
              }))
              .sort((a, b) => b.survivedSeconds - a.survivedSeconds),
          }
        : undefined,
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
