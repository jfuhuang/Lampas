/**
 * geo.js — pure geometry helpers for boundary logic.
 *
 * All functions are pure so they can be unit-tested without a server.
 * Positions are `{ lat, lng }` in decimal degrees.
 *
 * Design constraint (see CLAUDE.md): GPS is ~5–15m accurate outdoors, so no
 * mechanic here may need sub-10m precision. Boundaries are circles only.
 */

const EARTH_RADIUS_M = 6_371_000;

const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance between two points in meters (Haversine formula).
 * @param {{lat:number,lng:number}} a
 * @param {{lat:number,lng:number}} b
 * @returns {number} distance in meters
 */
export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Average position of a set of points. Fine for game-sized areas (<2km);
 * do not use across the antimeridian.
 * @param {Array<{lat:number,lng:number}>} points
 * @returns {{lat:number,lng:number}|null} centroid, or null for empty input
 */
export function centroid(points) {
  if (!points || points.length === 0) return null;
  let lat = 0;
  let lng = 0;
  for (const p of points) {
    lat += p.lat;
    lng += p.lng;
  }
  return { lat: lat / points.length, lng: lng / points.length };
}

/**
 * Is a point inside the boundary circle?
 * `marginM` widens the circle to absorb GPS noise (default 10m — generous
 * per the platform constraints).
 * @param {{lat:number,lng:number}} point
 * @param {{center:{lat:number,lng:number}, radiusM:number}} boundary
 * @param {number} [marginM=10]
 * @returns {boolean}
 */
export function insideBoundary(point, boundary, marginM = 10) {
  if (!point || !boundary || !boundary.center) return true; // no data → never punish
  return haversine(point, boundary.center) <= boundary.radiusM + marginM;
}

/**
 * Meters a point sits outside the boundary (0 if inside).
 * @param {{lat:number,lng:number}} point
 * @param {{center:{lat:number,lng:number}, radiusM:number}} boundary
 * @returns {number}
 */
export function distanceOutside(point, boundary) {
  if (!point || !boundary || !boundary.center) return 0;
  return Math.max(0, haversine(point, boundary.center) - boundary.radiusM);
}
