import { useState } from 'react';
import { useGame } from '../context/GameContext.jsx';
import { getStoredCreds } from '../lib/socket.js';

/**
 * Name + team entry, prefilled from localStorage so a returning player
 * rejoins with one tap.
 *
 * Host login: visit /host (password-only form), or type `host` as the name
 * on the landing page. Hosts are referees — they have NO team, so the team
 * field disappears for them.
 */
export default function JoinScreen() {
  const { join, connected } = useGame();
  const hostMode = window.location.pathname === '/host';
  const stored = getStoredCreds();
  const [name, setName] = useState(hostMode ? 'host' : (stored?.name ?? ''));
  const [teamName, setTeamName] = useState(stored?.teamName ?? '');
  const [hostPass, setHostPass] = useState(stored?.hostPass ?? '');

  const wantsHost = hostMode || name.trim().toLowerCase() === 'host';
  const canJoin =
    connected &&
    name.trim().length > 0 &&
    (wantsHost ? hostPass.length > 0 : teamName.trim().length > 0);

  return (
    <div className="flex flex-1 flex-col justify-center gap-6 py-10">
      <div className="text-center">
        <div className="lamp-flicker text-6xl">🏮</div>
        <h1 className="mt-3 text-4xl font-black tracking-tight text-lamp">
          Lampas{hostMode && <span className="text-neutral-400"> · host</span>}
        </h1>
        <p className="mt-1 text-sm text-neutral-400">
          {hostMode
            ? 'Referee login — enter the host password'
            : 'Flashlight hide & seek — stay lit, stay ready'}
        </p>
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canJoin) return;
          join(
            wantsHost ? 'host' : name.trim(),
            wantsHost ? undefined : teamName.trim(),
            wantsHost ? hostPass : undefined,
          );
        }}
      >
        {!hostMode && (
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
        )}
        {!wantsHost && (
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
        )}
        {wantsHost && (
          <label className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-amber-300">Host password</span>
            <input
              type="password"
              className="rounded-xl border border-amber-700 bg-panel px-4 py-3 text-lg outline-none focus:border-lamp"
              value={hostPass}
              onChange={(e) => setHostPass(e.target.value)}
              placeholder="required to referee"
              autoComplete="current-password"
              required
            />
          </label>
        )}
        <button
          type="submit"
          disabled={!canJoin}
          className="mt-2 rounded-xl bg-lamp px-4 py-4 text-lg font-black text-night active:scale-95 disabled:opacity-40"
        >
          {!connected
            ? 'Connecting to server…'
            : wantsHost
              ? 'Log in as host'
              : stored
                ? 'Rejoin the game'
                : 'Join the game'}
        </button>
        {!connected && (
          <p className="text-center text-xs font-semibold text-amber-400">
            Can't reach the game server. If this persists: the server may be
            waking up (free tier, ~1 min), or the client build is pointing at
            the wrong VITE_SERVER_URL.
          </p>
        )}
      </form>

      <p className="text-center text-xs text-neutral-500">
        {hostMode ? (
          <a href="/" className="underline">
            ← player join page
          </a>
        ) : (
          <>Teammates: type the exact same team name. Refereeing? Go to /host.</>
        )}
      </p>
    </div>
  );
}
