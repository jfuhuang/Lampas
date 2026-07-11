import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { DEFAULT_CENTER, DEFAULT_ZOOM } from '../lib/geo.js';
import { addStyleControl } from '../lib/mapStyles.js';

/**
 * Boundary map for HIDERS and SEEKERS: the amber circle + YOUR OWN blue
 * dot (from the phone's local GPS echo). Other players' positions never
 * reach player clients (privacy rule in CLAUDE.md) — EXCEPT during the
 * `reveal` curveball, when the server ships everyone's dots in `others`
 * and the map force-opens to show them. Collapsible: hiders want a dark
 * screen.
 */
export default function PlayerMap({
  boundary,
  myPos,
  heading,
  others,
  collapsedByDefault = false,
}) {
  const [open, setOpen] = useState(!collapsedByDefault);
  const revealed = (others?.length ?? 0) > 0;

  // Reveal event → pop the map open even if the hider collapsed it.
  useEffect(() => {
    if (revealed) setOpen(true);
  }, [revealed]);

  return (
    <div
      className={`rounded-xl border bg-panel ${
        revealed ? 'border-red-700' : 'border-neutral-800'
      }`}
    >
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs font-black uppercase tracking-widest text-neutral-400"
      >
        <span>
          Boundary map
          {revealed && <span className="ml-2 animate-pulse text-red-400">● LIVE REVEAL</span>}
        </span>
        <span>{open ? '▾ hide' : '▸ show'}</span>
      </button>
      {open &&
        (boundary ? (
          <div className="relative h-[32dvh] min-h-[200px] overflow-hidden rounded-b-xl">
            <MapCanvas boundary={boundary} myPos={myPos} heading={heading} others={others} />
            <NorthBadge />
          </div>
        ) : (
          <p className="px-3 pb-3 text-sm text-neutral-500">
            No boundary set yet — the host places it in the lobby.
          </p>
        ))}
    </div>
  );
}

/** Maps are always north-up (Leaflet doesn't rotate) — badge reminds. */
export function NorthBadge() {
  return (
    <div className="pointer-events-none absolute right-2 top-2 z-[500] rounded-md bg-night/80 px-1.5 py-0.5 text-xs font-black text-neutral-300">
      N ↑
    </div>
  );
}

function MapCanvas({ boundary, myPos, heading, others }) {
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const circleRef = useRef(null);
  const meRef = useRef(null);
  const headingRef = useRef(null); // rotating compass arrow over own dot
  const othersLayerRef = useRef(null); // reveal-event dots, redrawn per update

  useEffect(() => {
    const map = L.map(mapEl.current, {
      zoomControl: false,
      attributionControl: false,
    }).setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], DEFAULT_ZOOM);
    addStyleControl(map); // Night / Terrain / Satellite picker
    othersLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => map.remove();
  }, []);

  // Reveal dots: everyone's positions while the curveball is active.
  useEffect(() => {
    const layer = othersLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    for (const p of others ?? []) {
      const color = p.role === 'seeker' ? '#ef4444' : p.role === 'host' ? '#fbbf24' : '#34d399';
      L.circleMarker([p.lat, p.lng], {
        radius: 8,
        color: '#111',
        weight: 2,
        fillColor: color,
        fillOpacity: 0.95,
      })
        .bindTooltip(p.name, { permanent: true, direction: 'top', offset: [0, -8] })
        .addTo(layer);
    }
  }, [others]);

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

  // Compass arrow: rotates with the device so players can orient at night.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!myPos || heading == null) {
      headingRef.current?.remove();
      headingRef.current = null;
      return;
    }
    const icon = L.divIcon({
      className: '',
      html: `<div class="compass-arrow" style="transform: rotate(${heading}deg)">▲</div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
    if (!headingRef.current) {
      headingRef.current = L.marker([myPos.lat, myPos.lng], {
        icon,
        interactive: false,
        zIndexOffset: 1000,
      }).addTo(map);
    } else {
      headingRef.current.setLatLng([myPos.lat, myPos.lng]);
      headingRef.current.setIcon(icon);
    }
  }, [myPos, heading]);

  return <div ref={mapEl} className="h-full w-full" />;
}
