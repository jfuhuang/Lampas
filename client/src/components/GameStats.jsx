/**
 * End-game stats: survival leaderboard + event timeline. Rendered from
 * `game.stats` (server-computed, present only when phase === 'over').
 * Shared by the player GameOver screen and the referee's over panel.
 */
export default function GameStats({ stats }) {
  if (!stats?.teams?.length) return null;

  const mmss = (s) => {
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  };

  return (
    <div className="flex w-full flex-col gap-4">
      <section className="rounded-xl border border-neutral-800 bg-panel p-4">
        <h2 className="mb-2 text-xs font-black uppercase tracking-widest text-neutral-400">
          Survival leaderboard
        </h2>
        <ol className="flex flex-col gap-2">
          {stats.teams.map((t, i) => (
            <li
              key={t.teamId}
              className={`flex items-center justify-between rounded-lg px-3 py-2 ${
                t.winner ? 'bg-amber-950/60 text-lamp' : 'bg-neutral-800/60'
              }`}
            >
              <span className="font-bold">
                {t.winner ? '🏆' : `${i + 1}.`} {t.name}
              </span>
              <span className="text-right text-sm">
                <span className="font-mono font-bold tabular-nums">{mmss(t.survivedSeconds)}</span>
                <span className="ml-2 text-xs text-neutral-400">
                  {t.survived ? 'never caught' : t.caughtBy ? `caught: ${t.caughtBy}` : 'caught'}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      {stats.timeline?.length > 0 && (
        <section className="rounded-xl border border-neutral-800 bg-panel p-4">
          <h2 className="mb-2 text-xs font-black uppercase tracking-widest text-neutral-400">
            How it went down
          </h2>
          <ul className="max-h-48 overflow-y-auto font-mono text-[11px] leading-relaxed">
            {stats.timeline.map((e, i) => (
              <li key={`${e.at}-${i}`} className="flex gap-2">
                <span className="shrink-0 text-neutral-600">
                  +{Math.round((e.at - stats.seekStartedAt) / 1000)}s
                </span>
                <span className="text-neutral-300">{e.msg}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
