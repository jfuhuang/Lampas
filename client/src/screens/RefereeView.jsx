import { useEffect, useState } from 'react';
import { socket } from '../lib/socket.js';
import { getCurrentPosition, unlockAudio, requestWakeLock } from '../lib/geo.js';
import QRCode from 'qrcode';
import Countdown from '../components/Countdown.jsx';
import RefereeMap from '../components/RefereeMap.jsx';
import { NorthBadge } from '../components/PlayerMap.jsx';
import GameStats from '../components/GameStats.jsx';
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
      <div className="relative h-[45dvh] min-h-[280px] overflow-hidden rounded-xl border border-neutral-800 lg:sticky lg:top-4 lg:h-[calc(100dvh-2rem)]">
        <RefereeMap positions={positions} boundary={boundary} phase={phase} onSetCenter={setCenter} />
        <NorthBadge />
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
          <>
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
            <GameStats stats={game.stats} />
          </>
        )}

        <PlayerRoster game={game} />
        <GameLog log={game.log} />
      </div>
    </div>
  );
}

/** Referee-only event log — the debugging window into why the game did X. */
function GameLog({ log }) {
  if (!log?.length) return null;
  const colors = {
    over: 'text-red-300',
    tag: 'text-amber-300',
    boundary: 'text-sky-300',
    phase: 'text-emerald-300',
    event: 'text-fuchsia-300',
  };
  return (
    <Section title="Game log (newest first)">
      <ul className="max-h-56 overflow-y-auto font-mono text-[11px] leading-relaxed">
        {[...log].reverse().map((entry, i) => (
          <li key={`${entry.at}-${i}`} className="flex gap-2">
            <span className="shrink-0 text-neutral-600">
              {new Date(entry.at).toLocaleTimeString([], { hour12: false })}
            </span>
            <span className={colors[entry.type] ?? 'text-neutral-400'}>
              [{entry.type}] {entry.msg}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/* ── Lobby setup: boundary, timers, team roles, start ─────────────────── */

function LobbyControls({ game, boundary, settings, onUseMyLocation, onRadius, onStart }) {
  const setSetting = (key, value) => socket.emit('host:config', { settings: { [key]: value } });

  return (
    <>
      <InviteQR />
      <Section title="1 · Boundary (circle)">
        <div className="flex gap-2">
          <button onClick={onUseMyLocation} className="flex-1 rounded-lg bg-neutral-800 px-3 py-3 text-sm font-bold active:scale-95">
            📍 Center on me
          </button>
          <div className="flex-1 self-center text-center text-xs text-neutral-400">
            …or tap the map to place the center
          </div>
        </div>
        <div className="mt-3">
          <span className="text-sm font-semibold text-neutral-300">
            Radius: <span className="text-lamp">{boundary?.radiusM ?? 150} m</span>
          </span>
          <div className="mt-1 flex items-center gap-3">
            <input
              type="range"
              min="50"
              max="600"
              step="10"
              value={Math.min(600, boundary?.radiusM ?? 150)}
              onChange={(e) => onRadius(+e.target.value)}
              disabled={!boundary}
              className="min-w-0 flex-1 accent-amber-400"
              aria-label="Boundary radius slider"
            />
            <label className="flex items-center gap-1 text-sm font-semibold text-neutral-400">
              <input
                type="number"
                min="20"
                max="5000"
                step="5"
                value={boundary?.radiusM ?? 150}
                onChange={(e) => {
                  const v = Math.max(20, Math.min(5000, +e.target.value || 20));
                  onRadius(v);
                }}
                disabled={!boundary}
                className="w-20 rounded-lg border border-neutral-700 bg-night px-2 py-1.5 text-right text-base outline-none focus:border-lamp disabled:opacity-40"
                aria-label="Boundary radius in meters"
              />
              m
            </label>
          </div>
        </div>
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

/** QR of the game URL — players scan instead of typing at night. Generated
 *  locally by the `qrcode` package (no network, CSP-safe data URL). */
function InviteQR() {
  const [dataUrl, setDataUrl] = useState(null);
  const [open, setOpen] = useState(false);
  const url = window.location.origin;

  useEffect(() => {
    QRCode.toDataURL(url, { width: 360, margin: 2 })
      .then(setDataUrl)
      .catch(() => setDataUrl(null));
  }, [url]);

  return (
    <Section title="0 · Invite players">
      <button
        onClick={() => setOpen(!open)}
        className="w-full rounded-lg bg-neutral-800 px-3 py-3 text-sm font-bold active:scale-95"
      >
        {open ? 'Hide QR code' : '📱 Show QR code to join'}
      </button>
      {open && dataUrl && (
        <div className="mt-3 flex flex-col items-center gap-2">
          <img
            src={dataUrl}
            alt={`QR code for ${url}`}
            className="w-full max-w-[240px] rounded-xl"
          />
          <p className="break-all text-center text-xs text-neutral-400">{url}</p>
        </div>
      )}
    </Section>
  );
}

/* ── In-game: curveballs, phase skip, manual tag ──────────────────────── */

function LiveControls({ game, boundary }) {
  const [confirmReset, setConfirmReset] = useState(false);
  const [shrinkOpen, setShrinkOpen] = useState(false);
  const [targetR, setTargetR] = useState('');
  const trigger = (type, opts = {}) => socket.emit('host:trigger', { type, ...opts });

  const shrinkTo = (opts) => {
    trigger('shrink', opts);
    setShrinkOpen(false);
    setTargetR('');
  };

  return (
    <>
      <Section title="Curveballs">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <EventButton emoji="🔊" label="Sound" hint="hider phones ring" onClick={() => trigger('sound')} />
          <EventButton emoji="🔦" label="Torch" hint="lights-on flash" onClick={() => trigger('torch')} />
          <EventButton
            emoji="⭕"
            label="Shrink"
            hint={boundary ? `now ${boundary.radiusM}m — pick amount` : 'no boundary'}
            onClick={() => setShrinkOpen(!shrinkOpen)}
          />
          <EventButton
            emoji="📍"
            label="Reveal"
            hint={`all dots, ${game.settings.revealSeconds ?? 20}s`}
            onClick={() => trigger('reveal')}
          />
        </div>
        {shrinkOpen && boundary && (
          <div className="mt-2 rounded-lg border border-amber-900 bg-night p-2">
            <div className="flex gap-2">
              {[0.9, 0.75, 0.5].map((f) => (
                <button
                  key={f}
                  onClick={() => shrinkTo({ factor: f })}
                  className="flex-1 rounded-lg bg-neutral-800 px-2 py-2 text-sm font-bold active:scale-95"
                >
                  −{Math.round((1 - f) * 100)}%
                  <span className="block text-[10px] text-neutral-500">
                    → {Math.round(boundary.radiusM * f)}m
                  </span>
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="number"
                min="20"
                max={boundary.radiusM}
                placeholder={`target (≤ ${boundary.radiusM})`}
                value={targetR}
                onChange={(e) => setTargetR(e.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-neutral-700 bg-night px-3 py-2 text-base outline-none focus:border-lamp"
                aria-label="Shrink to exact radius in meters"
              />
              <button
                onClick={() => +targetR >= 20 && shrinkTo({ radiusM: +targetR })}
                disabled={!(+targetR >= 20 && +targetR < boundary.radiusM)}
                className="rounded-lg bg-amber-500 px-4 py-2 font-black text-night active:scale-95 disabled:opacity-40"
              >
                Shrink to m
              </button>
            </div>
          </div>
        )}
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
  const toast = useToast();
  const [armedTeamId, setArmedTeamId] = useState(null); // 2-tap team delete
  const inLobby = game.phase === 'lobby';

  // Kicking/deleting is lobby-only (server enforces too) — mid-game, force-tag instead.
  const onKick = inLobby
    ? (p) => {
        socket.emit('host:kick', { targetPlayerId: p.id });
        toast(`Kicked ${p.name} — they can re-join anytime`, 'info');
      }
    : undefined;

  // Deleting removes the team AND kicks all its members — arm on first tap.
  const onDeleteTeam = inLobby
    ? (t) => {
        if (armedTeamId !== t.id) {
          setArmedTeamId(t.id);
          toast(`Tap 🗑 on ${t.name} again to delete the team + kick its players`, 'warn');
          return;
        }
        setArmedTeamId(null);
        socket.emit('host:deleteTeam', { teamId: t.id });
        toast(`Deleted team ${t.name}`, 'info');
      }
    : undefined;

  return (
    <Section title={`Players (${game.teams.reduce((n, t) => n + t.players.length, 0)})`}>
      <TeamList
        teams={game.teams}
        youId={game.you?.id}
        onKick={onKick}
        onDeleteTeam={onDeleteTeam}
      />
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
