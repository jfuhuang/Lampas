import { useEffect } from 'react';

const TONES = {
  info: 'bg-sky-900/95 text-sky-100 border-sky-700',
  warn: 'bg-amber-900/95 text-amber-100 border-amber-600',
  alert: 'bg-red-900/95 text-red-100 border-red-600',
};

/** Self-dismissing banner pinned to the top; big text for outdoor readability. */
export default function Toast({ text, tone = 'info', onDone, ms = 6000 }) {
  useEffect(() => {
    const t = setTimeout(onDone, ms);
    return () => clearTimeout(t);
  }, [onDone, ms]);
  return (
    <div
      className={`fixed inset-x-3 top-3 z-50 rounded-xl border px-4 py-3 text-center text-base font-bold shadow-lg ${TONES[tone]}`}
      onClick={onDone}
      role="alert"
    >
      {text}
    </div>
  );
}
