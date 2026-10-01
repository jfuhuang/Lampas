import { useEffect, useRef, useState } from 'react';
import { playProximityPing, vibrate } from '../lib/geo.js';

// Heat levels come from the server (server/decoys.js heatFor): 0 cold … 4 burning.
const LEVELS = [
  { label: 'Cold', color: 'bg-sky-700', text: 'text-sky-300' },
  { label: 'Cool', color: 'bg-cyan-600', text: 'text-cyan-300' },
  { label: 'Warm', color: 'bg-amber-500', text: 'text-amber-300' },
  { label: 'Hot', color: 'bg-orange-500', text: 'text-orange-300' },
  { label: 'BURNING', color: 'bg-red-500', text: 'text-red-300' },
];
// Ping cadence per level; cold/cool stay silent so the cue means something.
const PING_EVERY_MS = { 2: 3000, 3: 1500, 4: 700 };

/**
 * Seeker proximity cue: haptic + sound pulses that speed up as the nearest
 * target (real hider OR decoy — the seeker can't tell which) gets closer.
 * Runs on a local timer off the latest level, so it keeps pulsing between
 * the server's ~2s state pushes.
 */
function useProximityCues(level, soundOn) {
  const levelRef = useRef(level);
  const soundRef = useRef(soundOn);
  levelRef.current = level;
  soundRef.current = soundOn;
  const prev = useRef(0);

  // Entering "burning" gets an immediate, stronger cue.
  useEffect(() => {
    if (level === 4 && prev.current < 4) {
      vibrate([200, 80, 200]);
      if (soundRef.current) playProximityPing(4);
    }
    prev.current = level;
  }, [level]);

  useEffect(() => {
    let timer;
    const loop = () => {
      const lv = levelRef.current;
      const every = PING_EVERY_MS[lv];
      if (every) {
        vibrate(lv === 4 ? [80, 50, 80] : [40]);
        if (soundRef.current) playProximityPing(lv);
      }
      timer = setTimeout(loop, every ?? 1000);
    };
    timer = setTimeout(loop, 1000);
    return () => clearTimeout(timer);
  }, []);
}

export default function HeatMeter({ heat }) {
  const [soundOn, setSoundOn] = useState(true);
  const level = heat?.level ?? 0;
  useProximityCues(level, soundOn);
  const info = LEVELS[level];

  return (
    <div className="rounded-xl border border-neutral-800 bg-panel p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-black uppercase tracking-widest text-neutral-400">
          Proximity
        </span>
        <button
          onClick={() => setSoundOn(!soundOn)}
          className="rounded-md bg-neutral-800 px-2 py-1 text-xs font-bold text-neutral-300 active:scale-95"
          aria-label="Toggle proximity sound"
        >
          {soundOn ? '🔊 sound on' : '🔇 sound off'}
        </button>
      </div>
      <div className="mt-2 flex gap-1" aria-hidden>
        {[1, 2, 3, 4].map((n) => (
          <div
            key={n}
            className={`h-3 flex-1 rounded ${level >= n ? LEVELS[level].color : 'bg-neutral-800'} ${
              level === 4 ? 'animate-pulse' : ''
            }`}
          />
        ))}
      </div>
      <p className={`mt-2 text-center text-lg font-black ${info.text}`}>
        {heat ? info.label : 'Waiting for GPS…'}
      </p>
      <p className="text-center text-xs text-neutral-500">
        Could be a hider — or a decoy.
      </p>
    </div>
  );
}
