/**
 * socket.js — single shared Socket.IO client, tuned for outdoor mobile
 * (short, frequent drops from screen lock / calls / backgrounding).
 *
 * Resilience contract with the server (see CLAUDE.md):
 * on EVERY connect (first or re-), emit `resync` with our playerId and the
 * server replies with full current state. We never replay missed events.
 */

import { io } from 'socket.io-client';

const STORAGE_KEY = 'lampas.playerId';

export function getStoredPlayerId() {
  return localStorage.getItem(STORAGE_KEY);
}

export function storePlayerId(id) {
  localStorage.setItem(STORAGE_KEY, id);
}

export function clearPlayerId() {
  localStorage.removeItem(STORAGE_KEY);
}

// Name + team persist too, so a phone can silently re-join after a server
// restart (playerId is server-lifetime only; creds outlive it).
const CREDS_KEY = 'lampas.creds';

export function getStoredCreds() {
  try {
    return JSON.parse(localStorage.getItem(CREDS_KEY)) ?? null;
  } catch {
    return null;
  }
}

export function storeCreds({ name, teamName }) {
  localStorage.setItem(CREDS_KEY, JSON.stringify({ name, teamName }));
}

// Server URL resolution:
// - VITE_SERVER_URL set (split deploy, e.g. client on Vercel, server on
//   Render/Railway/Fly) → connect there. Must be https:// in production.
// - unset → same-origin: Vite proxies /socket.io in dev; the Node server
//   serves both in the monolith deploy.
const SERVER_URL = import.meta.env.VITE_SERVER_URL || undefined;

export const socket = io(SERVER_URL, {
  reconnection: true,
  reconnectionDelay: 500, // retry fast — drops are short
  reconnectionDelayMax: 3000,
  timeout: 8000,
  autoConnect: true,
});

/**
 * Dev-mode hook: when an interceptor is installed (see dev/DevApp.jsx),
 * every socket.emit from any screen is swallowed and routed to the local
 * mock engine instead of the wire. Screens never know the difference —
 * that's the point: the dev view exercises the REAL components.
 */
let emitInterceptor = null;
export function setEmitInterceptor(fn) {
  emitInterceptor = fn;
}
const realEmit = socket.emit.bind(socket);
socket.emit = (event, ...args) => {
  if (emitInterceptor) {
    emitInterceptor(event, ...args);
    return socket;
  }
  return realEmit(event, ...args);
};

socket.on('connect', () => {
  const playerId = getStoredPlayerId();
  if (playerId) socket.emit('resync', { playerId });
});

// When the tab comes back from background (JS was suspended, socket likely
// dropped), force a reconnect check + resync instead of waiting for timers.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!socket.connected) socket.connect();
    else {
      const playerId = getStoredPlayerId();
      if (playerId) socket.emit('resync', { playerId });
    }
  }
});
