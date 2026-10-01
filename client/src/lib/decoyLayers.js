import L from 'leaflet';

/**
 * Redraw V2 decoy markers into a Leaflet layer group. Seekers get plain
 * markers (can't tell them from real hiders); `mine` decoys (hider's own
 * team) and referee decoys get a name tooltip.
 */
export function drawDecoyLayers(layer, decoys) {
  if (!layer) return;
  layer.clearLayers();
  for (const d of decoys ?? []) {
    const icon = L.divIcon({
      className: '',
      html: '<div class="decoy-marker">🎭</div>',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
    const marker = L.marker([d.lat, d.lng], { icon, interactive: !!(d.playerName || d.mine) });
    if (d.playerName) marker.bindTooltip(`decoy · ${d.playerName}`, { direction: 'top' });
    else if (d.mine) marker.bindTooltip('your decoy', { direction: 'top' });
    marker.addTo(layer);
  }
}
