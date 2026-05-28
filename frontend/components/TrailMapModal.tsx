/**
 * components/TrailMapModal.tsx
 *
 * Full-screen trail map using react-native-maps + Google Maps provider.
 * Renders a GPS movement trail as a polyline with direction arrows,
 * start/end markers, auto-fit bounds, and full native gesture support
 * (rotate, tilt, pinch-zoom).
 *
 * Prop interface is identical to the previous Mapbox version.
 * All callers (admin/panics, admin/escort-sessions, security/escort-sessions)
 * require zero changes.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Platform,
  Modal, ActivityIndicator, Linking,
} from 'react-native';
import MapView, {
  Marker, Polyline, PROVIDER_GOOGLE,
} from 'react-native-maps';
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

// ── Bounding region ───────────────────────────────────────────────────────────

function computeRegion(points: GpsPoint[]) {
  if (!points.length) {
    // Default to Nigeria center
    return { latitude: 9.082, longitude: 8.6753, latitudeDelta: 5, longitudeDelta: 5 };
  }

  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const p of points) {
    if (p.latitude  < minLat) minLat = p.latitude;
    if (p.latitude  > maxLat) maxLat = p.latitude;
    if (p.longitude < minLng) minLng = p.longitude;
    if (p.longitude > maxLng) maxLng = p.longitude;
  }

  const latPad = Math.max((maxLat - minLat) * 0.25, 0.005);
  const lngPad = Math.max((maxLng - minLng) * 0.25, 0.005);

  return {
    latitude:      (minLat + maxLat) / 2,
    longitude:     (minLng + maxLng) / 2,
    latitudeDelta:  (maxLat - minLat) + latPad * 2,
    longitudeDelta: (maxLng - minLng) + lngPad * 2,
  };
}

// ── Direction arrows ──────────────────────────────────────────────────────────
// Placed at evenly-spaced intervals along the trail.

function ArrowMarker({
  from,
  to,
}: {
  from: GpsPoint;
  to: GpsPoint;
}) {
  // Bearing in degrees
  const dLng = (to.longitude - from.longitude) * (Math.PI / 180);
  const lat1 = from.latitude * (Math.PI / 180);
  const lat2 = to.latitude   * (Math.PI / 180);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;

  // Midpoint
  const midLat = (from.latitude  + to.latitude)  / 2;
  const midLng = (from.longitude + to.longitude) / 2;

  return (
    <Marker
      coordinate={{ latitude: midLat, longitude: midLng }}
      anchor={{ x: 0.5, y: 0.5 }}
      flat
      tracksViewChanges={false}
    >
      <View style={[arrow.wrap, { transform: [{ rotate: `${bearing}deg` }] }]}>
        <View style={arrow.triangle} />
      </View>
    </Marker>
  );
}

const arrow = StyleSheet.create({
  wrap:     { width: 16, height: 16, justifyContent: 'center', alignItems: 'center' },
  triangle: {
    width: 0, height: 0,
    borderLeftWidth: 5, borderRightWidth: 5, borderBottomWidth: 10,
    borderLeftColor: 'transparent', borderRightColor: 'transparent',
    borderBottomColor: '#3B82F6',
    opacity: 0.9,
  },
});

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
            Linking.openURL(
              `https://www.google.com/maps?q=${pt.latitude},${pt.longitude}`,
            )
          }
        >
          <View style={[
            fb.dot,
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
  row:      {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 8, width: '100%',
    borderBottomWidth: 1, borderBottomColor: '#1E293B',
  },
  dot:      { width: 10, height: 10, borderRadius: 5, backgroundColor: '#3B82F6' },
  dotStart: { backgroundColor: '#22C55E' },
  dotEnd:   { backgroundColor: '#EF4444' },
  coord:    {
    flex: 1, color: '#94A3B8', fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
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
  const mapRef = useRef<MapView>(null);
  const [mapReady, setMapReady] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Derive stable region and coordinate arrays once
  const region      = computeRegion(points);
  const coordinates = points.map((p) => ({
    latitude:  p.latitude,
    longitude: p.longitude,
  }));

  // Fit map to trail once it's ready
  useEffect(() => {
    if (!mapReady || coordinates.length < 2 || !mapRef.current) return;
    const timer = setTimeout(() => {
      try {
        mapRef.current?.fitToCoordinates(coordinates, {
          edgePadding: { top: 60, right: 30, bottom: 60, left: 30 },
          animated: true,
        });
      } catch (_) {}
    }, 350);
    return () => clearTimeout(timer);
  }, [mapReady]);

  const handleMapReady = useCallback(() => {
    setMapReady(true);
    setIsLoading(false);
  }, []);

  const openExternal = useCallback(() => {
    if (!points.length) return;
    const { latitude, longitude } = points[0];
    const url =
      Platform.OS === 'ios'
        ? `maps:?q=${encodeURIComponent(title || 'Trail')}&ll=${latitude},${longitude}`
        : `geo:${latitude},${longitude}?q=${latitude},${longitude}(${encodeURIComponent(title || 'Trail')})`;
    Linking.openURL(url).catch(() =>
      Linking.openURL(
        `https://www.google.com/maps?q=${latitude},${longitude}`,
      ),
    );
  }, [points, title]);

  // Evenly-spaced arrow indices (max 12 arrows regardless of trail length)
  const arrowIndices: number[] = [];
  if (points.length >= 2) {
    const step = Math.max(1, Math.floor(points.length / Math.min(12, points.length)));
    for (let i = step; i < points.length; i += step) {
      arrowIndices.push(i);
    }
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View style={st.container}>

        {/* ── Header ── */}
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

        {/* ── Legend ── */}
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

        {/* ── Map ── */}
        <View style={st.mapWrap}>
          {/* Loading overlay */}
          {isLoading && (
            <View style={st.loadingOverlay}>
              <ActivityIndicator size="large" color="#3B82F6" />
              <Text style={st.loadingText}>Loading map…</Text>
            </View>
          )}

          {points.length >= 2 && Platform.OS !== 'web' ? (
            <MapView
              ref={mapRef}
              style={StyleSheet.absoluteFillObject}
              provider={PROVIDER_GOOGLE}
              mapType="hybrid"
              initialRegion={region}
              rotateEnabled
              pitchEnabled
              zoomEnabled
              scrollEnabled
              showsCompass
              onMapReady={handleMapReady}
            >
              {/* Trail polyline */}
              <Polyline
                coordinates={coordinates}
                strokeColor="#3B82F6"
                strokeWidth={4}
                lineDashPattern={[12, 6]}
                geodesic
              />

              {/* Direction arrows */}
              {arrowIndices.map((i) => (
                <ArrowMarker
                  key={`arrow-${i}`}
                  from={points[i - 1]}
                  to={points[i]}
                />
              ))}

              {/* Start marker */}
              <Marker
                coordinate={{
                  latitude:  points[0].latitude,
                  longitude: points[0].longitude,
                }}
                title="Start"
                description={
                  points[0].timestamp
                    ? new Date(points[0].timestamp).toLocaleString()
                    : undefined
                }
                tracksViewChanges={false}
              >
                <View style={mk.start}>
                  <Ionicons name="flag" size={16} color="#fff" />
                </View>
              </Marker>

              {/* End marker */}
              <Marker
                coordinate={{
                  latitude:  points[points.length - 1].latitude,
                  longitude: points[points.length - 1].longitude,
                }}
                title="End"
                description={
                  points[points.length - 1].timestamp
                    ? new Date(points[points.length - 1].timestamp).toLocaleString()
                    : undefined
                }
                tracksViewChanges={false}
              >
                <View style={mk.end}>
                  <Ionicons name="location" size={16} color="#fff" />
                </View>
              </Marker>
            </MapView>
          ) : (
            <TrailFallback points={points} />
          )}
        </View>

        {/* ── Stats bar ── */}
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

// ── Styles ────────────────────────────────────────────────────────────────────

const st = StyleSheet.create({
  container:      { flex: 1, backgroundColor: '#0F172A' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: Platform.OS === 'ios' ? 50 : 16,
    paddingBottom: 14,
    backgroundColor: '#1E293B',
    borderBottomWidth: 1, borderBottomColor: '#334155',
  },
  headerBtn:      { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  headerInfo:     { flex: 1, alignItems: 'center' },
  headerTitle:    { fontSize: 17, fontWeight: '700', color: '#fff' },
  headerSub:      { fontSize: 12, color: '#64748B', marginTop: 2 },
  legend: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 16, paddingVertical: 8,
    backgroundColor: '#1E293B',
    borderBottomWidth: 1, borderBottomColor: '#334155',
  },
  legendItem:     { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot:      { width: 10, height: 10, borderRadius: 5 },
  legendLine:     { width: 20, height: 3, backgroundColor: '#3B82F6', borderRadius: 2 },
  legendText:     { color: '#94A3B8', fontSize: 12 },
  legendCount:    { color: '#3B82F6', fontSize: 12, fontWeight: '700', marginLeft: 'auto' },
  mapWrap:        { flex: 1, position: 'relative' },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0F172A',
    justifyContent: 'center', alignItems: 'center', zIndex: 10,
  },
  loadingText:    { color: '#94A3B8', marginTop: 12, fontSize: 13 },
  statsBar: {
    flexDirection: 'row',
    backgroundColor: '#1E293B',
    padding: 14,
    paddingBottom: Platform.OS === 'ios' ? 32 : 14,
    gap: 12,
  },
  statItem:       { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  statLabel:      { color: '#64748B', fontSize: 11, fontWeight: '600' },
  statValue:      { color: '#94A3B8', fontSize: 11, flex: 1 },
  statDivider:    { width: 1, backgroundColor: '#334155' },
});

// ── Marker styles ─────────────────────────────────────────────────────────────

const mk = StyleSheet.create({
  start: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: '#22C55E',
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2.5, borderColor: '#fff',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4, shadowRadius: 4, elevation: 6,
  },
  end: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: '#EF4444',
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2.5, borderColor: '#fff',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4, shadowRadius: 4, elevation: 6,
  },
});

export default TrailMapModal;
