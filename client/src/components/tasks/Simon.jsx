import { useEffect, useState } from 'react';
import { randInt } from './util.js';

const PADS = ['bg-red-700', 'bg-blue-700', 'bg-yellow-600', 'bg-emerald-700'];
const STEPS = 4;
const newSeq = () => Array.from({ length: STEPS }, () => randInt(0, 3));

/** Reactor sequence: watch 4 pads flash, then repeat the order. */
export default function Simon({ onDone }) {
  const [seq, setSeq] = useState(newSeq);
  const [lit, setLit] = useState(null);
  const [playing, setPlaying] = useState(true);
  const [pos, setPos] = useState(0);
  const [msg, setMsg] = useState('Watch…');

  // Play the sequence back: 450ms on, 200ms gap.
  useEffect(() => {
    if (!playing) return undefined;
    const timers = [];
    seq.forEach((pad, i) => {
      timers.push(setTimeout(() => setLit(pad), 600 + i * 650));
      timers.push(setTimeout(() => setLit(null), 600 + i * 650 + 450));
    });
    timers.push(
      setTimeout(() => {
        setPlaying(false);
        setMsg('Your turn');
      }, 600 + seq.length * 650),
    );
    return () => timers.forEach(clearTimeout);
  }, [playing, seq]);

  const tap = (pad) => {
    if (playing) return;
    setLit(pad);
    setTimeout(() => setLit(null), 150);
    if (pad !== seq[pos]) {
      setMsg('Wrong — watch again');
      setPos(0);
      setSeq(newSeq());
      setPlaying(true);
      return;
    }
    if (pos + 1 === seq.length) {
      setMsg('Stable ✓');
      setTimeout(onDone, 300);
    }
    setPos(pos + 1);
  };

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-sm text-neutral-400">{msg}</p>
      <div className="grid grid-cols-2 gap-3">
        {PADS.map((bg, i) => (
          <button
            key={bg}
            onClick={() => tap(i)}
            className={`h-24 w-24 rounded-xl ${bg} transition-opacity ${
              lit === i ? 'opacity-100 ring-4 ring-white' : 'opacity-35'
            }`}
            aria-label={`pad ${i + 1}`}
          />
        ))}
      </div>
      <p className="text-xs text-neutral-500">
        {playing ? '' : `${pos}/${seq.length}`}
      </p>
    </div>
  );
}
