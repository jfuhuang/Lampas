import L from 'leaflet';

/**
 * Shared base-layer styles for both maps (referee + player).
 *
 * - Night:     standard OSM darkened via the `.tiles-night` CSS filter —
 *              easy on hider eyes in the dark.
 * - Terrain:   OpenTopoMap — contour lines, trails, and building/POI names.
 *              Native tiles stop at z17; Leaflet upscales beyond that.
 * - Satellite: Esri World Imagery — actual buildings/vegetation, no labels.
 *
 * All are free, keyless tile servers (attribution required and included).
 * The picked style persists per phone in localStorage.
 */

const STYLE_KEY = 'lampas.mapStyle';

function makeLayers() {
  return {
    Night: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      className: 'tiles-night',
      attribution: '&copy; OpenStreetMap contributors',
    }),
    Terrain: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxNativeZoom: 17,
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap, SRTM | &copy; OpenTopoMap (CC-BY-SA)',
    }),
    Satellite: L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        maxNativeZoom: 19,
        maxZoom: 19,
        attribution: 'Imagery &copy; Esri',
      },
    ),
  };
}

/**
 * Add the remembered base layer + a picker control to a Leaflet map.
 * Call once right after `L.map(...)`.
 */
export function addStyleControl(map) {
  const layers = makeLayers();
  const saved = localStorage.getItem(STYLE_KEY);
  (layers[saved] ?? layers.Night).addTo(map);
  L.control.layers(layers, null, { position: 'topright' }).addTo(map);
  map.on('baselayerchange', (e) => localStorage.setItem(STYLE_KEY, e.name));
}
