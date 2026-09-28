import { useCallback, useRef, useState } from 'react';
import { socket } from '../../lib/socket.js';
import { haversine, vibrate } from '../../lib/geo.js';
import Wires from './Wires.jsx';
import CardSwipe from './CardSwipe.jsx';
import Keypad from './Keypad.jsx';
import Download from './Download.jsx';
import Simon from './Simon.jsx';
import Dial from './Dial.jsx';

const GAMES = {
  wires: { title: 'Fix the wiring', Component: Wires },
  swipe: { title: 'Swipe the keycard', Component: CardSwipe },
  keypad: { title: 'Crack the keypad', Component: Keypad },
  download: { title: 'Download the ledger', Component: Download },
  simon: { title: 'Stabilize the reactor', Component: Simon },
  dial: { title: 'Crack the safe dial', Component: Dial },
};

// Server refuses completions faster than 3s (anti insta-finish) — pad the
// submit so a quick player never trips it.
const MIN_SUBMIT_MS = 3_500;
const FINISH_SLACK_M = 15; // mirrors server hysteresis

/**
 * Full-screen mini-game for one station. The server already verified
 * presence at start; it re-checks on complete. Dim palette on purpose —
 * a lit phone gives the robber away.
 */
export default function TaskRunner({ task, station, myPos, stationRadiusM, onClose, toast }) {
  const startedAt = useRef(Date.now());
  const [stage, setStage] = useState('playing'); // playing | submitting | failed
  const [error, setError] = useState(null);
  const game = GAMES[task.game] ?? GAMES.wires;
  const { Component } = game;

  const distM = myPos && station ? Math.round(haversine(myPos, station)) : null;
  const drifting = distM != null && distM > stationRadiusM + FINISH_SLACK_M;

  // Finished mini-game → upload. A refused upload (drifted, weak GPS) keeps
  // the server-side task open, so the robber can step back and retry
  // without replaying the game.
  const finish = useCallback(() => {
    setStage('submitting');
    const wait = Math.max(0, MIN_SUBMIT_MS - (Date.now() - startedAt.current));
    setTimeout(() => {
      // Acks die with a dropped socket — don't hang on "Uploading…" forever.
      let answered = false;
      const giveUp = setTimeout(() => {
        if (answered) return;
        setError('No connection — move somewhere with signal and retry');
        setStage('failed');
      }, 8000);
      socket.emit('task:complete', { stationId: task.stationId }, (res = {}) => {
        answered = true;
        clearTimeout(giveUp);
        if (res.ok) {
          vibrate([80, 40, 80]);
          toast(`💰 +${res.points} banked! Pool: ${res.score}`, 'info');
          onClose();
        } else {
          setError(res.error ?? 'Task not accepted');
          setStage('failed');
        }
      });
    }, wait);
  }, [task.stationId, onClose, toast]);

  const cancel = () => {
    socket.emit('task:cancel');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-night/95 px-4 py-6">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-widest text-violet-400">
            {station?.name ?? 'Station'} · {station?.points ?? '?'} pts
          </p>
          <h2 className="text-xl font-black text-neutral-200">{game.title}</h2>
        </div>
        <button onClick={cancel} className="rounded-lg bg-neutral-800 px-3 py-2 text-sm font-bold active:scale-95">
          ✕ Abort
        </button>
      </header>

      {drifting && (
        <p className="mt-3 rounded-lg bg-amber-950 px-3 py-2 text-center text-sm font-bold text-amber-300">
          ⚠ You're {distM}m from the station — get back in range or it won't count
        </p>
      )}

      <div className="flex flex-1 items-center justify-center">
        {stage === 'playing' && <Component onDone={finish} />}
        {stage === 'submitting' && <p className="text-lg font-bold text-neutral-300">Uploading…</p>}
        {stage === 'failed' && (
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="font-bold text-amber-300">{error}</p>
            <button
              onClick={finish}
              className="rounded-xl bg-violet-700 px-6 py-4 text-lg font-black text-white active:scale-95"
            >
              ↻ Retry upload
            </button>
          </div>
        )}
      </div>

      <p className="text-center text-xs text-neutral-600">Screen light gives you away — be quick.</p>
    </div>
  );
}

export const TASK_TITLES = Object.fromEntries(Object.entries(GAMES).map(([k, v]) => [k, v.title]));
