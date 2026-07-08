import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { DEFAULT_CENTER, DEFAULT_ZOOM } from '../lib/geo.js';

/**
 * Live Leaflet map for the host/referee ONLY — the one place player
 * positions are ever rendered (privacy constraint in CLAUDE.md).
 *
 * - dots: green = hider, red = seeker, host ringed in amber
 * - greyed dot = phone quiet (disconnected / no recent position)
 * - amber circle = boundary; in the lobby, tapping the map moves its center
 */
export default function RefereeMap({ positions, boundary, phase, onSetCenter }) {
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null); // markers redrawn each render
  const circleRef = useRef(null);
  const centeredOnce = useRef(false);
  const onSetCenterRef = useRef(onSetCenter);
  onSetCenterRef.current = onSetCenter;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // Init once
  useEffect(() => {
    const map = L.map(mapEl.current, { zoomControl: true }).setView(
      [DEFAULT_CENTER.lat, DEFAULT_CENTER.lng],
      DEFAULT_ZOOM,
    );
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    map.on('click', (e) => {
      // Boundary placement only makes sense before the game starts.
      if (phaseRef.current === 'lobby') {
        onSetCenterRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng });
      }
    });
    mapRef.current = map;
    return () => map.remove();
  }, []);

  // Boundary circle
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (circleRef.current) {
      circleRef.current.remove();
      circleRef.current = null;
    }
    if (boundary?.center) {
      circleRef.current = L.circle([boundary.center.lat, boundary.center.lng], {
        radius: boundary.radiusM,
        color: '#fbbf24',
        weight: 2,
        fillColor: '#fbbf24',
        fillOpacity: 0.08,
      }).addTo(map);
      if (!centeredOnce.current) {
        map.fitBounds(circleRef.current.getBounds(), { padding: [30, 30] });
        centeredOnce.current = true;
      }
    }
  }, [boundary?.center?.lat, boundary?.center?.lng, boundary?.radiusM]);

  // Player dots
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.clearLayers();
    const now = Date.now();
    for (const p of positions ?? []) {
      const stale = !p.connected || now - (p.at ?? 0) > 20_000;
      const color =
        p.role === 'seeker' ? '#ef4444' : p.role === 'host' ? '#fbbf24' : '#34d399';
      L.circleMarker([p.lat, p.lng], {
        radius: 9,
        color: stale ? '#555' : '#111',
        weight: 2,
        fillColor: stale ? '#666' : color,
        fillOpacity: stale ? 0.5 : 0.95,
      })
        .bindTooltip(`${p.name}${stale ? ' (quiet)' : ''}`, {
          permanent: true,
          direction: 'top',
          offset: [0, -8],
          className: 'ref-tooltip',
        })
        .addTo(layer);
    }
  }, [positions]);

  return <div ref={mapEl} className="h-full w-full rounded-xl" />;
}
