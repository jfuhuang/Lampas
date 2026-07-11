import { useState } from 'react';
import { socket } from '../lib/socket.js';
import {
  unlockAudio,
  requestWakeLock,
  prewarmTorch,
  enableTorch,
  disableTorch,
  requestCompassPermission,
} from '../lib/geo.js';
import { useGame } from '../context/GameContext.jsx';

/**
 * Player lobby: see teams forming, tap Ready. The Ready tap doubles as the
 * user gesture that unlocks audio and grabs the screen wake lock — both
 * REQUIRE a gesture on mobile, so they piggyback here (platform constraint).
 */
export default function Lobby() {
  const { game, you, logout } = useGame();
  const [torchTest, setTorchTest] = useState('idle'); // idle|testing|on|failed

  // Field diagnostic: verify the phone's torch BEFORE the game, inside a
  // guaranteed user gesture. 2s flash then off.
  const testTorch = async () => {
    setTorchTest('testing');
    const ok = await enableTorch();
    if (ok) {
      setTorchTest('on');
      setTimeout(() => {
        disableTorch();
        setTorchTest('idle');
      }, 2000);
    } else {
      setTorchTest('failed');
    }
  };

  const handleReady = async () => {
    // One tap unlocks every gesture-gated API: audio, wake lock, and the
    // camera permission for the Android torch (prompt now, not mid-event).
    unlockAudio();
    prewarmTorch(); // fire-and-forget; Android shows its prompt here
    requestCompassPermission(); // iOS orientation prompt (map heading arrow)
    await requestWakeLock();
    socket.emit('player:ready', { ready: !you.ready });
  };

  return (
    <div className="flex flex-1 flex-col gap-5 py-6">
      <header className="text-center">
        <div className="lamp-flicker text-4xl">🏮</div>
        <h1 className="text-2xl font-black text-lamp">Lobby</h1>
        <p className="text-sm text-neutral-400">
          Waiting for the host to start. You're <b className="text-neutral-200">{you.name}</b> on{' '}
          <b className="text-neutral-200">{you.teamName}</b>.
        </p>
      </header>

      <TeamList teams={game.teams} youId={you.id} />

      <div className="mt-auto flex flex-col gap-2">
        <button
          onClick={handleReady}
          className={`rounded-xl px-4 py-5 text-xl font-black active:scale-95 ${
            you.ready ? 'bg-green-600 text-white' : 'bg-lamp text-night'
          }`}
        >
          {you.ready ? '✓ Ready — tap to unready' : "I'm ready"}
        </button>
        <button
          onClick={testTorch}
          disabled={torchTest === 'testing' || torchTest === 'on'}
          className="rounded-xl border border-neutral-700 bg-panel px-4 py-3 text-sm font-bold text-neutral-300 active:scale-95 disabled:opacity-50"
        >
          {torchTest === 'idle' && '🔦 Test my flashlight (Android)'}
          {torchTest === 'testing' && 'Trying cameras…'}
          {torchTest === 'on' && '💡 Torch ON — turning off in 2s'}
          {torchTest === 'failed' &&
            '❌ No torch — use Chrome + allow camera (screen flash still works)'}
        </button>
        <p className="text-center text-xs text-neutral-500">
          Ready also enables sound &amp; keeps your screen awake. Arrive charged — GPS eats battery.
        </p>
        <div className="mx-auto mt-1 flex items-center gap-4 text-xs font-semibold text-neutral-500">
          <a href="/how" className="px-1 py-2 underline">
            How to play
          </a>
          <button onClick={logout} className="px-1 py-2 underline active:scale-95">
            Log out (forget me on this phone)
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * `onKick(player)` / `onDeleteTeam(team)` (host lobby only) add ✕ per
 * player and a 🗑 per team.
 */
export function TeamList({ teams, youId, onKick, onDeleteTeam }) {
  return (
    <div className="flex flex-col gap-3">
      {teams.map((team) => (
        <div key={team.id} className="rounded-xl border border-neutral-800 bg-panel p-3">
          <div className="flex items-center justify-between">
            <span className="font-bold">{team.name}</span>
            <span className="flex items-center gap-2">
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-bold uppercase ${
                  team.role === 'seeker' ? 'bg-red-900 text-red-200' : 'bg-emerald-900 text-emerald-200'
                }`}
              >
                {team.role}
              </span>
              {onDeleteTeam && (
                <button
                  onClick={() => onDeleteTeam(team)}
                  aria-label={`Delete team ${team.name}`}
                  className="rounded px-1.5 py-0.5 text-sm active:scale-90"
                >
                  🗑
                </button>
              )}
            </span>
          </div>
          <ul className="mt-2 flex flex-wrap gap-2">
            {team.players.map((p) => (
              <li
                key={p.id}
                className={`flex items-center gap-1 rounded-lg px-2 py-1 text-sm ${
                  p.id === youId ? 'bg-lamp/20 text-lamp' : 'bg-neutral-800 text-neutral-300'
                } ${!p.connected ? 'opacity-40' : ''}`}
              >
                {p.isHost && '👑 '}
                {p.name}
                {p.ready ? ' ✓' : ''}
                {onKick && !p.isHost && (
                  <button
                    onClick={() => onKick(p)}
                    aria-label={`Kick ${p.name}`}
                    className="-mr-0.5 ml-1 rounded px-1.5 py-0.5 font-black text-red-400 active:scale-90"
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
