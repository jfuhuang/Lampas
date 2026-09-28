import { useState } from 'react';
import { socket } from '../lib/socket.js';
import { getCurrentPosition } from '../lib/geo.js';
import { useToast } from '../context/GameContext.jsx';
import { ScoreBar, RobberList } from '../components/HeistBits.jsx';
import { TASK_TITLES } from '../components/tasks/TaskRunner.jsx';
import { Section, NumberField } from './RefereeView.jsx';

/**
 * Referee panel pieces for Heist mode (cops & robbers). RefereeView owns
 * layout; these are the mode-specific sections.
 */

/** Hide & Seek ↔ Heist. Lobby only (server enforces). */
export function ModePicker({ mode }) {
  const set = (m) => socket.emit('host:config', { mode: m });
  return (
    <Section title="Game mode">
      <div className="flex gap-2">
        {[
          ['hideseek', '🏮 Hide & Seek'],
          ['heist', '💰 Heist (cops & robbers)'],
        ].map(([m, label]) => (
          <button
            key={m}
            onClick={() => set(m)}
            className={`flex-1 rounded-lg px-3 py-3 text-sm font-black active:scale-95 ${
              mode === m ? 'bg-lamp text-night' : 'bg-neutral-800 text-neutral-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </Section>
  );
}

/** Overlay on the referee map: what does a tap place? */
export function PlacePicker({ value, onChange }) {
  const opts = [
    ['boundary', '⭕ Boundary'],
    ['station', '💰 Station'],
    ['prison', '🔒 Prison'],
  ];
  return (
    <div className="absolute bottom-2 left-1/2 z-[500] flex -translate-x-1/2 gap-1 rounded-xl bg-night/90 p-1 shadow-lg">
      <span className="self-center px-1 text-[10px] font-bold uppercase text-neutral-500">Tap places</span>
      {opts.map(([k, label]) => (
        <button
          key={k}
          onClick={() => onChange(k)}
          className={`rounded-lg px-2 py-1.5 text-xs font-black active:scale-95 ${
            value === k ? 'bg-lamp text-night' : 'text-neutral-300'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Lobby: prison, stations, and the heist knobs. */
export function HeistSetup({ game, settings }) {
  const toast = useToast();
  const stations = game.heist?.stations ?? [];
  const setSetting = (key, value) => socket.emit('host:config', { settings: { [key]: value } });

  // Walking the site and dropping at your feet captures that spot's real
  // GPS bias — better than a map tap (see README → Heist GPS tips).
  const dropHere = async (event) => {
    try {
      const pt = await getCurrentPosition();
      socket.emit(event, pt);
    } catch {
      toast('Could not get your location — tap the map instead', 'warn');
    }
  };

  return (
    <>
      <Section title="H1 · Prison & task stations">
        <p className="mb-2 text-xs text-neutral-500">
          Use the <b>Tap places</b> picker on the map, or walk to each spot and drop it at your
          feet (more accurate). Open sky, ≥60 m apart. Put more stations than the live count so
          they can rotate.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => dropHere('host:prison')}
            className="rounded-lg bg-blue-950 px-3 py-3 text-sm font-bold text-blue-200 active:scale-95"
          >
            🔒 Prison here {game.heist?.prison ? '✓' : ''}
          </button>
          <button
            onClick={() => dropHere('host:station:add')}
            className="rounded-lg bg-violet-950 px-3 py-3 text-sm font-bold text-violet-200 active:scale-95"
          >
            💰 Station here
          </button>
        </div>
        <ul className="mt-3 flex flex-col gap-2">
          {stations.map((s) => (
            <StationRow key={s.id} station={s} />
          ))}
          {stations.length === 0 && <li className="text-sm text-neutral-500">No stations yet.</li>}
        </ul>
        {stations.length > 0 && stations.length <= settings.activeStations && (
          <p className="mt-2 text-xs font-bold text-amber-400">
            ⚠ Only {stations.length} station(s) for {settings.activeStations} live — nothing can
            rotate. Add more or lower "Live at once".
          </p>
        )}
      </Section>

      <Section title="H2 · Heist rules">
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="Target loot"
            value={settings.targetScore}
            max={10000}
            onChange={(v) => setSetting('targetScore', v)}
          />
          <NumberField
            label="Live at once"
            value={settings.activeStations}
            max={50}
            onChange={(v) => setSetting('activeStations', v)}
          />
          <NumberField
            label="Jail (sec)"
            value={settings.jailSeconds}
            max={600}
            onChange={(v) => setSetting('jailSeconds', v)}
          />
          <NumberField
            label="Immunity (sec)"
            value={settings.immunitySeconds}
            max={600}
            onChange={(v) => setSetting('immunitySeconds', v)}
          />
          <NumberField
            label="Station radius (m)"
            value={settings.stationRadiusM}
            max={100}
            onChange={(v) => setSetting('stationRadiusM', Math.max(10, v))}
          />
          <NumberField
            label="Prison radius (m)"
            value={settings.prisonRadiusM}
            max={100}
            onChange={(v) => setSetting('prisonRadiusM', Math.max(10, v))}
          />
        </div>
      </Section>
    </>
  );
}

function StationRow({ station: s }) {
  const update = (changes) => socket.emit('host:station:update', { stationId: s.id, ...changes });
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg bg-neutral-900 px-2 py-2 text-sm">
      <span className="font-bold text-violet-200">{s.name}</span>
      <label className="flex items-center gap-1 text-xs text-neutral-400">
        pts
        <input
          type="number"
          min="1"
          max="1000"
          value={s.points}
          onChange={(e) => update({ points: Math.max(1, +e.target.value || 1) })}
          className="w-14 rounded border border-neutral-700 bg-night px-1.5 py-1 text-right text-base"
          aria-label={`${s.name} points`}
        />
      </label>
      <select
        value={s.game}
        onChange={(e) => update({ game: e.target.value })}
        className="min-w-0 flex-1 rounded border border-neutral-700 bg-night px-1.5 py-1 text-xs"
        aria-label={`${s.name} mini-game`}
      >
        <option value="random">🎲 random task</option>
        {Object.entries(TASK_TITLES).map(([k, title]) => (
          <option key={k} value={k}>
            {title}
          </option>
        ))}
      </select>
      <button
        onClick={() => socket.emit('host:station:remove', { stationId: s.id })}
        aria-label={`Remove ${s.name}`}
        className="rounded px-1.5 py-0.5 font-black text-red-400 active:scale-90"
      >
        ✕
      </button>
    </li>
  );
}

/** In-game: score + overrides (the safety net when GPS won't cooperate). */
export function HeistLiveControls({ game }) {
  const [armed, setArmed] = useState(null); // 2-tap guard for credit
  const heist = game.heist ?? {};
  const act = (payload) => socket.emit('host:heist', payload);
  const live = (heist.stations ?? []).filter((s) => s.active);
  const inHeist = game.phase === 'seek';

  return (
    <>
      <Section title="Loot (override)">
        <ScoreBar score={heist.score ?? 0} target={game.settings.targetScore} />
        <div className="mt-2 flex gap-2">
          {[-10, -5, 5, 10].map((d) => (
            <button
              key={d}
              disabled={!inHeist}
              onClick={() => act({ action: 'score', delta: d })}
              className="flex-1 rounded-lg bg-neutral-800 px-2 py-2 text-sm font-bold active:scale-95 disabled:opacity-40"
            >
              {d > 0 ? `+${d}` : d}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Live stations">
        <ul className="flex flex-col gap-1.5">
          {live.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-2 rounded-lg bg-neutral-900 px-3 py-2 text-sm">
              <span>
                <b className="text-violet-200">{s.name}</b>{' '}
                <span className="text-xs text-neutral-500">
                  {s.points} pts{s.lockedByName ? ` · ${s.lockedByName} working` : ''}
                </span>
              </span>
              <button
                disabled={!inHeist}
                onClick={() => {
                  if (armed !== s.id) return setArmed(s.id);
                  setArmed(null);
                  act({ action: 'credit', stationId: s.id });
                }}
                className={`rounded-lg px-2 py-1 text-xs font-bold active:scale-95 disabled:opacity-40 ${
                  armed === s.id ? 'bg-violet-600 text-white' : 'bg-neutral-800'
                }`}
              >
                {armed === s.id ? 'Confirm credit' : 'Credit ✓'}
              </button>
            </li>
          ))}
          {live.length === 0 && <li className="text-sm text-neutral-500">No live stations.</li>}
        </ul>
      </Section>

      <Section title="Robbers (manual catch / release)">
        <RobberList
          robbers={heist.robbers ?? []}
          settings={game.settings}
          serverNow={game.serverNow}
          actions={(r) =>
            r.status === 'jailed' ? (
              <button
                onClick={() => act({ action: 'release', playerId: r.id })}
                className="rounded bg-blue-900 px-2 py-1 text-blue-100 active:scale-95"
              >
                Release
              </button>
            ) : r.status === 'free' ? (
              <button
                disabled={!inHeist}
                onClick={() => act({ action: 'catch', playerId: r.id })}
                className="rounded bg-neutral-800 px-2 py-1 active:scale-95 disabled:opacity-40"
              >
                Catch
              </button>
            ) : null
          }
        />
      </Section>
    </>
  );
}
