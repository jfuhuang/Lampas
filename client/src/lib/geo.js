/**
 * geo.js (client) — device API wrappers: geolocation streaming, wake lock,
 * audio unlock + tone, torch (Android only), vibration.
 *
 * Platform reality (see CLAUDE.md):
 * - iOS Safari has NO torch API → torch event = full-screen white prompt for
 *   everyone; enableTorch() is an Android-Chrome bonus, never load-bearing.
 * - Audio must be unlocked by a user tap (done on the lobby Ready button).
 * - navigator.vibrate is Android-only; treat as best-effort backup.
 */

/**
 * Default map center: Snow Mountain Ranch (YMCA of the Rockies), Granby, CO.
 * Only a starting view — the referee re-centers by tapping the map or
 * "Center on me", and the map auto-fits once a boundary exists.
 */
export const DEFAULT_CENTER = { lat: 39.9865, lng: -105.9333 };
export const DEFAULT_ZOOM = 15;

/**
 * Great-circle distance in meters (same formula as server/geo.js — kept
 * separate because that file must stay browser-free and this one touches
 * browser globals). Used for the private edge-heartbeat: distance of MY
 * position to the boundary center, computed entirely on-device.
 */
export function haversine(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

// ── Geolocation ────────────────────────────────────────────────────────

/**
 * Stream positions to `onPos({lat, lng})`, throttled to ~3s. Loss-tolerant
 * by design — each update supersedes the last, so drops don't matter.
 * Returns a stop() function.
 */
export function startPositionStream(onPos, onError, throttleMs = 3000) {
  if (!('geolocation' in navigator)) {
    onError?.(new Error('Geolocation unsupported'));
    return () => {};
  }
  let lastSent = 0;
  const watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const now = Date.now();
      if (now - lastSent < throttleMs) return;
      lastSent = now;
      onPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    },
    (err) => onError?.(err),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
  );
  return () => navigator.geolocation.clearWatch(watchId);
}

/** One-shot position (host uses it to center the boundary). */
export function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      reject,
      { enableHighAccuracy: true, timeout: 15000 },
    );
  });
}

// ── Wake lock ──────────────────────────────────────────────────────────

let wakeLock = null;
let wakeLockWanted = false; // once anyone asks, keep re-trying on visibility

/**
 * Keep the screen on (Screen Wake Lock API — Chrome, iOS Safari 16.4+).
 * No user gesture required, but the page must be visible. Re-acquired
 * automatically whenever the tab returns to the foreground — including
 * after an earlier FAILED attempt (Low Power Mode denials are transient).
 *
 * Hard limit no web API crosses: the power button / OS still sleeps the
 * phone; wake lock only stops the idle-timeout dimming.
 */
export async function requestWakeLock() {
  wakeLockWanted = true;
  if (!('wakeLock' in navigator)) return false;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    return true;
  } catch {
    return false; // low battery / Low Power Mode — retried on next visibility
  }
}

document.addEventListener('visibilitychange', () => {
  // Wake locks are released on background; re-grab on return.
  if (document.visibilityState === 'visible' && wakeLockWanted) {
    requestWakeLock();
  }
});
void wakeLock;

// ── Audio ──────────────────────────────────────────────────────────────

let audioCtx = null;
let revealBuffer = null; // decoded /sounds/reveal.mp3
let revealSource = null; // currently playing source (so re-triggers restart)

/**
 * MUST be called from a user gesture (the lobby Ready tap). Creates and
 * resumes the AudioContext AND pre-decodes the reveal clip into a WebAudio
 * buffer. Later playback goes through the unlocked AudioContext — NOT an
 * HTMLAudio element, because unlocking the context does not unlock media
 * elements: `new Audio().play()` from a socket handler throws
 * NotAllowedError on Chrome/Samsung (this was the "no sound on Samsung"
 * bug). WebAudio buffers have no such per-element gesture rule.
 */
export function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    // Play one silent sample to satisfy iOS' gesture requirement.
    const buf = audioCtx.createBuffer(1, 1, 22050);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start(0);
    // Pre-decode the reveal clip (async is fine — event fires much later).
    if (!revealBuffer) {
      fetch('/sounds/reveal.mp3')
        .then((r) => r.arrayBuffer())
        .then((b) => audioCtx.decodeAudioData(b))
        .then((decoded) => {
          revealBuffer = decoded;
        })
        .catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Reveal sound for the `sound` curveball, looped for `seconds`.
 * Plays the decoded clip through WebAudio; falls back to a synthesized
 * two-tone siren if the clip failed to load. Requires unlockAudio() to
 * have run (Ready tap).
 */
export function playRevealTone(seconds = 10) {
  if (!audioCtx) return false;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  try {
    revealSource?.stop();
  } catch {
    /* already ended */
  }
  const now = audioCtx.currentTime;
  const gain = audioCtx.createGain();
  gain.connect(audioCtx.destination);

  if (revealBuffer) {
    gain.gain.setValueAtTime(0.35, now);
    const src = audioCtx.createBufferSource();
    src.buffer = revealBuffer;
    src.loop = true;
    src.connect(gain);
    src.start(now);
    src.stop(now + seconds);
    revealSource = src;
    return true;
  }

  // Fallback siren: 880/660 Hz square-wave alternation.
  gain.gain.setValueAtTime(0.5, now);
  const osc = audioCtx.createOscillator();
  osc.type = 'square';
  for (let t = 0; t < seconds; t += 0.5) {
    osc.frequency.setValueAtTime(t % 1 === 0 ? 880 : 660, now + t);
  }
  osc.connect(gain);
  osc.start(now);
  osc.stop(now + seconds);
  revealSource = osc;
  return true;
}

/** Android-only backup for silent-mode iPhones (no-op elsewhere). */
export function vibrate(pattern = [400, 150, 400, 150, 800]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}

// ── Compass (device heading) ───────────────────────────────────────────

/**
 * iOS requires an explicit permission prompt for orientation events, and
 * the request MUST come from a user gesture — so this rides the lobby
 * Ready tap alongside audio/wake-lock/camera. Android needs no prompt.
 */
export async function requestCompassPermission() {
  try {
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function'
    ) {
      return (await DeviceOrientationEvent.requestPermission()) === 'granted';
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Stream compass heading (degrees clockwise from north) to `onHeading`.
 * iOS exposes `webkitCompassHeading` directly; Android gives absolute
 * `alpha` (counter-clockwise), converted here. Returns stop().
 */
export function startCompass(onHeading, throttleMs = 250) {
  if (!('DeviceOrientationEvent' in window)) return () => {};
  let last = 0;
  const handler = (e) => {
    const now = Date.now();
    if (now - last < throttleMs) return;
    let heading = null;
    if (typeof e.webkitCompassHeading === 'number') heading = e.webkitCompassHeading;
    else if (e.absolute && typeof e.alpha === 'number') heading = (360 - e.alpha) % 360;
    if (heading !== null) {
      last = now;
      onHeading(Math.round(heading));
    }
  };
  const evt =
    'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
  window.addEventListener(evt, handler);
  return () => window.removeEventListener(evt, handler);
}

// ── Torch (Android Chrome only) ────────────────────────────────────────

let torchTrack = null;
let torchSupported = null; // null = unknown, set by prewarmTorch()
// Desired-state flag closes an iPhone race: camera acquisition can take
// SECONDS on iOS, so the event could expire (disableTorch → no-op, track
// still null) BEFORE enableTorch resolved and lit a torch nobody would
// ever turn off. Every acquisition re-checks this flag before keeping it.
let torchDesired = false;

/**
 * MUST be called from a user gesture (lobby Ready tap). Grabs then
 * immediately releases the back camera so Android shows its permission
 * prompt in the LOBBY — not mid-game when the 15s torch event is already
 * ticking (getUserMedia from a socket handler has no gesture, so the
 * prompt either interrupts play or never gets answered in time; that's
 * why the torch "didn't work"). Also records whether the camera actually
 * has a torch.
 */
export async function prewarmTorch() {
  if (!navigator.mediaDevices?.getUserMedia) {
    torchSupported = false;
    return false;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
    });
    const track = stream.getVideoTracks()[0];
    torchSupported = !!track.getCapabilities?.().torch;
    track.stop();
  } catch {
    torchSupported = false;
  }
  return torchSupported;
}

/**
 * Switch on the camera flash. Works on Android Chrome via the `torch`
 * MediaTrack constraint; impossible on iOS Safari. Returns true only if
 * the light actually turned on (verified via getSettings, since `advanced`
 * constraints fail silently). Bonus feature — the full-screen white prompt
 * is the real mechanic.
 *
 * Tries `exact: environment` first (guarantees the BACK camera — the
 * plain hint sometimes yields the front camera, which has no torch),
 * then falls back to the hint.
 */
export async function enableTorch() {
  torchDesired = true;
  if (torchTrack) return true;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  // NOTE: a failed prewarm does NOT short-circuit here — the user may have
  // granted camera permission after it ran, and the per-device probe below
  // can succeed where the facingMode prewarm couldn't.
  void torchSupported;

  // Constraint attempts, cheapest first. On multi-lens Androids the torch
  // is often bound to ONE specific back camera, so after the facingMode
  // attempts we enumerate every camera and probe them individually.
  const attempts = [
    { video: { facingMode: { exact: 'environment' } } },
    { video: { facingMode: 'environment' } },
  ];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    for (const d of devices) {
      if (d.kind === 'videoinput') {
        attempts.push({ video: { deviceId: { exact: d.deviceId } } });
      }
    }
  } catch {
    /* enumeration blocked — facingMode attempts still run */
  }

  for (const constraints of attempts) {
    if (!torchDesired) return false; // event ended while we were acquiring
    let track;
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities?.() ?? {};
      // Some Androids under-report capabilities — attempt regardless and
      // let the resulting settings be the judge.
      await track.applyConstraints({ advanced: [{ torch: true }] });
      const lit = caps.torch === true || track.getSettings?.().torch === true;
      if (!lit) {
        track.stop();
        continue;
      }
      if (!torchDesired) {
        // disableTorch() ran mid-acquisition — kill the light we just made.
        await killTorchTrack(track);
        return false;
      }
      torchTrack = track;
      return true;
    } catch {
      track?.stop();
    }
  }
  return false;
}

/** Explicit torch:false BEFORE stop — some iOS versions leave the lamp
 *  burning on a bare track.stop(). */
async function killTorchTrack(track) {
  try {
    await track.applyConstraints({ advanced: [{ torch: false }] });
  } catch {
    /* constraint refused — stop() below is still the best we can do */
  }
  track.stop();
}

export async function disableTorch() {
  torchDesired = false; // aborts any in-flight acquisition
  if (torchTrack) {
    const track = torchTrack;
    torchTrack = null;
    await killTorchTrack(track);
  }
}
