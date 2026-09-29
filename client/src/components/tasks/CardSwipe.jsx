import { useRef, useState } from 'react';

const MIN_MS = 500;
const MAX_MS = 1400;

/**
 * Swipe the keycard: drag the card across the reader — not too fast, not
 * too slow (the classic). Pointer events cover touch and mouse.
 */
export default function CardSwipe({ onDone }) {
  const track = useRef(null);
  const start = useRef(null); // { x, at }
  const [x, setX] = useState(0); // 0..1
  const [msg, setMsg] = useState('Drag the card across the reader');

  const frac = (clientX) => {
    const r = track.current.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left - 32) / (r.width - 64)));
  };

  const down = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { at: performance.now() };
    setX(frac(e.clientX));
  };
  const move = (e) => {
    if (start.current) setX(frac(e.clientX));
  };
  const up = (e) => {
    if (!start.current) return;
    const ms = performance.now() - start.current.at;
    const reached = frac(e.clientX) > 0.95;
    start.current = null;
    if (!reached) setMsg('Swipe all the way across');
    else if (ms < MIN_MS) setMsg('Too fast — try again');
    else if (ms > MAX_MS) setMsg('Too slow — try again');
    else {
      setMsg('Accepted ✓');
      setTimeout(onDone, 300);
      return;
    }
    setX(0);
  };

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-sm text-neutral-400">{msg}</p>
      <div
        ref={track}
        className="relative h-20 w-full max-w-xs touch-none rounded-xl border-2 border-neutral-700 bg-neutral-900"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <div
          className="absolute top-2 flex h-16 w-16 items-center justify-center rounded-lg bg-emerald-700 text-2xl"
          style={{ left: `calc(${x} * (100% - 4rem))` }}
        >
          💳
        </div>
      </div>
    </div>
  );
}
