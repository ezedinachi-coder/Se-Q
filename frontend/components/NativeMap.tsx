/**
 * components/NativeMap.tsx  (Native + Web)
 *
 * HIGH-RESOLUTION SATELLITE MAP — Leaflet WebView, no Mapbox required.
 *
 * Tile layers (satellite path):
 *   1. PRIMARY  — Google Maps Satellite  (zoom 1–21, ~0.1 m/px at z21)
 *      ⚠ Google tiles are unofficial/reverse-engineered; they work reliably
 *        on device but you should swap in a paid provider if Google blocks them.
 *   2. FALLBACK — Esri World Imagery     (zoom 1–20, ~0.3 m/px at z20)
 *      Free, no API key, excellent Africa/Nigeria coverage.
 *
 * Streets layer → OpenStreetMap (zoom 1–19).
 * Labels overlay → Esri World Boundaries & Places (toggled on satellite).
 *
 * Effective ground resolution at maxZoom:
 *   z19 ≈ 0.3 m/px  |  z20 ≈ 0.15 m/px  |  z21 ≈ 0.075 m/px
 * These correspond to 5–10 m feature visibility at z19–z20 — the target range.
 *
 * All communication between the WebView and RN is via postMessage / onMessage JSON.
 */

import React, { useRef, useEffect, useCallback } from 'react';
import {
  View, StyleSheet, Platform, Text, TouchableOpacity,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface MarkerData {
  id: string;
  latitude: number;
  longitude: number;
  title?: string;
  description?: string;
  pinColor?: string;
}

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
  initialMapStyle?: 'satellite' | 'streets';
}

// ── Tile layer URLs ────────────────────────────────────────────────────────────
//
// Google Satellite: highest available resolution (zoom up to 21 in most regions).
// Tile URL is the well-known reverse-engineered endpoint used by dozens of FOSS
// projects (e.g. QGIS, Leaflet-providers). Works without a key on device.
//
const TILES = {
  // PRIMARY high-res satellite
  googleSatellite:
    'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',

  // FALLBACK satellite (free, no key, great Africa coverage, max z20)
  esriSatellite:
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',

  // Labels overlay (always free)
  esriLabels:
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',

  // Streets
  osm:
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
};

// ── Build the self-contained HTML blob ─────────────────────────────────────

function buildMapHTML(opts: {
  lat: number;
  lng: number;
  zoom: number;
  markers: MarkerData[];
  radiusMeters: number;
  initialStyle: 'satellite' | 'streets';
}): string {
  const { lat, lng, zoom, markers, radiusMeters, initialStyle } = opts;

  const markersJson = JSON.stringify(markers);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body, #map { width: 100%; height: 100%; background: #0F172A; }

  .style-toggle {
    position: absolute;
    top: 10px;
    right: 10px;
    z-index: 1000;
    background: rgba(15,23,42,0.92);
    border: 1.5px solid #3B82F6;
    border-radius: 8px;
    padding: 6px 12px;
    color: #3B82F6;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    font-family: -apple-system, sans-serif;
    display: flex;
    align-items: center;
    gap: 5px;
    letter-spacing: 0.3px;
  }
  .style-toggle:active { opacity: 0.8; }

  .zoom-badge {
    position: absolute;
    top: 10px;
    left: 10px;
    z-index: 1000;
    background: rgba(15,23,42,0.85);
    border-radius: 6px;
    padding: 4px 8px;
    color: #64748B;
    font-size: 11px;
    font-family: -apple-system, sans-serif;
    pointer-events: none;
  }

  .coords-badge {
    position: absolute;
    bottom: 8px;
    left: 8px;
    z-index: 1000;
    background: rgba(15,23,42,0.85);
    border-radius: 6px;
    padding: 4px 8px;
    color: #94A3B8;
    font-size: 11px;
    font-family: -apple-system, sans-serif;
    pointer-events: none;
  }

  /* Compact marker */
  .map-marker {
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    border: 2.5px solid white;
    box-shadow: 0 2px 6px rgba(0,0,0,0.45);
  }
  .map-marker-dot {
    width: 7px;
    height: 7px;
    background: white;
    border-radius: 50%;
  }

  /* Pulse animation for active markers */
  @keyframes pulse {
    0%   { box-shadow: 0 0 0 0 rgba(59,130,246,0.6); }
    70%  { box-shadow: 0 0 0 10px rgba(59,130,246,0); }
    100% { box-shadow: 0 0 0 0 rgba(59,130,246,0); }
  }
  .map-marker-pulse { animation: pulse 2s infinite; }

  /* Override Leaflet attribution */
  .leaflet-control-attribution {
    background: rgba(15,23,42,0.7) !important;
    color: #64748B !important;
    font-size: 9px !important;
  }
  .leaflet-control-attribution a { color: #3B82F6 !important; }
  .leaflet-control-zoom a {
    background: rgba(15,23,42,0.92) !important;
    color: #3B82F6 !important;
    border-color: #1E293B !important;
  }
  .leaflet-control-zoom a:hover { background: #1E293B !important; }

  /* Popup style */
  .leaflet-popup-content-wrapper {
    background: #1E293B;
    color: #F1F5F9;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    font-family: -apple-system, sans-serif;
  }
  .leaflet-popup-tip { background: #1E293B; }
  .leaflet-popup-content { margin: 10px 14px; font-size: 13px; }
  .leaflet-popup-content b { color: #fff; }
  .leaflet-popup-close-button { color: #94A3B8 !important; }
</style>
</head>
<body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function() {

  var currentStyle = '${initialStyle}';
  var map = L.map('map', {
    zoomControl: true,
    attributionControl: true,
    // Allow native pinch-zoom to reach maximum tile resolution
    maxZoom: 21,
  }).setView([${lat}, ${lng}], ${zoom});

  // ── Tile layers ───────────────────────────────────────────────────────────
  //
  // Google Satellite — z1–21, uses subdomains 0-3 (mt0…mt3)
  var googleSat = L.tileLayer(
    '${TILES.googleSatellite}',
    {
      maxZoom: 21,
      subdomains: ['0','1','2','3'],
      attribution: '© Google',
      // Retry on tile error (network blip)
      errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    }
  );

  // Esri fallback — z1–20
  var esriSat = L.tileLayer(
    '${TILES.esriSatellite}',
    { maxZoom: 20, attribution: 'Esri, Maxar, Airbus' }
  );

  var esriLabels = L.tileLayer(
    '${TILES.esriLabels}',
    { maxZoom: 21, attribution: '' }
  );

  var osmStreets = L.tileLayer(
    '${TILES.osm}',
    { maxZoom: 19, attribution: '© OpenStreetMap contributors', subdomains: 'abc' }
  );

  // Track which satellite layer is live
  var activeSatLayer = null;

  function loadSatellite() {
    // Try Google first; fall back to Esri if tiles fail after 2 s
    if (activeSatLayer) { map.removeLayer(activeSatLayer); activeSatLayer = null; }
    googleSat.addTo(map);
    activeSatLayer = googleSat;
    esriLabels.addTo(map);

    // Fallback: if Google tiles error, switch to Esri silently
    var errCount = 0;
    googleSat.on('tileerror', function() {
      errCount++;
      if (errCount >= 3 && activeSatLayer === googleSat) {
        map.removeLayer(googleSat);
        esriSat.addTo(map);
        activeSatLayer = esriSat;
        errCount = 0;
      }
    });
  }

  function applyStyle(style) {
    if (style === 'satellite') {
      map.removeLayer(osmStreets);
      loadSatellite();
      toggleBtn.innerHTML = satIcon + ' Satellite';
    } else {
      if (activeSatLayer) { map.removeLayer(activeSatLayer); activeSatLayer = null; }
      map.removeLayer(esriLabels);
      osmStreets.addTo(map);
      toggleBtn.innerHTML = streetIcon + ' Streets';
    }
    currentStyle = style;
  }

  // Initial layer
  if (currentStyle === 'satellite') {
    loadSatellite();
  } else {
    osmStreets.addTo(map);
  }

  // ── Style toggle button ───────────────────────────────────────────────────
  var satIcon    = '🛰';
  var streetIcon = '🗺';

  var toggleBtn = document.createElement('button');
  toggleBtn.className = 'style-toggle';
  toggleBtn.innerHTML = currentStyle === 'satellite'
    ? satIcon + ' Satellite'
    : streetIcon + ' Streets';
  document.body.appendChild(toggleBtn);
  toggleBtn.addEventListener('click', function() {
    applyStyle(currentStyle === 'satellite' ? 'streets' : 'satellite');
  });

  // ── Zoom badge (shows current zoom for ground-resolution awareness) ───────
  var zoomBadge = document.createElement('div');
  zoomBadge.className = 'zoom-badge';
  function updateZoomBadge() {
    var z = map.getZoom();
    // Approximate ground resolution at equator (metres per pixel)
    var res = (156543.03392 * Math.cos(map.getCenter().lat * Math.PI / 180)) / Math.pow(2, z);
    zoomBadge.textContent = 'z' + z + ' ≈ ' + (res < 1 ? res.toFixed(2) : Math.round(res)) + ' m/px';
  }
  document.body.appendChild(zoomBadge);
  map.on('zoomend', updateZoomBadge);
  updateZoomBadge();

  // ── Coords badge ──────────────────────────────────────────────────────────
  var coordsBadge = document.createElement('div');
  coordsBadge.className = 'coords-badge';
  coordsBadge.textContent = '${lat.toFixed(4)}, ${lng.toFixed(4)}';
  document.body.appendChild(coordsBadge);
  map.on('move', function() {
    var c = map.getCenter();
    coordsBadge.textContent = c.lat.toFixed(6) + ', ' + c.lng.toFixed(6);
  });

  // ── Markers ───────────────────────────────────────────────────────────────
  var markersData = ${markersJson};
  var leafletMarkers = [];

  function addMarkers(data) {
    leafletMarkers.forEach(function(m) { m.remove(); });
    leafletMarkers = [];

    data.forEach(function(m) {
      var color = m.pinColor || '#3B82F6';
      var el = document.createElement('div');
      el.className = 'map-marker';
      // Pulse blue markers (security agents) to make them stand out on satellite
      if (color === '#3B82F6') el.classList.add('map-marker-pulse');
      el.style.cssText = 'width:22px;height:22px;background:' + color + ';';
      var dot = document.createElement('div');
      dot.className = 'map-marker-dot';
      el.appendChild(dot);

      var icon = L.divIcon({
        html: el.outerHTML,
        className: '',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        popupAnchor: [0, -14],
      });

      var marker = L.marker([m.latitude, m.longitude], { icon: icon }).addTo(map);

      if (m.title) {
        var popupContent = '<b>' + m.title + '</b>';
        if (m.description) popupContent += '<br><span style="color:#94A3B8;font-size:12px">' + m.description + '</span>';
        marker.bindPopup(popupContent);
      }

      marker.on('click', function() {
        sendMessage({ type: 'markerPress', latitude: m.latitude, longitude: m.longitude, id: m.id });
        marker.openPopup();
      });

      leafletMarkers.push(marker);
    });
  }

  addMarkers(markersData);

  // ── Radius circle ─────────────────────────────────────────────────────────
  var radiusCircle = null;
  if (${radiusMeters} > 0 && markersData.length > 0) {
    radiusCircle = L.circle([${lat}, ${lng}], {
      radius: ${radiusMeters},
      color: '#3B82F6',
      fillColor: '#3B82F6',
      fillOpacity: 0.12,
      weight: 2,
      dashArray: '6 4',
    }).addTo(map);
  }

  // ── Map click ─────────────────────────────────────────────────────────────
  map.on('click', function(e) {
    sendMessage({ type: 'mapPress', latitude: e.latlng.lat, longitude: e.latlng.lng });
  });

  // ── postMessage bridge ────────────────────────────────────────────────────
  function sendMessage(data) {
    try {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify(data));
      } else {
        window.parent.postMessage(JSON.stringify(data), '*');
      }
    } catch(e) {}
  }

  // ── Receive commands from RN ───────────────────────────────────────────────
  window.addEventListener('message', function(e) {
    try {
      var msg = JSON.parse(e.data);
      if (msg.type === 'updateMarkers') {
        addMarkers(msg.markers);
      } else if (msg.type === 'flyTo') {
        map.setView([msg.lat, msg.lng], msg.zoom || map.getZoom(), { animate: true, duration: 0.8 });
      } else if (msg.type === 'setStyle') {
        applyStyle(msg.style);
      } else if (msg.type === 'setZoom') {
        map.setZoom(msg.zoom, { animate: true });
      }
    } catch(e) {}
  });

  // Signal ready
  setTimeout(function() {
    sendMessage({ type: 'mapReady' });
  }, 100);

})();
</script>
</body>
</html>`;
}

// ── NativeMap component ──────────────────────────────────────────────────────

export function NativeMap({
  region,
  markerCoords,
  markers,
  radiusKm,
  onPress,
  onMarkerChange,
  style,
  initialMapStyle = 'satellite',
}: NativeMapProps) {
  const webViewRef = useRef<WebView>(null);

  const lat = markerCoords?.latitude ?? region.latitude;
  const lng = markerCoords?.longitude ?? region.longitude;
  // Clamp to z19 on initial load; user can pinch up to z21 from there.
  // Tighter latitudeDelta → higher zoom; cap at 19 so the tile request is valid.
  const zoom = Math.max(1, Math.min(19, Math.round(Math.log2(360 / region.latitudeDelta))));

  const allMarkers: MarkerData[] = markers
    ? markers
    : markerCoords
    ? [{ id: 'main', latitude: lat, longitude: lng, title: 'Selected Location', pinColor: '#EF4444' }]
    : [];

  const radiusMeters = radiusKm ? radiusKm * 1000 : 0;

  // Send updated markers when they change
  useEffect(() => {
    if (!webViewRef.current) return;
    const msg = JSON.stringify({ type: 'updateMarkers', markers: allMarkers });
    webViewRef.current.postMessage(msg);
  }, [JSON.stringify(markers), JSON.stringify(markerCoords)]);

  // Re-center when region changes
  useEffect(() => {
    if (!webViewRef.current) return;
    const msg = JSON.stringify({ type: 'flyTo', lat, lng, zoom });
    webViewRef.current.postMessage(msg);
  }, [region.latitude, region.longitude]);

  const handleMessage = useCallback((event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'mapPress' && onPress) {
        onPress({ latitude: data.latitude, longitude: data.longitude });
        if (onMarkerChange) onMarkerChange({ latitude: data.latitude, longitude: data.longitude });
      } else if (data.type === 'markerPress' && onPress) {
        onPress({ latitude: data.latitude, longitude: data.longitude });
      }
    } catch (_) {}
  }, [onPress, onMarkerChange]);

  const html = buildMapHTML({ lat, lng, zoom, markers: allMarkers, radiusMeters, initialStyle: initialMapStyle });

  return (
    <View style={[styles.container, style]}>
      <WebView
        ref={webViewRef}
        source={{ html }}
        style={styles.webview}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        scrollEnabled={false}
        bounces={false}
        onMessage={handleMessage}
        onError={(e) => console.warn('[NativeMap] WebView error:', e.nativeEvent.description)}
        mixedContentMode="always"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F172A' },
  webview: { flex: 1, backgroundColor: '#0F172A' },
});

export default NativeMap;
