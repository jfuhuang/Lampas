import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import {
  socket,
  getStoredPlayerId,
  storePlayerId,
  getStoredCreds,
  storeCreds,
} from '../lib/socket.js';
import {
  startPositionStream,
  playRevealTone,
  vibrate,
  enableTorch,
  disableTorch,
} from '../lib/geo.js';

/**
 * GameContext — single owner of the socket subscription, the authoritative
 * game-state mirror, credentials persistence, the position stream, and
 * event overlays. Screens consume it via hooks (useGame / useToast) instead
 * of prop-drilling `game` down the tree.
 */
const GameContext = createContext(null);

// Exported so dev/DevApp.jsx can mount screens against a mock value.
export { GameContext };

export function GameProvider({ children }) {
  const [game, setGame] = useState(null); // last `game:state` payload
  const [joined, setJoined] = useState(!!getStoredPlayerId());
  const [connected, setConnected] = useState(socket.connected);
  const [torchActive, setTorchActive] = useState(false);
  const [toast, setToast] = useState(null); // { text, tone, at }
  const soundPlayedFor = useRef(0); // dedupe sound event across resyncs
  const autoRejoined = useRef(false); // one silent re-join per server life

  const showToast = useCallback((text, tone = 'info') => {
    setToast({ text, tone, at: Date.now() });
  }, []);

  const join = useCallback((name, teamName) => {
    socket.emit('join', { playerId: getStoredPlayerId(), name, teamName }, (res) => {
      storePlayerId(res.playerId);
      storeCreds({ name, teamName });
      setJoined(true);
    });
  }, []);

  // ── Socket subscriptions ─────────────────────────────────────────────
  useEffect(() => {
    const onState = (state) => {
      if (state.unknownPlayer) {
        // Server restarted and lost our playerId. If we have stored creds,
        // silently re-join with the same name + team; otherwise show Join.
        const creds = getStoredCreds();
        if (creds && !autoRejoined.current) {
          autoRejoined.current = true;
          socket.emit('join', { name: creds.name, teamName: creds.teamName }, (res) => {
            storePlayerId(res.playerId);
            setJoined(true);
          });
          return;
        }
        setJoined(false);
        setGame(null);
        return;
      }
      autoRejoined.current = false; // healthy state → re-arm the auto-rejoin
      setGame(state);
      // Derive overlays from authoritative state so a resync after a drop
      // still shows/hides them correctly (never rely on event packets).
      const ev = state.activeEvent;
      setTorchActive(ev?.type === 'torch');
      if (ev?.type === 'sound' && ev.endsAt !== soundPlayedFor.current) {
        soundPlayedFor.current = ev.endsAt;
        const secondsLeft = Math.max(1, (ev.endsAt - state.serverNow) / 1000);
        // Only HIDER phones make noise (audible reveal); everyone vibrates.
        if (state.you?.role === 'hider') playRevealTone(secondsLeft);
        vibrate();
      }
    };

    const onTorch = () => {
      setTorchActive(true);
      vibrate();
      enableTorch(); // Android bonus; harmless no-op on iOS
    };
    const onConverted = ({ teamName, caughtPlayerName }) =>
      showToast(`${caughtPlayerName} caught — team ${teamName} are now seekers!`, 'alert');
    const onWarning = ({ metersOutside, graceSeconds }) => {
      vibrate([200, 100, 200]);
      showToast(
        metersOutside != null
          ? `OUT OF BOUNDS — ${metersOutside}m outside. Get back within ${graceSeconds}s!`
          : 'A team is out of bounds',
        'warn',
      );
    };
    const onShrink = () => showToast('THE ZONE IS SHRINKING — check the boundary!', 'warn');
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    socket.on('game:state', onState);
    socket.on('event:torch', onTorch);
    socket.on('event:shrink', onShrink);
    socket.on('team:converted', onConverted);
    socket.on('boundary:warning', onWarning);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    return () => {
      socket.off('game:state', onState);
      socket.off('event:torch', onTorch);
      socket.off('event:shrink', onShrink);
      socket.off('team:converted', onConverted);
      socket.off('boundary:warning', onWarning);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, [showToast]);

  // Torch overlay closes when the event expires (server drives via state)
  useEffect(() => {
    if (!torchActive) disableTorch();
  }, [torchActive]);

  // ── Position streaming (hide + seek phases) ──────────────────────────
  const phase = game?.phase ?? 'lobby';
  useEffect(() => {
    if (!joined || (phase !== 'hide' && phase !== 'seek')) return undefined;
    const stop = startPositionStream(
      (pos) => socket.emit('pos:update', pos),
      () => showToast('GPS unavailable — check location permission', 'warn'),
    );
    return stop;
  }, [joined, phase, showToast]);

  const value = {
    game,
    you: game?.you ?? null,
    phase,
    joined,
    connected,
    torchActive,
    toast,
    dismissToast: () => setToast(null),
    showToast,
    join,
  };

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}

/** Full game context: { game, you, phase, joined, connected, join, … } */
export function useGame() {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be used inside <GameProvider>');
  return ctx;
}

/** Just the toast trigger — for screens that only notify. */
export function useToast() {
  return useGame().showToast;
}
