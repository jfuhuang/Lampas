import { useEffect, useState } from 'react';
import { randInt } from './util.js';

const TUMBLERS = 3;
const TOLERANCE = 3;
const HOLD_MS = 800;

/**
 * Safe dial: slide to find each hidden number — the signal meter rises as
 * you get close. Hold on target briefly to click a tumbler. 3 tumblers.
 */
export default function Dial({ onDone }) {
  const [targets] = useState(() => Array.from({ length: TUMBLERS }, () => randInt(5, 95)));
  const [i, setI] = useState(0);
  const [value, setValue] = useState(50);
  const target = targets[i];
  const dist = Math.abs(value - target);
  const onTarget = dist <= TOLERANCE;
  const signal = Math.max(0, 100 - dist * 3);

  // Hold on target for HOLD_MS → tumbler clicks.
  useEffect(() => {
    if (!onTarget || i >= TUMBLERS) return undefined;
    const t = setTimeout(() => {
      if (i + 1 === TUMBLERS) onDone();
      setI(i + 1);
      setValue(50);
    }, HOLD_MS);
    return () => clearTimeout(t);
  }, [onTarget, i, onDone]);

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <p className="text-sm text-neutral-400">
        Tumbler {Math.min(i + 1, TUMBLERS)}/{TUMBLERS} — find the sweet spot and hold still
      </p>
      <div className="flex h-24 items-end gap-1">
        {Array.from({ length: 10 }, (_, b) => (
          <div
            key={b}
            className={`w-4 rounded-t ${signal >= (b + 1) * 10 ? (onTarget ? 'bg-emerald-400' : 'bg-amber-500') : 'bg-neutral-800'}`}
            style={{ height: `${(b + 1) * 10}%` }}
          />
        ))}
      </div>
      <input
        type="range"
        min="0"
        max="100"
        value={value}
        onChange={(e) => setValue(+e.target.value)}
        className="w-full max-w-xs accent-emerald-500"
        aria-label="Safe dial"
      />
      <p className="font-mono text-3xl font-black text-neutral-300">{String(value).padStart(2, '0')}</p>
    </div>
  );
}
