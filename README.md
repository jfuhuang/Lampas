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
   The first person in becomes the **host/referee** — they get a two-tab view
   (👑 Referee panel / 🔦 Play) so they can referee *and* play on a team.
   The host sets the boundary circle, timers, and picks which team seeks first.
   Everyone taps **Ready** (this also unlocks sound and keeps the screen awake).
2. **Hide phase** — hiders get a countdown to get inside the boundary and hide.
   Seekers are frozen at base.
3. **Seek phase** — seekers roam with real flashlights. When a beam hits a hider,
   the seeker taps **Tag [player]** (or the hider taps **I'm caught**) — the caught
   player's **whole team converts to seekers**.
4. **Curveballs** (host-triggered):
   - 🔊 **Sound** — every hider phone plays a loud siren (audible reveal)
   - 🔦 **Torch** — full-screen white "LIGHTS ON" flash on every phone
     (plus real camera torch on Android Chrome)
   - ⭕ **Shrink** — boundary radius drops, forcing hiders to relocate
5. **Win** — last un-caught hider team standing. If the seek timer runs out,
   surviving hiders win. Teams that drift outside the boundary get a warning,
   then are auto-caught after a grace period.

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

---

## Platform realities (design constraints, not bugs)

| Constraint | How Lampas handles it |
|---|---|
| iOS Safari has **no torch API** | Torch event = full-screen white flash on every phone (screen *is* the lamp); Android Chrome additionally gets the real camera torch as a bonus |
| The app **can't see a flashlight beam** | Catches are human-adjudicated: seeker taps "Tag", or hider taps "I'm caught" (both with confirmation) |
| GPS is **~5–15 m accurate** outdoors | Boundary is a circle only, with a 10 m noise margin and a 30 s grace period before penalties. No mechanic needs sub-10 m precision |
| Audio needs a **user gesture** to unlock | The lobby "Ready" tap unlocks the AudioContext; `navigator.vibrate()` is the Android backup for silent iPhones |
| Screens sleep, sockets drop | Screen Wake Lock API (re-acquired on tab return); clients **re-sync full state on every reconnect** instead of relying on event delivery |
| Live positions would ruin the game | Positions go to the server and the **referee map only**. Player screens never render anyone's location |

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
| `join` | `{playerId?, name, teamName}` + ack | Re-join with stored `playerId` keeps identity |
| `resync` | `{playerId}` | Sent on every (re)connect; server replies with full state |
| `pos:update` | `{lat, lng}` | Throttled ~3 s, fire-and-forget, no acks |
| `team:join` | `{teamName}` | Switch teams in the lobby |
| `player:ready` | `{ready}` | Lobby ready toggle |
| `tag:player` | `{targetPlayerId}` | Seeker adjudicates a catch |
| `caught:self` | — | Hider self-reports a catch |
| `host:startPhase` | `{phase}` | Host only: `hide` / `seek` / `lobby` |
| `host:trigger` | `{type}` | Host only: `sound` / `torch` / `shrink` |
| `host:config` | `{boundary?, settings?}` | Host only: circle + timers |
| `host:setTeamRole` | `{teamId, role}` | Host only, lobby only: pick starting seekers |
| `host:reset` | — | Host only: back to lobby |

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
        ├── App.jsx        # thin: provider + role router + overlays
        ├── context/       # GameContext — useGame()/useToast() hooks own all state
        ├── screens/       # JoinScreen, Lobby, HiderView, SeekerView,
        │                  #   HostView (tabs: Referee / Play), RefereeView
        ├── components/    # Countdown, Toast, TorchOverlay, RefereeMap (Leaflet)
        └── lib/
            ├── socket.js  # shared client socket, resync-on-connect, stored creds
            └── geo.js     # watchPosition, wake lock, audio unlock, torch, vibrate
```

---

## Running a game night — checklist

1. Deploy (or tunnel) so you have an **HTTPS** URL.
2. Everyone arrives with a **charged phone** (GPS + wake lock + socket is hungry).
3. Host opens the URL first (first join = host/referee), players join with team names.
4. Host: tap the map (or "Center on me") to place the boundary, set the radius
   slider, set timers, toggle the seeker team, wait for green ✓ Ready on everyone.
5. Grant **location permission** when prompted; iPhone users take phones off silent.
6. Host taps **Start hide phase**. Play. The referee panel can manually fire every
   event and tag every player — it's the safety net if any automation flakes.

## Troubleshooting

- **"GPS unavailable" toast** — the phone denied location permission, or the page
  isn't HTTPS. Check the browser's site permissions.
- **No sound on the sound curveball** — the player never tapped Ready in the lobby
  (audio needs a user gesture), or the iPhone is on silent (vibration still fires
  on Android; iOS on silent stays silent — that's an OS rule).
- **Dots frozen / player greyed out on the referee map** — that phone locked its
  screen or lost signal. State re-syncs automatically the moment it returns.
- **Server restarted mid-game** — state is in-memory by design. Phones silently
  re-join with their saved name + team (stored locally), but game progress
  (phase, catches, boundary) starts fresh — the host sets up again.

---

Built for one good night outside. 🏮
