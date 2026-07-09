import { GameProvider, useGame } from './context/GameContext.jsx';
import JoinScreen from './screens/JoinScreen.jsx';
import Lobby from './screens/Lobby.jsx';
import HiderView from './screens/HiderView.jsx';
import SeekerView from './screens/SeekerView.jsx';
import HostView from './screens/HostView.jsx';
import TorchOverlay from './components/TorchOverlay.jsx';
import Toast from './components/Toast.jsx';
import HiderTeamsBadge from './components/HiderTeamsBadge.jsx';
import DevApp from './dev/DevApp.jsx';

// `?dev` swaps the whole app for the mock-driven dev view (dev/DevApp.jsx):
// real screens, local fake engine, no server needed.
const DEV_MODE = new URLSearchParams(window.location.search).has('dev');

/**
 * App is deliberately thin: GameProvider owns all socket/game state
 * (see context/GameContext.jsx); Router just picks the screen by role.
 */
export default function App() {
  if (DEV_MODE) return <DevApp />;
  return (
    <GameProvider>
      <Shell>
        <Router />
        <Overlays />
      </Shell>
    </GameProvider>
  );
}

function Router() {
  const { game, you, phase, joined } = useGame();

  if (!joined || !you) return <JoinScreen />;
  if (you.isHost) return <HostView />;
  if (phase === 'lobby') return <Lobby />;
  if (you.role === 'seeker') return <SeekerView />;
  return <HiderView />;
}

function Overlays() {
  const { torchActive, toast, dismissToast } = useGame();
  return (
    <>
      <HiderTeamsBadge />
      {torchActive && <TorchOverlay />}
      {toast && <Toast key={toast.at} {...toast} onDone={dismissToast} />}
    </>
  );
}

/** Page chrome: dark shell + connection indicator. Mobile-first column. */
function Shell({ children }) {
  const { connected } = useGame();
  return (
    <div className="flex min-h-dvh flex-col">
      {!connected && (
        <div className="bg-red-900/90 px-4 py-2 text-center text-sm font-semibold text-red-100">
          Reconnecting… (game continues, state will re-sync)
        </div>
      )}
      <div className="mx-auto flex w-full max-w-lg flex-1 flex-col px-4 pb-6 lg:max-w-6xl">
        {children}
      </div>
    </div>
  );
}
