import Countdown from '../components/Countdown.jsx';
import PlayerMap from '../components/PlayerMap.jsx';
import { useGame } from '../context/GameContext.jsx';
import { PhaseBadge, GameOver } from './HiderView.jsx';

/**
 * Seeker screen: countdown, boundary map, and a read-only hunt list.
 * Seekers do NOT tag — when a flashlight beam lands, the caught hider taps
 * "I'm caught" on their own phone (or the referee tags manually). This
 * keeps the ground truth on the caught side and kills disputed tags.
 */
export default function SeekerView() {
  const { game, myPos, heading } = useGame();
  const { phase, phaseEndsAt, serverNow } = game;

  if (phase === 'over') return <GameOver />;

  const hiderTeams = game.teams.filter(
    (t) => t.role === 'hider' && t.players.length > 0,
  );

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

      <PlayerMap boundary={game.boundary} myPos={myPos} heading={heading} others={game.positions} />

      {phase === 'hide' ? (
        <div className="rounded-xl border border-neutral-800 bg-panel p-6 text-center">
          <div className="text-5xl">🧊</div>
          <p className="mt-2 font-bold">Frozen at base until the seek phase starts.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-neutral-800 bg-panel p-4 text-center">
            <p className="text-sm text-neutral-300">
              Lit someone up? <b className="text-lamp">They tap “I'm caught”</b> on their
              phone. Refusing? Call the referee over.
            </p>
          </div>
          {hiderTeams.map((team) => (
            <div key={team.id} className="rounded-xl border border-neutral-800 bg-panel p-3">
              <div className="font-bold text-emerald-300">{team.name} — still hiding</div>
              <div className="mt-1 text-sm text-neutral-400">
                {team.players.map((p) => p.name).join(' · ')}
              </div>
            </div>
          ))}
          {hiderTeams.length === 0 && (
            <p className="text-center text-neutral-400">No hiders left…</p>
          )}
        </div>
      )}
    </div>
  );
}
