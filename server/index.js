/**
 * index.js — single Node service: serves the React build AND the WebSocket.
 * One HTTPS URL, nothing to coordinate (see CLAUDE.md → Architecture).
 *
 * Core resilience principle: server is authoritative; clients emit `resync`
 * on every (re)connect and get the full role-appropriate state back. No
 * per-packet delivery guarantees anywhere.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { Game } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const TICK_MS = 2000;

// Host login: join with this username + password to get the referee role.
// Not real security — it keeps players from accidentally grabbing the host
// panel at a party. Override the password via env for a public deploy.
const HOST_USERNAME = 'host';
const HOST_PASSWORD = process.env.HOST_PASSWORD || 'pass';

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  // Tolerate short, frequent drops (screen lock, calls, backgrounding)
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 },
  cors: { origin: true }, // dev: Vite runs on another port; prod: same origin
});

// ── Lobbies, sessions + transport mapping ────────────────────────────
//
// Flow: username (session) → browse lobbies → join/create one → make or
// join a team. Each lobby owns an independent Game; the host (referee)
// creates lobbies, players pick one. A session outlives its lobby
// membership so leaving a lobby drops you back on the browse list.
//
// Rooms in use (Socket.IO):
//   - player id → that player's sockets
//   - 'browse'  → sockets with no lobby (get the live lobby list)
// Team / referee / broadcast scopes emitted by Game are fanned out to
// player-id rooms here, so nothing leaks across lobbies.

const LOBBY_IDLE_MS = 6 * 60 * 60 * 1000; // empty lobbies are swept after 6h
let nextLobbyId = 1;

/** @type {Map<string, {id: string, name: string, game: Game, emptySince: number|null}>} */
const lobbies = new Map();
/** @type {Map<string, {id: string, name: string, isHost: boolean, lobbyId: string|null}>} */
const sessions = new Map();

// State for one player: hosts get the referee payload (positions included)
// BUILT ON TOP of their player payload, so `you` is always present.
const stateFor = (game, player) =>
  player.isHost ? game.refereeState(player.id) : game.playerState(player.id);

const lobbySummaries = () =>
  [...lobbies.values()].map(({ id, name, game }) => ({
    id,
    name,
    phase: game.phase,
    mode: game.mode,
    players: [...game.players.values()].filter((p) => !p.isHost).length,
    teams: game.teams.size,
    hostOnline: [...game.players.values()].some((p) => p.isHost && p.connected),
  }));

const browseState = (session) => ({
  browse: true,
  you: { id: session.id, name: session.name, isHost: session.isHost },
  lobbies: lobbySummaries(),
});

const pushLobbyList = () => io.to('browse').emit('lobbies:list', lobbySummaries());

/** State for a session wherever it currently is (lobby or browse list). */
const sessionState = (session) => {
  const lobby = session.lobbyId && lobbies.get(session.lobbyId);
  const player = lobby?.game.players.get(session.id);
  return lobby && player ? stateFor(lobby.game, player) : browseState(session);
};

const emitStateToHosts = (game) => {
  for (const player of game.players.values()) {
    if (player.isHost) io.to(player.id).emit('game:state', game.refereeState(player.id));
  }
};

function createLobby(name, hostSession) {
  const lobby = { id: `L${nextLobbyId++}`, name, game: null, emptySince: null };
  // Game emits domain events; map its scopes onto player-id rooms.
  lobby.game = new Game((event, payload, scope = {}) => {
    const game = lobby.game;
    if (scope.perPlayer) {
      for (const player of game.players.values()) {
        io.to(player.id).emit('game:state', stateFor(game, player));
      }
      pushLobbyList(); // counts / phase changed
      return;
    }
    let targets;
    if (scope.room === 'referees') {
      targets = [...game.players.values()].filter((p) => p.isHost).map((p) => p.id);
    } else if (scope.room && game.teams.has(scope.room)) {
      targets = [...game.players.values()].filter((p) => p.teamId === scope.room).map((p) => p.id);
    } else if (scope.room) {
      targets = [scope.room]; // a player id
    } else {
      targets = [...game.players.keys()];
    }
    for (const id of targets) io.to(id).emit(event, payload);
  });
  lobbies.set(lobby.id, lobby);
  hostSession.lobbyId = lobby.id;
  return lobby;
}

/** Seat a session in a lobby (teamless) and point its sockets at it. */
function enterLobby(session, lobby) {
  session.lobbyId = lobby.id;
  lobby.emptySince = null;
  lobby.game.addPlayer({ playerId: session.id, name: session.name, isHost: session.isHost });
  io.in(session.id).socketsLeave('browse');
  lobby.game.broadcastState();
}

/**
 * Take a session out of its lobby and back to the browse list. The player
 * record is dropped (hosts included — the lobby itself survives).
 */
function exitLobby(session, reason) {
  const lobby = session.lobbyId && lobbies.get(session.lobbyId);
  session.lobbyId = null;
  if (lobby) {
    const { game } = lobby;
    if (game.players.get(session.id)?.isHost) game.players.delete(session.id);
    else game.removePlayer(session.id);
    if (!game.players.size) lobby.emptySince = Date.now();
    game.broadcastState();
  }
  io.in(session.id).socketsJoin('browse');
  if (reason) io.to(session.id).emit('kicked', { reason });
  io.to(session.id).emit('game:state', browseState(session));
  pushLobbyList();
}

function closeLobby(lobby) {
  lobbies.delete(lobby.id); // first, so the browse states below omit it
  for (const player of [...lobby.game.players.values()]) {
    const session = sessions.get(player.id);
    if (!session) continue;
    session.lobbyId = null;
    io.in(session.id).socketsJoin('browse');
    io.to(session.id).emit('kicked', { reason: 'lobby-closed', lobbyName: lobby.name });
    io.to(session.id).emit('game:state', browseState(session));
  }
  pushLobbyList();
}

// Server tick: timers, boundary checks, event expiry. Referee map also
// refreshes here so moving dots stay live without extra traffic.
setInterval(() => {
  for (const lobby of [...lobbies.values()]) {
    const { game } = lobby;
    game.tick();
    if (game.activeEvent?.type === 'reveal' || game.hasExposed() || game.hasJailed()) {
      // dots move live during reveal / while someone's exposed; prison
      // progress bars tick live while a robber is serving time
      game.broadcastState();
    } else if (game.phase !== 'lobby') {
      emitStateToHosts(game);
    }
    if (lobby.emptySince && Date.now() - lobby.emptySince > LOBBY_IDLE_MS) {
      lobbies.delete(lobby.id);
      pushLobbyList();
    }
  }
}, TICK_MS);

// ── Sockets ────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  // socket.data.playerId is the SESSION id (set on join/resync).

  const session = () => sessions.get(socket.data.playerId);
  const lobbyOf = () => {
    const s = session();
    return s?.lobbyId ? lobbies.get(s.lobbyId) : null;
  };
  const gameOf = () => lobbyOf()?.game ?? null;
  const isHost = () => !!session()?.isHost;
  const reply = (ack, res) => typeof ack === 'function' && ack(res);

  const bindSession = (sess) => {
    socket.data.playerId = sess.id;
    socket.join(sess.id);
    const lobby = sess.lobbyId && lobbies.get(sess.lobbyId);
    if (lobby?.game.players.has(sess.id)) {
      socket.leave('browse');
      lobby.game.setConnected(sess.id, true);
    } else {
      sess.lobbyId = null;
      socket.join('browse');
    }
  };

  const sendState = (sess) => socket.emit('game:state', sessionState(sess));

  // Step 1: pick a username. (Host: username `host` + password.)
  socket.on('join', ({ playerId, name, hostPass } = {}, ack) => {
    const cleanName = String(name ?? '').trim().slice(0, 24);
    if (!cleanName) return reply(ack, { error: 'Pick a username' });
    const wantsHost = cleanName.toLowerCase() === HOST_USERNAME;
    if (wantsHost && hostPass !== HOST_PASSWORD) return reply(ack, { error: 'Wrong host password' });
    // Only ever reuse ids WE issued — a client can't claim someone else's.
    let sess = playerId && sessions.get(playerId);
    if (!sess) {
      sess = { id: crypto.randomUUID(), name: cleanName, isHost: wantsHost, lobbyId: null };
      sessions.set(sess.id, sess);
    }
    sess.name = wantsHost ? 'host' : cleanName;
    sess.isHost = wantsHost;
    bindSession(sess);
    const lobby = sess.lobbyId && lobbies.get(sess.lobbyId);
    if (lobby) {
      lobby.game.addPlayer({ playerId: sess.id, name: sess.name, isHost: sess.isHost });
      lobby.game.broadcastState();
    } else {
      sendState(sess);
    }
    reply(ack, { playerId: sess.id, isHost: sess.isHost });
  });

  // Full-state pull on every (re)connect — the resilience backbone.
  socket.on('resync', ({ playerId } = {}) => {
    const sess = playerId && sessions.get(playerId);
    if (!sess) return socket.emit('game:state', { unknownPlayer: true });
    bindSession(sess);
    sendState(sess);
    if (sess.lobbyId) {
      const lobby = lobbies.get(sess.lobbyId);
      if (lobby) emitStateToHosts(lobby.game);
    }
  });

  // Voluntary logout: drop the session entirely.
  socket.on('leave', () => {
    const sess = session();
    if (!sess) return;
    exitLobby(sess);
    sessions.delete(sess.id);
    socket.leave(sess.id);
    socket.leave('browse');
    socket.data.playerId = null;
  });

  // ── Step 2: lobbies ──────────────────────────────────────────────────

  socket.on('lobby:list', () => socket.emit('lobbies:list', lobbySummaries()));

  socket.on('lobby:create', ({ name } = {}, ack) => {
    const sess = session();
    if (!sess) return reply(ack, { error: 'Not joined' });
    if (!sess.isHost) return reply(ack, { error: 'Only the host can create a lobby' });
    const cleanName = String(name ?? '').trim().slice(0, 24);
    if (!cleanName) return reply(ack, { error: 'Name your lobby' });
    if ([...lobbies.values()].some((l) => l.name.toLowerCase() === cleanName.toLowerCase())) {
      return reply(ack, { error: `A lobby named "${cleanName}" already exists` });
    }
    if (sess.lobbyId) exitLobby(sess);
    enterLobby(sess, createLobby(cleanName, sess));
    reply(ack, {});
  });

  socket.on('lobby:join', ({ lobbyId } = {}, ack) => {
    const sess = session();
    const lobby = lobbies.get(lobbyId);
    if (!sess) return reply(ack, { error: 'Not joined' });
    if (!lobby) return reply(ack, { error: 'That lobby no longer exists' });
    if (sess.lobbyId === lobby.id) return reply(ack, {});
    if (sess.lobbyId) exitLobby(sess);
    enterLobby(sess, lobby);
    reply(ack, {});
  });

  socket.on('lobby:leave', () => {
    const sess = session();
    if (sess?.lobbyId) exitLobby(sess);
  });

  // Host: shut the lobby down; everyone lands back on the browse list.
  socket.on('lobby:close', () => {
    const lobby = lobbyOf();
    if (lobby && isHost()) closeLobby(lobby);
  });

  // Loss-tolerant, fire-and-forget. No acks, ever.
  socket.on('pos:update', ({ lat, lng, accuracy } = {}) => {
    const game = gameOf();
    if (game) game.updatePosition(socket.data.playerId, { lat, lng, accuracy });
  });

  // ── Step 3: teams ────────────────────────────────────────────────────

  const teamResult = (ack, game, res) => {
    if (!res.error) game.broadcastState();
    reply(ack, res.error ? { error: res.error } : {});
  };

  socket.on('team:create', ({ name } = {}, ack) => {
    const game = gameOf();
    if (!game) return reply(ack, { error: 'Not in a lobby' });
    teamResult(ack, game, game.createTeam(socket.data.playerId, name));
  });

  socket.on('team:join', ({ teamId } = {}, ack) => {
    const game = gameOf();
    if (!game) return reply(ack, { error: 'Not in a lobby' });
    teamResult(ack, game, game.joinTeamById(socket.data.playerId, teamId));
  });

  socket.on('team:leave', () => {
    const game = gameOf();
    if (game?.leaveTeam(socket.data.playerId)) game.broadcastState();
  });

  socket.on('player:ready', ({ ready } = {}) => {
    const game = gameOf();
    if (!game) return;
    game.setReady(socket.data.playerId, ready);
    game.broadcastState();
  });

  // Catch adjudication is on the CAUGHT side: the hider self-reports, or
  // the referee tags manually. Seekers cannot tag — prevents disputed /
  // trigger-happy tags; the hider's own confirmation is the ground truth.
  socket.on('tag:player', ({ targetPlayerId } = {}) => {
    const game = gameOf();
    if (game && isHost()) game.tagPlayer(targetPlayerId, socket.data.playerId);
  });

  socket.on('caught:self', () => {
    const game = gameOf();
    if (game) game.tagPlayer(socket.data.playerId, socket.data.playerId);
  });

  // ── Heist (cops & robbers) — robber task flow ────────────────────────
  // Acked: the phone needs the verdict (which mini-game, or why not).

  socket.on('task:start', ({ stationId } = {}, ack) => {
    const game = gameOf();
    if (!game) return reply(ack, { error: 'Not joined' });
    reply(ack, game.startTask(socket.data.playerId, stationId));
  });

  socket.on('task:complete', ({ stationId } = {}, ack) => {
    const game = gameOf();
    if (!game) return reply(ack, { error: 'Not joined' });
    reply(ack, game.completeTask(socket.data.playerId, stationId));
  });

  socket.on('task:cancel', () => {
    const game = gameOf();
    if (!game) return;
    game.cancelTask(socket.data.playerId);
    game.broadcastState();
  });

  // ── Host-only actions ────────────────────────────────────────────────
  // Each handler resolves the host's lobby; non-hosts and lobbyless
  // sockets fall through.
  const onHost = (event, handler) =>
    socket.on(event, (payload = {}, ack) => {
      const game = gameOf();
      if (game && isHost()) handler(game, payload ?? {}, ack);
    });

  onHost('host:startPhase', (game, { phase }) => game.startPhase(phase));

  onHost('host:trigger', (game, { type, ...opts }) => game.trigger(type, opts));

  onHost('host:config', (game, { boundary, settings, mode }) => {
    game.configure({ boundary, settings, mode });
    game.broadcastState();
  });

  // Heist lobby setup: stations + prison (lobby-only, enforced in heist.js).
  onHost('host:station:add', (game, { lat, lng, points, game: miniGame }) => {
    game.addStation({ lat, lng, points, game: miniGame });
    game.broadcastState();
  });

  onHost('host:station:update', (game, { stationId, ...changes }) => {
    game.updateStation(stationId, changes);
    game.broadcastState();
  });

  onHost('host:station:remove', (game, { stationId }) => {
    game.removeStation(stationId);
    game.broadcastState();
  });

  onHost('host:prison', (game, { lat, lng }) => {
    game.setPrison({ lat, lng });
    game.broadcastState();
  });

  // Referee overrides — the safety net when GPS won't cooperate.
  onHost('host:heist', (game, { action, playerId, stationId, delta }) => {
    if (!game.isHeist()) return;
    if (action === 'catch') game.catchRobber(playerId, socket.data.playerId);
    else if (action === 'release') game.releaseRobber(playerId);
    else if (action === 'credit') {
      const s = game.heist.stations.get(stationId);
      if (s?.active && game.phase === 'seek') game.creditStation(s);
    } else if (action === 'score') game.adjustScore(delta);
  });

  onHost('host:setTeamRole', (game, { teamId, role }) => {
    game.setTeamRole(teamId, role);
    game.broadcastState();
  });

  // Lobby team management: delete (members become teamless), move, shuffle.
  onHost('host:deleteTeam', (game, { teamId }) => {
    if (game.removeTeam(teamId, { kick: false })) game.broadcastState();
  });

  onHost('host:movePlayer', (game, { playerId, teamId }, ack) => {
    const res = game.movePlayer(playerId, teamId ?? null);
    if (!res.error) game.broadcastState();
    reply(ack, res);
  });

  onHost('host:randomize', (game) => {
    if (game.randomizeTeams()) game.broadcastState();
  });

  onHost('host:reset', (game) => game.startPhase('lobby'));

  // Kick = back to the browse list (not a ban — they can pick a lobby again).
  onHost('host:kick', (game, { targetPlayerId }) => {
    const target = sessions.get(targetPlayerId);
    if (!target || target.lobbyId !== lobbyOf().id || target.isHost) return;
    exitLobby(target, 'kicked');
  });

  // Surface disconnects — referee view greys out quiet phones. A dropped
  // connection NEVER removes anyone from a team or deletes a team.
  socket.on('disconnect', () => {
    const sess = session();
    const lobby = sess?.lobbyId && lobbies.get(sess.lobbyId);
    if (lobby) {
      lobby.game.setConnected(sess.id, false);
      emitStateToHosts(lobby.game);
      pushLobbyList();
    }
  });
});

// ── Static client (production build) ──────────────────────────────────

const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('/healthz', (_req, res) => res.json({ ok: true, lobbies: lobbies.size }));
// SPA fallback (Express 4: '*' catch-all after static)
app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));

httpServer.listen(PORT, () => {
  console.log(`Lampas listening on http://localhost:${PORT}`);
});
