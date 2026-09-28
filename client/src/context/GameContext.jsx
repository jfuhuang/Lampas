import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import {
  socket,
  getStoredPlayerId,
  storePlayerId,
  clearPlayerId,
  getStoredCreds,
  storeCreds,
  clearCreds,
} from '../lib/socket.js';
import {
  startPositionStream,
  playRevealTone,
  vibrate,
  enableTorch,
  disableTorch,
  requestWakeLock,
  startCompass,
  unlockAudioOnFirstGesture,
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
  const [lobbies, setLobbies] = useState([]); // browse-list summaries
  const [joined, setJoined] = useState(!!getStoredPlayerId());
  const [connected, setConnected] = useState(socket.connected);
  const [torchActive, setTorchActive] = useState(false);
  const [myPos, setMyPos] = useState(null); // own GPS only — never others'
  const [heading, setHeading] = useState(null); // compass degrees, device-local
  const [toast, setToast] = useState(null); // { text, tone, at }
  const soundPlayedFor = useRef(0); // dedupe sound event across resyncs
  const revealToastFor = useRef(0); // dedupe reveal toast across resyncs
  const isHostRef = useRef(false); // event packets arrive outside React state
  const autoRejoined = useRef(false); // silent re-join in flight (guards stale unknownPlayer replies)

  const showToast = useCallback((text, tone = 'info') => {
    setToast({ text, tone, at: Date.now() });
  }, []);

  const join = useCallback(
    (name, hostPass) => {
      socket.emit(
        'join',
        { playerId: getStoredPlayerId(), name, hostPass },
        (res) => {
          if (res.error) {
            showToast(res.error, 'alert');
            return;
          }
          storePlayerId(res.playerId);
          storeCreds({ name, hostPass });
          setJoined(true);
        },
      );
    },
    [showToast],
  );

  /** Acked server action; failures surface as an alert toast. */
  const request = useCallback(
    (event, payload) =>
      new Promise((resolve) => {
        socket.emit(event, payload, (res) => {
          if (res?.error) showToast(res.error, 'alert');
          resolve(res ?? {});
        });
      }),
    [showToast],
  );

  const leaveLobby = useCallback(() => socket.emit('lobby:leave'), []);

  /** Full local sign-out: wipe stored identity + creds, back to Join. */
  const logout = useCallback(() => {
    socket.emit('leave'); // server drops us from the lobby roster (lobby only)
    clearPlayerId();
    clearCreds();
    setJoined(false);
    setGame(null);
  }, []);

  // ── Socket subscriptions ─────────────────────────────────────────────
  useEffect(() => {
    const onState = (state) => {
      if (state.unknownPlayer) {
        // Server restarted and lost our session. If we have stored creds,
        // silently re-join with the same username; otherwise show Join.
        // Stale resyncs (sent with the old playerId before the re-join ack
        // lands) also answer unknownPlayer — ignore them while one re-join
        // is in flight, never bounce a creds-holding user back to Join.
        const creds = getStoredCreds();
        if (!creds) {
          setJoined(false);
          setGame(null);
          return;
        }
        if (!autoRejoined.current) {
          autoRejoined.current = true;
          socket.emit(
            'join',
            { name: creds.name, hostPass: creds.hostPass },
            (res) => {
              autoRejoined.current = false;
              if (res.error) {
                // e.g. host password changed server-side — fall back to Join.
                setJoined(false);
                setGame(null);
                return;
              }
              storePlayerId(res.playerId);
              setJoined(true);
              socket.emit('resync', { playerId: res.playerId });
            },
          );
        }
        return;
      }
      setGame(state);
      if (state.lobbies) setLobbies(state.lobbies);
      isHostRef.current = !!state.you?.isHost;
      // Derive overlays from authoritative state so a resync after a drop
      // still shows/hides them correctly (never rely on event packets).
      // The HOST is exempt from all curveball effects — the referee panel
      // must stay usable while everyone else's screen flashes/rings.
      const ev = state.activeEvent;
      setTorchActive(ev?.type === 'torch' && !state.you?.isHost);
      if (ev?.type === 'sound' && ev.endsAt !== soundPlayedFor.current) {
        soundPlayedFor.current = ev.endsAt;
        const secondsLeft = Math.max(1, (ev.endsAt - state.serverNow) / 1000);
        // Only HIDER phones make noise (audible reveal); players vibrate.
        if (state.you?.role === 'hider' && !playRevealTone(secondsLeft)) {
          showToast('🔊 SOUND EVENT — tap anywhere once to enable sound on this phone', 'alert');
        }
        if (!state.you?.isHost) vibrate();
      }
      if (ev?.type === 'reveal' && ev.endsAt !== revealToastFor.current) {
        revealToastFor.current = ev.endsAt;
        if (!state.you?.isHost) {
          vibrate();
          showToast('📍 ALL LOCATIONS REVEALED — check the map!', 'alert');
        }
      }
    };

    const onTorch = () => {
      if (isHostRef.current) return; // referee screen never flashes
      setTorchActive(true);
      vibrate();
      enableTorch(); // Android bonus; harmless no-op on iOS
    };
    const onConverted = ({ teamName, caughtPlayerName }) =>
      showToast(`${caughtPlayerName} caught — team ${teamName} are now seekers!`, 'alert');
    const onWarning = ({ metersOutside, teamName }) => {
      vibrate([200, 100, 200]);
      showToast(
        metersOutside != null
          ? `OUT OF BOUNDS — ${metersOutside}m outside. Your location is now VISIBLE to everyone until you're back in!`
          : `Team ${teamName ?? ''} is out of bounds — their dots are exposed`,
        'warn',
      );
    };
    // Heist (cops & robbers) — fast-path toasts; state still comes via game:state.
    const onHeistCaught = ({ name }) => showToast(`🚨 ${name} was caught — off to prison!`, 'alert');
    const onHeistReleased = () => {
      vibrate([100, 60, 100]);
      showToast('🛡 Released! You are IMMUNE for a bit — get back to work', 'info');
    };
    const onHeistScore = ({ name, points, score }) =>
      showToast(`💰 +${points}${name ? ` — ${name} cracked a station` : ''} (total ${score})`, 'info');
    const onShrink = () => showToast('THE ZONE IS SHRINKING — check the boundary!', 'warn');
    // Kicked / lobby closed: the session survives, the server drops us on
    // the browse list (its own game:state follows this event).
    const onKicked = ({ reason, lobbyName } = {}) =>
      showToast(
        reason === 'lobby-closed'
          ? `The host closed ${lobbyName ?? 'the lobby'}`
          : 'The host removed you from the lobby',
        'alert',
      );
    const onLobbies = (list) => setLobbies(list);
    const onConnect = () => setConnected(true);
    const onDisconnect = () => {
      setConnected(false);
      autoRejoined.current = false; // a lost re-join ack must not wedge us
    };

    socket.on('game:state', onState);
    socket.on('event:torch', onTorch);
    socket.on('event:shrink', onShrink);
    socket.on('team:converted', onConverted);
    socket.on('boundary:warning', onWarning);
    socket.on('kicked', onKicked);
    socket.on('lobbies:list', onLobbies);
    socket.on('heist:score', onHeistScore);
    socket.on('heist:released', onHeistReleased);
    socket.on('heist:caught', onHeistCaught);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    // The module-level connect handler may have resynced BEFORE these
    // listeners existed (its game:state reply was lost). Now that we're
    // subscribed, pull state again if the socket is already up.
    if (socket.connected) {
      const pid = getStoredPlayerId();
      if (pid) socket.emit('resync', { playerId: pid });
      setConnected(true);
    }
    return () => {
      socket.off('game:state', onState);
      socket.off('event:torch', onTorch);
      socket.off('event:shrink', onShrink);
      socket.off('team:converted', onConverted);
      socket.off('boundary:warning', onWarning);
      socket.off('kicked', onKicked);
      socket.off('lobbies:list', onLobbies);
      socket.off('heist:score', onHeistScore);
      socket.off('heist:released', onHeistReleased);
      socket.off('heist:caught', onHeistCaught);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, [showToast]);

  // Any first tap unlocks audio (Ready button isn't the only path in).
  useEffect(() => {
    unlockAudioOnFirstGesture();
  }, []);

  // Torch overlay closes when the event expires (server drives via state)
  useEffect(() => {
    if (!torchActive) disableTorch();
  }, [torchActive]);

  // ── Position streaming (hide + seek phases) ──────────────────────────
  const phase = game?.phase ?? 'lobby';
  useEffect(() => {
    if (!joined || game?.browse || (phase !== 'hide' && phase !== 'seek')) return undefined;
    // Safety net for players who skipped Ready or reloaded mid-game: the
    // Wake Lock API needs no gesture, so grab it whenever play is live.
    requestWakeLock();
    // Compass heading for the map arrow (iOS permission came from Ready).
    const stopCompass = startCompass(setHeading);
    const stop = startPositionStream(
      (pos) => {
        setMyPos(pos); // local echo for the player boundary map
        socket.emit('pos:update', pos);
      },
      () => showToast('GPS unavailable — check location permission', 'warn'),
    );
    return () => {
      stop();
      stopCompass();
    };
  }, [joined, phase, game?.browse, showToast]);

  const value = {
    game,
    lobbies,
    request,
    you: game?.you ?? null,
    phase,
    joined,
    connected,
    torchActive,
    myPos,
    heading,
    toast,
    dismissToast: () => setToast(null),
    showToast,
    join,
    leaveLobby,
    logout,
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
