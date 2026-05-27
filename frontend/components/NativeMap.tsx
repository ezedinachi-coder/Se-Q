/**
 * components/NativeMap.tsx  (Native + Web)
 *
 * ZERO-DEPENDENCY MAP — no Mapbox, no API keys.
 *
 * Uses react-native-webview to render a self-contained Leaflet map with:
 *   • Satellite layer  → Esri World Imagery (free, no key, excellent Africa/Nigeria coverage)
 *   • Streets layer    → OpenStreetMap standard tiles
 *   • Labels overlay   → Esri World Boundaries & Places (toggled on satellite)
 *
 * Esri World Imagery is composed of the best available imagery from multiple providers
 * (Maxar, Airbus, etc.) and covers Nigeria / Africa at 0.3–1 m/px resolution.
 * For truly current change-detection imagery, Sentinel-2 requires a Copernicus account
 * and a WMTS token — the Esri layer uses composited imagery that is updated continuously.
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

// ── Tile layer URLs (all free, no API key) ──────────────────────────────────

const TILES = {
  esriSatellite:
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  esriLabels:
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
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
  .style-toggle svg { flex-shrink: 0; }

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
  }).setView([${lat}, ${lng}], ${zoom});

  // ── Tile layers ───────────────────────────────────────────────────────────
  var esriSat = L.tileLayer(
    '${TILES.esriSatellite}',
    { maxZoom: 20, attribution: 'Esri, Maxar, Airbus' }
  );

  var esriLabels = L.tileLayer(
    '${TILES.esriLabels}',
    { maxZoom: 20, attribution: '' }
  );

  var osmStreets = L.tileLayer(
    '${TILES.osm}',
    { maxZoom: 19, attribution: '© OpenStreetMap contributors', subdomains: 'abc' }
  );

  function applyStyle(style) {
    if (style === 'satellite') {
      map.removeLayer(osmStreets);
      esriSat.addTo(map);
      esriLabels.addTo(map);
      toggleBtn.innerHTML = satelliteIcon + ' Satellite';
    } else {
      map.removeLayer(esriSat);
      map.removeLayer(esriLabels);
      osmStreets.addTo(map);
      toggleBtn.innerHTML = streetIcon + ' Streets';
    }
    currentStyle = style;
  }

  // Initial layer
  if (currentStyle === 'satellite') {
    esriSat.addTo(map);
    esriLabels.addTo(map);
  } else {
    osmStreets.addTo(map);
  }

  // ── Style toggle button ───────────────────────────────────────────────────
  var satelliteIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" stroke-width="2.5"><circle cx="12" cy="12" r="3"/><path d="M3 12a9 9 0 0 0 9 9"/><path d="M21 12a9 9 0 0 0-9-9"/><path d="m3.6 9 2.4-.6"/><path d="m18 15.6 2.4-.6"/><path d="m9 3.6-.6 2.4"/><path d="m15.6 18 -.6 2.4"/></svg>';
  var streetIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" stroke-width="2.5"><path d="M3 6h18M3 12h18M3 18h18"/></svg>';

  var toggleBtn = document.createElement('button');
  toggleBtn.className = 'style-toggle';
  toggleBtn.innerHTML = currentStyle === 'satellite'
    ? satelliteIcon + ' Satellite'
    : streetIcon + ' Streets';
  document.body.appendChild(toggleBtn);

  toggleBtn.addEventListener('click', function() {
    applyStyle(currentStyle === 'satellite' ? 'streets' : 'satellite');
  });

  // ── Coords badge ──────────────────────────────────────────────────────────
  var coordsBadge = document.createElement('div');
  coordsBadge.className = 'coords-badge';
  coordsBadge.textContent = '${lat.toFixed(4)}, ${lng.toFixed(4)}';
  document.body.appendChild(coordsBadge);

  map.on('move', function() {
    var c = map.getCenter();
    coordsBadge.textContent = c.lat.toFixed(4) + ', ' + c.lng.toFixed(4);
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
      fillOpacity: 0.15,
      weight: 2,
    }).addTo(map);
  }

  // ── Map click ─────────────────────────────────────────────────────────────
  map.on('click', function(e) {
    sendMessage({ type: 'mapPress', latitude: e.latlng.lat, longitude: e.latlng.lng });
  });

  // ── postMessage bridge ────────────────────────────────────────────────────
  function sendMessage(data) {
    try {
      // React Native WebView
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
  const zoom = Math.max(1, Math.min(18, Math.round(Math.log2(360 / region.latitudeDelta))));

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
        // Allow loading CDN resources
        mixedContentMode="always"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F172A' },
  webview: { flex: 1, backgroundColor: '#0F172A' },
  fallback: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#0F172A' },
  fallbackText: { color: '#94A3B8', marginTop: 12, fontSize: 13, textAlign: 'center' },
});

export default NativeMap;
