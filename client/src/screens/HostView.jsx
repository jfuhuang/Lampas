import { useState } from 'react';
import { useGame } from '../context/GameContext.jsx';
import RefereeView from './RefereeView.jsx';
import Lobby from './Lobby.jsx';
import HiderView from './HiderView.jsx';
import SeekerView from './SeekerView.jsx';

/**
 * Host view: the host is BOTH referee and a player on a team. Two tabs —
 *   👑 Referee: map, controls, curveballs (RefereeView)
 *   🔦 Play:    the host's own player screen (lobby / hider / seeker)
 * so hosting doesn't lock them out of playing the game.
 */
export default function HostView() {
  const { you, phase } = useGame();
  const [tab, setTab] = useState('referee'); // 'referee' | 'play'

  // Hosts join teamless (referee-only) — no team, no Play tab, no tab bar.
  if (!you.teamId) return <RefereeView />;

  let playScreen;
  if (phase === 'lobby') playScreen = <Lobby />;
  else if (you.role === 'seeker') playScreen = <SeekerView />;
  else playScreen = <HiderView />;

  return (
    <div className="flex flex-1 flex-col">
      <nav className="sticky top-2 z-30 mt-2 flex gap-1 rounded-xl border border-neutral-800 bg-panel p-1">
        <TabButton active={tab === 'referee'} onClick={() => setTab('referee')}>
          👑 Referee
        </TabButton>
        <TabButton active={tab === 'play'} onClick={() => setTab('play')}>
          🔦 Play ({you.role})
        </TabButton>
      </nav>
      {tab === 'referee' ? <RefereeView /> : playScreen}
    </div>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-lg px-3 py-2.5 text-sm font-black transition-colors active:scale-95 ${
        active ? 'bg-lamp text-night' : 'text-neutral-400'
      }`}
    >
      {children}
    </button>
  );
}
