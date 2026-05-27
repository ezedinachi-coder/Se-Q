/**
 * components/TrailMapModal.tsx
 *
 * Full-screen trail map — Google Maps JS API via WebView.
 *
 * Shows GPS movement trail as a polyline with animated direction arrows,
 * start/end markers, and full Google Maps controls (zoom, Street View, rotate).
 * Supports satellite, hybrid, roadmap, terrain via a custom type bar.
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Platform,
  Modal, ActivityIndicator, Linking,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Bounding box / center ─────────────────────────────────────────────────────

function computeBounds(points: GpsPoint[]) {
  if (!points.length) return { lat: 9.082, lng: 8.6753, zoom: 7 }; // Nigeria center
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const p of points) {
    if (p.latitude  < minLat) minLat = p.latitude;
    if (p.latitude  > maxLat) maxLat = p.latitude;
    if (p.longitude < minLng) minLng = p.longitude;
    if (p.longitude > maxLng) maxLng = p.longitude;
  }
  const lat     = (minLat + maxLat) / 2;
  const lng     = (minLng + maxLng) / 2;
  const latSpan = maxLat - minLat || 0.01;
  const zoom    = Math.max(8, Math.min(17, Math.floor(Math.log2(170 / latSpan))));
  return { lat, lng, zoom, minLat, maxLat, minLng, maxLng };
}

// ── Trail HTML builder ────────────────────────────────────────────────────────

function buildTrailHTML(apiKey: string, points: GpsPoint[], initialMapType = 'hybrid'): string {
  const { lat, lng, zoom, minLat, maxLat, minLng, maxLng } = computeBounds(points);
  const coordsJson   = JSON.stringify(points.map(p => ({ lat: p.latitude, lng: p.longitude })));
  const firstTs      = points[0]?.timestamp  ? new Date(points[0].timestamp).toLocaleString()  : '';
  const lastTs       = points[points.length - 1]?.timestamp
    ? new Date(points[points.length - 1].timestamp).toLocaleString() : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"/>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body, #map { width:100%; height:100%; background:#0F172A; }
  .type-bar {
    position:absolute; top:10px; left:50%; transform:translateX(-50%);
    z-index:9999; display:flex; gap:5px;
    background:rgba(15,23,42,0.92); border:1px solid #334155;
    border-radius:24px; padding:5px 8px;
  }
  .type-btn {
    font-family:-apple-system,sans-serif; font-size:11px; font-weight:700;
    color:#64748B; background:transparent; border:none; border-radius:18px;
    padding:5px 10px; cursor:pointer; white-space:nowrap;
  }
  .type-btn.active { background:#2563EB; color:#fff; }
  .gm-style-mtc { display:none!important; }
  .info-chip {
    position:absolute; bottom:10px; left:10px; z-index:9999;
    background:rgba(15,23,42,0.88); border:1px solid #1E293B;
    border-radius:10px; padding:8px 12px;
    font-family:-apple-system,sans-serif; font-size:11px; color:#94A3B8;
    pointer-events:none;
    max-width: 200px;
  }
  .info-chip b { color:#F1F5F9; display:block; margin-bottom:2px; }
</style>
</head>
<body>
<div id="map"></div>

<div class="type-bar" id="typeBar">
  <button class="type-btn ${initialMapType==='hybrid'?'active':''}"    onclick="setType('hybrid',this)">🛰 Hybrid</button>
  <button class="type-btn ${initialMapType==='satellite'?'active':''}" onclick="setType('satellite',this)">📡 Sat</button>
  <button class="type-btn ${initialMapType==='roadmap'?'active':''}"   onclick="setType('roadmap',this)">🗺 Roads</button>
</div>

<div class="info-chip" id="infoChip">
  <b>${points.length} GPS points</b>
  ${firstTs ? 'From: ' + firstTs : ''}
  ${lastTs  ? '<br>To: '   + lastTs  : ''}
</div>

<script>
var map;
var pts = ${coordsJson};

function initMap() {
  map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: ${lat}, lng: ${lng} },
    zoom: ${zoom},
    mapTypeId: '${initialMapType}',
    disableDefaultUI: false,
    mapTypeControl: false,
    streetViewControl: true,
    fullscreenControl: false,
    rotateControl: true,
    gestureHandling: 'greedy',
  });

  if (pts.length < 2) { return; }

  // ── Trail polyline ──────────────────────────────────────────────────────────
  var polyline = new google.maps.Polyline({
    path: pts,
    geodesic: true,
    strokeColor: '#3B82F6',
    strokeOpacity: 0.9,
    strokeWeight: 4,
    icons: [{
      icon: {
        path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
        scale: 3,
        strokeColor: '#3B82F6',
        strokeWeight: 2,
        fillColor: '#fff',
        fillOpacity: 0.9,
      },
      offset: '50%',
      repeat: '100px',
    }],
    map: map,
  });

  // ── Start marker ────────────────────────────────────────────────────────────
  new google.maps.Marker({
    position: pts[0],
    map: map,
    title: 'Start' + (${JSON.stringify(firstTs)} ? ' — ' + ${JSON.stringify(firstTs)} : ''),
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 10,
      fillColor: '#22C55E',
      fillOpacity: 1,
      strokeColor: '#fff',
      strokeWeight: 2.5,
    },
    label: { text: 'S', color: '#fff', fontWeight: '700', fontSize: '11px' },
    zIndex: 10,
  });

  // ── End marker ──────────────────────────────────────────────────────────────
  new google.maps.Marker({
    position: pts[pts.length - 1],
    map: map,
    title: 'End' + (${JSON.stringify(lastTs)} ? ' — ' + ${JSON.stringify(lastTs)} : ''),
    icon: {
      path: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z',
      fillColor: '#EF4444',
      fillOpacity: 1,
      strokeColor: '#fff',
      strokeWeight: 1.5,
      scale: 1.8,
      anchor: new google.maps.Point(12, 22),
    },
    zIndex: 10,
  });

  // ── Fit bounds to trail ─────────────────────────────────────────────────────
  try {
    var bounds = new google.maps.LatLngBounds(
      { lat: ${minLat ?? lat} - 0.002, lng: ${minLng ?? lng} - 0.002 },
      { lat: ${maxLat ?? lat} + 0.002, lng: ${maxLng ?? lng} + 0.002 }
    );
    map.fitBounds(bounds, { top: 60, bottom: 40, left: 20, right: 20 });
  } catch(e) {}
}

function setType(type, btn) {
  if (!map) return;
  map.setMapTypeId(type);
  document.querySelectorAll('.type-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
}

window.addEventListener('message', function(e) {
  try {
    var msg = JSON.parse(e.data);
    if (msg.type === 'flyTo' && map) map.panTo({ lat: msg.lat, lng: msg.lng });
  } catch(e) {}
});
</script>

<script src="https://maps.googleapis.com/maps/api/js?key=${apiKey}&callback=initMap&libraries=maps,marker" async defer></script>
</body>
</html>`;
}

// ── Coordinate fallback list ──────────────────────────────────────────────────

function TrailFallback({ points }: { points: GpsPoint[] }) {
  return (
    <View style={fb.wrap}>
      <Ionicons name="navigate" size={48} color="#3B82F6" />
      <Text style={fb.title}>Trail — {points.length} GPS points</Text>
      {points.slice(0, 8).map((pt, i) => (
        <TouchableOpacity
          key={i}
          style={fb.row}
          onPress={() =>
            Linking.openURL(`https://www.google.com/maps?q=${pt.latitude},${pt.longitude}`)
          }
        >
          <View style={[fb.dot,
            i === 0 && fb.dotStart,
            i === points.length - 1 && fb.dotEnd,
          ]} />
          <Text style={fb.coord}>
            {pt.latitude.toFixed(5)}, {pt.longitude.toFixed(5)}
          </Text>
          {pt.timestamp && (
            <Text style={fb.time}>
              {new Date(pt.timestamp).toLocaleTimeString()}
            </Text>
          )}
        </TouchableOpacity>
      ))}
      {points.length > 8 && (
        <Text style={fb.more}>+ {points.length - 8} more points</Text>
      )}
    </View>
  );
}

const fb = StyleSheet.create({
  wrap:     { flex: 1, padding: 20, alignItems: 'center', backgroundColor: '#0F172A' },
  title:    { color: '#94A3B8', fontSize: 15, fontWeight: '600', marginTop: 12, marginBottom: 16 },
  row:      { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, width: '100%', borderBottomWidth: 1, borderBottomColor: '#1E293B' },
  dot:      { width: 10, height: 10, borderRadius: 5, backgroundColor: '#3B82F6' },
  dotStart: { backgroundColor: '#22C55E' },
  dotEnd:   { backgroundColor: '#EF4444' },
  coord:    { flex: 1, color: '#94A3B8', fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  time:     { color: '#475569', fontSize: 11 },
  more:     { color: '#475569', fontSize: 12, marginTop: 12 },
});

// ── Main component ────────────────────────────────────────────────────────────

export function TrailMapModal({
  visible,
  onClose,
  points,
  title,
  subtitle,
}: TrailMapModalProps) {
  const [isLoading, setIsLoading] = useState(true);
  const apiKey: string =
    (Constants.expoConfig?.extra?.googleMapsApiKey as string) ?? '';

  const openExternal = useCallback(() => {
    if (!points.length) return;
    const { latitude, longitude } = points[0];
    const url = Platform.OS === 'ios'
      ? `maps:?q=${encodeURIComponent(title || 'Trail')}&ll=${latitude},${longitude}`
      : `geo:${latitude},${longitude}?q=${latitude},${longitude}(${encodeURIComponent(title || 'Trail')})`;
    Linking.openURL(url).catch(() =>
      Linking.openURL(`https://www.google.com/maps?q=${latitude},${longitude}`)
    );
  }, [points, title]);

  const html = apiKey && points.length >= 2
    ? buildTrailHTML(apiKey, points)
    : null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View style={st.container}>
        {/* Header */}
        <View style={st.header}>
          <TouchableOpacity onPress={onClose} style={st.headerBtn}>
            <Ionicons name="close" size={26} color="#fff" />
          </TouchableOpacity>
          <View style={st.headerInfo}>
            <Text style={st.headerTitle}>{title || 'Movement Trail'}</Text>
            <Text style={st.headerSub}>
              {subtitle ?? `${points.length} GPS points`}
            </Text>
          </View>
          <TouchableOpacity onPress={openExternal} style={st.headerBtn}>
            <Ionicons name="open-outline" size={22} color="#3B82F6" />
          </TouchableOpacity>
        </View>

        {/* Map */}
        <View style={st.mapWrap}>
          {html ? (
            <>
              {isLoading && (
                <View style={st.loadingOverlay}>
                  <ActivityIndicator size="large" color="#3B82F6" />
                  <Text style={st.loadingText}>Loading Google Maps…</Text>
                </View>
              )}
              <WebView
                source={{ html }}
                style={st.webview}
                originWhitelist={['*']}
                javaScriptEnabled
                domStorageEnabled
                scrollEnabled={false}
                bounces={false}
                mixedContentMode="always"
                userAgent="Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
                onLoadEnd={() => setIsLoading(false)}
                onError={() => setIsLoading(false)}
              />
            </>
          ) : !apiKey ? (
            <View style={st.noKey}>
              <Ionicons name="key-outline" size={42} color="#EF4444" />
              <Text style={st.noKeyTitle}>Google Maps API Key Missing</Text>
              <Text style={st.noKeyText}>
                Add your key to app.config.js → extra.googleMapsApiKey
              </Text>
            </View>
          ) : (
            <TrailFallback points={points} />
          )}
        </View>

        {/* Stats */}
        {points.length >= 2 && (
          <View style={st.statsBar}>
            <View style={st.statItem}>
              <Ionicons name="location" size={15} color="#22C55E" />
              <Text style={st.statLabel}>Start</Text>
              <Text style={st.statValue}>
                {points[0].latitude.toFixed(4)}, {points[0].longitude.toFixed(4)}
              </Text>
            </View>
            <View style={st.statDivider} />
            <View style={st.statItem}>
              <Ionicons name="flag" size={15} color="#EF4444" />
              <Text style={st.statLabel}>End</Text>
              <Text style={st.statValue}>
                {points[points.length - 1].latitude.toFixed(4)},{' '}
                {points[points.length - 1].longitude.toFixed(4)}
              </Text>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#0F172A' },
  header:       {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: Platform.OS === 'ios' ? 50 : 16,
    paddingBottom: 14,
    backgroundColor: '#1E293B',
  },
  headerBtn:    { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  headerInfo:   { flex: 1, alignItems: 'center' },
  headerTitle:  { fontSize: 17, fontWeight: '700', color: '#fff' },
  headerSub:    { fontSize: 12, color: '#64748B', marginTop: 2 },
  mapWrap:      { flex: 1, position: 'relative' },
  webview:      { flex: 1, backgroundColor: '#0F172A' },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0F172A',
    justifyContent: 'center', alignItems: 'center', zIndex: 10,
  },
  loadingText:  { color: '#94A3B8', marginTop: 12, fontSize: 13 },
  statsBar:     {
    flexDirection: 'row', backgroundColor: '#1E293B', padding: 14, gap: 12,
    paddingBottom: Platform.OS === 'ios' ? 32 : 14,
  },
  statItem:     { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  statLabel:    { color: '#64748B', fontSize: 11, fontWeight: '600' },
  statValue:    { color: '#94A3B8', fontSize: 11, flex: 1 },
  statDivider:  { width: 1, backgroundColor: '#334155' },
  noKey:        { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, backgroundColor: '#0F172A' },
  noKeyTitle:   { color: '#EF4444', fontSize: 16, fontWeight: '700', marginTop: 14, marginBottom: 8 },
  noKeyText:    { color: '#64748B', fontSize: 13, textAlign: 'center', lineHeight: 20 },
});

export default TrailMapModal;
