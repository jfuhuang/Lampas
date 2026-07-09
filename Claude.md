# Lampas — Flashlight Hide & Seek

> **Name:** Lampas (Greek λαμπάς, "torch/lamp" — the lamps kept burning through the night
> in the Parable of the Ten Virgins, Matthew 25). A nighttime game about staying lit and staying ready.

This file is the project context. If you're an AI coding agent, read it fully before writing code.
It captures every design decision and constraint already worked out — don't re-litigate them unless asked.

---

## What the game is

Outdoor, nighttime flashlight hide-and-seek played with friends.

- Start: one team of 2–3 **seekers**; everyone else are **hiders**.
- Hiders get a set time to hide inside a boundary.
- A hider is "caught" when a seeker shines a flashlight on them → that hider/team converts to seekers.
- **Last un-caught hider team standing wins.**

The web app is a **facilitator and referee**, not a sensor. It runs timers, checks boundaries,
tracks team positions, and fires "curveball" events. It does NOT detect the physical flashlight catch.

---

## Hard platform constraints (these SHAPE the design — do not design around them)

1. **Flashlight/torch:** Android Chrome can toggle torch via the camera `torch` constraint.
   **iOS Safari cannot — no web API exists.** So the "lights on" event must show a full-screen
   prompt to *everyone*, and *additionally* auto-toggle on Android. Auto-torch = bonus, never load-bearing.

2. **No beam detection.** The app cannot see a flashlight hitting a player. The "caught" moment is
   adjudicated by a human: seeker taps "Tag [player]" or the caught hider taps "I'm caught."

3. **GPS is ~5–15m accurate outdoors, worse near trees/buildings.** Use generous margins.
   Boundaries are a **circle (center + radius)**, never a polygon. No mechanic may need sub-10m precision.

4. **Sound:** audio must be unlocked by a user tap first (do it in the lobby). iPhones on silent won't ring.
   Add `navigator.vibrate()` as an Android-only backup.

5. **Screen sleep / battery:** use the Screen Wake Lock API to keep phones awake. GPS + wake lock +
   live socket drains battery fast — players should arrive charged.

6. **Privacy of positions:** live team locations go to the **server** (for logic) and a **host/referee view**
   only. Seekers never get live hider positions — that would ruin the game. Positions surface to seekers
   only during a "reveal" curveball.

7. **HTTPS required.** Geolocation and camera APIs won't work without it.

---

## Architecture

Single Node service serves the React build AND the WebSocket — one HTTPS URL, nothing to coordinate.

- **Frontend:** Vite + React + Tailwind. Leaflet for the referee map. Players get a minimal role-based UI.
- **Backend:** Node + Express + **Socket.IO**.
- **State:** IN MEMORY (a plain `Map`). This is a one-night ephemeral game — **no database, no MySQL, no schema.**
- **Deploy:** Render / Railway / Fly.io (free HTTPS). For phone testing pre-deploy, tunnel with `cloudflared` or `ngrok`.

### Data flow
```
phone: watchPosition (throttled ~3s)
  → socket.emit("pos:update", {lat,lng})
    → server stores per player, computes team centroid + boundary check on a ~2s tick
      → emits "game:state" (referee = full; players = role-appropriate)
      → emits events: "event:sound" | "event:torch" | "event:shrink"
```

### Socket events
- **Client→server:** `join`, `resync`, `pos:update`, `tag:player`, `caught:self`, `host:startPhase`, `host:trigger`
- **Server→client:** `game:state`, `phase:changed`, `event:sound`, `event:torch`, `event:shrink`, `boundary:warning`, `game:over`

---

## Networking & resilience (outdoor mobile = worst-case network)

Socket.IO is the right pick for the timeline, BUT the design must expect constant short disconnects.
Most drops won't even be network — they'll be **lifecycle**: locking the screen, taking a call, or a
notification backgrounding the tab suspends JS and drops the socket. Wake Lock reduces this, not all of it.
The patterns below cover network drops and lifecycle drops identically, so no separate handling is needed.

**Core principle: server is authoritative; clients re-sync full state on every (re)connect.**
Do NOT rely on guaranteed delivery of individual event packets. On connect/reconnect the client emits
`resync` and the server replies with the entire current `game:state` (current phase, current boundary
radius, whether an event is active, who's a seeker). A client that missed events while dropped renders
correctly instantly, because it pulls current truth instead of replaying history. Less code, more robust.

**Two traffic classes — treat them differently:**
- `pos:update` = **loss-tolerant, fire-and-forget.** Sent ~3s, GPS already 5–15m fuzzy, each update
  supersedes the last, boundary check runs on a server tick against latest-known position. If a phone
  drops for 6s and three updates vanish, it does not matter. Do NOT build guaranteed delivery for these.
- **Game events** (`event:*`, `phase:changed`, tag/conversion, `game:over`) = **must land.** The fix is
  NOT per-packet delivery guarantees — it's the re-sync-on-reconnect above.

**Config — tune for short, frequent drops:**
```js
// server
const io = new Server(httpServer, {
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 }
});
// client
const socket = io(URL, {
  reconnection: true,
  reconnectionDelay: 500,      // retry fast — drops are short
  reconnectionDelayMax: 3000,
  timeout: 8000
});
socket.on("connect", () => socket.emit("resync", { playerId }));
```

**Surface disconnects, don't just fight them.** Use `disconnect`/`connect` + a "last seen" timestamp so
the referee view can grey out a player whose phone went quiet — useful game info, not just an error state.

**Rooms map onto teams:** `io.to(teamId).emit(...)`. This is a reason to stay on Socket.IO over alternatives.

**Considered alternative — SSE + HTTP POST:** POST each position as a stateless request (nothing persistent
to drop) + Server-Sent Events downstream (native auto-reconnect w/ `Last-Event-ID` replay). Arguably even
more tolerant of flaky mobile, but two channels instead of one and no clean rooms concept. Reach for this
ONLY if Socket.IO reconnection becomes a genuine headache. Hosted realtime (Ably/Pusher/Supabase) is
overkill for a one-night free game.

---

## Game state machine

1. **Lobby** — players join w/ name, assigned to teams. Host sets boundary (center pin + radius),
   hide-timer, seek-timer. Everyone taps "Ready" → this also unlocks audio + requests wake lock.
2. **Hide phase** — countdown; hiders get inside boundary & hide; seekers frozen at base. Boundary check active.
3. **Seek phase** — seekers roam. Physical catch → someone taps to tag → that player/team converts to seekers.
4. **Curveballs** (host-triggered or timed):
   - `sound` — hider phones play a tone (audible reveal)
   - `torch` — lights-on prompt (auto on Android)
   - `shrink` — boundary radius drops, forcing relocation
5. **Win** — last un-caught hider team standing.

### Boundary logic
Server computes each team's centroid (average lat/lng of its players), Haversine-distances it from
the boundary center. Outside radius during seek phase → `boundary:warning`; after a grace period,
a penalty (auto-reveal or forced tag).

---

## Build plan (3 days)

- **Wed — plumbing:** scaffold client + server, join/lobby, stream geolocation, moving dots on referee map.
  Success = dots move on a map when you walk around outside.
- **Thu — the game:** phases + timers, centroid + boundary check, manual tagging, role conversion, win condition.
  Playable end-to-end even if ugly.
- **Fri AM — curveballs + polish + FIELD TEST:** sound event, torch prompt (auto Android), shrink-zone,
  wake lock, audio unlock. Then go outside and test in daylight before dark.

> **STATUS: all three days' scope is IMPLEMENTED** — see "Implementation status" at the
> bottom of this file for what exists, where, and the deltas from this plan.

### MVP cut line (if short on time)
Lobby + roles + timers + manual tag + boundary check + **host-triggered** events.
Cut auto-torch and the fancy map first. Build the **manual referee panel early** — a host who can
manually fire every event and mark every tag means the game runs even if all automation flakes.
That panel is the safety net.

---

## Suggested repo layout
```
lampas/
├── CLAUDE.md            # this file
├── server/
│   ├── index.js         # express + socket.io, serves client build
│   ├── game.js          # state machine, in-memory store
│   └── geo.js           # haversine, centroid, boundary checks
├── client/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── screens/     # Lobby, HiderView, SeekerView, RefereeView
│   │   ├── lib/socket.js
│   │   └── lib/geo.js   # watchPosition wrapper, wake lock, audio unlock, torch
│   └── ...
└── package.json
```

---

## Implementation status (2026-07-07)

The full build plan is implemented and verified. Everything below is the ground truth of
the code as it exists — keep this section updated when the code changes.

### What exists

| Area | File(s) | Notes |
|---|---|---|
| Server entry | `server/index.js` | Express + Socket.IO, serves `client/dist`, SPA fallback, `/healthz`, 2s tick loop, `connectionStateRecovery` (2 min) |
| State machine | `server/game.js` | `Game` class, transport-agnostic (emits via callback), phases `lobby→hide→seek→over`, curveballs, forced tag on grace expiry, win check |
| Geometry | `server/geo.js` | Pure: `haversine`, `centroid`, `insideBoundary` (10m GPS margin), `distanceOutside` |
| Unit tests | `server/geo.test.js`, `server/game.test.js` | `npm test` (node:test), 29 tests: geometry, credential-based host, team reuse, tag/convert, win rules (one-left / single-team / phantom teams), timers, boundary grace, privacy of positions, referee `you`, kick, reset |
| Client root | `client/src/App.jsx` | Thin: mounts `GameProvider`, routes by role, renders overlays |
| Game context | `client/src/context/GameContext.jsx` | Owns socket subscription, state mirror, creds, position streaming, overlays/toasts. Consumed via `useGame()` / `useToast()` hooks — screens take NO game props |
| Screens | `client/src/screens/` | `JoinScreen` (doubles as `/host` password login), `Lobby`, `HiderView` ("I'm caught" + collapsed boundary map), `SeekerView` (read-only hunt list + boundary map), `HostView` (plain referee for teamless hosts; 👑/🔦 tabs only if host has a team), `RefereeView` |
| Components | `client/src/components/` | `Countdown` (server-clock corrected), `Toast`, `TorchOverlay` (full-screen white flash), `RefereeMap` (Leaflet, plain JS — NOT react-leaflet), `PlayerMap` (boundary circle + OWN dot only, collapsible; collapsed by default for hiders — lit screen betrays the hiding spot; own position is the local GPS echo `myPos` from GameContext, other players' positions never reach player clients) |
| Device APIs | `client/src/lib/geo.js` | `startPositionStream` (3s throttle), `getCurrentPosition`, `requestWakeLock` (re-acquires on visibility), `unlockAudio`, `playRevealTone` (loops `public/sounds/reveal.mp3`), `vibrate`, `enableTorch`/`disableTorch`. Also exports `DEFAULT_CENTER`/`DEFAULT_ZOOM` (Snow Mountain Ranch) |
| Socket client | `client/src/lib/socket.js` | Single shared socket, `resync` on every connect AND on tab-visible. Persistence: playerId (`lampas.playerId`) + name/team creds (`lampas.creds`) in `localStorage`. Exposes `setEmitInterceptor()` for the dev view. Server URL from `VITE_SERVER_URL` (build-time, split deploys e.g. Vercel client + remote server — see `client/.env.example`); unset = same-origin monolith |
| Dev view | `client/src/dev/DevApp.jsx`, `client/src/dev/engine.js` | `?dev` URL flag swaps the app for a mock-driven harness: real screens, screen + persona pickers, local engine mirroring server rules (tag/convert/win/timers/curveballs), bot drift on the map, sim pause/reset. `socket.emit` intercepted, real socket disconnected. Engine is a deliberate throwaway mimic — `server/game.js` stays the rules source of truth |

### Deltas / decisions made during implementation

- **Extra socket events beyond the original spec list** (all documented in README):
  `team:join`, `player:ready`, `host:config` (boundary + settings), `host:setTeamRole`,
  `host:reset`, and server→client `team:converted`. The original list had no channel for
  lobby configuration; `host:config` fills that.
- **Host = referee = credential login, NOT join order** (changed 2026-07-08): log in at
  `/host` (password-only form; the SPA fallback serves it) or type `host` as the name
  on the landing page. Password from `HOST_PASSWORD` env, default `pass`. Wrong
  password → join acked with `{error}`, surfaced as a toast. Password re-checked on
  every join, rides in `lampas.creds` (plaintext — party-game stakes) so a host phone
  re-earns the role after a server restart. **Hosts are TEAMLESS** — server ignores
  `teamName` for them, `you.role` is `'host'` (so the sound curveball never rings the
  host phone), their map dot is amber, and `HostView` renders the plain referee panel
  (the two-tab Play mode only appears if a host somehow has a team, e.g. in the dev
  view's mock). Host-only socket handlers verify `isHost` server-side.
- **Frontend state via context hooks, not prop drilling**: `GameProvider` (in
  `context/GameContext.jsx`) is the single owner of socket + game state; screens call
  `useGame()` / `useToast()`. Only leaf components (`Countdown`, `TeamList`, `Toast`)
  still take props, deliberately — they're per-instance.
- **Creds persist locally for reconnect**: `lampas.playerId` survives socket drops
  (server keeps the player record); `lampas.creds` (name + team) survives SERVER
  restarts — on `unknownPlayer` the client silently re-joins with stored creds
  (one attempt per server life, guarded by a ref), and the Join form is prefilled
  as fallback.
- **Teams are created on demand by name** (case-insensitive match) at join time; players
  can switch with `team:join` in the lobby. Host toggles which team(s) start as seekers.
- **Rooms**: player id, team id, and `'referees'` — referee room gets the full state
  (with positions) on every tick; players get role-scoped state with NO positions ever
  (verified by unit test).
- **Overlays derive from authoritative state**, not event packets: `game:state` carries
  `activeEvent`, so a phone that reconnects mid-torch still shows/clears the flash
  correctly. `event:torch` packet is only the fast path (vibrate + Android auto-torch).
- **Sound curveball**: only HIDER phones play it (audible reveal of hiders); players
  vibrate. Sound is a looped audio clip — `client/public/sounds/reveal.mp3`, played
  via HTMLAudio at 0.35 volume for the event duration (changed 2026-07-08 from the
  original WebAudio square-wave siren; swap the mp3 to change the sound).
  `unlockAudio()` (lobby Ready tap) is still required — it satisfies the mobile
  autoplay gesture rule that also gates HTMLAudio playback.
- **Game log + premature-end fixes** (2026-07-08): user reported games ending early.
  Two root causes found and fixed: (1) `outsideSince` set during the HIDE phase rolled
  into seek → grace already "expired" seconds into seek → instant boundary force-tag;
  now cleared at seek start. (2) stale GPS from dropped phones (pos never expired)
  dragged team centroids out of bounds; `teamCentroid()` now ignores positions older
  than 60s. Diagnostics: `Game.logEvent()` ring buffer (200 entries, survives lobby
  reset, mirrored to server console with ISO timestamps) records joins/kicks/team
  changes/phase transitions (with hider-count + win-threshold on seek start)/boundary
  warnings + clears + forced tags (with meters + source)/tags (with `[self]` /
  `[referee (name)]` / `[boundary penalty]` and hiders-left ratio)/events/config/game
  over (with reason). Last 60 entries ship in `refereeState().log`; RefereeView shows
  a color-coded, newest-first "Game log" panel. Players never see the log.
- **Log out** (2026-07-08): `logout()` in GameContext wipes `lampas.playerId` +
  `lampas.creds` and emits `leave` (server removes the record — lobby only, same rules
  as kick; mid-game the record stays and greys out). UI: "Log out" link in the Lobby,
  "Not you? Clear saved info" on the Join screen when creds exist.
- **Host can delete teams** (2026-07-08): `host:deleteTeam` → `Game.removeTeam()` —
  lobby-only, deletes the team AND its members (hosts spared), members get `kicked`
  with `reason: 'team-deleted'` + a targeted toast. UI: 🗑 per team in the referee
  roster, two-tap armed confirm (first tap warns, second deletes). Also cleans up
  empty shell teams.
- **Host can kick from the lobby** (2026-07-08): `host:kick` → `Game.removePlayer()`
  (lobby-only, host unkickable, not a ban). Kicked phone receives `kicked`, clears its
  stored playerId (blocks silent auto-rejoin) but keeps creds for one-tap re-join, and
  resets to JoinScreen. ✕ buttons appear in the referee roster (`TeamList`'s optional
  `onKick` prop) during lobby only. Mid-game problem players: force-tag their team.
- **Tagging is caught-side only** (2026-07-08): `tag:player` is HOST-ONLY server-side;
  seekers have NO tag buttons — the caught hider taps "I'm caught" (`caught:self`),
  or the referee tags manually. Ground truth lives with the caught player; kills
  disputed tags. SeekerView shows a read-only hunt list instead.
- **Boundary radius = slider (50–600m) + manual number input (20–5000m)** in the
  referee lobby panel; both drive the same `host:config`. Slider clamps its own
  display at 600 when the typed value exceeds it.
- **Host is exempt from ALL curveball effects** (2026-07-08): no torch flash, no
  siren, no vibration — the referee panel must stay usable while everyone else's
  screen flashes. Gated in GameContext on `you.isHost` (state-derived path) and an
  `isHostRef` (fast packet path); dev view mirrors the flash exemption.
- **Seek-timer expiry = surviving hiders win** (`reason: 'time'` on `game:over`).
- **Win rule (hardened 2026-07-08)**: game ends the moment exactly ONE hider team
  remains — they win. Two guards: (1) empty player-less "shell" teams (left behind by
  team switches) never count as hiders; (2) a game that STARTED with a single hider
  team plays until 0 remain (else it would end at kickoff) — `initialHiderTeams` is
  snapshotted at seek start. Mirrored in the dev engine.
- **Boundary grace penalty = forced tag** of the whole offending team (not auto-reveal);
  warning fires in both hide and seek phases, penalty only in seek.
- **Countdown drift handling**: every `game:state` carries `serverNow`; the client
  computes `endsAt - (localNow + offset)` so wrong phone clocks don't skew timers.
- **Tailwind v4** (`@tailwindcss/vite` plugin, `@theme` tokens in `index.css` — there is
  no `tailwind.config.js`, that's v4-normal). Custom colors: `night`, `panel`, `lamp`.
- **Leaflet used directly** (no react-leaflet — avoids React-version coupling). OSM tiles
  dark-filtered via CSS for night use. Default view: **Snow Mountain Ranch, Granby CO**
  (`DEFAULT_CENTER` in `client/src/lib/geo.js`, 39.9865/-105.9333, zoom 15) — starting
  view only; auto-fits to the boundary once one is set. The dev engine duplicates the
  coords literally (it must stay importable in plain Node, and lib/geo.js touches
  browser globals).
- **Mobile-first responsive**: single column `max-w-lg` on phones; `RefereeView` goes
  two-column (sticky map + controls) at `lg:`. `min-h-dvh`, safe-area padding,
  `viewport-fit=cover`, no user scaling, big touch targets, `active:scale-95` feedback.
- **Dev workflow**: Vite on :5173 proxies `/socket.io` (ws) to the Node server on :3000,
  so the client is always same-origin. Prod: Node serves `client/dist` itself.

### Commands

```bash
npm install      # root deps; postinstall also installs client deps
npm test         # unit tests (server/geo + server/game)
npm run build    # vite build → client/dist
npm start        # production: node server/index.js (reads PORT)
npm run dev      # dev server :3000
npm run dev:client  # vite :5173 (run alongside dev)
```

### Verified

- `npm test`: 29/29 pass.
- `vite build`: clean (~115 kB gzip JS).
- Scripted end-to-end socket smoke tests: credential host login (teamless), config,
  team roles, hide→seek auto-advance, out-of-bounds warning → forced tag after grace,
  win + winner name, reset restores roles, restart-recovery (stale playerId →
  `unknownPlayer` → creds re-join → full state with `you` + `isHost`), and players'
  `game:state` contains no `positions` field while the referee's does.

### Not implemented (deliberately)

- No database, no auth, no multiple concurrent games (one Game per process — by design).
- No polygon boundaries, no beam detection, no sub-10m mechanics (platform constraints).
- No SSE fallback (documented alternative; reach for it only if Socket.IO reconnection
  becomes a real problem in the field).
