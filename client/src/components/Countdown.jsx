import { useEffect, useMemo, useState } from 'react';

/**
 * Ticks down to `endsAt` using the server clock: `serverNow` arrived in the
 * same game:state payload as `endsAt`, so the offset (serverNow - local now)
 * corrects a wrong phone clock. Local time then advances the remainder.
 */
export default function Countdown({ endsAt, serverNow, label, className = '' }) {
  // Clock offset captured once per payload (serverNow changes every state push).
  const offset = useMemo(() => serverNow - Date.now(), [serverNow]);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  if (!endsAt) return null;
  const remaining = Math.max(0, endsAt - (now + offset));
  const totalSec = Math.ceil(remaining / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  const urgent = totalSec <= 30;

  return (
    <div className={`text-center ${className}`}>
      {label && (
        <div className="text-xs font-semibold uppercase tracking-widest text-neutral-400">
          {label}
        </div>
      )}
      <div
        className={`font-mono text-6xl font-black tabular-nums ${
          urgent ? 'animate-pulse text-red-400' : 'text-lamp'
        }`}
      >
        {mm}:{ss}
      </div>
    </div>
  );
}
