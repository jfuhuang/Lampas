import { useState } from 'react';
import { socket } from '../lib/socket.js';
import { haversine, bearing } from '../lib/geo.js';
import Countdown from '../components/Countdown.jsx';
import PlayerMap from '../components/PlayerMap.jsx';
import CompassDial from '../components/CompassDial.jsx';
import TaskRunner from '../components/tasks/TaskRunner.jsx';
import {
  HeistBadge,
  ScoreBar,
  HeistGameOver,
  RobberList,
  useServerNow,
} from '../components/HeistBits.jsx';
import { useGame } from '../context/GameContext.jsx';

const MAX_ACCURACY_M = 35; // mirrors server/heist.js — worse = refuse to start

/**
 * Robber screen (Heist mode): walk to a live station, run its mini-game,
 * bank points into the shared pool. Caught → walk to the prison and stay
 * inside until the timer fills, then enjoy a spell of immunity.
 *
 * Only ACTIVE stations ever reach this phone (server-side privacy);
 * distances/arrows are computed on-device from the local GPS echo.
 */
export default function RobberView() {
  const { game, myPos, heading, showToast } = useGame();
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(null); // stationId awaiting ack
  const [localTask, setLocalTask] = useState(null); // { stationId, game } after ack
  const [dismissedTask, setDismissedTask] = useState(null); // closed server task (pre-resync)
  const { phase, phaseEndsAt, serverNow, settings, you } = game;
  const heist = game.heist ?? {};
  const me = heist.me ?? { status: 'free' };
  const now = useServerNow(serverNow);

  if (phase === 'over') return <HeistGameOver />;

  const stations = (heist.stations ?? [])
    .map((s) => ({
      ...s,
      distM: myPos ? Math.round(haversine(myPos, s)) : null,
      bearing: myPos ? bearing(myPos, s) : null,
    }))
    .sort((a, b) => (a.distM ?? 1e9) - (b.distM ?? 1e9));

  // Resume after a reload/resync: the server remembers our open task.
  const serverTask = me.task && me.task.startedAt !== dismissedTask ? me.task : null;
  const task = localTask ?? serverTask;
  const taskStation = task && (heist.stations ?? []).find((s) => s.id === task.stationId);

  const weakGps = myPos?.accuracy != null && myPos.accuracy > MAX_ACCURACY_M;
  const jailed = me.status === 'jailed';
  const prisonDistM = myPos && heist.prison ? Math.round(haversine(myPos, heist.prison)) : null;

  const start = (s) => {
    setStarting(s.id);
    socket.emit('task:start', { stationId: s.id }, (res = {}) => {
      setStarting(null);
      if (res.ok) setLocalTask({ stationId: s.id, game: res.game });
      else showToast(res.error ?? 'Could not start', 'warn');
    });
  };

  const closeTask = () => {
    setDismissedTask(me.task?.startedAt ?? null);
    setLocalTask(null);
  };

  return (
    <div className="flex flex-1 flex-col gap-4 py-6">
      {task && taskStation && phase === 'seek' && !jailed && (
        <TaskRunner
          key={task.stationId}
          task={task}
          station={taskStation}
          myPos={myPos}
          stationRadiusM={settings.stationRadiusM}
          onClose={closeTask}
          toast={showToast}
        />
      )}

      <header className="text-center">
        <HeistBadge phase={phase} role="hider" />
        <Countdown
          endsAt={phaseEndsAt}
          serverNow={serverNow}
          label={phase === 'hide' ? 'Scatter — cops are frozen' : 'Time to hit the target'}
          className="mt-3"
        />
      </header>

      <ScoreBar score={heist.score ?? 0} target={settings.targetScore} />

      <StatusCard
        me={me}
        now={now}
        settings={settings}
        phase={phase}
        prisonDistM={prisonDistM}
      />

      <CompassDial heading={heading} />

      <PlayerMap
        title="Heist map"
        boundary={game.boundary}
        myPos={myPos}
        heading={heading}
        others={game.positions}
        heist={{
          stations: heist.stations,
          prison: heist.prison,
          stationRadiusM: settings.stationRadiusM,
          prisonRadiusM: settings.prisonRadiusM,
        }}
      />

      {!jailed && (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-black uppercase tracking-widest text-neutral-400">
            Live stations {weakGps && <span className="text-amber-400">· weak GPS ±{myPos.accuracy}m</span>}
          </h2>
          {stations.map((s) => {
            const inRange = s.distM != null && s.distM <= settings.stationRadiusM;
            const canStart = phase === 'seek' && inRange && !weakGps && !s.busy && starting == null;
            return (
              <div
                key={s.id}
                className="flex items-center gap-3 rounded-xl border border-neutral-800 bg-panel p-3"
              >
                <Arrow bearing={s.bearing} heading={heading} />
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-violet-200">
                    {s.name} <span className="text-xs text-neutral-500">· {s.points} pts</span>
                  </div>
                  <div className="text-xs text-neutral-400">
                    {s.distM == null ? 'waiting for GPS…' : `${s.distM} m away`}
                    {s.busy && <span className="text-amber-400"> · another robber is on it</span>}
                  </div>
                </div>
                <button
                  onClick={() => start(s)}
                  disabled={!canStart}
                  className="rounded-lg bg-violet-700 px-3 py-2 text-sm font-black text-white active:scale-95 disabled:bg-neutral-800 disabled:text-neutral-500"
                >
                  {starting === s.id
                    ? '…'
                    : phase !== 'seek'
                      ? 'Wait'
                      : inRange
                        ? weakGps
                          ? 'Weak GPS'
                          : 'Start'
                        : 'Too far'}
                </button>
              </div>
            );
          })}
          {stations.length === 0 && (
            <p className="text-sm text-neutral-500">No live stations right now.</p>
          )}
        </section>
      )}

      <details className="rounded-xl border border-neutral-800 bg-panel p-3">
        <summary className="text-xs font-black uppercase tracking-widest text-neutral-400">Crew status</summary>
        <div className="mt-2">
          <RobberList robbers={heist.robbers ?? []} settings={settings} serverNow={serverNow} youId={you.id} />
        </div>
      </details>

      <div className="mt-auto flex flex-col gap-2">
        {confirming ? (
          <>
            <p className="text-center text-sm font-bold text-red-300">
              A cop's light hit you? You'll have to serve {settings.jailSeconds}s in prison.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirming(false)}
                className="flex-1 rounded-xl bg-neutral-700 px-4 py-4 text-lg font-bold active:scale-95"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  socket.emit('caught:self');
                  setConfirming(false);
                  setLocalTask(null);
                }}
                className="flex-1 rounded-xl bg-red-600 px-4 py-4 text-lg font-black text-white active:scale-95"
              >
                Yes, caught
              </button>
            </div>
          </>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            disabled={phase !== 'seek' || me.status !== 'free'}
            className="rounded-xl border-2 border-red-700 bg-red-950 px-4 py-5 text-xl font-black text-red-200 active:scale-95 disabled:opacity-30"
          >
            {me.status === 'immune' ? '🛡 Immune — can’t be caught' : "🔦 I'm caught"}
          </button>
        )}
        <p className="text-center text-xs text-neutral-600">
          Team: {you.teamName} · You've banked {me.points ?? 0} pts
        </p>
      </div>
    </div>
  );
}

function StatusCard({ me, now, settings, phase, prisonDistM }) {
  if (me.status === 'jailed') {
    const served = Math.floor((me.jailServedMs ?? 0) / 1000);
    const pct = Math.min(100, Math.round((served / settings.jailSeconds) * 100));
    const inside = prisonDistM != null && prisonDistM <= settings.prisonRadiusM;
    return (
      <div className="rounded-xl border-2 border-blue-700 bg-blue-950/60 p-4 text-center">
        <p className="text-2xl font-black text-blue-200">🔒 CAUGHT</p>
        <p className="mt-1 text-sm text-blue-200">
          Walk to the prison (blue circle) and stay inside. No tasks until you're out.
        </p>
        <div className="mt-3 h-3 overflow-hidden rounded-full bg-neutral-800">
          <div className="h-full bg-blue-500 transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1 font-mono text-sm text-blue-300">
          {served}/{settings.jailSeconds}s served
        </p>
        <p className={`mt-1 text-sm font-bold ${inside ? 'text-emerald-300' : 'text-amber-300'}`}>
          {prisonDistM == null
            ? 'Waiting for GPS…'
            : inside
              ? 'Inside the prison — timer running'
              : `Prison is ${prisonDistM} m away — timer paused`}
        </p>
      </div>
    );
  }
  if (me.status === 'immune') {
    const left = Math.max(0, Math.ceil((me.immuneUntil - now) / 1000));
    return (
      <div className="rounded-xl border-2 border-emerald-700 bg-emerald-950/60 p-4 text-center">
        <p className="text-2xl font-black text-emerald-200">🛡 IMMUNE · {left}s</p>
        <p className="text-sm text-emerald-300">Cops can't catch you. Make it count.</p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-neutral-800 bg-panel p-3 text-center text-sm text-neutral-400">
      {phase === 'hide'
        ? 'Scatter! Stations unlock when the heist starts. Cops are frozen at base.'
        : `Get within ${settings.stationRadiusM} m of a live station to crack it. Cops don't know where they are.`}
    </div>
  );
}

/** Direction to a station relative to where the phone faces (north-up without a compass). */
function Arrow({ bearing: b, heading }) {
  if (b == null) return <span className="w-8 text-center text-neutral-600">·</span>;
  const rel = heading == null ? b : b - heading;
  return (
    <span
      className="inline-block w-8 text-center text-2xl text-violet-300"
      style={{ transform: `rotate(${rel}deg)`, transition: 'transform 0.25s ease-out' }}
      aria-label={`direction ${Math.round(b)}°`}
    >
      ↑
    </span>
  );
}
