import L from 'leaflet';

/**
 * Heist-mode map overlays (stations + prison), shared by PlayerMap and
 * RefereeMap. Redraws `layer` from scratch — cheap at game scale.
 *
 * - live station  = violet circle (its task radius) + label with points
 * - dark station  = dashed grey (referee only; robbers never receive them)
 * - busy station  = amber (another robber is working it)
 * - prison        = blue circle
 */
export function drawHeistLayers(layer, { stations, prison, stationRadiusM, prisonRadiusM }) {
  if (!layer) return;
  layer.clearLayers();
  if (prison) {
    L.circle([prison.lat, prison.lng], {
      radius: prisonRadiusM ?? 25,
      color: '#60a5fa',
      weight: 2,
      fillColor: '#60a5fa',
      fillOpacity: 0.15,
    })
      .bindTooltip('🔒 Prison', { permanent: true, direction: 'center', className: 'ref-tooltip' })
      .addTo(layer);
  }
  for (const s of stations ?? []) {
    const color = !s.active ? '#6b7280' : s.busy || s.lockedByName ? '#f59e0b' : '#a78bfa';
    L.circle([s.lat, s.lng], {
      radius: stationRadiusM ?? 20,
      color,
      weight: 2,
      dashArray: s.active ? null : '4 6',
      fillColor: color,
      fillOpacity: s.active ? 0.2 : 0.05,
    })
      .bindTooltip(`💰 ${s.name} · ${s.points}`, {
        permanent: true,
        direction: 'top',
        className: 'ref-tooltip',
      })
      .addTo(layer);
  }
}
