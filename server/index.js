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
const game = new Game((event, payload, scope = {}) => {
  if (scope.perPlayer) {
    for (const player of game.players.values()) {
      io.to(player.id).emit('game:state', game.playerState(player.id));
    }
    io.to('referees').emit('game:state', game.refereeState());
    return;
  }
  if (scope.room) io.to(scope.room).emit(event, payload);
  else io.emit(event, payload);
});

// Server tick: timers, boundary checks, event expiry. Referee map also
// refreshes here so moving dots stay live without extra traffic.
setInterval(() => {
  game.tick();
  if (game.phase !== 'lobby') io.to('referees').emit('game:state', game.refereeState());
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
    socket.emit(
      'game:state',
      player.isHost ? game.refereeState() : game.playerState(player.id),
    );
  };

  socket.on('join', ({ playerId, name, teamName } = {}, ack) => {
    const player = game.addPlayer({ playerId, name, teamName });
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

  socket.on('tag:player', ({ targetPlayerId } = {}) => {
    game.tagPlayer(targetPlayerId, socket.data.playerId);
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

  // Surface disconnects — referee view greys out quiet phones.
  socket.on('disconnect', () => {
    if (socket.data.playerId) {
      game.setConnected(socket.data.playerId, false);
      io.to('referees').emit('game:state', game.refereeState());
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
