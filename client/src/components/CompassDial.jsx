/**
 * Standalone compass dial — always on screen, independent of the (often
 * collapsed, dark-by-default for hiders) boundary map. Dial face rotates
 * with the device so N/E/S/W track true north; a fixed pointer at the top
 * always represents "the way the phone is facing."
 */
export default function CompassDial({ heading }) {
  const available = heading != null;
  return (
    <div className="mx-auto flex flex-col items-center gap-1">
      <div className="relative flex h-20 w-20 items-center justify-center rounded-full border-2 border-neutral-700 bg-panel">
        <div
          className="absolute inset-0"
          style={{
            transform: `rotate(${available ? -heading : 0}deg)`,
            transition: 'transform 0.2s ease-out',
          }}
        >
          <span className="absolute left-1/2 top-1 -translate-x-1/2 text-xs font-black text-red-400">N</span>
          <span className="absolute right-1 top-1/2 -translate-y-1/2 text-xs font-bold text-neutral-400">E</span>
          <span className="absolute bottom-1 left-1/2 -translate-x-1/2 text-xs font-bold text-neutral-400">S</span>
          <span className="absolute left-1 top-1/2 -translate-y-1/2 text-xs font-bold text-neutral-400">W</span>
        </div>
        <div className="pointer-events-none absolute top-0.5 text-lamp">▲</div>
      </div>
      <span className="text-[10px] font-semibold text-neutral-500">
        {available ? `${heading}°` : 'no compass signal'}
      </span>
    </div>
  );
}
