import { useState } from 'react';
import { useGame } from '../context/GameContext.jsx';
import { getStoredCreds } from '../lib/socket.js';

/**
 * Name + team entry. First player to join becomes host/referee.
 * Prefilled from localStorage so a returning player (or one whose server
 * restarted mid-night) rejoins with one tap.
 */
export default function JoinScreen() {
  const { join } = useGame();
  const stored = getStoredCreds();
  const [name, setName] = useState(stored?.name ?? '');
  const [teamName, setTeamName] = useState(stored?.teamName ?? '');

  const canJoin = name.trim().length > 0 && teamName.trim().length > 0;

  return (
    <div className="flex flex-1 flex-col justify-center gap-6 py-10">
      <div className="text-center">
        <div className="lamp-flicker text-6xl">🏮</div>
        <h1 className="mt-3 text-4xl font-black tracking-tight text-lamp">Lampas</h1>
        <p className="mt-1 text-sm text-neutral-400">Flashlight hide &amp; seek — stay lit, stay ready</p>
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canJoin) join(name.trim(), teamName.trim());
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-neutral-300">Your name</span>
          <input
            className="rounded-xl border border-neutral-700 bg-panel px-4 py-3 text-lg outline-none focus:border-lamp"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Maria"
            maxLength={24}
            autoComplete="off"
            required
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-neutral-300">Team name</span>
          <input
            className="rounded-xl border border-neutral-700 bg-panel px-4 py-3 text-lg outline-none focus:border-lamp"
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            placeholder="e.g. Night Owls (same name = same team)"
            maxLength={24}
            autoComplete="off"
            required
          />
        </label>
        <button
          type="submit"
          disabled={!canJoin}
          className="mt-2 rounded-xl bg-lamp px-4 py-4 text-lg font-black text-night active:scale-95 disabled:opacity-40"
        >
          {stored ? 'Rejoin the game' : 'Join the game'}
        </button>
      </form>

      <p className="text-center text-xs text-neutral-500">
        First person in becomes the host / referee. Teammates: type the exact same team name.
      </p>
    </div>
  );
}
