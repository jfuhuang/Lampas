/**
 * /how — static tutorial page. No game state needed; reachable before
 * joining (linked from the Join screen and the Lobby).
 */
export default function HowToPlay() {
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-5 px-4 py-8">
      <header className="text-center">
        <div className="lamp-flicker text-5xl">🏮</div>
        <h1 className="mt-2 text-3xl font-black text-lamp">How to play Lampas</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Flashlight hide &amp; seek, refereed by your phone
        </p>
      </header>

      <Card title="🎯 The game">
        Teams hide in the dark inside a circular boundary. Seekers hunt them with real
        flashlights. When a beam lights you up, you're caught — your whole team joins
        the seekers. <b>Last un-caught hider team wins.</b> The app runs timers, the
        boundary, and events — the catching happens with actual flashlights outside.
      </Card>

      <Card title="👥 Roles">
        <ul className="list-inside list-disc space-y-1">
          <li>
            <b>Hiders</b> — hide inside the boundary, stay quiet, survive.
          </li>
          <li>
            <b>Seekers</b> — roam with flashlights and light people up.
          </li>
          <li>
            <b>Host / referee</b> — logs in at <code>/host</code>, runs the game from
            the referee panel, sees everyone on a live map. Doesn't play.
          </li>
        </ul>
      </Card>

      <Card title="⏱ Phases">
        <ol className="list-inside list-decimal space-y-1">
          <li>
            <b>Lobby</b> — join with your name + team name (same name = same team).
            Tap <b>Ready</b> — it unlocks sound, keeps your screen awake, and asks for
            the camera (Android flashlight).
          </li>
          <li>
            <b>Hide</b> — hiders get a countdown to hide inside the circle. Seekers
            frozen at base.
          </li>
          <li>
            <b>Seek</b> — seekers hunt until the timer runs out (survivors win) or
            one hider team remains (they win).
          </li>
        </ol>
      </Card>

      <Card title="🔦 Getting caught (honor system)">
        A seeker lit you up? <b>You</b> tap "I'm caught" on your own phone — the
        seeker can't tag you. Dispute? The referee has the final say and can tag
        manually. Your whole team converts to seekers when any member is caught.
      </Card>

      <Card title="⭕ The boundary">
        Stay inside the amber circle on your map. Drift out and your phone warns you
        (it also buzzes when you're within ~20m of the edge). There's no automatic
        penalty — GPS is too wobbly for that — but the <b>referee sees exactly who's
        outside</b> and can tag teams that abuse it. GPS wobbles ±10m — don't hug the
        line.
      </Card>

      <Card title="🎲 Curveballs (host-triggered)">
        <ul className="space-y-1">
          <li>🔊 <b>Sound</b> — every hider phone rings. Audible reveal.</li>
          <li>
            🔦 <b>Torch</b> — every screen flashes white, held up = you're a lamp.
            Android Chrome also fires the real flashlight.
          </li>
          <li>⭕ <b>Shrink</b> — the boundary tightens. Relocate fast.</li>
          <li>📍 <b>Reveal</b> — everyone's dot on everyone's map for ~20s.</li>
        </ul>
      </Card>

      <Card title="📱 Phone prep">
        <ul className="list-inside list-disc space-y-1">
          <li>Arrive <b>charged</b> — GPS + screen-on is hungry.</li>
          <li>Allow <b>location</b> when asked (needs it for the boundary).</li>
          <li>Android: use <b>Chrome</b> and test the flashlight in the lobby.</li>
          <li>iPhone: take it <b>off silent</b> or you won't hear the sound event.</li>
          <li>Screen dim + face-down while hiding. Light leaks lose games.</li>
        </ul>
      </Card>

      <a
        href="/"
        className="rounded-xl bg-lamp px-4 py-4 text-center text-lg font-black text-night active:scale-95"
      >
        ← Back to the game
      </a>
    </div>
  );
}

function Card({ title, children }) {
  return (
    <section className="rounded-xl border border-neutral-800 bg-panel p-4 text-sm text-neutral-300">
      <h2 className="mb-2 font-black text-neutral-100">{title}</h2>
      {children}
    </section>
  );
}
