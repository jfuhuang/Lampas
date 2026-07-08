import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { DEFAULT_CENTER, DEFAULT_ZOOM } from '../lib/geo.js';

/**
 * Boundary map for HIDERS and SEEKERS: the amber circle + YOUR OWN blue
 * dot (from the phone's local GPS echo). Nobody else's position is ever
 * drawn here — that data never even reaches player clients (privacy rule
 * in CLAUDE.md). Collapsible: hiders want a dark screen.
 */
export default function PlayerMap({ boundary, myPos, collapsedByDefault = false }) {
  const [open, setOpen] = useState(!collapsedByDefault);

  return (
    <div className="rounded-xl border border-neutral-800 bg-panel">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs font-black uppercase tracking-widest text-neutral-400"
      >
        <span>Boundary map</span>
        <span>{open ? '▾ hide' : '▸ show'}</span>
      </button>
      {open &&
        (boundary ? (
          <div className="h-[32dvh] min-h-[200px] overflow-hidden rounded-b-xl">
            <MapCanvas boundary={boundary} myPos={myPos} />
          </div>
        ) : (
          <p className="px-3 pb-3 text-sm text-neutral-500">
            No boundary set yet — the host places it in the lobby.
          </p>
        ))}
    </div>
  );
}

function MapCanvas({ boundary, myPos }) {
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const circleRef = useRef(null);
  const meRef = useRef(null);

  useEffect(() => {
    const map = L.map(mapEl.current, {
      zoomControl: false,
      attributionControl: false,
    }).setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], DEFAULT_ZOOM);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
    mapRef.current = map;
    return () => map.remove();
  }, []);

  // Boundary circle — refit whenever it changes (covers the shrink event).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !boundary?.center) return;
    if (circleRef.current) circleRef.current.remove();
    circleRef.current = L.circle([boundary.center.lat, boundary.center.lng], {
      radius: boundary.radiusM,
      color: '#fbbf24',
      weight: 2,
      fillColor: '#fbbf24',
      fillOpacity: 0.08,
    }).addTo(map);
    map.fitBounds(circleRef.current.getBounds(), { padding: [20, 20] });
  }, [boundary?.center?.lat, boundary?.center?.lng, boundary?.radiusM]);

  // Own dot only.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !myPos) return;
    if (!meRef.current) {
      meRef.current = L.circleMarker([myPos.lat, myPos.lng], {
        radius: 8,
        color: '#0c4a6e',
        weight: 2,
        fillColor: '#38bdf8',
        fillOpacity: 1,
      })
        .bindTooltip('you', { permanent: true, direction: 'top', offset: [0, -8] })
        .addTo(map);
    } else {
      meRef.current.setLatLng([myPos.lat, myPos.lng]);
    }
  }, [myPos]);

  return <div ref={mapEl} className="h-full w-full" />;
}
