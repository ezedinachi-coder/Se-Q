/**
 * components/NativeMap.tsx
 *
 * Native map using react-native-maps with Google Maps provider.
 *
 * WHY react-native-maps:
 *   - Full native gesture support: two-finger rotate, tilt, pinch zoom — all work
 *   - Uses Google Maps tile servers → current imagery for Nigeria/Africa
 *   - No Mapbox complexity, no separate downloads token
 *   - Autolinking handles native setup; no --clean prebuild needed
 *
 * SETUP (one-time, do not run prebuild --clean):
 *   1. yarn add react-native-maps
 *   2. Add ONE line to android/app/src/main/res/values/strings.xml:
 *        <string name="google_maps_api_key">YOUR_AIza_KEY_HERE</string>
 *   3. Add ONE meta-data entry to android/app/src/main/AndroidManifest.xml
 *      inside the <application> tag:
 *        <meta-data
 *            android:name="com.google.android.geo.API_KEY"
 *            android:value="@string/google_maps_api_key"/>
 *   4. EAS build (no prebuild needed — autolinking runs on the build server).
 *
 * PROP INTERFACE: identical to the previous Mapbox version — all screens
 * (set-location, nearby, security-map, etc.) require zero changes.
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, Platform, TouchableOpacity,
  ActivityIndicator, Linking,
} from 'react-native';
import MapView, {
  Marker, Circle, PROVIDER_GOOGLE,
  MapType, Region,
} from 'react-native-maps';
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
  /** Default: 'hybrid' — satellite with road/label overlay */
  initialMapStyle?: GoogleMapType;
}

// ── Map type → react-native-maps MapType ─────────────────────────────────────

function toRNMapType(style: GoogleMapType): MapType {
  switch (style) {
    case 'satellite': return 'satellite';
    case 'hybrid':    return 'hybrid';
    case 'terrain':   return 'terrain';
    case 'roadmap':
    default:          return 'standard';
  }
}

// ── Type toggle bar ───────────────────────────────────────────────────────────

const MAP_TYPES: { key: GoogleMapType; label: string; icon: string }[] = [
  { key: 'hybrid',    label: 'Hybrid',     icon: '🛰' },
  { key: 'satellite', label: 'Satellite',  icon: '📡' },
  { key: 'standard' as any,  label: 'Roads',  icon: '🗺' },
  { key: 'terrain',   label: 'Terrain',    icon: '🏔' },
];

function TypeBar({
  current,
  onChange,
}: {
  current: GoogleMapType;
  onChange: (t: GoogleMapType) => void;
}) {
  return (
    <View style={bar.wrap}>
      {MAP_TYPES.map((t) => {
        const active = current === t.key || (current === 'roadmap' && t.key === ('standard' as any));
        return (
          <TouchableOpacity
            key={t.key}
            style={[bar.btn, active && bar.btnActive]}
            onPress={() => onChange(t.key)}
            activeOpacity={0.75}
          >
            <Text style={[bar.label, active && bar.labelActive]}>
              {t.icon} {t.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const bar = StyleSheet.create({
  wrap: {
    position: 'absolute', top: 10, left: '50%',
    transform: [{ translateX: -110 }],
    zIndex: 10, flexDirection: 'row', gap: 4,
    backgroundColor: 'rgba(15,23,42,0.92)',
    borderRadius: 24, paddingHorizontal: 6, paddingVertical: 5,
    borderWidth: 1, borderColor: '#334155',
  },
  btn: {
    borderRadius: 18, paddingHorizontal: 9, paddingVertical: 5,
  },
  btnActive: { backgroundColor: '#2563EB' },
  label: { fontSize: 11, fontWeight: '700', color: '#64748B' },
  labelActive: { color: '#fff' },
});

// ── Coords badge ──────────────────────────────────────────────────────────────

function CoordsBadge({ lat, lng }: { lat: number; lng: number }) {
  return (
    <View style={coord.wrap} pointerEvents="none">
      <Text style={coord.text}>{lat.toFixed(4)}, {lng.toFixed(4)}</Text>
    </View>
  );
}

const coord = StyleSheet.create({
  wrap: {
    position: 'absolute', bottom: 8, left: 8, zIndex: 10,
    backgroundColor: 'rgba(15,23,42,0.82)',
    borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4,
  },
  text: { fontSize: 11, color: '#94A3B8' },
});

// ── NativeMap ─────────────────────────────────────────────────────────────────

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
  const mapRef = useRef<MapView>(null);
  const [mapType, setMapType] = useState<GoogleMapType>(initialMapStyle);
  const [ready, setReady] = useState(false);

  const lat = markerCoords?.latitude  ?? region.latitude;
  const lng = markerCoords?.longitude ?? region.longitude;

  // Build marker list
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

  // Animate to new region when it changes (after map is ready)
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    mapRef.current.animateToRegion(
      {
        latitude: region.latitude,
        longitude: region.longitude,
        latitudeDelta: region.latitudeDelta,
        longitudeDelta: region.longitudeDelta,
      },
      400,
    );
  }, [region.latitude, region.longitude, ready]);

  const handlePress = useCallback(
    (e: any) => {
      const { latitude, longitude } = e.nativeEvent.coordinate;
      onPress?.({ latitude, longitude });
      onMarkerChange?.({ latitude, longitude });
    },
    [onPress, onMarkerChange],
  );

  const handleMarkerDragEnd = useCallback(
    (e: any) => {
      const { latitude, longitude } = e.nativeEvent.coordinate;
      onPress?.({ latitude, longitude });
      onMarkerChange?.({ latitude, longitude });
    },
    [onPress, onMarkerChange],
  );

  // Web fallback — MapView not available on web
  if (Platform.OS === 'web') {
    return (
      <View style={[styles.container, style]}>
        <View style={styles.webFallback}>
          <Ionicons name="map-outline" size={48} color="#3B82F6" />
          <Text style={styles.fallbackCoords}>{lat.toFixed(6)}, {lng.toFixed(6)}</Text>
          <TouchableOpacity
            style={styles.openBtn}
            onPress={() =>
              Linking.openURL(`https://www.google.com/maps?q=${lat},${lng}`)
            }
          >
            <Ionicons name="open-outline" size={16} color="#fff" />
            <Text style={styles.openBtnText}>Open in Google Maps</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, style]}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFillObject}
        provider={PROVIDER_GOOGLE}
        mapType={toRNMapType(mapType)}
        initialRegion={{
          latitude: region.latitude,
          longitude: region.longitude,
          latitudeDelta: region.latitudeDelta,
          longitudeDelta: region.longitudeDelta,
        }}
        // Gesture controls — all enabled for full native UX
        rotateEnabled
        pitchEnabled
        zoomEnabled
        scrollEnabled
        showsCompass
        showsScale
        showsMyLocationButton={false}
        showsBuildings
        showsTraffic={false}
        // Tap handler
        onPress={handlePress}
        onMapReady={() => setReady(true)}
      >
        {/* Markers */}
        {allMarkers.map((m) => (
          <Marker
            key={m.id}
            coordinate={{ latitude: m.latitude, longitude: m.longitude }}
            title={m.title}
            description={m.description}
            pinColor={m.pinColor ?? '#3B82F6'}
            draggable={!!onMarkerChange}
            onDragEnd={handleMarkerDragEnd}
          />
        ))}

        {/* Radius circle */}
        {radiusMeters > 0 && allMarkers.length > 0 && (
          <Circle
            center={{ latitude: lat, longitude: lng }}
            radius={radiusMeters}
            strokeColor="#3B82F6"
            strokeWidth={2}
            fillColor="rgba(59,130,246,0.12)"
          />
        )}
      </MapView>

      {/* Map type toggle */}
      <TypeBar current={mapType} onChange={setMapType} />

      {/* Coords badge */}
      <CoordsBadge lat={lat} lng={lng} />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#0F172A' },
  webFallback:  {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    backgroundColor: '#0F172A', gap: 12,
  },
  fallbackCoords: { color: '#94A3B8', fontSize: 14, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  openBtn:      {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#3B82F6', paddingVertical: 10,
    paddingHorizontal: 20, borderRadius: 8, marginTop: 8,
  },
  openBtnText:  { color: '#fff', fontWeight: '600', fontSize: 14 },
});

export default NativeMap;
