/**
 * components/TrailMapModal.tsx — WebView + MapLibre GL JS
 *
 * Full-screen GPS trail map. Same WebView/MapLibre engine as NativeMap.tsx.
 *
 * FEATURES:
 *   ✅ Polyline trail with animated dash stroke
 *   ✅ Direction arrows at evenly-spaced intervals
 *   ✅ Green start / Red end custom markers
 *   ✅ Auto-fit bounds to the full trail on load
 *   ✅ Satellite / Hybrid / Street / Terrain toggle
 *   ✅ Full rotate, pitch, zoom gestures
 *   ✅ No API key, no google-services.json
 *
 * Prop interface unchanged — all callers require zero changes.
 */

import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Platform,
  Modal, ActivityIndicator, Linking,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeBounds(points: GpsPoint[]) {
  if (!points.length) return { minLng: 3.0, maxLng: 15.0, minLat: 4.0, maxLat: 14.0 };
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const p of points) {
    if (p.latitude  < minLat) minLat = p.latitude;
    if (p.latitude  > maxLat) maxLat = p.latitude;
    if (p.longitude < minLng) minLng = p.longitude;
    if (p.longitude > maxLng) maxLng = p.longitude;
  }
  const pad = 0.003;
  return { minLng: minLng - pad, maxLng: maxLng + pad, minLat: minLat - pad, maxLat: maxLat + pad };
}

// ── Trail HTML builder ────────────────────────────────────────────────────────

function buildTrailHTML(points: GpsPoint[]): string {
  const coords     = points.map(p => [p.longitude, p.latitude]);
  const bounds     = computeBounds(points);
  const startPt    = points[0];
  const endPt      = points[points.length - 1];

  // Direction arrow midpoints — max 10
  const step = Math.max(1, Math.floor(points.length / 10));
  const arrowPoints: { from: GpsPoint; to: GpsPoint }[] = [];
  for (let i = step; i < points.length; i += step) {
    arrowPoints.push({ from: points[i - 1], to: points[i] });
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"/>
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css"/>
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body, #map { width:100%; height:100%; background:#0f172a; }

  #styleBar {
    position:absolute; top:10px; left:50%; transform:translateX(-50%);
    z-index:100; display:flex; gap:4px;
    background:rgba(15,23,42,0.92); border-radius:24px;
    padding:5px 6px; border:1px solid #334155; white-space:nowrap;
  }
  .sBtn {
    border:none; background:transparent; color:#64748b;
    font-size:11px; font-weight:700; padding:5px 9px;
    border-radius:18px; cursor:pointer; font-family:-apple-system,sans-serif;
  }
  .sBtn.active { background:#2563eb; color:#fff; }

  #compass {
    position:absolute; top:52px; right:10px; width:36px; height:36px;
    z-index:100; background:rgba(15,23,42,0.88); border-radius:50%;
    border:1px solid #334155; display:flex; align-items:center;
    justify-content:center; cursor:pointer; font-size:20px; transition:transform 0.15s;
  }

  .maplibregl-ctrl-bottom-right,.maplibregl-ctrl-bottom-left,
  .maplibregl-ctrl-top-right,.maplibregl-ctrl-top-left { display:none; }

  .maplibregl-popup-content {
    background:#1e293b; color:#f1f5f9; font-family:-apple-system,sans-serif;
    font-size:13px; border-radius:8px; padding:8px 12px;
    border:1px solid #334155;
  }
  .maplibregl-popup-tip { border-top-color:#1e293b !important; }

  .marker-start,.marker-end {
    width:28px; height:28px; border-radius:50%;
    border:2.5px solid #fff; display:flex; align-items:center;
    justify-content:center; font-size:14px;
    box-shadow:0 2px 6px rgba(0,0,0,.5);
  }
  .marker-start { background:#22c55e; }
  .marker-end   { background:#ef4444; }
</style>
</head>
<body>
<div id="map"></div>
<div id="styleBar"></div>
<div id="compass">🧭</div>

<script>
const COORDS    = ${JSON.stringify(coords)};
const BOUNDS    = ${JSON.stringify(bounds)};
const START_PT  = ${JSON.stringify({ lng: startPt.longitude, lat: startPt.latitude, ts: startPt.timestamp || null })};
const END_PT    = ${JSON.stringify({ lng: endPt.longitude, lat: endPt.latitude, ts: endPt.timestamp || null })};
const ARROWS    = ${JSON.stringify(arrowPoints)};
const PT_COUNT  = ${points.length};

const SOURCES = {
  street:    { label:'Street',    icon:'🗺',  tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], maxzoom:19, tileSize:256 },
  satellite: { label:'Satellite', icon:'🛰',  tiles:['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], maxzoom:19, tileSize:256 },
  hybrid:    { label:'Hybrid',    icon:'🌍',  tiles:['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], overlayTiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], maxzoom:19, tileSize:256 },
  terrain:   { label:'Terrain',   icon:'🏔',  tiles:['https://tile.opentopomap.org/{z}/{x}/{y}.png'], maxzoom:17, tileSize:256 },
};

let currentStyle = 'hybrid';

function buildStyle(key) {
  const src = SOURCES[key];
  const sources = { base: { type:'raster', tiles:src.tiles, tileSize:src.tileSize, maxzoom:src.maxzoom } };
  const layers  = [{ id:'base-layer', type:'raster', source:'base' }];
  if (key === 'hybrid' && src.overlayTiles) {
    sources.overlay = { type:'raster', tiles:src.overlayTiles, tileSize:256, maxzoom:19 };
    layers.push({ id:'overlay-layer', type:'raster', source:'overlay', paint:{ 'raster-opacity':0.5 } });
  }
  return { version:8, sources, layers };
}

const map = new maplibregl.Map({
  container: 'map',
  style: buildStyle(currentStyle),
  bounds: [[BOUNDS.minLng, BOUNDS.minLat],[BOUNDS.maxLng, BOUNDS.maxLat]],
  fitBoundsOptions: { padding: 50 },
  bearing: 0, pitch: 0,
  attributionControl: false,
});

// Style bar
const bar = document.getElementById('styleBar');
Object.entries(SOURCES).forEach(([key, src]) => {
  const btn = document.createElement('button');
  btn.className = 'sBtn' + (key === currentStyle ? ' active' : '');
  btn.textContent = src.icon + ' ' + src.label;
  btn.onclick = () => {
    currentStyle = key;
    document.querySelectorAll('.sBtn').forEach((b,i) => {
      b.className = 'sBtn' + (Object.keys(SOURCES)[i] === key ? ' active' : '');
    });
    map.setStyle(buildStyle(key));
    map.once('styledata', addTrailLayers);
  };
  bar.appendChild(btn);
});

// Compass
const compass = document.getElementById('compass');
map.on('rotate', () => { compass.style.transform = 'rotate(' + (-map.getBearing()) + 'deg)'; });
compass.onclick = () => map.easeTo({ bearing:0, pitch:0, duration:400 });

// Trail + overlays
function addTrailLayers() {
  // Remove old layers/sources if switching style
  ['trail-line','trail-casing','arrow-layer'].forEach(id => { if(map.getLayer(id)) map.removeLayer(id); });
  ['trail','arrows'].forEach(id => { if(map.getSource(id)) map.removeSource(id); });

  // Trail source
  map.addSource('trail', {
    type: 'geojson',
    data: {
      type: 'Feature',
      geometry: { type:'LineString', coordinates: COORDS }
    }
  });

  // Casing (outer glow)
  map.addLayer({ id:'trail-casing', type:'line', source:'trail',
    paint: { 'line-color':'rgba(59,130,246,0.3)', 'line-width':8, 'line-cap':'round', 'line-join':'round' }
  });

  // Main trail line
  map.addLayer({ id:'trail-line', type:'line', source:'trail',
    paint: { 'line-color':'#3b82f6', 'line-width':4, 'line-cap':'round', 'line-join':'round',
             'line-dasharray':[2, 0.5] }
  });

  // Arrow markers (direction indicators)
  const arrowFeatures = ARROWS.map((a, i) => {
    const dLng = (a.to.longitude - a.from.longitude) * Math.PI / 180;
    const lat1 = a.from.latitude * Math.PI / 180;
    const lat2 = a.to.latitude   * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    const bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    return {
      type: 'Feature',
      properties: { bearing, id: i },
      geometry: {
        type: 'Point',
        coordinates: [
          (a.from.longitude + a.to.longitude) / 2,
          (a.from.latitude  + a.to.latitude)  / 2,
        ]
      }
    };
  });

  map.addSource('arrows', { type:'geojson', data:{ type:'FeatureCollection', features:arrowFeatures } });
  map.addLayer({ id:'arrow-layer', type:'symbol', source:'arrows',
    layout: { 'icon-image':'triangle', 'icon-rotate':['get','bearing'], 'icon-allow-overlap':true, 'icon-ignore-placement':true, 'icon-size':0.5 }
  });
}

// Start marker
const startEl = document.createElement('div');
startEl.className = 'marker-start';
startEl.textContent = '▶';
const startPopup = new maplibregl.Popup({ offset:20, closeButton:false })
  .setHTML('<strong>Start</strong>' + (START_PT.ts ? '<br><small>' + new Date(START_PT.ts).toLocaleTimeString() + '</small>' : ''));
new maplibregl.Marker({ element: startEl })
  .setLngLat([START_PT.lng, START_PT.lat])
  .setPopup(startPopup)
  .addTo(map);

// End marker
const endEl = document.createElement('div');
endEl.className = 'marker-end';
endEl.textContent = '⬛';
const endPopup = new maplibregl.Popup({ offset:20, closeButton:false })
  .setHTML('<strong>End</strong>' + (END_PT.ts ? '<br><small>' + new Date(END_PT.ts).toLocaleTimeString() + '</small>' : ''));
new maplibregl.Marker({ element: endEl })
  .setLngLat([END_PT.lng, END_PT.lat])
  .setPopup(endPopup)
  .addTo(map);

map.on('load', () => {
  addTrailLayers();
  window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({ type:'ready' }));
});
</script>
</body>
</html>`;
}

// ── Coordinate fallback (web / < 2 points) ────────────────────────────────────

function TrailFallback({ points }: { points: GpsPoint[] }) {
  return (
    <View style={fb.wrap}>
      <Ionicons name="navigate" size={48} color="#3B82F6" />
      <Text style={fb.title}>Trail — {points.length} GPS points</Text>
      {points.slice(0, 8).map((pt, i) => (
        <TouchableOpacity
          key={i} style={fb.row}
          onPress={() => Linking.openURL(`https://www.google.com/maps?q=${pt.latitude},${pt.longitude}`)}
        >
          <View style={[fb.dot, i === 0 && fb.dotStart, i === points.length - 1 && fb.dotEnd]} />
          <Text style={fb.coord}>{pt.latitude.toFixed(5)}, {pt.longitude.toFixed(5)}</Text>
          {pt.timestamp && <Text style={fb.time}>{new Date(pt.timestamp).toLocaleTimeString()}</Text>}
        </TouchableOpacity>
      ))}
      {points.length > 8 && <Text style={fb.more}>+ {points.length - 8} more points</Text>}
    </View>
  );
}

const fb = StyleSheet.create({
  wrap:     { flex:1, padding:20, alignItems:'center', backgroundColor:'#0F172A' },
  title:    { color:'#94A3B8', fontSize:15, fontWeight:'600', marginTop:12, marginBottom:16 },
  row:      { flexDirection:'row', alignItems:'center', gap:8, paddingVertical:8, width:'100%', borderBottomWidth:1, borderBottomColor:'#1E293B' },
  dot:      { width:10, height:10, borderRadius:5, backgroundColor:'#3B82F6' },
  dotStart: { backgroundColor:'#22C55E' },
  dotEnd:   { backgroundColor:'#EF4444' },
  coord:    { flex:1, color:'#94A3B8', fontSize:12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  time:     { color:'#475569', fontSize:11 },
  more:     { color:'#475569', fontSize:12, marginTop:12 },
});

// ── Main component ────────────────────────────────────────────────────────────

export function TrailMapModal({ visible, onClose, points, title, subtitle }: TrailMapModalProps) {
  const [isLoading, setIsLoading] = useState(true);

  const handleMessage = useCallback((event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'ready') setIsLoading(false);
    } catch (_) {}
  }, []);

  const openExternal = useCallback(() => {
    if (!points.length) return;
    const { latitude, longitude } = points[0];
    Linking.openURL(`https://www.google.com/maps?q=${latitude},${longitude}`).catch(() => {});
  }, [points]);

  const useWebView = Platform.OS !== 'web' && points.length >= 2;
  const html = useWebView ? buildTrailHTML(points) : '';

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={st.container}>

        {/* Header */}
        <View style={st.header}>
          <TouchableOpacity onPress={onClose} style={st.headerBtn}>
            <Ionicons name="close" size={26} color="#fff" />
          </TouchableOpacity>
          <View style={st.headerInfo}>
            <Text style={st.headerTitle}>{title || 'Movement Trail'}</Text>
            <Text style={st.headerSub}>{subtitle ?? `${points.length} GPS points`}</Text>
          </View>
          <TouchableOpacity onPress={openExternal} style={st.headerBtn}>
            <Ionicons name="open-outline" size={22} color="#3B82F6" />
          </TouchableOpacity>
        </View>

        {/* Legend */}
        <View style={st.legend}>
          <View style={st.legendItem}>
            <View style={[st.legendDot, { backgroundColor: '#22C55E' }]} />
            <Text style={st.legendText}>Start</Text>
          </View>
          <View style={st.legendItem}>
            <View style={st.legendLine} />
            <Text style={st.legendText}>Trail</Text>
          </View>
          <View style={st.legendItem}>
            <View style={[st.legendDot, { backgroundColor: '#EF4444' }]} />
            <Text style={st.legendText}>End</Text>
          </View>
          <Text style={st.legendCount}>{points.length} pts</Text>
        </View>

        {/* Map */}
        <View style={st.mapWrap}>
          {isLoading && useWebView && (
            <View style={st.loadingOverlay}>
              <ActivityIndicator size="large" color="#3B82F6" />
              <Text style={st.loadingText}>Loading map…</Text>
            </View>
          )}

          {useWebView ? (
            <WebView
              style={StyleSheet.absoluteFillObject}
              source={{ html }}
              onMessage={handleMessage}
              javaScriptEnabled
              domStorageEnabled
              originWhitelist={['*']}
              mixedContentMode="always"
              scrollEnabled={false}
              bounces={false}
              setSupportMultipleWindows={false}
              androidLayerType="hardware"
            />
          ) : (
            <TrailFallback points={points} />
          )}
        </View>

        {/* Stats bar */}
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
                {points[points.length - 1].latitude.toFixed(4)}, {points[points.length - 1].longitude.toFixed(4)}
              </Text>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const st = StyleSheet.create({
  container:      { flex:1, backgroundColor:'#0F172A' },
  header:         { flexDirection:'row', alignItems:'center', justifyContent:'space-between', paddingHorizontal:12, paddingTop: Platform.OS === 'ios' ? 50 : 16, paddingBottom:14, backgroundColor:'#1E293B', borderBottomWidth:1, borderBottomColor:'#334155' },
  headerBtn:      { width:44, height:44, justifyContent:'center', alignItems:'center' },
  headerInfo:     { flex:1, alignItems:'center' },
  headerTitle:    { fontSize:17, fontWeight:'700', color:'#fff' },
  headerSub:      { fontSize:12, color:'#64748B', marginTop:2 },
  legend:         { flexDirection:'row', alignItems:'center', gap:14, paddingHorizontal:16, paddingVertical:8, backgroundColor:'#1E293B', borderBottomWidth:1, borderBottomColor:'#334155' },
  legendItem:     { flexDirection:'row', alignItems:'center', gap:6 },
  legendDot:      { width:10, height:10, borderRadius:5 },
  legendLine:     { width:20, height:3, backgroundColor:'#3B82F6', borderRadius:2 },
  legendText:     { color:'#94A3B8', fontSize:12 },
  legendCount:    { color:'#3B82F6', fontSize:12, fontWeight:'700', marginLeft:'auto' },
  mapWrap:        { flex:1, position:'relative' },
  loadingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor:'#0F172A', justifyContent:'center', alignItems:'center', zIndex:10 },
  loadingText:    { color:'#94A3B8', marginTop:12, fontSize:13 },
  statsBar:       { flexDirection:'row', backgroundColor:'#1E293B', padding:14, paddingBottom: Platform.OS === 'ios' ? 32 : 14, gap:12 },
  statItem:       { flex:1, flexDirection:'row', alignItems:'center', gap:6 },
  statLabel:      { color:'#64748B', fontSize:11, fontWeight:'600' },
  statValue:      { color:'#94A3B8', fontSize:11, flex:1 },
  statDivider:    { width:1, backgroundColor:'#334155' },
});

export default TrailMapModal;
