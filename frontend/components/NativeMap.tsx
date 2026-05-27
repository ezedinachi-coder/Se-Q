/**
 * components/NativeMap.tsx
 *
 * Google Maps JavaScript API — rendered inside react-native-webview.
 *
 * WHY GOOGLE MAPS:
 *   Every alternative (Esri/Maxar, Sentinel-2, Mapbox) has stale imagery for
 *   Nigeria/Africa (1-6 years old). Google Maps has current satellite imagery,
 *   interactive Street View with rotation, and a generous free tier:
 *   10,000 map loads/month at no cost (Essentials SKU, March 2025 pricing).
 *
 * SETUP — one-time (5 minutes):
 *   1. console.cloud.google.com → New project → Enable "Maps JavaScript API"
 *   2. APIs & Services → Credentials → Create API Key
 *   3. Restrict key: Application restrictions → Android apps (com.seq.app)
 *      + HTTP referrers for web. Also restrict to Maps JavaScript API only.
 *   4. Add to app.config.js  →  extra.googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY
 *   5. Add to eas.json env   →  GOOGLE_MAPS_API_KEY: "AIza..."
 *
 * MAP TYPES available:
 *   'satellite' → pure satellite (current Google Earth imagery)
 *   'hybrid'    → satellite + road/label overlay  ← RECOMMENDED default
 *   'roadmap'   → full Google Maps road view (replaces OpenStreetMap)
 *   'terrain'   → topographic view
 *
 * All RN ↔ WebView communication uses postMessage / onMessage JSON.
 */

import React, { useRef, useEffect, useCallback } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { WebView } from 'react-native-webview';
import Constants from 'expo-constants';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface MarkerData {
  id: string;
  latitude: number;
  longitude: number;
  title?: string;
  description?: string;
  pinColor?: string; // hex e.g. '#EF4444'
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
  /** Default: 'hybrid' — satellite imagery with road/label overlay */
  initialMapStyle?: GoogleMapType;
}

// ── Zoom from latitudeDelta ───────────────────────────────────────────────────

function deltaToZoom(latitudeDelta: number): number {
  return Math.max(3, Math.min(20, Math.round(Math.log2(180 / latitudeDelta))));
}

// ── Hex color → Google Maps marker icon URL ───────────────────────────────────

function hexToGoogleColor(hex?: string): string {
  // Google Maps marker colors from the Chart API replacement
  const colorMap: Record<string, string> = {
    '#EF4444': 'red', '#22C55E': 'green', '#3B82F6': 'blue',
    '#F59E0B': 'yellow', '#8B5CF6': 'purple', '#F97316': 'orange',
  };
  return colorMap[hex?.toUpperCase() ?? ''] ?? 'red';
}

// ── HTML builder ──────────────────────────────────────────────────────────────

function buildGoogleMapsHTML(opts: {
  apiKey: string;
  lat: number;
  lng: number;
  zoom: number;
  markers: MarkerData[];
  radiusMeters: number;
  initialMapType: GoogleMapType;
}): string {
  const { apiKey, lat, lng, zoom, markers, radiusMeters, initialMapType } = opts;
  const markersJson = JSON.stringify(markers);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body, #map { width: 100%; height: 100%; background: #0F172A; }

  /* Custom map type toggle */
  .map-type-bar {
    position: absolute;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 9999;
    display: flex;
    gap: 6px;
    background: rgba(15,23,42,0.92);
    border: 1px solid #334155;
    border-radius: 24px;
    padding: 5px 8px;
    pointer-events: all;
  }
  .map-type-btn {
    font-family: -apple-system, sans-serif;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.3px;
    color: #64748B;
    background: transparent;
    border: none;
    border-radius: 18px;
    padding: 5px 11px;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
    white-space: nowrap;
  }
  .map-type-btn.active {
    background: #2563EB;
    color: #fff;
  }

  /* Hide Google's default map type control (we use our own) */
  .gm-style-mtc { display: none !important; }

  /* Style Google Maps UI to match dark theme */
  .gm-control-active, .gm-svpc, .gm-fullscreen-control {
    background-color: rgba(15,23,42,0.92) !important;
    border-radius: 8px !important;
  }
  .gm-bundled-control .gmnoprint {
    background: rgba(15,23,42,0.92) !important;
  }
</style>
</head>
<body>
<div id="map"></div>

<!-- Custom type bar -->
<div class="map-type-bar" id="typeBar">
  <button class="map-type-btn ${initialMapType === 'hybrid'   ? 'active' : ''}" onclick="setType('hybrid')">🛰 Hybrid</button>
  <button class="map-type-btn ${initialMapType === 'satellite'? 'active' : ''}" onclick="setType('satellite')">📡 Satellite</button>
  <button class="map-type-btn ${initialMapType === 'roadmap'  ? 'active' : ''}" onclick="setType('roadmap')">🗺 Roads</button>
  <button class="map-type-btn ${initialMapType === 'terrain'  ? 'active' : ''}" onclick="setType('terrain')">🏔 Terrain</button>
</div>

<script>
var map, currentMarkers = [], radiusCircle = null;

function initMap() {
  map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: ${lat}, lng: ${lng} },
    zoom: ${zoom},
    mapTypeId: '${initialMapType}',
    disableDefaultUI: false,
    mapTypeControl: false,       // we use our own bar
    streetViewControl: true,     // pegman for Street View
    fullscreenControl: false,
    rotateControl: true,
    tiltControl: true,
    gestureHandling: 'greedy',   // single-finger pan (better for mobile)
    styles: [],                  // no custom style - use Google's standard
  });

  // ── Markers ───────────────────────────────────────────────────────────────
  var markersData = ${markersJson};
  addMarkers(markersData);

  // ── Radius circle ─────────────────────────────────────────────────────────
  if (${radiusMeters} > 0 && markersData.length > 0) {
    radiusCircle = new google.maps.Circle({
      strokeColor: '#3B82F6',
      strokeOpacity: 0.9,
      strokeWeight: 2,
      fillColor: '#3B82F6',
      fillOpacity: 0.12,
      map: map,
      center: { lat: ${lat}, lng: ${lng} },
      radius: ${radiusMeters},
    });
  }

  // ── Map click ─────────────────────────────────────────────────────────────
  map.addListener('click', function(e) {
    sendMessage({
      type: 'mapPress',
      latitude: e.latLng.lat(),
      longitude: e.latLng.lng(),
    });
  });

  // Signal ready
  setTimeout(function() { sendMessage({ type: 'mapReady' }); }, 200);
}

// ── Map type switch ───────────────────────────────────────────────────────────
function setType(type) {
  if (!map) return;
  map.setMapTypeId(type);
  document.querySelectorAll('.map-type-btn').forEach(function(btn) {
    btn.classList.remove('active');
  });
  event.target.classList.add('active');
  sendMessage({ type: 'mapTypeChange', mapType: type });
}

// ── Add markers ───────────────────────────────────────────────────────────────
function addMarkers(data) {
  currentMarkers.forEach(function(m) { m.setMap(null); });
  currentMarkers = [];

  var infoWindow = new google.maps.InfoWindow();

  data.forEach(function(m) {
    var markerColor = m.pinColor || '#3B82F6';
    // Use Google's SVG marker path (no external Chart API needed)
    var svgMarker = {
      path: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z',
      fillColor: markerColor,
      fillOpacity: 1,
      strokeColor: '#fff',
      strokeWeight: 1.5,
      scale: 1.6,
      anchor: new google.maps.Point(12, 22),
    };

    var marker = new google.maps.Marker({
      position: { lat: m.latitude, lng: m.longitude },
      map: map,
      icon: svgMarker,
      title: m.title || '',
      animation: google.maps.Animation.DROP,
    });

    if (m.title || m.description) {
      marker.addListener('click', function() {
        var content = '<div style="font-family:-apple-system,sans-serif;padding:2px 4px">'
          + (m.title ? '<b style="font-size:14px;color:#0F172A">' + m.title + '</b>' : '')
          + (m.description ? '<br><span style="font-size:12px;color:#64748B">' + m.description + '</span>' : '')
          + '</div>';
        infoWindow.setContent(content);
        infoWindow.open(map, marker);
        sendMessage({ type: 'markerPress', latitude: m.latitude, longitude: m.longitude, id: m.id });
      });
    }

    currentMarkers.push(marker);
  });
}

// ── postMessage bridge ────────────────────────────────────────────────────────
function sendMessage(data) {
  try {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(data));
    } else {
      window.parent.postMessage(JSON.stringify(data), '*');
    }
  } catch(e) {}
}

// ── Receive commands from RN ──────────────────────────────────────────────────
window.addEventListener('message', function(e) {
  try {
    var msg = JSON.parse(typeof e.data === 'string' ? e.data : JSON.stringify(e.data));
    if (!map) return;
    if (msg.type === 'updateMarkers') {
      addMarkers(msg.markers);
    } else if (msg.type === 'flyTo') {
      map.panTo({ lat: msg.lat, lng: msg.lng });
      if (msg.zoom) map.setZoom(msg.zoom);
    } else if (msg.type === 'setMapType') {
      map.setMapTypeId(msg.mapType);
    }
  } catch(e) {}
});
</script>

<!-- Load Google Maps JS API last -->
<script
  src="https://maps.googleapis.com/maps/api/js?key=${apiKey}&callback=initMap&libraries=maps,marker"
  async defer>
</script>
</body>
</html>`;
}

// ── NativeMap component ───────────────────────────────────────────────────────

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
  const webViewRef = useRef<WebView>(null);

  const apiKey: string =
    (Constants.expoConfig?.extra?.googleMapsApiKey as string) ?? '';

  const lat = markerCoords?.latitude  ?? region.latitude;
  const lng = markerCoords?.longitude ?? region.longitude;
  const zoom = deltaToZoom(region.latitudeDelta);

  const allMarkers: MarkerData[] = markers
    ? markers
    : markerCoords
    ? [{
        id: 'main',
        latitude: lat,
        longitude: lng,
        title: 'Selected Location',
        pinColor: '#EF4444',
      }]
    : [];

  const radiusMeters = radiusKm ? radiusKm * 1000 : 0;

  // Send updated markers when they change
  useEffect(() => {
    webViewRef.current?.postMessage(
      JSON.stringify({ type: 'updateMarkers', markers: allMarkers })
    );
  }, [JSON.stringify(markers), JSON.stringify(markerCoords)]);

  // Re-center when region changes
  useEffect(() => {
    webViewRef.current?.postMessage(
      JSON.stringify({ type: 'flyTo', lat, lng, zoom })
    );
  }, [region.latitude, region.longitude]);

  const handleMessage = useCallback((event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if ((data.type === 'mapPress' || data.type === 'markerPress') && onPress) {
        onPress({ latitude: data.latitude, longitude: data.longitude });
        if (onMarkerChange && data.type === 'mapPress') {
          onMarkerChange({ latitude: data.latitude, longitude: data.longitude });
        }
      }
    } catch (_) {}
  }, [onPress, onMarkerChange]);

  const html = buildGoogleMapsHTML({
    apiKey,
    lat,
    lng,
    zoom,
    markers: allMarkers,
    radiusMeters,
    initialMapType: initialMapStyle,
  });

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
        scrollEnabled={false}
        bounces={false}
        onMessage={handleMessage}
        mixedContentMode="always"
        // Required: Google Maps JS API checks the referrer / user-agent.
        // Setting a web user-agent makes the WebView present as a browser.
        userAgent="Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
        onError={(e) =>
          console.warn('[NativeMap] WebView error:', e.nativeEvent.description)
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F172A' },
  webview:   { flex: 1, backgroundColor: '#0F172A' },
});

export default NativeMap;
