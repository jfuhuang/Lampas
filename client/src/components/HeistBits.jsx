import { useEffect, useMemo, useState } from 'react';
import { useGame } from '../context/GameContext.jsx';

/**
 * Small shared pieces for Heist mode (cops & robbers) — used by
 * RobberView, CopView, the referee panel and the corner badge.
 * Role mapping: team role 'hider' = robber, 'seeker' = cop.
 */

export const HEIST_PHASE_LABEL = { lobby: 'lobby', hide: 'scatter', seek: 'heist', over: 'over' };

/** Server-corrected "now", ticking every 500ms (same trick as Countdown). */
export function useServerNow(serverNow) {
  const offset = useMemo(() => (serverNow ? serverNow - Date.now() : 0), [serverNow]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  return now + offset;
}

export function HeistBadge({ phase, role }) {
  const styles = {
    hide: 'bg-sky-900 text-sky-200',
    seek: 'bg-violet-900 text-violet-200',
    over: 'bg-neutral-800 text-neutral-300',
    lobby: 'bg-neutral-800 text-neutral-300',
  };
  return (
    <div className="flex items-center justify-center gap-2">
      <span className={`rounded-full px-3 py-1 text-sm font-black uppercase tracking-widest ${styles[phase]}`}>
        {HEIST_PHASE_LABEL[phase]} phase
      </span>
      <span
        className={`rounded-full px-3 py-1 text-sm font-bold uppercase ${
          role === 'seeker' ? 'bg-blue-950 text-blue-200' : 'bg-violet-950 text-violet-200'
        }`}
      >
        {role === 'seeker' ? '🚓 cop' : '💰 robber'}
      </span>
    </div>
  );
}

/** Robbers' shared pool vs the target. */
export function ScoreBar({ score, target }) {
  const pct = Math.min(100, Math.round((score / Math.max(1, target)) * 100));
  return (
    <div className="rounded-xl border border-neutral-800 bg-panel p-3">
      <div className="flex items-baseline justify-between text-sm font-bold">
        <span className="text-neutral-400">Robbers' loot</span>
        <span className="font-mono text-violet-300">
          {score} / {target}
        </span>
      </div>
      <div className="mt-2 h-3 overflow-hidden rounded-full bg-neutral-800">
        <div className="h-full bg-violet-500 transition-[width]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** One robber's public status line. */
export function RobberStatus({ robber, settings, now }) {
  if (robber.status === 'jailed') {
    const served = Math.floor(robber.jailServedMs / 1000);
    return (
      <span className="text-blue-300">
        🔒 jailed {served}/{settings.jailSeconds}s
      </span>
    );
  }
  if (robber.status === 'immune') {
    const left = Math.max(0, Math.ceil((robber.immuneUntil - now) / 1000));
    return <span className="text-emerald-300">🛡 immune {left}s</span>;
  }
  return <span className="text-violet-300">💰 free</span>;
}

/** Robber roster (names + status) — status is public so cops know who's immune. */
export function RobberList({ robbers, settings, serverNow, youId, actions }) {
  const now = useServerNow(serverNow);
  return (
    <ul className="flex flex-col gap-1.5">
      {robbers.map((r) => (
        <li
          key={r.id}
          className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm ${
            r.id === youId ? 'bg-lamp/15' : 'bg-neutral-900'
          }`}
        >
          <span className="font-bold">{r.name}</span>
          <span className="flex items-center gap-2 text-xs font-bold">
            <RobberStatus robber={r} settings={settings} now={now} />
            {actions?.(r)}
          </span>
        </li>
      ))}
      {robbers.length === 0 && <li className="text-sm text-neutral-500">No robbers.</li>}
    </ul>
  );
}

export function HeistGameOver() {
  const { game } = useGame();
  const { heist, you, settings } = game;
  const winner = heist?.winner;
  const mine = you?.role === 'seeker' ? 'cops' : 'robbers';
  const won = winner && winner === mine && !you?.isHost;
  const board = [...(heist?.robbers ?? [])].sort((a, b) => b.points - a.points);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-10 text-center">
      <div className="text-7xl">{winner === 'robbers' ? '💰' : '🚓'}</div>
      <h1 className="text-3xl font-black text-lamp">Game over</h1>
      <p className="text-xl font-bold">
        {winner === 'robbers' ? 'The robbers pulled it off!' : 'The cops held the line!'}
        {won && ' — that’s you!'}
      </p>
      <p className="text-sm text-neutral-400">
        Loot: {heist?.score ?? 0} / {settings.targetScore}
      </p>
      <HeistStats robbers={board} />
    </div>
  );
}

export function HeistStats({ robbers }) {
  if (!robbers?.length) return null;
  return (
    <section className="w-full rounded-xl border border-neutral-800 bg-panel p-4 text-left">
      <h2 className="mb-2 text-xs font-black uppercase tracking-widest text-neutral-400">
        Robber leaderboard
      </h2>
      <ol className="flex flex-col gap-1 text-sm">
        {robbers.map((r, i) => (
          <li key={r.id} className="flex justify-between">
            <span>
              {i + 1}. <b>{r.name}</b>
            </span>
            <span className="text-neutral-400">
              <span className="text-violet-300">{r.points} pts</span> · caught {r.timesCaught}×
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
