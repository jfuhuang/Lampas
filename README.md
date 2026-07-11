# 🏮 Lampas — Flashlight Hide & Seek

**Lampas** (Greek λαμπάς, "torch/lamp") is a web app that facilitates and referees outdoor,
nighttime flashlight hide-and-seek. It runs timers, enforces a circular play boundary via GPS,
tracks team positions for the referee, and fires "curveball" events (sound reveals, lights-on
flashes, shrinking zones). The **physical catch** — a flashlight beam hitting a hider — is
adjudicated by humans tapping a button; the app is a referee, not a sensor.

Monolithic full-stack app: one Node process serves the React build **and** the WebSocket.
One URL, nothing to coordinate, no database — state lives in memory for one night of play.

---

## How the game works

1. **Lobby** — everyone opens the URL on their phone, enters a name + team name
   (same team name = same team; both are remembered on the phone for reconnects).
   The **host/referee** logs in at **`/host`** instead — password only
   (default `pass`, override with the `HOST_PASSWORD` env var on the server);
   typing `host` as the name on the landing page works too. Hosts have no
   team — they get the referee panel (map, timers, curveballs, manual tags).
   The host sets the boundary circle, timers, and picks which team seeks
   first. Everyone taps **Ready** (this also unlocks sound and keeps the
   screen awake).
2. **Hide phase** — hiders get a countdown to get inside the boundary and hide.
   Seekers are frozen at base.
3. **Seek phase** — seekers roam with real flashlights. When a beam hits a hider,
   the **caught hider taps "I'm caught"** on their own phone (or the referee tags
   them manually — seekers can't tag) — the caught player's **whole team converts
   to seekers**.
4. **Curveballs** (host-triggered):
   - 🔊 **Sound** — every hider phone plays a looped reveal sound (audible reveal;
     clip at `client/public/sounds/reveal.mp3`, swap the file to change it)
   - 🔦 **Torch** — full-screen white "LIGHTS ON" flash on every phone
     (plus real camera torch on Android Chrome)
   - ⭕ **Shrink** — boundary radius drops, forcing hiders to relocate
   - 📍 **Reveal** — everyone's live location appears on every player's map
     for ~20 seconds (the one sanctioned privacy breach — spice)
5. **Win** — last un-caught hider team standing. If the seek timer runs out,
   surviving hiders win. Teams that drift outside the boundary get a warning
   (no automatic penalty — the referee sees offenders and tags manually if
   needed). Hider phones also buzz privately when within ~20m of the edge
   (computed on-device — nothing sent anywhere).
6. **Game over** — everyone sees the survival leaderboard (who lasted how long,
   how each team got caught) and an event timeline.

New players: the **`/how`** page is a full tutorial. The host can show a **QR
code** in the lobby (Invite players section) so phones join by scanning.

---

## Quick start

Requires **Node ≥ 18**.

```bash
npm install        # installs server + client deps (postinstall handles client)
npm run build      # builds the React client into client/dist
npm start          # serves everything on http://localhost:3000
```

Open `http://localhost:3000`. Done — that one URL is the whole app.

### Development (hot reload)

Run the server and the Vite dev server in two terminals:

```bash
npm run dev          # terminal 1 — Node server on :3000
npm run dev:client   # terminal 2 — Vite on :5173 (proxies the websocket to :3000)
```

Open `http://localhost:5173`. Vite exposes the dev server on your LAN
(`host: true`), so phones on the same Wi-Fi can hit `http://<your-ip>:5173` —
**but see the HTTPS warning below.**

### Tests

```bash
npm test           # unit tests (node:test) — geometry + game state machine
```

### Dev view (no server, no GPS, no friends required)

Open the app with **`?dev`** in the URL — e.g. `http://localhost:5173/?dev`:

- Renders the **real screens** against a local mock game engine
  (`client/src/dev/`): `socket.emit` is intercepted, so every button —
  tags, ready, curveballs, phase changes, map taps — mutates mock state
  instead of hitting the server (the real socket is disconnected).
- **Screen picker**: force any screen (join / lobby / hider / seeker /
  host / referee / game-over) or leave `auto` to see exactly what the
  selected persona would see in the current phase.
- **Persona picker**: view the game as the host, a hider, or a seeker.
- **Simulation**: bots drift on the referee map every second, timers run,
  hide auto-advances to seek. Buttons for `bot catch` and an out-of-bounds
  warning toast complete the mimicry. `⏸ sim` pauses, `↺ reset` starts a
  fresh scenario.

---

## ⚠️ HTTPS is required on phones

Geolocation and camera (torch) APIs only work in **secure contexts**. `localhost` counts
as secure; a bare LAN IP does not. For real phone testing:

- **Tunnel** during development:
  ```bash
  npx cloudflared tunnel --url http://localhost:3000    # or ngrok http 3000
  ```
- **Deploy** for game night: Render / Railway / Fly.io all give free HTTPS.
  - Build command: `npm install && npm run build`
  - Start command: `npm start`
  - The server reads `PORT` from the environment.

### Split deploy (client on Vercel, server elsewhere)

The monolith (one URL) is the recommended path, but the client also runs fine
as a static site pointed at a remote server:

1. Deploy the **server** anywhere with HTTPS (Render/Railway/Fly) — it still
   works standalone; CORS is open (`origin: true`).
2. On **Vercel**, set the project root to `client/` and add an environment
   variable (see `client/.env.example`):
   ```
   VITE_SERVER_URL=https://your-server.onrender.com
   ```
3. Redeploy. ⚠️ Vite bakes env vars in at **build time** — changing the
   variable requires a rebuild, and it must be `https://` or phones will
   refuse GPS/camera. Leave `VITE_SERVER_URL` unset for the monolith and
   for local dev (the Vite proxy handles it).

---

## Platform realities (design constraints, not bugs)

| Constraint | How Lampas handles it |
|---|---|
| iOS Safari has **no torch API** | Torch event = full-screen white flash on every phone (screen *is* the lamp); Android Chrome additionally gets the real camera torch as a bonus |
| The app **can't see a flashlight beam** | Catches are human-adjudicated: the caught hider taps "I'm caught" (with confirmation), or the referee tags manually. Seekers cannot tag |
| GPS is **~5–15 m accurate** outdoors | Boundary is a circle only, with a 10 m noise margin. Out-of-bounds triggers **warnings only** — no automatic penalty (GPS too janky to auto-tag on); the referee adjudicates. No mechanic needs sub-10 m precision |
| Audio needs a **user gesture** to unlock | The lobby "Ready" tap unlocks the AudioContext; `navigator.vibrate()` is the Android backup for silent iPhones |
| Screens sleep, sockets drop | Screen Wake Lock API (re-acquired on tab return); clients **re-sync full state on every reconnect** instead of relying on event delivery |
| Live positions would ruin the game | Positions go to the server and the **referee map only**. Hiders and seekers get a boundary map showing the circle and **their own dot only** (local GPS echo — other players' locations never reach their phones) |

---

## Architecture

```
phone: watchPosition (throttled ~3s)
  → socket.emit("pos:update", {lat,lng})        # fire-and-forget, loss-tolerant
    → server stores per player, computes team centroid + boundary check on a 2s tick
      → emits "game:state"  (referee = full incl. positions; players = role-appropriate)
      → emits events: "event:sound" | "event:torch" | "event:shrink" | "boundary:warning"
```

- **Server:** Node + Express + Socket.IO. Authoritative, in-memory state (`server/game.js`),
  pure geometry helpers (`server/geo.js`), transport wiring (`server/index.js`).
- **Client:** Vite + React + Tailwind v4. Leaflet map for the referee. Role-based screens.
- **Resilience:** outdoor mobile means constant short drops (screen lock, calls,
  backgrounding). The client emits `resync` on every (re)connect and on tab-visible;
  the server replies with the entire current state. Missed events never matter because
  clients render current truth, not event history. Socket.IO `connectionStateRecovery`
  plus fast reconnection (500 ms → 3 s backoff) covers the gaps.

### Socket protocol

**Client → server**

| Event | Payload | Notes |
|---|---|---|
| `join` | `{playerId?, name, teamName?, hostPass?}` + ack | Re-join with stored `playerId` keeps identity. Username `host` + correct `hostPass` grants referee (teamName ignored — hosts are teamless); wrong password acks `{error}` |
| `resync` | `{playerId}` | Sent on every (re)connect; server replies with full state |
| `pos:update` | `{lat, lng}` | Throttled ~3 s, fire-and-forget, no acks |
| `team:join` | `{teamName}` | Switch teams in the lobby |
| `player:ready` | `{ready}` | Lobby ready toggle |
| `tag:player` | `{targetPlayerId}` | **Host only** — referee manual tag |
| `caught:self` | — | Hider self-reports a catch (the normal path) |
| `host:startPhase` | `{phase}` | Host only: `hide` / `seek` / `lobby` |
| `host:trigger` | `{type}` | Host only: `sound` / `torch` / `shrink` |
| `host:config` | `{boundary?, settings?}` | Host only: circle + timers |
| `host:setTeamRole` | `{teamId, role}` | Host only, lobby only: pick starting seekers |
| `host:reset` | — | Host only: back to lobby |
| `host:kick` | `{targetPlayerId}` | Host only, lobby only: remove a player (not a ban — they can re-join). Kicked phone gets a `kicked` event and resets to the join screen |
| `leave` | — | Voluntary logout (lobby only removes the record; mid-game it just greys out). Client also wipes stored playerId + creds |
| `host:deleteTeam` | `{teamId}` | Host only, lobby only: delete a team and kick all its members (they get `kicked` with `reason: 'team-deleted'`) |

**Server → client**

| Event | Meaning |
|---|---|
| `game:state` | Full role-appropriate state (referee gets positions; players never do) |
| `phase:changed` | Phase transition (also reflected in `game:state`) |
| `event:sound` / `event:torch` / `event:shrink` | Curveballs |
| `boundary:warning` | Your team's centroid left the circle — grace clock running |
| `team:converted` | A team got caught and flipped to seekers |
| `game:over` | Winner announcement |

### Repo layout

```
lampas/
├── Claude.md              # project context + design decisions (read first)
├── package.json           # server deps + scripts (monolith root)
├── server/
│   ├── index.js           # express + socket.io, serves client build, 2s tick
│   ├── game.js            # authoritative state machine, in-memory store
│   ├── geo.js             # haversine, centroid, boundary checks (pure)
│   ├── game.test.js       # state machine unit tests
│   └── geo.test.js        # geometry unit tests
└── client/
    ├── vite.config.js     # tailwind v4 plugin + /socket.io dev proxy
    └── src/
        ├── App.jsx        # thin: provider + role router + overlays (+ ?dev gate)
        ├── context/       # GameContext — useGame()/useToast() hooks own all state
        ├── dev/           # ?dev view: DevApp (controls) + engine (mock game)
        ├── screens/       # JoinScreen (+/host login), Lobby, HiderView,
        │                  #   SeekerView, HostView, RefereeView
        ├── components/    # Countdown, Toast, TorchOverlay, RefereeMap (Leaflet)
        └── lib/
            ├── socket.js  # shared client socket, resync-on-connect, stored creds
            └── geo.js     # watchPosition, wake lock, audio unlock, torch, vibrate
```

---

## Running a game night — checklist

1. Deploy (or tunnel) so you have an **HTTPS** URL.
2. Everyone arrives with a **charged phone** (GPS + wake lock + socket is hungry).
3. Host logs in at `/host` with the host password (default `pass`; set
   `HOST_PASSWORD` on the server for a public deploy); players join with team
   names — scan the lobby QR code, or read `/how` first if new.
4. Host: tap the map (or "Center on me") to place the boundary, set the radius
   slider, set timers, toggle the seeker team, wait for green ✓ Ready on everyone.
5. Grant **location permission** when prompted; iPhone users take phones off silent.
6. Host taps **Start hide phase**. Play. The referee panel can manually fire every
   event and tag every player — it's the safety net if any automation flakes.

## Troubleshooting

- **"Why did the game end?" / any dispute** — check the **Game log** panel at the
  bottom of the referee screen: every join, kick, phase change, boundary warning,
  tag (with who/what triggered it — self, referee, or boundary penalty), curveball,
  and game-over lands there with a timestamp. The same lines go to the server
  console (visible in Render's Logs tab). The log survives "back to lobby".

- **"GPS unavailable" toast** — the phone denied location permission, or the page
  isn't HTTPS. Check the browser's site permissions.
- **No sound on the sound curveball** — the player never tapped Ready in the lobby
  (audio needs a user gesture), or the iPhone is on silent (vibration still fires
  on Android; iOS on silent stays silent — that's an OS rule).
- **Torch doesn't fire on Android** — use the **"Test my flashlight"** button in
  the lobby: it flashes the torch for 2s or tells you why not. Requirements: HTTPS,
  Chrome (not Samsung Internet/Firefox — spotty support), camera permission granted
  (the Ready tap prompts for it), back camera with flash. The app probes every
  camera lens individually (multi-lens phones often bind the torch to one specific
  camera). The full-screen white flash is the guaranteed fallback either way.
- **Dots frozen / player greyed out on the referee map** — that phone locked its
  screen or lost signal. State re-syncs automatically the moment it returns.
- **Server restarted mid-game** — state is in-memory by design. Phones silently
  re-join with their saved name + team (stored locally), but game progress
  (phase, catches, boundary) starts fresh — the host sets up again.

---

Built for one good night outside. 🏮
