import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { GameContext } from '../context/GameContext.jsx';
import { socket, setEmitInterceptor } from '../lib/socket.js';
import { unlockAudio, playRevealTone, vibrate } from '../lib/geo.js';
import { makeScenario, applyAction, tick, toGamePayload, personas, seedHeist } from './engine.js';
import JoinScreen from '../screens/JoinScreen.jsx';
import Lobby from '../screens/Lobby.jsx';
import HiderView, { GameOver } from '../screens/HiderView.jsx';
import SeekerView from '../screens/SeekerView.jsx';
import RobberView from '../screens/RobberView.jsx';
import CopView from '../screens/CopView.jsx';
import HostView from '../screens/HostView.jsx';
import RefereeView from '../screens/RefereeView.jsx';
import TorchOverlay from '../components/TorchOverlay.jsx';
import Toast from '../components/Toast.jsx';
import HiderTeamsBadge from '../components/HiderTeamsBadge.jsx';

/**
 * Dev view — open the app with `?dev` in the URL (e.g. localhost:5173/?dev).
 *
 * Renders the REAL screens against a local mock engine (dev/engine.js):
 * - socket.emit is intercepted, so every button in every screen mutates the
 *   mock state instead of the wire (the real socket is disconnected).
 * - Bots drift on the referee map each second; timers and curveballs run.
 * - Swap screens and personas freely, or leave "auto" to see exactly what
 *   the chosen persona would see in the current phase.
 */

const SCREENS = ['auto', 'join', 'lobby', 'hider', 'seeker', 'robber', 'cop', 'host', 'referee', 'over'];

export default function DevApp() {
  const [state, setStateRaw] = useState(makeScenario);
  // Mirror for synchronous reads: acked events (task:start/complete) need
  // their result immediately, not after React flushes the update.
  const stateRef = useRef(state);
  const setState = useCallback((next) => {
    setStateRaw((prev) => {
      const s = typeof next === 'function' ? next(prev) : next;
      stateRef.current = s;
      return s;
    });
  }, []);
  const [screen, setScreen] = useState('auto');
  const [toast, setToast] = useState(null);
  const [running, setRunning] = useState(true);

  const showToast = useCallback((text, tone = 'info') => {
    setToast({ text, tone, at: Date.now() });
  }, []);

  const dispatch = useCallback(
    (event, payload, ack) => {
      const next = applyAction(stateRef.current, event, payload);
      stateRef.current = next;
      setState(next);
      if (typeof ack === 'function') setTimeout(() => ack(next.lastAck ?? {}), 150); // fake RTT
      // Side effects the real GameProvider would produce:
      if (event === 'host:trigger' && payload?.type === 'sound') {
        unlockAudio(); // button click = the required gesture
        playRevealTone(3); // short burst — it's a dev tool, not a siren test
        vibrate(); // (production: host phones stay silent; dev keeps the
        // burst as button feedback regardless of persona)
      }
      if (event === 'host:trigger' && payload?.type === 'shrink') {
        showToast('THE ZONE IS SHRINKING — check the boundary!', 'warn');
      }
    },
    [showToast, setState],
  );

  // Swallow every socket.emit from the real screens; kill the real socket.
  useEffect(() => {
    setEmitInterceptor((event, payload, ack) => dispatch(event, payload, ack));
    socket.disconnect();
    return () => {
      setEmitInterceptor(null);
      socket.connect();
    };
  }, [dispatch]);

  // 1s sim tick: timers, event expiry, bot drift.
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => setState((s) => tick(s)), 1000);
    return () => clearInterval(t);
  }, [running, setState]);

  const game = useMemo(() => toGamePayload(state), [state]);
  const torchActive = game.activeEvent?.type === 'torch';

  // Mock context value — same shape GameProvider supplies.
  const ctx = {
    game,
    you: game.you,
    phase: game.phase,
    joined: true,
    connected: true,
    torchActive,
    myPos: state.positions.find((p) => p.playerId === state.youId) ?? null,
    heading: 45, // fixed fake heading so the arrow renders in dev
    toast,
    dismissToast: () => setToast(null),
    showToast,
    join: (name, teamName) => dispatch('join', { name, teamName }),
    logout: () => showToast('Dev mode — logout is a no-op here', 'info'),
  };

  return (
    <GameContext.Provider value={ctx}>
      <div className="flex min-h-dvh flex-col">
        <DevBar
          state={state}
          setState={setState}
          screen={screen}
          setScreen={setScreen}
          running={running}
          setRunning={setRunning}
          dispatch={dispatch}
          showToast={showToast}
        />
        <div className="mx-auto flex w-full max-w-lg flex-1 flex-col px-4 pb-6 lg:max-w-6xl">
          <ScreenFor key={`${screen}-${state.youId}`} screen={screen} game={game} />
        </div>
        {/* Below the dev bar (which is ~fixed at the top and z-40) */}
        <HiderTeamsBadge position="right-3 top-32" />
        {/* Host persona is exempt from the flash, same as production */}
        {torchActive && !game.you?.isHost && <TorchOverlay />}
        {toast && <Toast key={toast.at} {...toast} onDone={() => setToast(null)} />}
      </div>
    </GameContext.Provider>
  );
}

/** Forced screen, or 'auto' = the real Router logic for the current persona. */
function ScreenFor({ screen, game }) {
  const you = game.you;
  switch (screen) {
    case 'join':
      return <JoinScreen />;
    case 'lobby':
      return <Lobby />;
    case 'hider':
      return <HiderView />;
    case 'seeker':
      return <SeekerView />;
    case 'robber':
      return <RobberView />;
    case 'cop':
      return <CopView />;
    case 'host':
      return <HostView />;
    case 'referee':
      return <RefereeView />;
    case 'over':
      return <GameOver />;
    default: // auto — mirror App.jsx routing
      if (you.isHost) return <HostView />;
      if (game.phase === 'lobby') return <Lobby />;
      if (game.mode === 'heist') return you.role === 'seeker' ? <CopView /> : <RobberView />;
      if (you.role === 'seeker') return <SeekerView />;
      return <HiderView />;
  }
}

/* ── Control bar ─────────────────────────────────────────────────────── */

function DevBar({ state, setState, screen, setScreen, running, setRunning, dispatch, showToast }) {
  const botCatch = () => {
    const victims = state.teams.filter(
      (t) => t.role === 'hider' && !t.players.some((p) => p.id === state.youId),
    );
    const victim = victims[Math.floor(Math.random() * victims.length)];
    if (!victim) return showToast('No catchable bot team left', 'warn');
    if (state.phase !== 'seek') return showToast('Bot catch needs seek phase', 'warn');
    dispatch('tag:player', { targetPlayerId: victim.players[0].id });
    showToast(`${victim.players[0].name} caught — team ${victim.name} are now seekers!`, 'alert');
  };

  // Heist drivers: teleport YOUR dot (no GPS in dev) + jail a bot robber.
  const teleport = (pt) =>
    setState((s) => ({
      ...s,
      positions: s.positions.map((p) =>
        p.playerId === s.youId ? { ...p, lat: pt.lat, lng: pt.lng, at: Date.now() } : p,
      ),
    }));
  const goStation = () => {
    const st = state.heist.stations.find((x) => x.active);
    if (!st) return showToast('No live station — start scatter/heist first', 'warn');
    teleport(st);
  };
  const goPrison = () =>
    state.heist.prison ? teleport(state.heist.prison) : showToast('No prison placed', 'warn');
  const botJail = () => {
    const bot = state.teams
      .filter((t) => t.role === 'hider')
      .flatMap((t) => t.players)
      .find((p) => p.id !== state.youId && (state.heist.robbers[p.id]?.status ?? 'free') === 'free');
    if (!bot || state.phase !== 'seek') return showToast('Needs heist phase + a free bot robber', 'warn');
    dispatch('host:heist', { action: 'catch', playerId: bot.id });
    showToast(`🚨 ${bot.name} was caught — off to prison!`, 'alert');
  };

  const oobWarn = () =>
    showToast('OUT OF BOUNDS — 37m outside. Get back within 30s!', 'warn');

  return (
    <div className="sticky top-0 z-40 border-b-2 border-fuchsia-700 bg-[#1a0d1f]/95 px-3 py-2 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-col gap-1.5">
        {/* Row 1: identity */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded bg-fuchsia-700 px-1.5 py-0.5 text-[10px] font-black tracking-widest text-white">
            DEV
          </span>
          <span className="text-[11px] font-bold text-fuchsia-300">
            phase: {state.phase}
          </span>
          <select
            value={state.youId}
            onChange={(e) => setState((s) => ({ ...s, youId: e.target.value }))}
            className="rounded-md border border-fuchsia-800 bg-night px-1.5 py-1 text-xs font-bold text-fuchsia-100"
          >
            {personas(state).map((p) => (
              <option key={p.id} value={p.id}>
                You are: {p.label}
              </option>
            ))}
          </select>
          <button onClick={() => setRunning(!running)} className={chip(running)}>
            {running ? '⏸ sim' : '▶ sim'}
          </button>
          <button onClick={() => setState(makeScenario())} className={chip(false)}>
            ↺ reset
          </button>
        </div>

        {/* Row 2: screen picker */}
        <div className="flex flex-wrap gap-1">
          {SCREENS.map((sc) => (
            <button key={sc} onClick={() => setScreen(sc)} className={chip(screen === sc)}>
              {sc}
            </button>
          ))}
        </div>

        {/* Row 3: gameplay drivers */}
        <div className="flex flex-wrap gap-1">
          {['lobby', 'hide', 'seek'].map((ph) => (
            <button
              key={ph}
              onClick={() => dispatch('host:startPhase', { phase: ph })}
              className={chip(state.phase === ph, 'sky')}
            >
              ▶ {ph}
            </button>
          ))}
          <button onClick={() => dispatch('host:trigger', { type: 'sound' })} className={chip(false, 'amber')}>
            🔊 sound
          </button>
          <button onClick={() => dispatch('host:trigger', { type: 'torch' })} className={chip(false, 'amber')}>
            🔦 torch
          </button>
          <button onClick={() => dispatch('host:trigger', { type: 'shrink' })} className={chip(false, 'amber')}>
            ⭕ shrink
          </button>
          <button onClick={() => dispatch('host:trigger', { type: 'reveal' })} className={chip(false, 'amber')}>
            📍 reveal
          </button>
          <button onClick={botCatch} className={chip(false, 'red')}>
            🎯 bot catch
          </button>
          <button onClick={oobWarn} className={chip(false, 'red')}>
            ⚠ OOB warn
          </button>
        </div>

        {/* Row 4: heist (cops & robbers) */}
        <div className="flex flex-wrap gap-1">
          <button
            onClick={() => setState((s) => seedHeist(s))}
            className={chip(state.mode === 'heist', 'violet')}
          >
            💰 heist mode + layout
          </button>
          <button onClick={goStation} className={chip(false, 'violet')}>
            📍 me → station
          </button>
          <button onClick={goPrison} className={chip(false, 'violet')}>
            🔒 me → prison
          </button>
          <button onClick={botJail} className={chip(false, 'red')}>
            🚨 bot jail
          </button>
        </div>
      </div>
    </div>
  );
}

function chip(active, hue = 'fuchsia') {
  const on = {
    fuchsia: 'bg-fuchsia-600 text-white',
    sky: 'bg-sky-600 text-white',
    amber: 'bg-amber-500 text-night',
    red: 'bg-red-600 text-white',
    violet: 'bg-violet-600 text-white',
  }[hue];
  return `rounded-md px-2 py-1 text-xs font-bold active:scale-95 ${
    active ? on : 'bg-neutral-800 text-neutral-300'
  }`;
}
