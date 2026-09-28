import { useMemo, useState } from 'react';
import { shuffled } from './util.js';

const COLORS = [
  { id: 'red', bg: 'bg-red-600' },
  { id: 'blue', bg: 'bg-blue-600' },
  { id: 'yellow', bg: 'bg-yellow-500' },
  { id: 'pink', bg: 'bg-pink-500' },
];

/**
 * Fix the wiring: tap a wire on the left, then its matching color on the
 * right. Tap-tap instead of drag — far easier one-handed in the dark.
 */
export default function Wires({ onDone }) {
  const right = useMemo(() => shuffled(COLORS), []);
  const [picked, setPicked] = useState(null);
  const [done, setDone] = useState([]);

  const pickRight = (id) => {
    if (!picked) return;
    if (picked === id) {
      const next = [...done, id];
      setDone(next);
      if (next.length === COLORS.length) setTimeout(onDone, 300);
    }
    setPicked(null);
  };

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-sm text-neutral-400">Tap a wire, then the matching socket.</p>
      <div className="flex w-full max-w-xs justify-between">
        <div className="flex flex-col gap-4">
          {COLORS.map((c) => (
            <button
              key={c.id}
              disabled={done.includes(c.id)}
              onClick={() => setPicked(c.id)}
              className={`h-12 w-20 rounded-r-full ${c.bg} ${
                picked === c.id ? 'ring-4 ring-white' : ''
              } disabled:opacity-25`}
              aria-label={`${c.id} wire`}
            />
          ))}
        </div>
        <div className="flex flex-col gap-4">
          {right.map((c) => (
            <button
              key={c.id}
              disabled={done.includes(c.id)}
              onClick={() => pickRight(c.id)}
              className={`h-12 w-20 rounded-l-full border-4 border-neutral-600 ${c.bg} disabled:opacity-25`}
              aria-label={`${c.id} socket`}
            />
          ))}
        </div>
      </div>
      <p className="text-xs text-neutral-500">
        {done.length}/{COLORS.length} connected
      </p>
    </div>
  );
}
