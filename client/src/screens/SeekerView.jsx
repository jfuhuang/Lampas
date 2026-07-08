import { useState } from 'react';
import { socket } from '../lib/socket.js';
import Countdown from '../components/Countdown.jsx';
import { useGame } from '../context/GameContext.jsx';
import { PhaseBadge, GameOver } from './HiderView.jsx';

/**
 * Seeker screen: countdown + tag buttons for every still-hiding player.
 * The physical catch happens with a real flashlight; the tap here is just
 * the adjudication (the app cannot detect the beam — platform constraint).
 * Seekers NEVER see hider positions.
 */
export default function SeekerView() {
  const { game } = useGame();
  const [confirmTarget, setConfirmTarget] = useState(null); // player object
  const { phase, phaseEndsAt, serverNow } = game;

  if (phase === 'over') return <GameOver />;

  const hiderTeams = game.teams.filter((t) => t.role === 'hider');

  return (
    <div className="flex flex-1 flex-col gap-5 py-6">
      <header className="text-center">
        <PhaseBadge phase={phase} role="seeker" />
        <Countdown
          endsAt={phaseEndsAt}
          serverNow={serverNow}
          label={phase === 'hide' ? 'Hiders are hiding — stay at base' : 'Time left to catch them'}
          className="mt-3"
        />
      </header>

      {phase === 'hide' ? (
        <div className="rounded-xl border border-neutral-800 bg-panel p-6 text-center">
          <div className="text-5xl">🧊</div>
          <p className="mt-2 font-bold">Frozen at base until the seek phase starts.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-center text-sm text-neutral-400">
            Shine your flashlight on a hider, then tag them here:
          </p>
          {hiderTeams.map((team) => (
            <div key={team.id} className="rounded-xl border border-neutral-800 bg-panel p-3">
              <div className="font-bold text-emerald-300">{team.name}</div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {team.players.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setConfirmTarget(p)}
                    className="rounded-lg bg-neutral-800 px-3 py-3 font-bold text-neutral-100 active:scale-95"
                  >
                    🔦 Tag {p.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {hiderTeams.length === 0 && (
            <p className="text-center text-neutral-400">No hiders left…</p>
          )}
        </div>
      )}

      {confirmTarget && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-2xl bg-panel p-5">
            <p className="text-center text-lg font-bold">
              Confirm: you lit up <span className="text-lamp">{confirmTarget.name}</span>?
            </p>
            <p className="mt-1 text-center text-sm text-neutral-400">
              Their whole team converts to seekers.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setConfirmTarget(null)}
                className="flex-1 rounded-xl bg-neutral-700 px-4 py-4 font-bold active:scale-95"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  socket.emit('tag:player', { targetPlayerId: confirmTarget.id });
                  setConfirmTarget(null);
                }}
                className="flex-1 rounded-xl bg-red-600 px-4 py-4 font-black text-white active:scale-95"
              >
                Tag!
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
