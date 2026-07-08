/**
 * index.js — single Node service: serves the React build AND the WebSocket.
 * One HTTPS URL, nothing to coordinate (see CLAUDE.md → Architecture).
 *
 * Core resilience principle: server is authoritative; clients emit `resync`
 * on every (re)connect and get the full role-appropriate state back. No
 * per-packet delivery guarantees anywhere.
 */

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

// ── Game instance + transport mapping ─────────────────────────────────

/**
 * Game emits domain events; this hook maps them onto Socket.IO rooms.
 * Rooms in use:
 *   - player id      → that player's sockets
 *   - team id        → team-wide messages (boundary warnings)
 *   - 'referees'     → host/referee sockets (get full state incl. positions)
 *   - (no room)      → broadcast
 * `perPlayer: true` fans out role-appropriate `game:state` to every player.
 */
// State for one player: hosts get the referee payload (positions included)
// BUILT ON TOP of their player payload, so `you` is always present.
const stateFor = (player) =>
  player.isHost ? game.refereeState(player.id) : game.playerState(player.id);

const emitStateToHosts = () => {
  for (const player of game.players.values()) {
    if (player.isHost) io.to(player.id).emit('game:state', game.refereeState(player.id));
  }
};

const game = new Game((event, payload, scope = {}) => {
  if (scope.perPlayer) {
    for (const player of game.players.values()) {
      io.to(player.id).emit('game:state', stateFor(player));
    }
    return;
  }
  if (scope.room) io.to(scope.room).emit(event, payload);
  else io.emit(event, payload);
});

// Server tick: timers, boundary checks, event expiry. Referee map also
// refreshes here so moving dots stay live without extra traffic.
setInterval(() => {
  game.tick();
  if (game.phase !== 'lobby') emitStateToHosts();
}, TICK_MS);

// ── Sockets ────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  // socket.data.playerId is set on join/resync and used for room targeting.

  const bindPlayer = (playerId) => {
    const player = game.players.get(playerId);
    if (!player) return null;
    socket.data.playerId = player.id;
    socket.join(player.id);
    if (player.teamId) socket.join(player.teamId);
    if (player.isHost) socket.join('referees');
    game.setConnected(player.id, true);
    return player;
  };

  const sendState = (player) => {
    socket.emit('game:state', stateFor(player));
  };

  socket.on('join', ({ playerId, name, teamName, hostPass } = {}, ack) => {
    const wantsHost = String(name ?? '').trim().toLowerCase() === HOST_USERNAME;
    if (wantsHost && hostPass !== HOST_PASSWORD) {
      if (typeof ack === 'function') ack({ error: 'Wrong host password' });
      return;
    }
    // Hosts are referees, not team members — teamName is ignored for them.
    const player = game.addPlayer({
      playerId,
      name,
      teamName: wantsHost ? undefined : teamName,
      isHost: wantsHost,
    });
    bindPlayer(player.id);
    if (typeof ack === 'function') ack({ playerId: player.id, isHost: player.isHost });
    game.broadcastState();
  });

  // Full-state pull on every (re)connect — the resilience backbone.
  socket.on('resync', ({ playerId } = {}) => {
    const player = bindPlayer(playerId);
    if (player) sendState(player);
    else socket.emit('game:state', { phase: game.phase, unknownPlayer: true });
  });

  // Loss-tolerant, fire-and-forget. No acks, ever.
  socket.on('pos:update', ({ lat, lng } = {}) => {
    if (socket.data.playerId) game.updatePosition(socket.data.playerId, { lat, lng });
  });

  socket.on('team:join', ({ teamName } = {}) => {
    if (!socket.data.playerId) return;
    // Leave old team room, join new one.
    const player = game.players.get(socket.data.playerId);
    if (player?.teamId) socket.leave(player.teamId);
    const team = game.joinTeam(socket.data.playerId, teamName);
    if (team) socket.join(team.id);
    game.broadcastState();
  });

  socket.on('player:ready', ({ ready } = {}) => {
    if (!socket.data.playerId) return;
    game.setReady(socket.data.playerId, ready);
    game.broadcastState();
  });

  // Catch adjudication is on the CAUGHT side: the hider self-reports, or
  // the referee tags manually. Seekers cannot tag — prevents disputed /
  // trigger-happy tags; the hider's own confirmation is the ground truth.
  socket.on('tag:player', ({ targetPlayerId } = {}) => {
    if (isHost()) game.tagPlayer(targetPlayerId, socket.data.playerId);
  });

  socket.on('caught:self', () => {
    if (socket.data.playerId) game.tagPlayer(socket.data.playerId, socket.data.playerId);
  });

  // ── Host-only actions ────────────────────────────────────────────────
  const isHost = () => game.players.get(socket.data.playerId)?.isHost;

  socket.on('host:startPhase', ({ phase } = {}) => {
    if (isHost()) game.startPhase(phase);
  });

  socket.on('host:trigger', ({ type } = {}) => {
    if (isHost()) game.trigger(type);
  });

  socket.on('host:config', ({ boundary, settings } = {}) => {
    if (!isHost()) return;
    game.configure({ boundary, settings });
    game.broadcastState();
  });

  socket.on('host:setTeamRole', ({ teamId, role } = {}) => {
    if (!isHost()) return;
    game.setTeamRole(teamId, role);
    game.broadcastState();
  });

  socket.on('host:reset', () => {
    if (isHost()) game.startPhase('lobby');
  });

  // Voluntary logout. Same rules as a kick (lobby-only, hosts stay) —
  // mid-game the record survives and just greys out on the referee map.
  socket.on('leave', () => {
    if (!socket.data.playerId) return;
    const removed = game.removePlayer(socket.data.playerId);
    if (removed) {
      socket.data.playerId = null;
      game.broadcastState();
    }
  });

  socket.on('host:kick', ({ targetPlayerId } = {}) => {
    if (!isHost()) return;
    const removed = game.removePlayer(targetPlayerId);
    if (!removed) return;
    // Tell the kicked phone first (it resets to the join screen and drops
    // its stored playerId so it doesn't silently auto-rejoin), then update
    // everyone else. Their socket stays connected — it's just playerless.
    io.to(removed.id).emit('kicked', { by: game.players.get(socket.data.playerId)?.name });
    game.broadcastState();
  });

  // Surface disconnects — referee view greys out quiet phones.
  socket.on('disconnect', () => {
    if (socket.data.playerId) {
      game.setConnected(socket.data.playerId, false);
      emitStateToHosts();
    }
  });
});

// ── Static client (production build) ──────────────────────────────────

const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('/healthz', (_req, res) => res.json({ ok: true, phase: game.phase }));
// SPA fallback (Express 4: '*' catch-all after static)
app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));

httpServer.listen(PORT, () => {
  console.log(`Lampas listening on http://localhost:${PORT}`);
});
