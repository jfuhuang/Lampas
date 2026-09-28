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
 * Player lobby (step 3): make a team or join one, then tap Ready. The Ready tap doubles as the
 * user gesture that unlocks audio and grabs the screen wake lock — both
 * REQUIRE a gesture on mobile, so they piggyback here (platform constraint).
 */
export default function Lobby() {
  const { game, you, logout, request, leaveLobby } = useGame();
  const [teamName, setTeamName] = useState('');
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

  const max = game.settings?.maxTeamSize ?? 0;
  const unassigned = game.unassigned ?? [];

  const createTeam = async (e) => {
    e.preventDefault();
    if (!teamName.trim()) return;
    const res = await request('team:create', { name: teamName.trim() });
    if (!res.error) setTeamName('');
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
          Waiting for the host to start. You're <b className="text-neutral-200">{you.name}</b>
          {you.teamName ? (
            <>
              {' '}on <b className="text-neutral-200">{you.teamName}</b>.
            </>
          ) : (
            ' — make a team or join one below.'
          )}
        </p>
        {game.mode === 'heist' && (
          <p className="mt-2 inline-block rounded-full bg-violet-950 px-3 py-1 text-sm font-bold text-violet-200">
            🚓 Heist mode — you're a {you.role === 'seeker' ? 'COP' : 'ROBBER'}
          </p>
        )}
      </header>

      <TeamList
        teams={game.teams}
        youId={you.id}
        youTeamId={you.teamId}
        maxSize={max}
        onJoin={(t) => request('team:join', { teamId: t.id })}
        onLeave={() => socket.emit('team:leave')}
      />
      {game.teams.length === 0 && (
        <p className="text-center text-sm text-neutral-500">No teams yet — create the first one.</p>
      )}
      {unassigned.length > 0 && (
        <p className="text-center text-xs text-neutral-500">
          Not on a team yet: {unassigned.map((p) => p.name).join(', ')}
        </p>
      )}

      <form onSubmit={createTeam} className="flex gap-2">
        <input
          className="min-w-0 flex-1 rounded-xl border border-neutral-700 bg-panel px-4 py-3 outline-none focus:border-lamp"
          value={teamName}
          onChange={(e) => setTeamName(e.target.value)}
          placeholder="New team name"
          maxLength={24}
          autoComplete="off"
        />
        <button
          type="submit"
          disabled={!teamName.trim()}
          className="rounded-xl bg-neutral-800 px-4 py-3 font-bold active:scale-95 disabled:opacity-40"
        >
          + Create
        </button>
      </form>

      <div className="mt-auto flex flex-col gap-2">
        <button
          onClick={handleReady}
          disabled={!you.teamId}
          className={`rounded-xl disabled:opacity-40 px-4 py-5 text-xl font-black active:scale-95 ${
            you.ready ? 'bg-green-600 text-white' : 'bg-lamp text-night'
          }`}
        >
          {!you.teamId
            ? 'Pick a team to get ready'
            : you.ready
              ? '✓ Ready — tap to unready'
              : "I'm ready"}
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
          <button onClick={leaveLobby} className="px-1 py-2 underline active:scale-95">
            ← Lobbies
          </button>
          <button onClick={logout} className="px-1 py-2 underline active:scale-95">
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Player mode: `onJoin(team)` / `onLeave()` (+ `youTeamId`) add Join / Leave
 * buttons. Host mode: `onKick(player)` (any phase), `onDeleteTeam(team)` and
 * `onMove(player, teamId|null)` (lobby only) add ✕, 🗑 and a move dropdown.
 * `maxSize` (0 = none) shows n/max and disables Join on full teams.
 */
export function TeamList({
  teams,
  youId,
  youTeamId,
  maxSize = 0,
  onJoin,
  onLeave,
  onKick,
  onDeleteTeam,
  onMove,
}) {
  const heist = useGame().game?.mode === 'heist';
  const roleLabel = (role) => (heist ? (role === 'seeker' ? 'cops' : 'robbers') : role);
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
                {roleLabel(team.role)}
              </span>
              <span className="text-xs font-semibold text-neutral-400">
                {team.players.length}
                {maxSize > 0 ? `/${maxSize}` : ''}
              </span>
              {onJoin && team.id !== youTeamId && (
                <button
                  onClick={() => onJoin(team)}
                  disabled={maxSize > 0 && team.players.length >= maxSize}
                  className="rounded-lg bg-lamp px-3 py-1 text-xs font-black text-night active:scale-95 disabled:opacity-40"
                >
                  {maxSize > 0 && team.players.length >= maxSize ? 'Full' : 'Join'}
                </button>
              )}
              {onLeave && team.id === youTeamId && (
                <button
                  onClick={onLeave}
                  className="rounded-lg border border-neutral-600 px-3 py-1 text-xs font-bold text-neutral-300 active:scale-95"
                >
                  Leave
                </button>
              )}
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
                {onMove && !p.isHost && (
                  <select
                    value={team.id}
                    onChange={(e) => onMove(p, e.target.value || null)}
                    aria-label={`Move ${p.name} to another team`}
                    className="ml-1 w-6 rounded bg-neutral-700 text-xs text-neutral-200"
                  >
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                    <option value="">— no team —</option>
                  </select>
                )}
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
