/**
 * components/TrailMapModal.tsx
 *
 * Full-screen map modal that renders a movement trail as a dashed polyline
 * with direction arrows and auto-fit bounds. Used by admin panics and escort
 * sessions to visualize the full GPS path.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Platform,
  Modal, ActivityIndicator, Linking, Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import BACKEND_URL from '../config/mapbox';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// ── Coordinate types ──────────────────────────────────────────────────────────
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

// ── Mapbox import (lazy, with graceful fallback) ─────────────────────────────
let Mapbox: any = null;
let MapView: any = null;
let Camera: any = null;
let ShapeSource: any = null;
let LineLayer: any = null;
let MarkerView: any = null;
let GeoJSON: any = null;
let mapboxLoaded = false;
let mapboxLoadError: string | null = null;

try {
  const rnmapbox = require('@rnmapbox/maps');
  Mapbox      = rnmapbox.default;
  MapView     = rnmapbox.MapView;
  Camera      = rnmapbox.Camera;
  ShapeSource = rnmapbox.ShapeSource;
  LineLayer   = rnmapbox.LineLayer;
  MarkerView  = rnmapbox.MarkerView;
  GeoJSON     = (global as any).GeoJSON;
  mapboxLoaded = true;
} catch (e: any) {
  mapboxLoadError = e?.message ?? 'Failed to load Mapbox';
  console.error('[TrailMapModal] Mapbox require failed:', mapboxLoadError);
}

// Set Mapbox token if available
const MAPBOX_TOKEN = (BACKEND_URL as any)?.MAPBOX_TOKEN || '';
if (Mapbox && MAPBOX_TOKEN) {
  try { Mapbox.setAccessToken(MAPBOX_TOKEN); } catch (_) {}
}

// ── Compute bounding box & center ────────────────────────────────────────────
function computeBounds(points: GpsPoint[]) {
  if (!points || points.length === 0) {
    return { center: [0, 0] as [number, number], padding: 80 };
  }

  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const pt of points) {
    if (pt.latitude  < minLat)  minLat  = pt.latitude;
    if (pt.latitude  > maxLat)  maxLat  = pt.latitude;
    if (pt.longitude < minLng)  minLng  = pt.longitude;
    if (pt.longitude > maxLng)  maxLng  = pt.longitude;
  }

  const centerLat = (minLat + maxLat) / 2;
  const centerLng = (minLng + maxLng) / 2;
  const latSpan   = maxLat - minLat;
  const lngSpan   = maxLng - minLng;

  // Add 20% padding around the trail
  const padding = Math.max(latSpan, lngSpan) * 0.3;

  return {
    center: [centerLng, centerLat] as [number, number],
    padding: Math.max(60, padding * 111000), // rough meters conversion
  };
}

// ── Trail line GeoJSON ────────────────────────────────────────────────────────
function buildTrailGeoJSON(points: GpsPoint[]): any {
  if (!points || points.length < 2) return null;

  const coordinates = points.map(p => [p.longitude, p.latitude]);

  return {
    type: 'FeatureCollection',
    features: [
      // Main dashed trail line
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates },
      },
      // Arrow markers at intervals (every 3rd point for clarity)
      ...points.filter((_, i) => i > 0 && i % 3 === 0).map((pt, idx) => ({
        type: 'Feature',
        properties: { index: idx },
        geometry: { type: 'Point', coordinates: [pt.longitude, pt.latitude] },
      })),
    ],
  };
}

// ── Map Trail layer (uses Mapbox if available) ───────────────────────────────
function TrailMapboxLayer({
  points,
  autoFit,
}: {
  points: GpsPoint[];
  autoFit: boolean;
}) {
  const [mapLoaded, setMapLoaded] = useState(false);
  const mapRef = useRef<any>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const bounds = computeBounds(points);
  const geojson = buildTrailGeoJSON(points);
  const trailCoords = points.map(p => [p.longitude, p.latitude]);

  // Timeout fallback
  useEffect(() => {
    setMapLoaded(false);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setMapLoaded(true), 8000);
    return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); };
  }, [points]);

  const handleStyleLoad = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setMapLoaded(true);

    // Auto-fit to trail bounds
    if (autoFit && mapRef.current && trailCoords.length > 0) {
      setTimeout(() => {
        try {
          mapRef.current.fitBounds(
            [bounds.center[0] - (bounds.padding / 111000), bounds.center[1] - (bounds.padding / 111000)],
            [bounds.center[0] + (bounds.padding / 111000), bounds.center[1] + (bounds.padding / 111000)],
            [60, 60, 60, 60],
            1000
          );
        } catch (e) { console.warn('[TrailMap] fitBounds failed:', e); }
      }, 300);
    }
  };

  if (!mapboxLoaded) {
    return <TrailFallback points={points} />;
  }

  return (
    <MapView
      ref={mapRef}
      style={styles.map}
      styleURL="mapbox://styles/mapbox/satellite-streets-v12"
      surfaceView={true}
      onStyleLoad={handleStyleLoad}
      rotateEnabled={true}
      pitchEnabled={true}
      compassEnabled={true}
      logoEnabled={false}
      attributionEnabled={false}
    >
      <Camera
        defaultSettings={{
          centerCoordinate: bounds.center,
          zoomLevel: 14,
          pitch: 45,
          bearing: 0,
        }}
      />

      {/* Dashed trail line */}
      {geojson && (
        <ShapeSource id="trail" shape={geojson.features[0]}>
          <LineLayer
            id="trail-line"
            style={{
              lineColor: '#3B82F6',
              lineWidth: 4,
              lineDasharray: [3, 2],
              lineOpacity: 0.9,
            }}
          />
        </ShapeSource>
      )}

      {/* Direction arrows (triangle markers on trail) */}
      {points.map((pt, idx) => {
        if (idx === 0) return null;
        // Draw a small arrow marker every 3 points
        if (idx % 3 !== 0) return null;
        return (
          <MarkerView
            key={`arrow-${idx}`}
            coordinate={[pt.longitude, pt.latitude]}
            anchor={{ x: 0.5, y: 0.5 }}
          >
            <View style={arrowStyles.container}>
              <View style={arrowStyles.triangle} />
            </View>
          </MarkerView>
        );
      })}

      {/* Start marker (green) */}
      {points.length > 0 && (
        <MarkerView
          coordinate={[points[0].longitude, points[0].latitude]}
          anchor={{ x: 0.5, y: 0.5 }}
        >
          <View style={markerStyles.start}>
            <Ionicons name="flag" size={22} color="white" />
          </View>
        </MarkerView>
      )}

      {/* End marker (red) */}
      {points.length > 1 && (
        <MarkerView
          coordinate={[
            points[points.length - 1].longitude,
            points[points.length - 1].latitude,
          ]}
          anchor={{ x: 0.5, y: 0.5 }}
        >
          <View style={markerStyles.end}>
            <Ionicons name="location" size={22} color="white" />
          </View>
        </MarkerView>
      )}
    </MapView>
  );
}

// ── Web / Fallback trail (static map + coordinate list) ─────────────────────
function TrailFallback({ points }: { points: GpsPoint[] }) {
  const formatCoord = (pt: GpsPoint) => `${pt.latitude.toFixed(6)}, ${pt.longitude.toFixed(6)}`;

  return (
    <View style={styles.fallback}>
      <View style={styles.fallbackIcon}>
        <Ionicons name="navigate" size={60} color="#3B82F6" />
      </View>
      <Text style={styles.fallbackTitle}>Trail Map</Text>
      <Text style={styles.fallbackSub}>{points.length} GPS points</Text>

      <View style={styles.fallbackList}>
        {points.map((pt, i) => (
          <View key={i} style={styles.fallbackRow}>
            <View style={[styles.fallbackDot, i === 0 && styles.fallbackDotStart, i === points.length - 1 && styles.fallbackDotEnd]} />
            <View style={styles.fallbackContent}>
              <Text style={styles.fallbackCoords}>{formatCoord(pt)}</Text>
              {pt.timestamp && (
                <Text style={styles.fallbackTime}>
                  {new Date(pt.timestamp).toLocaleString()}
                </Text>
              )}
            </View>
            <TouchableOpacity
              onPress={() => Linking.openURL(`https://www.google.com/maps?q=${pt.latitude},${pt.longitude}`)}
              style={styles.fallbackMapBtn}
            >
              <Ionicons name="map" size={16} color="#3B82F6" />
            </TouchableOpacity>
          </View>
        ))}
      </View>
    </View>
  );
}

// ── Web trail with Leaflet (if on web and we can use WebView) ─────────────────
function WebLeafletTrail({ points }: { points: GpsPoint[] }) {
  if (points.length < 2) return <TrailFallback points={points} />;

  const bounds = computeBounds(points);
  const padding = bounds.padding / 111000;

  // Build polyline encoded coordinates for URL
  const encodedPath = points
    .map(p => `${p.latitude},${p.longitude}`)
    .join('|');

  const mapsUrl = `https://www.google.com/maps/dir/?api=1&travelmode=driving&dir_action=interpolate`;

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0F172A' }}>
      <Ionicons name="map" size={80} color="#3B82F6" />
      <Text style={{ color: '#fff', fontSize: 18, marginTop: 16, fontWeight: '600' }}>
        Trail Map — {points.length} points
      </Text>
      <Text style={{ color: '#94A3B8', fontSize: 14, marginTop: 8 }}>
        {points[0].latitude.toFixed(4)}, {points[0].longitude.toFixed(4)}
        {' → '}
        {points[points.length - 1].latitude.toFixed(4)}, {points[points.length - 1].longitude.toFixed(4)}
      </Text>

      <TouchableOpacity
        style={styles.openMapsBtn}
        onPress={() => {
          const url = `https://www.google.com/maps/dir/${points.map(p => `${p.latitude},${p.longitude}`).join('/')}`;
          Linking.openURL(url).catch(() => {});
        }}
      >
        <Ionicons name="open-outline" size={18} color="#fff" />
        <Text style={styles.openMapsBtnText}>Open in Google Maps</Text>
      </TouchableOpacity>

      <View style={{ marginTop: 24, paddingHorizontal: 16, width: '100%' }}>
        {points.slice(0, 5).map((pt, i) => (
          <View key={i} style={styles.fallbackRow}>
            <View style={[styles.fallbackDot, i === 0 && styles.fallbackDotStart, i === points.length - 1 && styles.fallbackDotEnd]} />
            <View style={styles.fallbackContent}>
              <Text style={styles.fallbackCoords}>{pt.latitude.toFixed(5)}, {pt.longitude.toFixed(5)}</Text>
              {pt.timestamp && <Text style={styles.fallbackTime}>{new Date(pt.timestamp).toLocaleTimeString()}</Text>}
            </View>
          </View>
        ))}
        {points.length > 5 && (
          <Text style={{ color: '#64748B', textAlign: 'center', marginTop: 8 }}>
            + {points.length - 5} more points
          </Text>
        )}
      </View>
    </View>
  );
}

// ── Main TrailMapModal export ────────────────────────────────────────────────
export function TrailMapModal({
  visible,
  onClose,
  points,
  title = 'Movement Trail',
  subtitle,
}: TrailMapModalProps) {
  const [mapLoading, setMapLoading] = useState(true);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!visible) { setMapLoading(true); return; }
    const t = setTimeout(() => {
      if (isMountedRef.current) setMapLoading(false);
    }, 6000);
    return () => clearTimeout(t);
  }, [visible]);

  const openExternalMaps = () => {
    if (!points || points.length === 0) return;
    const first = points[0];
    const last  = points[points.length - 1];
    const waypoints = points.map(p => `${p.latitude},${p.longitude}`).join('/');
    const url = `https://www.google.com/maps/dir/${waypoints}`;
    Linking.openURL(url).catch(() => {
      Linking.openURL(`https://www.google.com/maps?q=${first.latitude},${first.longitude}`);
    });
  };

  // Web: show Leaflet-style fallback
  if (Platform.OS === 'web') {
    return (
      <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
        <View style={styles.container}>
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Ionicons name="close" size={28} color="#fff" />
            </TouchableOpacity>
            <View style={styles.headerInfo}>
              <Text style={styles.headerTitle}>{title}</Text>
              {subtitle && <Text style={styles.headerSubtitle}>{subtitle}</Text>}
            </View>
            <TouchableOpacity onPress={openExternalMaps} style={styles.closeButton}>
              <Ionicons name="open-outline" size={24} color="#3B82F6" />
            </TouchableOpacity>
          </View>
          <WebLeafletTrail points={points} />
        </View>
      </Modal>
    );
  }

  // Native: show Mapbox trail
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Ionicons name="close" size={28} color="#fff" />
          </TouchableOpacity>
          <View style={styles.headerInfo}>
            <Text style={styles.headerTitle}>{title}</Text>
            {subtitle && <Text style={styles.headerSubtitle}>{subtitle}</Text>}
          </View>
          <TouchableOpacity onPress={openExternalMaps} style={styles.closeButton}>
            <Ionicons name="open-outline" size={24} color="#3B82F6" />
          </TouchableOpacity>
        </View>

        {/* Legend bar */}
        <View style={styles.legendBar}>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#10B981' }]} />
            <Text style={styles.legendText}>Start</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendLine]} />
            <Text style={styles.legendText}>Trail</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#EF4444' }]} />
            <Text style={styles.legendText}>End</Text>
          </View>
          <Text style={styles.legendCount}>{points.length} points</Text>
        </View>

        <View style={styles.mapContainer}>
          {mapLoading && (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator size="large" color="#3B82F6" />
              <Text style={styles.loadingText}>Loading trail map…</Text>
            </View>
          )}

          {mapboxLoaded ? (
            <TrailMapboxLayer points={points} autoFit={true} />
          ) : (
            <TrailFallback points={points} />
          )}
        </View>

        {/* Bottom info */}
        {points.length > 0 && (
          <View style={styles.bottomInfo}>
            <View style={styles.coordsCard}>
              <View style={styles.coordRow}>
                <View style={[styles.coordDot, { backgroundColor: '#10B981' }]} />
                <View>
                  <Text style={styles.coordLabel}>Start</Text>
                  <Text style={styles.coordValue}>
                    {points[0].latitude.toFixed(6)}, {points[0].longitude.toFixed(6)}
                  </Text>
                </View>
              </View>

              <View style={styles.coordDivider} />

              <View style={styles.coordRow}>
                <View style={[styles.coordDot, { backgroundColor: '#EF4444' }]} />
                <View>
                  <Text style={styles.coordLabel}>End</Text>
                  <Text style={styles.coordValue}>
                    {points[points.length - 1].latitude.toFixed(6)}, {points[points.length - 1].longitude.toFixed(6)}
                  </Text>
                </View>
              </View>

              <TouchableOpacity onPress={openExternalMaps} style={styles.openMapsCircle}>
                <Ionicons name="navigate" size={20} color="#3B82F6" />
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container:       { flex: 1, backgroundColor: '#0F172A' },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingTop: Platform.OS === 'ios' ? 50 : 16, paddingBottom: 12,
    backgroundColor: '#1E293B',
    borderBottomWidth: 1, borderBottomColor: '#334155',
  },
  closeButton:  { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  headerInfo:   { flex: 1, alignItems: 'center' },
  headerTitle:  { fontSize: 18, fontWeight: '600', color: '#fff' },
  headerSubtitle: { fontSize: 14, color: '#94A3B8', marginTop: 2 },

  legendBar: {
    flexDirection: 'row', alignItems: 'center', gap: 16,
    paddingHorizontal: 16, paddingVertical: 8,
    backgroundColor: '#1E293B',
    borderBottomWidth: 1, borderBottomColor: '#334155',
  },
  legendItem:   { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot:    { width: 10, height: 10, borderRadius: 5 },
  legendLine:   { width: 20, height: 3, backgroundColor: '#3B82F6', borderRadius: 2 },
  legendText:   { color: '#94A3B8', fontSize: 12 },
  legendCount:  { color: '#3B82F6', fontSize: 12, fontWeight: '700', marginLeft: 'auto' },

  mapContainer:  { flex: 1, position: 'relative' },
  map:           { flex: 1 },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject, backgroundColor: '#0F172A',
    justifyContent: 'center', alignItems: 'center', zIndex: 10,
  },
  loadingText:  { color: '#94A3B8', marginTop: 12, fontSize: 14 },

  fallback:     { flex: 1, paddingHorizontal: 16, paddingTop: 24 },
  fallbackIcon: { alignItems: 'center', paddingVertical: 24 },
  fallbackTitle:{ color: '#fff', fontSize: 20, fontWeight: '700', textAlign: 'center' },
  fallbackSub:  { color: '#94A3B8', fontSize: 14, textAlign: 'center', marginTop: 4 },
  fallbackList: { marginTop: 24, gap: 8 },
  fallbackRow:  { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#1E293B', padding: 12, borderRadius: 8 },
  fallbackDot:  { width: 10, height: 10, borderRadius: 5, backgroundColor: '#334155' },
  fallbackDotStart: { backgroundColor: '#10B981' },
  fallbackDotEnd:   { backgroundColor: '#EF4444' },
  fallbackContent:  { flex: 1 },
  fallbackCoords:    { color: '#E2E8F0', fontSize: 13, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  fallbackTime:      { color: '#64748B', fontSize: 11, marginTop: 2 },
  fallbackMapBtn: { padding: 6 },

  openMapsBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#3B82F6', paddingVertical: 12, paddingHorizontal: 24,
    borderRadius: 8, marginTop: 24,
  },
  openMapsBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },

  bottomInfo:   { backgroundColor: '#1E293B', padding: 16, paddingBottom: Platform.OS === 'ios' ? 34 : 16 },
  coordsCard:   { flexDirection: 'row', alignItems: 'center', gap: 16, backgroundColor: '#0F172A', padding: 16, borderRadius: 12 },
  coordRow:     { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  coordDot:     { width: 12, height: 12, borderRadius: 6 },
  coordLabel:   { color: '#64748B', fontSize: 11 },
  coordValue:   { color: '#E2E8F0', fontSize: 12, marginTop: 2, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  coordDivider: { width: 1, height: 40, backgroundColor: '#334155' },
  openMapsCircle:{ width: 44, height: 44, borderRadius: 22, backgroundColor: '#3B82F620', justifyContent: 'center', alignItems: 'center' },
});

// ── Arrow marker styles ───────────────────────────────────────────────────────
const arrowStyles = StyleSheet.create({
  container: { width: 20, height: 20, justifyContent: 'center', alignItems: 'center' },
  triangle:   {
    width: 0, height: 0,
    borderLeftWidth: 7, borderRightWidth: 7,
    borderTopWidth: 12,
    borderLeftColor: 'transparent', borderRightColor: 'transparent',
    borderTopColor: '#3B82F6',
  },
});

// ── Start / End marker styles ─────────────────────────────────────────────────
const markerStyles = StyleSheet.create({
  start: {
    backgroundColor: '#10B981',
    width: 32, height: 32, borderRadius: 16,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 3, borderColor: 'white',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4, shadowRadius: 4, elevation: 6,
  },
  end: {
    backgroundColor: '#EF4444',
    width: 32, height: 32, borderRadius: 16,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 3, borderColor: 'white',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4, shadowRadius: 4, elevation: 6,
  },
});