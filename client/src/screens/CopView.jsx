import Countdown from '../components/Countdown.jsx';
import PlayerMap from '../components/PlayerMap.jsx';
import CompassDial from '../components/CompassDial.jsx';
import { HeistBadge, ScoreBar, HeistGameOver, RobberList } from '../components/HeistBits.jsx';
import { useGame } from '../context/GameContext.jsx';

/**
 * Cop screen (Heist mode): timer, the robbers' loot bar, the prison, and
 * who's free / jailed / immune. Cops NEVER receive station locations
 * (server-side privacy) — they hunt by watching for lit-up phones and
 * the loot bar ticking up. Catches are honor-system: the robber taps
 * "I'm caught" on their own phone.
 */
export default function CopView() {
  const { game, myPos, heading } = useGame();
  const { phase, phaseEndsAt, serverNow, settings } = game;
  const heist = game.heist ?? {};

  if (phase === 'over') return <HeistGameOver />;

  return (
    <div className="flex flex-1 flex-col gap-4 py-6">
      <header className="text-center">
        <HeistBadge phase={phase} role="seeker" />
        <Countdown
          endsAt={phaseEndsAt}
          serverNow={serverNow}
          label={phase === 'hide' ? 'Robbers are scattering — stay at base' : 'Hold them off until'}
          className="mt-3"
        />
      </header>

      <ScoreBar score={heist.score ?? 0} target={settings.targetScore} />

      {phase === 'hide' ? (
        <div className="rounded-xl border border-neutral-800 bg-panel p-6 text-center">
          <div className="text-5xl">🧊</div>
          <p className="mt-2 font-bold">Frozen at base until the heist starts.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-neutral-800 bg-panel p-3 text-center text-sm text-neutral-300">
          Light a robber up → <b className="text-lamp">they tap “I'm caught”</b> and head to prison.
          Immune robbers (🛡) can't be caught. Refusing? Call the referee.
        </div>
      )}

      <CompassDial heading={heading} />

      <PlayerMap
        title="Map · prison"
        boundary={game.boundary}
        myPos={myPos}
        heading={heading}
        others={game.positions} settings={game.settings}
        heist={{ prison: heist.prison, prisonRadiusM: settings.prisonRadiusM }}
      />

      <section className="rounded-xl border border-neutral-800 bg-panel p-3">
        <h2 className="mb-2 text-xs font-black uppercase tracking-widest text-neutral-400">Robbers</h2>
        <RobberList robbers={heist.robbers ?? []} settings={settings} serverNow={serverNow} />
      </section>
    </div>
  );
}
