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

/** Keep the screen on. Re-acquired automatically when the tab is re-shown. */
export async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return false;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    return true;
  } catch {
    return false; // low battery / permission — non-fatal
  }
}

document.addEventListener('visibilitychange', () => {
  // Wake locks are released on background; re-grab on return.
  if (document.visibilityState === 'visible' && wakeLock !== null) {
    requestWakeLock();
  }
});

// ── Audio ──────────────────────────────────────────────────────────────

let audioCtx = null;

/**
 * MUST be called from a user gesture (the lobby Ready tap). Creates and
 * resumes the AudioContext so later `event:sound` tones can play unprompted.
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
    return true;
  } catch {
    return false;
  }
}

/** Loud two-tone siren for the `sound` curveball. Runs `seconds` long. */
export function playRevealTone(seconds = 10) {
  if (!audioCtx) return false;
  const now = audioCtx.currentTime;
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.6, now);
  gain.connect(audioCtx.destination);
  const osc = audioCtx.createOscillator();
  osc.type = 'square';
  // Alternate 880/660 Hz every half second — carries outdoors.
  for (let t = 0; t < seconds; t += 0.5) {
    osc.frequency.setValueAtTime(t % 1 === 0 ? 880 : 660, now + t);
  }
  osc.connect(gain);
  osc.start(now);
  osc.stop(now + seconds);
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

// ── Torch (Android Chrome only) ────────────────────────────────────────

let torchTrack = null;

/**
 * Try to switch on the camera flash. Works on Android Chrome via the
 * `torch` MediaTrack constraint; impossible on iOS Safari. Returns true
 * only if the light actually turned on. Bonus feature — the full-screen
 * white prompt is the real mechanic.
 */
export async function enableTorch() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    });
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities?.() ?? {};
    if (!caps.torch) {
      track.stop();
      return false;
    }
    await track.applyConstraints({ advanced: [{ torch: true }] });
    torchTrack = track;
    return true;
  } catch {
    return false;
  }
}

export function disableTorch() {
  if (torchTrack) {
    torchTrack.stop(); // stopping the track kills the torch too
    torchTrack = null;
  }
}
