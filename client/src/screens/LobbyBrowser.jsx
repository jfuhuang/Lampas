import { useState } from 'react';
import { socket } from '../lib/socket.js';
import { useGame } from '../context/GameContext.jsx';

const PHASE_LABEL = { lobby: 'Open', hide: 'Hiding', seek: 'In play', over: 'Finished' };

/**
 * Step 2: choose which lobby to join. Hosts (referees) can also create one.
 * The list is pushed live by the server (`lobbies:list`).
 */
export default function LobbyBrowser() {
  const { you, lobbies, request, logout } = useGame();
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const act = async (event, payload) => {
    setBusy(true);
    await request(event, payload);
    setBusy(false);
  };

  return (
    <div className="flex flex-1 flex-col gap-6 py-10">
      <header className="text-center">
        <div className="lamp-flicker text-4xl">🏮</div>
        <h1 className="text-2xl font-black text-lamp">Choose a lobby</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Playing as <b className="text-neutral-200">{you.name}</b>
          {you.isHost && ' · referee'}
        </p>
      </header>

      <div className="flex flex-col gap-2">
        {lobbies.map((l) => (
          <button
            key={l.id}
            disabled={busy}
            onClick={() => act('lobby:join', { lobbyId: l.id })}
            className="flex items-center justify-between rounded-xl border border-neutral-800 bg-panel px-4 py-3 text-left active:scale-95 disabled:opacity-50"
          >
            <span>
              <span className="block font-bold">{l.name}</span>
              <span className="text-xs text-neutral-400">
                {l.players} player{l.players === 1 ? '' : 's'} · {l.teams} team
                {l.teams === 1 ? '' : 's'}
                {l.mode === 'heist' ? ' · 🚓 heist' : ''}
                {l.mode === 'hideseek2' ? ' · 🎭 V2' : ''}
                {!l.hostOnline ? ' · no host online' : ''}
              </span>
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-bold uppercase ${
                l.phase === 'lobby' ? 'bg-emerald-900 text-emerald-200' : 'bg-neutral-800 text-neutral-300'
              }`}
            >
              {PHASE_LABEL[l.phase] ?? l.phase}
            </span>
          </button>
        ))}
        {lobbies.length === 0 && (
          <p className="text-center text-sm text-neutral-500">
            {you.isHost
              ? 'No lobbies yet — create one below.'
              : 'No lobbies yet — waiting for the host to open one.'}
          </p>
        )}
      </div>

      {you.isHost && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (newName.trim()) act('lobby:create', { name: newName.trim() });
          }}
        >
          <input
            className="min-w-0 flex-1 rounded-xl border border-amber-700 bg-panel px-4 py-3 text-lg outline-none focus:border-lamp"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New lobby name"
            maxLength={24}
            autoComplete="off"
          />
          <button
            type="submit"
            disabled={busy || !newName.trim()}
            className="rounded-xl bg-lamp px-4 py-3 font-black text-night active:scale-95 disabled:opacity-40"
          >
            Create
          </button>
        </form>
      )}

      <button
        onClick={() => socket.emit('lobby:list')}
        className="mx-auto px-3 py-1 text-xs font-semibold text-neutral-500 underline active:scale-95"
      >
        Refresh list
      </button>
      <button
        onClick={logout}
        className="mx-auto px-3 py-1 text-xs font-semibold text-neutral-500 underline active:scale-95"
      >
        Not you? Log out
      </button>
    </div>
  );
}
