/**
 * components/NativeMap.tsx — WebView + MapLibre GL JS
 *
 * APPROACH: Renders a fully self-contained MapLibre GL JS map inside a
 * react-native-webview. This completely bypasses all react-native-maps
 * native bridge issues (New Architecture white-tile, PROVIDER_GOOGLE
 * google-services.json requirement, Fabric renderer regression).
 *
 * CAPABILITIES:
 *   ✅ Two-finger rotate (bearing)
 *   ✅ Two-finger pitch/tilt
 *   ✅ Pinch zoom + scroll
 *   ✅ Satellite view  — Esri World Imagery (free, no key, excellent Nigeria coverage)
 *   ✅ Street view     — OpenStreetMap standard tiles (free, no key)
 *   ✅ Hybrid view     — Esri satellite + OSM road labels overlay
 *   ✅ Terrain view    — OpenTopoMap (free, no key)
 *   ✅ Draggable markers
 *   ✅ Radius circle overlay
 *   ✅ Compass needle (auto-rotates with map bearing)
 *   ✅ Zero API keys required
 *   ✅ Works with newArchEnabled: true
 *   ✅ Works on every EAS build — no native linking, no google-services.json
 *
 * PROP INTERFACE: identical to all previous versions — zero call-site changes.
 */

import React, { useRef, useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, Platform, TouchableOpacity, Linking,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MarkerData {
  id: string;
  latitude: number;
  longitude: number;
  title?: string;
  description?: string;
  pinColor?: string;
}

export type GoogleMapType = 'satellite' | 'hybrid' | 'roadmap' | 'terrain';

export interface NativeMapProps {
  region: {
    latitude: number;
    longitude: number;
    latitudeDelta: number;
    longitudeDelta: number;
  };
  markerCoords?: { latitude: number; longitude: number };
  markers?: MarkerData[];
  radiusKm?: number;
  onPress?: (coords: { latitude: number; longitude: number }) => void;
  onMarkerChange?: (coords: { latitude: number; longitude: number }) => void;
  style?: any;
  initialMapStyle?: GoogleMapType;
}

// ── Tile sources ──────────────────────────────────────────────────────────────
// All free, no API key, verified coverage for Nigeria/Africa.

const TILE_SOURCES = {
  street: {
    label: 'Street',
    icon: '🗺',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© OpenStreetMap contributors',
    maxzoom: 19,
    tileSize: 256,
  },
  satellite: {
    label: 'Satellite',
    icon: '🛰',
    // Esri World Imagery — free, no key, excellent Africa/Nigeria coverage
    tiles: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    ],
    attribution: '© Esri, Maxar, Earthstar Geographics',
    maxzoom: 19,
    tileSize: 256,
  },
  hybrid: {
    label: 'Hybrid',
    icon: '🌍',
    // Esri satellite base + OSM road/label overlay
    tiles: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    ],
    overlayTiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© Esri, © OpenStreetMap contributors',
    maxzoom: 19,
    tileSize: 256,
  },
  terrain: {
    label: 'Terrain',
    icon: '🏔',
    tiles: ['https://tile.opentopomap.org/{z}/{x}/{y}.png'],
    attribution: '© OpenTopoMap contributors',
    maxzoom: 17,
    tileSize: 256,
  },
};

// ── HTML template ─────────────────────────────────────────────────────────────

function buildMapHTML(opts: {
  lat: number;
  lng: number;
  zoom: number;
  markers: MarkerData[];
  radiusKm: number;
  draggable: boolean;
  initialStyle: string;
}): string {
  const { lat, lng, zoom, markers, radiusKm, draggable, initialStyle } = opts;

  const markersJson = JSON.stringify(markers);
  const sourcesJson = JSON.stringify(TILE_SOURCES);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"/>
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css"/>
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body, #map { width: 100%; height: 100%; background: #0f172a; }

  /* Style toggle bar */
  #styleBar {
    position: absolute;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 100;
    display: flex;
    gap: 4px;
    background: rgba(15,23,42,0.92);
    border-radius: 24px;
    padding: 5px 6px;
    border: 1px solid #334155;
    white-space: nowrap;
  }
  .styleBtn {
    border: none;
    background: transparent;
    color: #64748b;
    font-size: 11px;
    font-weight: 700;
    padding: 5px 9px;
    border-radius: 18px;
    cursor: pointer;
    font-family: -apple-system, sans-serif;
  }
  .styleBtn.active { background: #2563eb; color: #fff; }

  /* Compass */
  #compass {
    position: absolute;
    top: 52px;
    right: 10px;
    width: 36px;
    height: 36px;
    z-index: 100;
    background: rgba(15,23,42,0.88);
    border-radius: 50%;
    border: 1px solid #334155;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 20px;
    transition: transform 0.15s;
  }

  /* Coords badge */
  #coords {
    position: absolute;
    bottom: 8px;
    left: 8px;
    z-index: 100;
    background: rgba(15,23,42,0.82);
    color: #94a3b8;
    font-size: 11px;
    font-family: monospace;
    padding: 4px 8px;
    border-radius: 6px;
    pointer-events: none;
  }

  /* Maplibre overrides */
  .maplibregl-ctrl-bottom-right { display: none; }
  .maplibregl-ctrl-bottom-left  { display: none; }
  .maplibregl-ctrl-top-right    { display: none; }
  .maplibregl-ctrl-top-left     { display: none; }

  /* Custom marker */
  .seq-marker {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 2.5px solid #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: 0 2px 6px rgba(0,0,0,0.5);
    font-size: 13px;
  }

  /* Popup */
  .maplibregl-popup-content {
    background: #1e293b;
    color: #f1f5f9;
    font-family: -apple-system, sans-serif;
    font-size: 13px;
    border-radius: 8px;
    padding: 8px 12px;
    border: 1px solid #334155;
  }
  .maplibregl-popup-tip { border-top-color: #1e293b !important; }
</style>
</head>
<body>
<div id="map"></div>
<div id="styleBar"></div>
<div id="compass" title="Reset North">🧭</div>
<div id="coords"></div>

<script>
// ── Config ────────────────────────────────────────────────────────────────
const SOURCES   = ${sourcesJson};
const MARKERS   = ${markersJson};
const RADIUS_KM = ${radiusKm};
const DRAGGABLE = ${draggable};
const INIT_LNG  = ${lng};
const INIT_LAT  = ${lat};
const INIT_ZOOM = ${zoom};

let currentStyle = '${initialStyle}';
let mapMarkers   = [];
let circleSource = null;

// ── Build MapLibre style ──────────────────────────────────────────────────
function buildStyle(styleKey) {
  const src = SOURCES[styleKey] || SOURCES.street;
  const layers = [];
  const sources = {};

  sources['base'] = {
    type: 'raster',
    tiles: src.tiles,
    tileSize: src.tileSize,
    maxzoom: src.maxzoom,
    attribution: src.attribution,
  };
  layers.push({ id: 'base-layer', type: 'raster', source: 'base' });

  // Hybrid: add OSM road overlay on top of satellite
  if (styleKey === 'hybrid' && src.overlayTiles) {
    sources['overlay'] = {
      type: 'raster',
      tiles: src.overlayTiles,
      tileSize: 256,
      maxzoom: 19,
    };
    layers.push({ id: 'overlay-layer', type: 'raster', source: 'overlay', paint: { 'raster-opacity': 0.55 } });
  }

  return { version: 8, sources, layers };
}

// ── Init map ──────────────────────────────────────────────────────────────
const map = new maplibregl.Map({
  container: 'map',
  style: buildStyle(currentStyle),
  center: [INIT_LNG, INIT_LAT],
  zoom: INIT_ZOOM,
  bearing: 0,
  pitch: 0,
  attributionControl: false,
  logoPosition: 'bottom-left',
});

// ── Style toggle bar ──────────────────────────────────────────────────────
const styleBar = document.getElementById('styleBar');
Object.entries(SOURCES).forEach(([key, src]) => {
  const btn = document.createElement('button');
  btn.className = 'styleBtn' + (key === currentStyle ? ' active' : '');
  btn.textContent = src.icon + ' ' + src.label;
  btn.onclick = () => switchStyle(key);
  styleBar.appendChild(btn);
});

function switchStyle(key) {
  currentStyle = key;
  document.querySelectorAll('.styleBtn').forEach((b, i) => {
    b.className = 'styleBtn' + (Object.keys(SOURCES)[i] === key ? ' active' : '');
  });
  map.setStyle(buildStyle(key));
  map.once('styledata', () => {
    addCircleIfNeeded();
  });
}

// ── Compass ───────────────────────────────────────────────────────────────
const compass = document.getElementById('compass');
map.on('rotate', () => {
  const bearing = map.getBearing();
  compass.style.transform = 'rotate(' + (-bearing) + 'deg)';
});
compass.onclick = () => map.easeTo({ bearing: 0, pitch: 0, duration: 400 });

// ── Coords badge ──────────────────────────────────────────────────────────
const coordsEl = document.getElementById('coords');
function updateCoords(center) {
  coordsEl.textContent = center.lat.toFixed(4) + ', ' + center.lng.toFixed(4);
}
map.on('move', () => updateCoords(map.getCenter()));
updateCoords({ lat: INIT_LAT, lng: INIT_LNG });

// ── Radius circle ─────────────────────────────────────────────────────────
function makeCircleGeoJSON(lng, lat, radiusKm) {
  const points = 64;
  const coords = [];
  const R = 6371;
  const latR = lat * Math.PI / 180;
  const lngR = lng * Math.PI / 180;
  const d    = radiusKm / R;
  for (let i = 0; i <= points; i++) {
    const bearing = (i / points) * 2 * Math.PI;
    const pLat = Math.asin(Math.sin(latR) * Math.cos(d) + Math.cos(latR) * Math.sin(d) * Math.cos(bearing));
    const pLng = lngR + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(latR), Math.cos(d) - Math.sin(latR) * Math.sin(pLat));
    coords.push([pLng * 180 / Math.PI, pLat * 180 / Math.PI]);
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] } };
}

function addCircleIfNeeded() {
  if (RADIUS_KM <= 0 || MARKERS.length === 0) return;
  const m = MARKERS[0];
  const geoJSON = makeCircleGeoJSON(m.longitude, m.latitude, RADIUS_KM);

  if (map.getLayer('circle-fill')) map.removeLayer('circle-fill');
  if (map.getLayer('circle-stroke')) map.removeLayer('circle-stroke');
  if (map.getSource('circle')) map.removeSource('circle');

  map.addSource('circle', { type: 'geojson', data: geoJSON });
  map.addLayer({ id: 'circle-fill', type: 'fill', source: 'circle',
    paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.12 } });
  map.addLayer({ id: 'circle-stroke', type: 'line', source: 'circle',
    paint: { 'line-color': '#3b82f6', 'line-width': 2 } });
}

// ── Markers ───────────────────────────────────────────────────────────────
function addMarkers() {
  MARKERS.forEach((m) => {
    const el = document.createElement('div');
    el.className = 'seq-marker';
    const color = m.pinColor || '#3b82f6';
    el.style.background = color;
    el.textContent = '📍';

    const marker = new maplibregl.Marker({ element: el, draggable: DRAGGABLE })
      .setLngLat([m.longitude, m.latitude])
      .addTo(map);

    if (m.title) {
      const popup = new maplibregl.Popup({ offset: 20, closeButton: false })
        .setHTML('<strong>' + m.title + '</strong>' + (m.description ? '<br>' + m.description : ''));
      marker.setPopup(popup);
      el.onclick = () => marker.togglePopup();
    }

    if (DRAGGABLE) {
      marker.on('dragend', () => {
        const lngLat = marker.getLngLat();
        window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
          JSON.stringify({ type: 'markerDrag', latitude: lngLat.lat, longitude: lngLat.lng })
        );
      });
    }

    mapMarkers.push(marker);
  });
}

// ── Map click ─────────────────────────────────────────────────────────────
map.on('click', (e) => {
  window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
    JSON.stringify({ type: 'mapPress', latitude: e.lngLat.lat, longitude: e.lngLat.lng })
  );
});

// ── Ready ─────────────────────────────────────────────────────────────────
map.on('load', () => {
  addMarkers();
  addCircleIfNeeded();
  window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
    JSON.stringify({ type: 'ready' })
  );
});

map.on('error', (e) => {
  // Tile load errors are non-fatal — MapLibre retries automatically
  console.warn('MapLibre error:', e.error && e.error.message);
});

// ── Commands from RN ──────────────────────────────────────────────────────
window.addEventListener('message', (event) => {
  try {
    const cmd = JSON.parse(event.data);
    if (cmd.type === 'flyTo') {
      map.flyTo({ center: [cmd.lng, cmd.lat], zoom: cmd.zoom || INIT_ZOOM, duration: 600 });
    }
  } catch (_) {}
});
</script>
</body>
</html>`;
}

// ── NativeMap component ────────────────────────────────────────────────────────

export function NativeMap({
  region,
  markerCoords,
  markers,
  radiusKm,
  onPress,
  onMarkerChange,
  style,
  initialMapStyle = 'hybrid',
}: NativeMapProps) {
  const webRef = useRef<WebView>(null);
  const [ready, setReady] = useState(false);

  const lat = markerCoords?.latitude  ?? region.latitude;
  const lng = markerCoords?.longitude ?? region.longitude;

  // Zoom from latitudeDelta (rough but good enough for initial view)
  const zoom = Math.round(Math.log2(360 / region.latitudeDelta)) - 1;

  const allMarkers: MarkerData[] = markers
    ? markers
    : markerCoords
    ? [{ id: 'main', latitude: lat, longitude: lng, title: 'Selected Location', pinColor: '#EF4444' }]
    : [];

  const html = buildMapHTML({
    lat,
    lng,
    zoom: Math.max(2, Math.min(zoom, 18)),
    markers: allMarkers,
    radiusKm: radiusKm ?? 0,
    draggable: !!onMarkerChange,
    initialStyle: initialMapStyle === 'roadmap' ? 'street' : initialMapStyle,
  });

  const handleMessage = useCallback((event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'ready') {
        setReady(true);
      } else if (msg.type === 'mapPress') {
        onPress?.({ latitude: msg.latitude, longitude: msg.longitude });
      } else if (msg.type === 'markerDrag') {
        onMarkerChange?.({ latitude: msg.latitude, longitude: msg.longitude });
        onPress?.({ latitude: msg.latitude, longitude: msg.longitude });
      }
    } catch (_) {}
  }, [onPress, onMarkerChange]);

  // Web platform — show coords + link
  if (Platform.OS === 'web') {
    return (
      <View style={[s.container, style]}>
        <View style={s.webFallback}>
          <Ionicons name="map-outline" size={48} color="#3B82F6" />
          <Text style={s.fallbackCoords}>{lat.toFixed(6)}, {lng.toFixed(6)}</Text>
          <TouchableOpacity
            style={s.openBtn}
            onPress={() => Linking.openURL(`https://www.google.com/maps?q=${lat},${lng}`)}
          >
            <Ionicons name="open-outline" size={16} color="#fff" />
            <Text style={s.openBtnText}>Open in Google Maps</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={[s.container, style]}>
      <WebView
        ref={webRef}
        style={StyleSheet.absoluteFillObject}
        source={{ html }}
        onMessage={handleMessage}
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={['*']}
        // Allow loading Esri/OSM tile URLs
        mixedContentMode="always"
        // Prevent the WebView's own scroll from eating map gestures
        scrollEnabled={false}
        bounces={false}
        // Suppress "Are you sure you want to leave this page?" dialogs
        setSupportMultipleWindows={false}
        // Keep alive — don't kill the map when the parent re-renders
        androidHardwareAccelerationDisabled={false}
        androidLayerType="hardware"
      />
    </View>
  );
}

const s = StyleSheet.create({
  container:     { flex: 1, backgroundColor: '#0F172A' },
  webFallback:   { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0F172A', gap: 12 },
  fallbackCoords:{ color: '#94A3B8', fontSize: 14, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  openBtn:       { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#3B82F6', paddingVertical: 10, paddingHorizontal: 20, borderRadius: 8, marginTop: 8 },
  openBtnText:   { color: '#fff', fontWeight: '600', fontSize: 14 },
});

export default NativeMap;
