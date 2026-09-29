import { useEffect, useRef, useState } from 'react';

// Keep ≥ the server's MIN_TASK_MS.download (10s) or completion is refused.
const NEEDED_MS = 11_000;

/**
 * Download the files: hold the button until the bar fills. Letting go
 * pauses (doesn't reset) — the tension is standing still, lit up, for 11s.
 */
export default function Download({ onDone }) {
  const [held, setHeld] = useState(false);
  const [ms, setMs] = useState(0);
  const finished = useRef(false);

  useEffect(() => {
    if (!held) return undefined;
    let last = performance.now();
    const t = setInterval(() => {
      const now = performance.now();
      setMs((m) => Math.min(NEEDED_MS, m + (now - last)));
      last = now;
    }, 100);
    return () => clearInterval(t);
  }, [held]);

  useEffect(() => {
    if (ms >= NEEDED_MS && !finished.current) {
      finished.current = true;
      onDone();
    }
  }, [ms, onDone]);

  const pct = Math.round((ms / NEEDED_MS) * 100);

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-sm text-neutral-400">Hold to download the vault ledger. Letting go pauses.</p>
      <div className="h-4 w-full max-w-xs overflow-hidden rounded-full bg-neutral-800">
        <div className="h-full bg-emerald-500 transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <p className="font-mono text-lg text-emerald-300">{pct}%</p>
      <button
        onPointerDown={() => setHeld(true)}
        onPointerUp={() => setHeld(false)}
        onPointerLeave={() => setHeld(false)}
        onPointerCancel={() => setHeld(false)}
        onContextMenu={(e) => e.preventDefault()}
        className={`h-28 w-28 touch-none select-none rounded-full text-lg font-black ${
          held ? 'scale-95 bg-emerald-700 text-white' : 'bg-neutral-800 text-neutral-300'
        }`}
      >
        {held ? 'Downloading…' : 'HOLD'}
      </button>
    </div>
  );
}
