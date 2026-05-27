/**
 * components/TrailMapModal.tsx
 *
 * Full-screen map modal — renders a GPS movement trail as a coloured polyline
 * with start/end markers. Uses the same zero-dependency WebView+Leaflet approach
 * as NativeMap (no Mapbox, no API key required).
 *
 * Tile sources:
 *   Satellite  → Esri World Imagery (free, excellent Africa coverage)
 *   Streets    → OpenStreetMap
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Platform,
  Modal, ActivityIndicator, Linking,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';

export interface GpsPoint {
  latitude: number;
  longitude: number;
  accuracy?: number;
  timestamp?: string;
}

interface TrailMapModalProps {
  visible: boolean;
  onClose: () => void;
  points: GpsPoint[];
  title?: string;
  subtitle?: string;
}

// ── Bounding box helper ──────────────────────────────────────────────────────

function computeCenter(points: GpsPoint[]) {
  if (!points.length) return { lat: 0, lng: 0, zoom: 14 };
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const p of points) {
    if (p.latitude < minLat) minLat = p.latitude;
    if (p.latitude > maxLat) maxLat = p.latitude;
    if (p.longitude < minLng) minLng = p.longitude;
    if (p.longitude > maxLng) maxLng = p.longitude;
  }
  const lat = (minLat + maxLat) / 2;
  const lng = (minLng + maxLng) / 2;
  const latSpan = maxLat - minLat || 0.01;
  const zoom = Math.max(8, Math.min(16, Math.floor(Math.log2(180 / latSpan))));
  return { lat, lng, zoom };
}

// ── Trail HTML builder ────────────────────────────────────────────────────────

function buildTrailHTML(points: GpsPoint[], initialStyle: 'satellite' | 'streets'): string {
  const { lat, lng, zoom } = computeCenter(points);
  const coordsArray = JSON.stringify(points.map(p => [p.latitude, p.longitude]));
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body, #map { width: 100%; height: 100%; background: #0F172A; }
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
  }
  .info-badge {
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
  .endpoint-marker {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 2.5px solid white;
    font-size: 15px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.5);
  }
  .leaflet-popup-content-wrapper {
    background: #1E293B;
    color: #F1F5F9;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    font-family: -apple-system, sans-serif;
  }
  .leaflet-popup-tip { background: #1E293B; }
  .leaflet-popup-content { margin: 8px 12px; font-size: 12px; }
</style>
</head>
<body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function() {
  var pts = ${coordsArray};
  var currentStyle = '${initialStyle}';

  var map = L.map('map', { zoomControl: true, attributionControl: true })
             .setView([${lat}, ${lng}], ${zoom});

  var esriSat = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 20, attribution: 'Esri, Maxar, Airbus' }
  );
  var esriLabels = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 20, attribution: '' }
  );
  var osm = L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, subdomains: 'abc', attribution: '© OpenStreetMap contributors' }
  );

  function applyStyle(s) {
    if (s === 'satellite') {
      map.removeLayer(osm);
      esriSat.addTo(map); esriLabels.addTo(map);
      toggleBtn.textContent = '🛰 Satellite';
    } else {
      map.removeLayer(esriSat); map.removeLayer(esriLabels);
      osm.addTo(map);
      toggleBtn.textContent = '🗺 Streets';
    }
    currentStyle = s;
  }

  applyStyle(currentStyle);

  var toggleBtn = document.createElement('button');
  toggleBtn.className = 'style-toggle';
  toggleBtn.textContent = currentStyle === 'satellite' ? '🛰 Satellite' : '🗺 Streets';
  document.body.appendChild(toggleBtn);
  toggleBtn.onclick = function() { applyStyle(currentStyle === 'satellite' ? 'streets' : 'satellite'); };

  var badge = document.createElement('div');
  badge.className = 'info-badge';
  badge.textContent = pts.length + ' GPS points';
  document.body.appendChild(badge);

  if (pts.length < 2) { return; }

  // Trail polyline
  var polyline = L.polyline(pts, {
    color: '#3B82F6',
    weight: 4,
    opacity: 0.9,
    dashArray: '10, 6',
    lineJoin: 'round',
  }).addTo(map);

  // Direction arrows every ~5 points
  for (var i = 5; i < pts.length; i += Math.max(5, Math.floor(pts.length / 10))) {
    var prev = pts[i-1], curr = pts[i];
    var angle = Math.atan2(curr[1] - prev[1], curr[0] - prev[0]) * 180 / Math.PI;
    var arrowEl = document.createElement('div');
    arrowEl.style.cssText = 'width:12px;height:12px;background:#3B82F6;clip-path:polygon(50% 0%,100% 100%,0% 100%);transform:rotate(' + (angle - 90) + 'deg);opacity:0.85;';
    L.marker([curr[0], curr[1]], {
      icon: L.divIcon({ html: arrowEl.outerHTML, className: '', iconSize: [12,12], iconAnchor: [6,6] }),
      interactive: false,
    }).addTo(map);
  }

  // Start marker (green flag)
  var startEl = document.createElement('div');
  startEl.className = 'endpoint-marker';
  startEl.style.background = '#22C55E';
  startEl.textContent = '🚩';
  var startIcon = L.divIcon({ html: startEl.outerHTML, className: '', iconSize: [28,28], iconAnchor: [14,14], popupAnchor: [0,-16] });
  L.marker([pts[0][0], pts[0][1]], { icon: startIcon })
   .bindPopup('<b>Start</b>${firstPoint?.timestamp ? '<br><span style="color:#94A3B8">' + new Date(firstPoint.timestamp).toLocaleString() + '</span>' : ''}')
   .addTo(map);

  // End marker (red pin)
  var endEl = document.createElement('div');
  endEl.className = 'endpoint-marker';
  endEl.style.background = '#EF4444';
  endEl.textContent = '📍';
  var endIdx = pts.length - 1;
  var endIcon = L.divIcon({ html: endEl.outerHTML, className: '', iconSize: [28,28], iconAnchor: [14,14], popupAnchor: [0,-16] });
  L.marker([pts[endIdx][0], pts[endIdx][1]], { icon: endIcon })
   .bindPopup('<b>End</b>${lastPoint?.timestamp ? '<br><span style="color:#94A3B8">' + new Date(lastPoint.timestamp).toLocaleString() + '</span>' : ''}')
   .addTo(map);

  // Fit bounds to trail
  setTimeout(function() {
    try { map.fitBounds(polyline.getBounds(), { padding: [40, 40], maxZoom: 16 }); } catch(e) {}
  }, 200);

})();
</script>
</body>
</html>`;
}

// ── Coordinate fallback list ──────────────────────────────────────────────────

function TrailFallback({ points }: { points: GpsPoint[] }) {
  return (
    <View style={styles.fallback}>
      <Ionicons name="navigate" size={48} color="#3B82F6" />
      <Text style={styles.fallbackTitle}>Trail — {points.length} GPS points</Text>
      {points.slice(0, 8).map((pt, i) => (
        <TouchableOpacity
          key={i}
          style={styles.fallbackRow}
          onPress={() => Linking.openURL(`https://www.google.com/maps?q=${pt.latitude},${pt.longitude}`)}
        >
          <View style={[styles.dot, i === 0 && styles.dotStart, i === points.length - 1 && styles.dotEnd]} />
          <Text style={styles.fallbackCoord}>{pt.latitude.toFixed(5)}, {pt.longitude.toFixed(5)}</Text>
          {pt.timestamp && (
            <Text style={styles.fallbackTime}>{new Date(pt.timestamp).toLocaleTimeString()}</Text>
          )}
        </TouchableOpacity>
      ))}
      {points.length > 8 && (
        <Text style={styles.moreText}>+ {points.length - 8} more points</Text>
      )}
    </View>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function TrailMapModal({ visible, onClose, points, title, subtitle }: TrailMapModalProps) {
  const [initialStyle] = useState<'satellite' | 'streets'>('satellite');
  const [isLoading, setIsLoading] = useState(true);

  const openExternalMaps = useCallback(() => {
    if (!points.length) return;
    const { latitude, longitude } = points[0];
    const url = Platform.OS === 'ios'
      ? `maps:?q=${encodeURIComponent(title || 'Trail')}&ll=${latitude},${longitude}`
      : `geo:${latitude},${longitude}?q=${latitude},${longitude}(${encodeURIComponent(title || 'Trail')})`;
    Linking.openURL(url).catch(() =>
      Linking.openURL(`https://www.google.com/maps?q=${latitude},${longitude}`)
    );
  }, [points, title]);

  const html = points.length >= 2 ? buildTrailHTML(points, initialStyle) : null;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.headerBtn}>
            <Ionicons name="close" size={26} color="#fff" />
          </TouchableOpacity>
          <View style={styles.headerInfo}>
            <Text style={styles.headerTitle}>{title || 'Movement Trail'}</Text>
            {subtitle
              ? <Text style={styles.headerSub}>{subtitle}</Text>
              : <Text style={styles.headerSub}>{points.length} GPS points</Text>
            }
          </View>
          <TouchableOpacity onPress={openExternalMaps} style={styles.headerBtn}>
            <Ionicons name="open-outline" size={22} color="#3B82F6" />
          </TouchableOpacity>
        </View>

        {/* Map or fallback */}
        <View style={styles.mapWrapper}>
          {points.length >= 2 && html ? (
            <>
              {isLoading && (
                <View style={styles.loadingOverlay}>
                  <ActivityIndicator size="large" color="#3B82F6" />
                  <Text style={styles.loadingText}>Loading satellite view...</Text>
                </View>
              )}
              <WebView
                source={{ html }}
                style={styles.webview}
                originWhitelist={['*']}
                javaScriptEnabled
                domStorageEnabled
                scrollEnabled={false}
                bounces={false}
                mixedContentMode="always"
                onLoadEnd={() => setIsLoading(false)}
                onError={() => setIsLoading(false)}
              />
            </>
          ) : (
            <TrailFallback points={points} />
          )}
        </View>

        {/* Stats bar */}
        {points.length >= 2 && (
          <View style={styles.statsBar}>
            <View style={styles.statItem}>
              <Ionicons name="location" size={16} color="#3B82F6" />
              <Text style={styles.statLabel}>Start</Text>
              <Text style={styles.statValue}>
                {points[0].latitude.toFixed(4)}, {points[0].longitude.toFixed(4)}
              </Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Ionicons name="flag" size={16} color="#EF4444" />
              <Text style={styles.statLabel}>End</Text>
              <Text style={styles.statValue}>
                {points[points.length-1].latitude.toFixed(4)}, {points[points.length-1].longitude.toFixed(4)}
              </Text>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F172A' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: Platform.OS === 'ios' ? 50 : 16,
    paddingBottom: 14,
    backgroundColor: '#1E293B',
  },
  headerBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  headerInfo: { flex: 1, alignItems: 'center' },
  headerTitle: { fontSize: 17, fontWeight: '700', color: '#fff' },
  headerSub: { fontSize: 12, color: '#64748B', marginTop: 2 },
  mapWrapper: { flex: 1, position: 'relative' },
  webview: { flex: 1, backgroundColor: '#0F172A' },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0F172A',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  loadingText: { color: '#94A3B8', marginTop: 12, fontSize: 13 },
  statsBar: {
    flexDirection: 'row',
    backgroundColor: '#1E293B',
    padding: 14,
    paddingBottom: Platform.OS === 'ios' ? 32 : 14,
    gap: 12,
  },
  statItem: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  statLabel: { color: '#64748B', fontSize: 11, fontWeight: '600' },
  statValue: { color: '#94A3B8', fontSize: 11, flex: 1 },
  statDivider: { width: 1, backgroundColor: '#334155' },
  // Fallback styles
  fallback: { flex: 1, padding: 20, alignItems: 'center', backgroundColor: '#0F172A' },
  fallbackTitle: { color: '#94A3B8', fontSize: 15, fontWeight: '600', marginTop: 12, marginBottom: 16 },
  fallbackRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, width: '100%', borderBottomWidth: 1, borderBottomColor: '#1E293B' },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#3B82F6' },
  dotStart: { backgroundColor: '#22C55E' },
  dotEnd: { backgroundColor: '#EF4444' },
  fallbackCoord: { flex: 1, color: '#94A3B8', fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  fallbackTime: { color: '#475569', fontSize: 11 },
  moreText: { color: '#475569', fontSize: 12, marginTop: 12 },
});

export default TrailMapModal;
