import { useEffect, useState } from 'react';
import { randInt } from './util.js';

const LEN = 5;
const SHOW_MS = 2500;
const newCode = () => Array.from({ length: LEN }, () => randInt(0, 9)).join('');

/** Crack the vault: memorize a 5-digit code (shown briefly), then punch it in. */
export default function Keypad({ onDone }) {
  const [code, setCode] = useState(newCode);
  const [showing, setShowing] = useState(true);
  const [entry, setEntry] = useState('');
  const [wrong, setWrong] = useState(false);

  useEffect(() => {
    if (!showing) return undefined;
    const t = setTimeout(() => setShowing(false), SHOW_MS);
    return () => clearTimeout(t);
  }, [showing]);

  const press = (d) => {
    if (showing) return;
    const next = entry + d;
    if (next.length < LEN) return setEntry(next);
    if (next === code) {
      setEntry(next);
      setTimeout(onDone, 300);
    } else {
      setWrong(true);
      setEntry('');
      setCode(newCode());
      setTimeout(() => {
        setWrong(false);
        setShowing(true);
      }, 700);
    }
  };

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-sm text-neutral-400">
        {showing ? 'Memorize the code…' : wrong ? 'Wrong — new code incoming' : 'Enter the code'}
      </p>
      <div
        className={`font-mono text-4xl font-black tracking-[0.4em] ${
          wrong ? 'text-red-400' : 'text-emerald-300'
        }`}
      >
        {showing ? code : entry.padEnd(LEN, '·')}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((d) => (
          <button
            key={d}
            onClick={() => press(String(d))}
            disabled={showing}
            className={`h-14 w-16 rounded-lg bg-neutral-800 text-2xl font-bold active:bg-neutral-600 disabled:opacity-40 ${
              d === 0 ? 'col-start-2' : ''
            }`}
          >
            {d}
          </button>
        ))}
      </div>
    </div>
  );
}
