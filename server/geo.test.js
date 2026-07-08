import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversine, centroid, insideBoundary, distanceOutside } from './geo.js';

test('haversine: zero distance for identical points', () => {
  const p = { lat: 40.7128, lng: -74.006 };
  assert.equal(haversine(p, p), 0);
});

test('haversine: ~111km per degree of latitude', () => {
  const a = { lat: 0, lng: 0 };
  const b = { lat: 1, lng: 0 };
  const d = haversine(a, b);
  assert.ok(Math.abs(d - 111_195) < 200, `expected ~111195m, got ${d}`);
});

test('haversine: short game-scale distance (~100m)', () => {
  // 0.0009° latitude ≈ 100m
  const a = { lat: 51.5, lng: -0.12 };
  const b = { lat: 51.5009, lng: -0.12 };
  const d = haversine(a, b);
  assert.ok(Math.abs(d - 100) < 2, `expected ~100m, got ${d}`);
});

test('centroid: averages points', () => {
  const c = centroid([
    { lat: 10, lng: 20 },
    { lat: 20, lng: 40 },
  ]);
  assert.deepEqual(c, { lat: 15, lng: 30 });
});

test('centroid: empty input → null', () => {
  assert.equal(centroid([]), null);
  assert.equal(centroid(null), null);
});

test('insideBoundary: inside, outside, and margin band', () => {
  const boundary = { center: { lat: 51.5, lng: -0.12 }, radiusM: 100 };
  const inside = { lat: 51.5004, lng: -0.12 }; // ~44m out from center
  const nearEdge = { lat: 51.50095, lng: -0.12 }; // ~106m — outside radius, inside 10m margin
  const farOut = { lat: 51.502, lng: -0.12 }; // ~222m
  assert.equal(insideBoundary(inside, boundary), true);
  assert.equal(insideBoundary(nearEdge, boundary), true, 'margin should absorb GPS noise');
  assert.equal(insideBoundary(farOut, boundary), false);
});

test('insideBoundary: missing data never punishes', () => {
  assert.equal(insideBoundary(null, { center: { lat: 0, lng: 0 }, radiusM: 50 }), true);
  assert.equal(insideBoundary({ lat: 0, lng: 0 }, null), true);
});

test('distanceOutside: 0 inside, positive outside', () => {
  const boundary = { center: { lat: 51.5, lng: -0.12 }, radiusM: 100 };
  assert.equal(distanceOutside({ lat: 51.5, lng: -0.12 }, boundary), 0);
  const d = distanceOutside({ lat: 51.502, lng: -0.12 }, boundary);
  assert.ok(d > 100 && d < 140, `expected ~122m outside, got ${d}`);
});
