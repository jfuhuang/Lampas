import { useState } from 'react';
import { useGame } from '../context/GameContext.jsx';

/**
 * Corner indicator: how many hider teams are still un-caught. Tap to
 * expand the team names. Team identities are public info (everyone saw
 * the lobby) — only their POSITIONS are secret, and those never appear
 * here. Hidden in the lobby; sits below the toast layer (z-50).
 */
export default function HiderTeamsBadge({ position = 'right-3 top-3' }) {
  const { game, phase, joined } = useGame();
  const [open, setOpen] = useState(false);

  if (!joined || !game || phase === 'lobby') return null;
  const hiders = game.teams.filter((t) => t.role === 'hider' && t.players.length > 0);

  return (
    <button
      onClick={() => setOpen(!open)}
      className={`fixed ${position} z-30 rounded-xl border border-emerald-800 bg-emerald-950/90 px-3 py-2 text-left shadow-lg backdrop-blur active:scale-95`}
      aria-label={`${hiders.length} hider teams remaining — tap for names`}
    >
      <span className="flex items-center gap-1.5 text-sm font-black text-emerald-200">
        🏮 {hiders.length} hiding
        <span className="text-[10px] font-bold text-emerald-500">{open ? '▴' : '▾'}</span>
      </span>
      {open && (
        <ul className="mt-1 border-t border-emerald-900 pt-1 text-xs font-semibold text-emerald-300">
          {hiders.map((t) => (
            <li key={t.id}>{t.name}</li>
          ))}
          {hiders.length === 0 && <li className="text-neutral-400">none left</li>}
        </ul>
      )}
    </button>
  );
}
