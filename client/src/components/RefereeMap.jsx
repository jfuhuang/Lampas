import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { DEFAULT_CENTER, DEFAULT_ZOOM, shrinkCenter } from '../lib/geo.js';
import { addStyleControl } from '../lib/mapStyles.js';
import { drawHeistLayers } from '../lib/heistLayers.js';
import { drawDecoyLayers } from '../lib/decoyLayers.js';

/**
 * Live Leaflet map for the host/referee ONLY — the one place player
 * positions are ever rendered (privacy constraint in CLAUDE.md).
 *
 * - dots: green = hider, red = seeker, host ringed in amber
 * - greyed dot = phone quiet (disconnected / no recent position)
 * - amber circle = boundary; in the lobby, a tap calls onLobbyTap (boundary
 *   center, or a heist station / prison — RefereeView picks)
 * - heist: violet = live station, dashed grey = dark station, blue = prison
 */
export default function RefereeMap({ positions, boundary, phase, onLobbyTap, shrinkPreviewM, shrinkTarget, onTargetTap, heist, decoys }) {
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null); // markers redrawn each render
  const circleRef = useRef(null);
  const previewCircleRef = useRef(null); // dashed: where the next auto-shrink would land
  const targetMarkerRef = useRef(null); // referee-only shrink destination
  const centeredOnce = useRef(false);
  const heistLayerRef = useRef(null); // heist stations + prison
  const decoyLayerRef = useRef(null); // V2 decoys (with owner names)
  const onLobbyTapRef = useRef(onLobbyTap);
  onLobbyTapRef.current = onLobbyTap;
  const onTargetTapRef = useRef(onTargetTap);
  onTargetTapRef.current = onTargetTap;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // Init once
  useEffect(() => {
    const map = L.map(mapEl.current, { zoomControl: true }).setView(
      [DEFAULT_CENTER.lat, DEFAULT_CENTER.lng],
      DEFAULT_ZOOM,
    );
    addStyleControl(map); // Night / Terrain / Satellite picker
    heistLayerRef.current = L.layerGroup().addTo(map);
    decoyLayerRef.current = L.layerGroup().addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    map.on('click', (e) => {
      // Boundary / station / prison placement only makes sense before the
      // game starts — the parent decides which one a tap places.
      if (onTargetTapRef.current) {
        onTargetTapRef.current({ lat: e.latlng.lat, lng: e.latlng.lng });
      } else if (phaseRef.current === 'lobby') {
        onLobbyTapRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng });
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

  // Auto-shrink preview — dashed, no fill, same center. Random among 4
  // curveball types, so this is "if the next one is a shrink," not a timer.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (previewCircleRef.current) {
      previewCircleRef.current.remove();
      previewCircleRef.current = null;
    }
    if (boundary?.center && shrinkPreviewM) {
      const c = shrinkCenter(boundary, shrinkPreviewM, shrinkTarget);
      previewCircleRef.current = L.circle([c.lat, c.lng], {
        radius: shrinkPreviewM,
        color: '#ef4444',
        weight: 2,
        dashArray: '6 6',
        fill: false,
      }).addTo(map);
    }
  }, [boundary?.center?.lat, boundary?.center?.lng, boundary?.radiusM, shrinkPreviewM, shrinkTarget?.lat, shrinkTarget?.lng]);

  // Shrink target marker — where the zone drifts on each shrink.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    targetMarkerRef.current?.remove();
    targetMarkerRef.current = null;
    if (shrinkTarget) {
      targetMarkerRef.current = L.marker([shrinkTarget.lat, shrinkTarget.lng], {
        icon: L.divIcon({ className: '', html: '<div style="font-size:22px;line-height:22px">🎯</div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
        interactive: false,
      }).addTo(map);
    }
  }, [shrinkTarget?.lat, shrinkTarget?.lng]);

  // Heist: every station (dark ones dashed) + prison.
  useEffect(() => {
    drawHeistLayers(heistLayerRef.current, heist ?? {});
  }, [heist]);

  useEffect(() => {
    drawDecoyLayers(decoyLayerRef.current, decoys);
  }, [decoys]);

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
