import { socket } from '../lib/socket.js';
import { unlockAudio, requestWakeLock } from '../lib/geo.js';
import { useGame } from '../context/GameContext.jsx';

/**
 * Player lobby: see teams forming, tap Ready. The Ready tap doubles as the
 * user gesture that unlocks audio and grabs the screen wake lock — both
 * REQUIRE a gesture on mobile, so they piggyback here (platform constraint).
 */
export default function Lobby() {
  const { game, you } = useGame();

  const handleReady = async () => {
    unlockAudio();
    await requestWakeLock();
    socket.emit('player:ready', { ready: !you.ready });
  };

  return (
    <div className="flex flex-1 flex-col gap-5 py-6">
      <header className="text-center">
        <div className="lamp-flicker text-4xl">🏮</div>
        <h1 className="text-2xl font-black text-lamp">Lobby</h1>
        <p className="text-sm text-neutral-400">
          Waiting for the host to start. You're <b className="text-neutral-200">{you.name}</b> on{' '}
          <b className="text-neutral-200">{you.teamName}</b>.
        </p>
      </header>

      <TeamList teams={game.teams} youId={you.id} />

      <div className="mt-auto flex flex-col gap-2">
        <button
          onClick={handleReady}
          className={`rounded-xl px-4 py-5 text-xl font-black active:scale-95 ${
            you.ready ? 'bg-green-600 text-white' : 'bg-lamp text-night'
          }`}
        >
          {you.ready ? '✓ Ready — tap to unready' : "I'm ready"}
        </button>
        <p className="text-center text-xs text-neutral-500">
          Ready also enables sound &amp; keeps your screen awake. Arrive charged — GPS eats battery.
        </p>
      </div>
    </div>
  );
}

export function TeamList({ teams, youId }) {
  return (
    <div className="flex flex-col gap-3">
      {teams.map((team) => (
        <div key={team.id} className="rounded-xl border border-neutral-800 bg-panel p-3">
          <div className="flex items-center justify-between">
            <span className="font-bold">{team.name}</span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-bold uppercase ${
                team.role === 'seeker' ? 'bg-red-900 text-red-200' : 'bg-emerald-900 text-emerald-200'
              }`}
            >
              {team.role}
            </span>
          </div>
          <ul className="mt-2 flex flex-wrap gap-2">
            {team.players.map((p) => (
              <li
                key={p.id}
                className={`rounded-lg px-2 py-1 text-sm ${
                  p.id === youId ? 'bg-lamp/20 text-lamp' : 'bg-neutral-800 text-neutral-300'
                } ${!p.connected ? 'opacity-40' : ''}`}
              >
                {p.isHost && '👑 '}
                {p.name}
                {p.ready ? ' ✓' : ''}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
