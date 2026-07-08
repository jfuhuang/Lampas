import { useState } from 'react';
import { socket } from '../lib/socket.js';
import { getCurrentPosition, unlockAudio, requestWakeLock } from '../lib/geo.js';
import Countdown from '../components/Countdown.jsx';
import RefereeMap from '../components/RefereeMap.jsx';
import { useGame, useToast } from '../context/GameContext.jsx';
import { TeamList } from './Lobby.jsx';

/**
 * Referee panel (rendered inside HostView's 👑 tab) — the safety net
 * (CLAUDE.md MVP note): every event can be fired and every tag marked
 * manually here, so the game runs even if all automation flakes.
 * Gets the FULL state including live positions.
 *
 * Layout: single column on phones, map + control column on desktop.
 */
export default function RefereeView() {
  const { game } = useGame();
  const toast = useToast();
  const { phase, phaseEndsAt, serverNow, boundary, settings } = game;
  const positions = game.positions ?? [];

  const setCenter = (center) =>
    socket.emit('host:config', {
      boundary: { center, radiusM: boundary?.radiusM ?? 150 },
    });

  const setRadius = (radiusM) => {
    if (boundary?.center) socket.emit('host:config', { boundary: { ...boundary, radiusM } });
  };

  const useMyLocation = async () => {
    try {
      const center = await getCurrentPosition();
      setCenter(center);
    } catch {
      toast?.('Could not get your location — tap the map instead', 'warn');
    }
  };

  const startHide = () => {
    if (!boundary) return toast?.('Set a boundary first (tap the map)', 'warn');
    const seekers = game.teams.filter((t) => t.role === 'seeker').length;
    if (seekers === 0) return toast?.('Mark at least one team as seekers', 'warn');
    unlockAudio(); // host gesture — host phone also needs sound + wake lock
    requestWakeLock();
    socket.emit('host:startPhase', { phase: 'hide' });
  };

  return (
    <div className="flex flex-1 flex-col gap-4 py-4 lg:grid lg:grid-cols-[1fr_380px] lg:items-start">
      {/* ── Map (always visible; the referee's main instrument) ── */}
      <div className="h-[45dvh] min-h-[280px] overflow-hidden rounded-xl border border-neutral-800 lg:sticky lg:top-4 lg:h-[calc(100dvh-2rem)]">
        <RefereeMap positions={positions} boundary={boundary} phase={phase} onSetCenter={setCenter} />
      </div>

      <div className="flex flex-col gap-4">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-black text-lamp">👑 Referee — {phase.toUpperCase()}</h1>
          {phaseEndsAt && <Countdown endsAt={phaseEndsAt} serverNow={serverNow} className="scale-[0.55] origin-right" />}
        </header>

        {phase === 'lobby' && (
          <LobbyControls
            game={game}
            boundary={boundary}
            settings={settings}
            onUseMyLocation={useMyLocation}
            onRadius={setRadius}
            onStart={startHide}
          />
        )}

        {(phase === 'hide' || phase === 'seek') && (
          <LiveControls game={game} boundary={boundary} />
        )}

        {phase === 'over' && (
          <div className="rounded-xl border border-neutral-800 bg-panel p-4 text-center">
            <div className="text-4xl">🏆</div>
            <p className="mt-1 text-lg font-bold">
              {game.winnerTeamName ? `${game.winnerTeamName} win!` : 'Seekers caught everyone!'}
            </p>
            <button
              onClick={() => socket.emit('host:reset')}
              className="mt-3 w-full rounded-xl bg-lamp px-4 py-3 font-black text-night active:scale-95"
            >
              Back to lobby
            </button>
          </div>
        )}

        <PlayerRoster game={game} />
      </div>
    </div>
  );
}

/* ── Lobby setup: boundary, timers, team roles, start ─────────────────── */

function LobbyControls({ game, boundary, settings, onUseMyLocation, onRadius, onStart }) {
  const setSetting = (key, value) => socket.emit('host:config', { settings: { [key]: value } });

  return (
    <>
      <Section title="1 · Boundary (circle)">
        <div className="flex gap-2">
          <button onClick={onUseMyLocation} className="flex-1 rounded-lg bg-neutral-800 px-3 py-3 text-sm font-bold active:scale-95">
            📍 Center on me
          </button>
          <div className="flex-1 self-center text-center text-xs text-neutral-400">
            …or tap the map to place the center
          </div>
        </div>
        <label className="mt-3 block text-sm font-semibold text-neutral-300">
          Radius: <span className="text-lamp">{boundary?.radiusM ?? 150} m</span>
          <input
            type="range"
            min="50"
            max="600"
            step="10"
            value={boundary?.radiusM ?? 150}
            onChange={(e) => onRadius(+e.target.value)}
            disabled={!boundary}
            className="mt-1 w-full accent-amber-400"
          />
        </label>
      </Section>

      <Section title="2 · Timers">
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="Hide (min)"
            value={Math.round(settings.hideSeconds / 60)}
            onChange={(v) => setSetting('hideSeconds', v * 60)}
          />
          <NumberField
            label="Seek (min)"
            value={Math.round(settings.seekSeconds / 60)}
            onChange={(v) => setSetting('seekSeconds', v * 60)}
          />
        </div>
      </Section>

      <Section title="3 · Who seeks first? (tap a team to toggle)">
        <div className="flex flex-wrap gap-2">
          {game.teams.map((t) => (
            <button
              key={t.id}
              onClick={() =>
                socket.emit('host:setTeamRole', {
                  teamId: t.id,
                  role: t.role === 'seeker' ? 'hider' : 'seeker',
                })
              }
              className={`rounded-lg px-3 py-2 text-sm font-bold active:scale-95 ${
                t.role === 'seeker' ? 'bg-red-800 text-red-100' : 'bg-emerald-900 text-emerald-100'
              }`}
            >
              {t.name}: {t.role}
            </button>
          ))}
          {game.teams.length === 0 && (
            <p className="text-sm text-neutral-500">No teams yet — players are still joining.</p>
          )}
        </div>
      </Section>

      <button
        onClick={onStart}
        className="rounded-xl bg-lamp px-4 py-5 text-xl font-black text-night active:scale-95"
      >
        🏁 Start hide phase
      </button>
    </>
  );
}

/* ── In-game: curveballs, phase skip, manual tag ──────────────────────── */

function LiveControls({ game, boundary }) {
  const [confirmReset, setConfirmReset] = useState(false);
  const trigger = (type) => socket.emit('host:trigger', { type });

  return (
    <>
      <Section title="Curveballs">
        <div className="grid grid-cols-3 gap-2">
          <EventButton emoji="🔊" label="Sound" hint="hider phones ring" onClick={() => trigger('sound')} />
          <EventButton emoji="🔦" label="Torch" hint="lights-on flash" onClick={() => trigger('torch')} />
          <EventButton
            emoji="⭕"
            label="Shrink"
            hint={boundary ? `→ ${Math.round(boundary.radiusM * game.settings.shrinkFactor)}m` : 'no boundary'}
            onClick={() => trigger('shrink')}
          />
        </div>
      </Section>

      <Section title="Manual tag (referee override)">
        <div className="flex flex-col gap-2">
          {game.teams
            .filter((t) => t.role === 'hider')
            .map((t) => (
              <div key={t.id} className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold text-emerald-300">{t.name}:</span>
                {t.players.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => socket.emit('tag:player', { targetPlayerId: p.id })}
                    className="rounded-lg bg-neutral-800 px-2 py-1 text-sm font-semibold active:scale-95"
                  >
                    Tag {p.name}
                  </button>
                ))}
              </div>
            ))}
        </div>
      </Section>

      <Section title="Phase">
        <div className="flex gap-2">
          {game.phase === 'hide' && (
            <button
              onClick={() => socket.emit('host:startPhase', { phase: 'seek' })}
              className="flex-1 rounded-lg bg-red-800 px-3 py-3 font-bold text-red-100 active:scale-95"
            >
              ⏭ Start seek now
            </button>
          )}
          {confirmReset ? (
            <button
              onClick={() => {
                socket.emit('host:reset');
                setConfirmReset(false);
              }}
              className="flex-1 rounded-lg bg-red-600 px-3 py-3 font-bold text-white active:scale-95"
            >
              Confirm reset
            </button>
          ) : (
            <button
              onClick={() => setConfirmReset(true)}
              className="flex-1 rounded-lg bg-neutral-800 px-3 py-3 font-bold active:scale-95"
            >
              ↺ Reset to lobby
            </button>
          )}
        </div>
      </Section>
    </>
  );
}

/* ── Shared bits ──────────────────────────────────────────────────────── */

function PlayerRoster({ game }) {
  return (
    <Section title={`Players (${game.teams.reduce((n, t) => n + t.players.length, 0)})`}>
      <TeamList teams={game.teams} youId={game.you?.id} />
    </Section>
  );
}

function Section({ title, children }) {
  return (
    <section className="rounded-xl border border-neutral-800 bg-panel p-3">
      <h2 className="mb-2 text-xs font-black uppercase tracking-widest text-neutral-400">{title}</h2>
      {children}
    </section>
  );
}

function EventButton({ emoji, label, hint, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center rounded-xl bg-neutral-800 px-2 py-3 active:scale-95"
    >
      <span className="text-2xl">{emoji}</span>
      <span className="font-bold">{label}</span>
      <span className="text-[10px] text-neutral-500">{hint}</span>
    </button>
  );
}

function NumberField({ label, value, onChange }) {
  return (
    <label className="flex flex-col gap-1 text-sm font-semibold text-neutral-300">
      {label}
      <input
        type="number"
        min="1"
        max="120"
        value={value}
        onChange={(e) => onChange(Math.max(1, +e.target.value || 1))}
        className="rounded-lg border border-neutral-700 bg-night px-3 py-2 text-lg outline-none focus:border-lamp"
      />
    </label>
  );
}
