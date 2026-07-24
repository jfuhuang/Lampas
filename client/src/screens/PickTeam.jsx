import { socket } from '../lib/socket.js';
import { useGame } from '../context/GameContext.jsx';

/**
 * Shown when a player is joined but teamless mid-game — either they just
 * joined after the round started, or their old team name no longer exists
 * (kicked/deleted). No free-text team creation here: the round is already
 * live, so they can only slot into a team that already exists
 * (server enforces this too — see game.js joinTeam).
 */
export default function PickTeam() {
  const { game, you, logout } = useGame();
  const teams = game.teams.filter((t) => t.players.length > 0);

  const pick = (team) => socket.emit('team:join', { teamName: team.name });

  return (
    <div className="flex flex-1 flex-col justify-center gap-6 py-10">
      <header className="text-center">
        <div className="lamp-flicker text-4xl">🏮</div>
        <h1 className="text-2xl font-black text-lamp">Pick a team</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Hey <b className="text-neutral-200">{you.name}</b> — the round is already live, so join
          one of the teams already playing.
        </p>
      </header>

      <div className="flex flex-col gap-2">
        {teams.map((t) => (
          <button
            key={t.id}
            onClick={() => pick(t)}
            className="flex items-center justify-between rounded-xl border border-neutral-800 bg-panel px-4 py-3 text-left active:scale-95"
          >
            <span className="font-bold">{t.name}</span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-bold uppercase ${
                t.role === 'seeker' ? 'bg-red-900 text-red-200' : 'bg-emerald-900 text-emerald-200'
              }`}
            >
              {t.role} · {t.players.length}
            </span>
          </button>
        ))}
        {teams.length === 0 && (
          <p className="text-center text-sm text-neutral-500">
            No teams are playing yet — hang tight.
          </p>
        )}
      </div>

      <button onClick={logout} className="mx-auto px-3 py-1 text-xs font-semibold text-neutral-500 underline active:scale-95">
        Not you? Log out
      </button>
    </div>
  );
}
