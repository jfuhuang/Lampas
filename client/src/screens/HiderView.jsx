import { useState } from "react";
import { socket } from "../lib/socket.js";
import Countdown from "../components/Countdown.jsx";
import PlayerMap from "../components/PlayerMap.jsx";
import { useGame } from "../context/GameContext.jsx";

/**
 * Hider screen: phase countdown, minimal status, and the "I'm caught"
 * button. Deliberately dark & minimal — a bright screen gives away a
 * hiding spot. NO positions of anyone are ever shown here (privacy rule).
 */
export default function HiderView() {
  const { game, myPos } = useGame();
  const [confirming, setConfirming] = useState(false);
  const { phase, phaseEndsAt, serverNow, you } = game;
  const hiderTeams = game.teams.filter((t) => t.role === "hider").length;

  if (phase === "over") return <GameOver />;

  return (
    <div className="flex flex-1 flex-col gap-6 py-6">
      <header className="text-center">
        <PhaseBadge phase={phase} role="hider" />
        <Countdown
          endsAt={phaseEndsAt}
          serverNow={serverNow}
          label={phase === "hide" ? "Time to hide" : "Survive until"}
          className="mt-3"
        />
      </header>

      <div className="rounded-xl border border-neutral-800 bg-panel p-4 text-center">
        <p className="text-sm text-neutral-400">
          {phase === "hide"
            ? "Get inside the boundary and hide. Seekers are frozen at base."
            : "Seekers are hunting. Stay inside the boundary — outside too long = auto-caught."}
        </p>
        <p className="mt-2 text-lg font-bold text-emerald-300">
          {hiderTeams} hider team{hiderTeams === 1 ? "" : "s"} still free
        </p>
      </div>

      {/* Collapsed by default — a lit screen gives away a hiding spot. */}
      <PlayerMap boundary={game.boundary} myPos={myPos} others={game.positions} collapsedByDefault />

      <div className="mt-auto flex flex-col gap-2">
        {confirming ? (
          <>
            <p className="text-center text-sm font-bold text-red-300">
              A seeker's light hit you? This converts your WHOLE team to
              seekers.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirming(false)}
                className="flex-1 rounded-xl bg-neutral-700 px-4 py-4 text-lg font-bold active:scale-95"
              >
                Cancel
              </button>
              <button
                onClick={() => socket.emit("caught:self")}
                className="flex-1 rounded-xl bg-red-600 px-4 py-4 text-lg font-black text-white active:scale-95"
              >
                Yes, caught
              </button>
            </div>
          </>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            disabled={phase !== "seek"}
            className="rounded-xl border-2 border-red-700 bg-red-950 px-4 py-5 text-xl font-black text-red-200 active:scale-95 disabled:opacity-30"
          >
            🔦 I'm caught
          </button>
        )}
        <p className="text-center text-xs text-neutral-600">
          Team: {you.teamName} · Keep this screen dim &amp; face-down while
          hiding
        </p>
      </div>
    </div>
  );
}

export function PhaseBadge({ phase, role }) {
  const styles = {
    hide: "bg-sky-900 text-sky-200",
    seek: "bg-red-900 text-red-200",
    over: "bg-neutral-800 text-neutral-300",
    lobby: "bg-neutral-800 text-neutral-300",
  };
  return (
    <div className="flex items-center justify-center gap-2">
      <span
        className={`rounded-full px-3 py-1 text-sm font-black uppercase tracking-widest ${styles[phase]}`}
      >
        {phase} phase
      </span>
      <span className="rounded-full bg-neutral-800 px-3 py-1 text-sm font-bold uppercase text-neutral-300">
        {role}
      </span>
    </div>
  );
}

export function GameOver() {
  const { game } = useGame();
  const won = game.winnerTeamId && game.you?.teamId === game.winnerTeamId;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-10 text-center">
      <div className="text-7xl">{won ? "🏆" : "🏮"}</div>
      <h1 className="text-3xl font-black text-lamp">Game over</h1>
      <p className="text-xl font-bold">
        {game.winnerTeamName
          ? `${game.winnerTeamName} win${won ? " — that’s you!" : "!"}`
          : "Seekers caught everyone!"}
      </p>
      <p className="text-sm text-neutral-400">Return to Blue Ridge!</p>
    </div>
  );
}
