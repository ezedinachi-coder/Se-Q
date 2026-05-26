import React, { useState, useRef, useEffect, Component, ErrorInfo, ReactNode } from 'react';
import { View, StyleSheet, Platform, Text, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Linking } from 'react-native';

// Timeout for map loading (ms)
const MAP_TIMEOUT = 8000;

// ── Error Boundary ────────────────────────────────────────────────────────────
// FIX (Mapbox crash): @rnmapbox/maps throws a native ExceptionInInitializerError
// when the Mapbox common .so symbols can't be resolved. Wrapping in an Error Boundary
// means the crash is caught at the React layer and a graceful fallback is shown
// instead of the whole app closing. Once the native build is clean (build.gradle fix),
// this boundary will never trigger in production — but it prevents catastrophic
// failure on mis-matched builds.
interface BoundaryProps { children: ReactNode; lat: number; lng: number; }
interface BoundaryState { hasError: boolean; error: string | null; }
class MapErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error): BoundaryState {
    return { hasError: true, error: error.message };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[NativeMap] Error boundary caught:', error.message, info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      const { lat, lng } = this.props;
      return (
        <View style={styles.errorFallback}>
          <Ionicons name="map-outline" size={48} color="#3B82F6" />
          <Text style={styles.errorTitle}>Map unavailable</Text>
          <Text style={styles.errorCoords}>{lat.toFixed(6)}, {lng.toFixed(6)}</Text>
          <Text style={styles.errorHint}>
            If this persists, rebuild the app — a native library version mismatch was detected.
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

// ── Lazy-load Mapbox so the import error is caught by the boundary, not at module level ──
let Mapbox: any = null;
let MapView: any = null;
let Camera: any = null;
let ShapeSource: any = null;
let CircleLayer: any = null;
let MarkerView: any = null;
let mapboxLoaded = false;
let mapboxLoadError: string | null = null;
try {
  const rnmapbox = require('@rnmapbox/maps');
  Mapbox      = rnmapbox.default;
  MapView     = rnmapbox.MapView;
  Camera      = rnmapbox.Camera;
  ShapeSource = rnmapbox.ShapeSource;
  CircleLayer = rnmapbox.CircleLayer;
  MarkerView  = rnmapbox.MarkerView;
  mapboxLoaded = true;
} catch (e: any) {
  mapboxLoadError = e?.message ?? 'Failed to load Mapbox';
  console.error('[NativeMap] Mapbox require failed:', mapboxLoadError);
}

import { MAPBOX_TOKEN } from '../config/mapbox';
if (Mapbox && MAPBOX_TOKEN) {
  try { Mapbox.setAccessToken(MAPBOX_TOKEN); } catch (_) {}
}

// ── Types ─────────────────────────────────────────────────────────────────────
type MapStyleType = 'satellite' | 'streets';

interface MarkerData {
  id: string;
  latitude: number;
  longitude: number;
  title?: string;
  description?: string;
  pinColor?: string;
}

interface NativeMapProps {
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
}

// Compact marker design - small circle with dot
function CompactMarker({ color, title }: { color: string; title?: string }) {
  return (
    <View style={compactStyles.markerOuter}>
      <View style={[compactStyles.markerInner, { backgroundColor: color }]}>
        <View style={compactStyles.markerDot} />
      </View>
      {title && (
        <View style={compactStyles.markerLabel}>
          <Text style={compactStyles.markerLabelText} numberOfLines={1}>{title}</Text>
        </View>
      )}
    </View>
  );
}

// ── Inner map (only rendered when Mapbox loaded successfully) ─────────────────
function MapboxMap({ region, markerCoords, markers, radiusKm, onPress, style }: NativeMapProps) {
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapStyle, setMapStyle] = useState<MapStyleType>('satellite');
  const mapRef = useRef<any>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const lat = markerCoords?.latitude ?? region.latitude;
  const lng = markerCoords?.longitude ?? region.longitude;

  // Clear timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const allMarkers = markers
    ? markers
    : (markerCoords ? [{ id: 'main', latitude: lat, longitude: lng, title: 'Selected Location', pinColor: '#EF4444' }] : []);

  const radiusMeters = radiusKm ? radiusKm * 1000 : 0;

  const getStyleUrl = (): string => {
    // Use Satellite Streets for the best-looking map experience
    // satellite-streets-v12: beautiful satellite imagery + street labels + POIs
    return mapStyle === 'satellite'
      ? 'mapbox://styles/mapbox/satellite-streets-v12'
      : Mapbox.StyleURL.Streets;
  };

  const toggleMapStyle = () => setMapStyle(prev => prev === 'satellite' ? 'streets' : 'satellite');

  const circleFeature = radiusMeters > 0 && allMarkers.length > 0
    ? { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [lng, lat] }, properties: {} }
    : null;

  const handleMapPress = (feature: any) => {
    if (feature?.geometry && onPress) {
      const [pLng, pLat] = feature.geometry.coordinates;
      onPress({ latitude: pLat, longitude: pLng });
    }
  };

  const handleMarkerDrag = (marker: any, longitude: number, latitude: number) => {
    if (onPress) onPress({ latitude, longitude });
  };

  const handleMapLoad = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setMapLoaded(true);
  };

  const handleMapError = () => {
    console.warn('[NativeMap] Map style load failed');
    // Don't fall back - keep trying with Mapbox
  };

  const openExternalMaps = () => {
    const label = allMarkers[0]?.title || 'Location';
    const url = Platform.OS === 'ios'
      ? `maps:?q=${encodeURIComponent(label)}&ll=${lat},${lng}`
      : `geo:${lat},${lng}?q=${lat},${lng}(${encodeURIComponent(label)})`;
    Linking.openURL(url).catch(() => {
      Linking.openURL(`https://www.google.com/maps?q=${lat},${lng}`);
    });
  };

  // Start timeout timer when component mounts
  useEffect(() => {
    setMapLoaded(false);
    // Set timeout to ensure we eventually show content
    timeoutRef.current = setTimeout(() => {
      console.log('[NativeMap] Map timeout - showing Mapbox');
      setMapLoaded(true);
    }, MAP_TIMEOUT);
  }, [region.latitude, region.longitude]);

  return (
    <View style={[styles.container, style]}>
      {/* Loading overlay */}
      {!mapLoaded && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#3B82F6" />
          <Text style={styles.loadingText}>
            Loading {mapStyle === 'satellite' ? 'satellite' : 'map'} view...
          </Text>
        </View>
      )}

      {/* Mapbox Map */}
      {mapLoaded && (
        <MapView
          ref={mapRef}
          style={styles.map}
          styleURL={getStyleUrl()}
          surfaceView={true}
          onStyleLoad={handleMapLoad}
          onError={handleMapError}
          onPress={handleMapPress}
          rotateEnabled={true}
          pitchEnabled={true}
          compassEnabled={true}
          logoEnabled={false}
          attributionEnabled={false}
        >
          <Camera
            defaultSettings={{ centerCoordinate: [lng, lat], zoomLevel: 15, pitch: 45, bearing: 0 }}
          />

          {circleFeature && (
            <ShapeSource id="radius" shape={circleFeature}>
              <CircleLayer
                id="radius-circle"
                style={{
                  circleRadius: radiusMeters / 10,
                  circleColor: '#3B82F6',
                  circleOpacity: 0.2,
                  circleStrokeWidth: 2,
                  circleStrokeColor: '#3B82F6',
                }}
              />
            </ShapeSource>
          )}

          {allMarkers.map((marker) => (
            <MarkerView
              key={marker.id}
              coordinate={[marker.longitude, marker.latitude]}
              draggable
              onDrag={(e: any) => {
                const coords = e.geometry.coordinates;
                handleMarkerDrag(marker, coords[0], coords[1]);
              }}
            >
              <CompactMarker
                color={marker.pinColor || '#3B82F6'}
                title={marker.title}
              />
            </MarkerView>
          ))}
        </MapView>
      )}

      {/* Map style toggle control */}
      {mapLoaded && (
        <View style={styles.controlsContainer}>
          <TouchableOpacity style={styles.controlButton} onPress={toggleMapStyle}>
            <Ionicons name={mapStyle === 'satellite' ? 'layers' : 'satellite'} size={16} color="#3B82F6" />
            <Text style={styles.controlText}>{mapStyle === 'satellite' ? 'Satellite Streets' : 'Map View'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Info overlay */}
      {mapLoaded && (
        <View style={styles.infoOverlay}>
          <Text style={styles.infoText}>
            {lat.toFixed(4)}, {lng.toFixed(4)}
            {allMarkers.length > 0 && ` • ${allMarkers.length} marker${allMarkers.length > 1 ? 's' : ''}`}
          </Text>
        </View>
      )}
    </View>
  );
}

// ── Public export ─────────────────────────────────────────────────────────────
export function NativeMap(props: NativeMapProps) {
  const lat = props.markerCoords?.latitude ?? props.region.latitude;
  const lng = props.markerCoords?.longitude ?? props.region.longitude;

  // Web: delegate to NativeMap.web.tsx (handled by bundler)
  if (Platform.OS === 'web') {
    // This won't be used since we have separate web file, but needed for type
    return (
      <View style={[styles.container, props.style]}>
        <View style={styles.webFallback}>
          <Ionicons name="map" size={60} color="#3B82F6" />
          <Text style={styles.coordsText}>{lat.toFixed(6)}, {lng.toFixed(6)}</Text>
          {props.radiusKm ? <Text style={styles.radiusText}>Radius: {props.radiusKm} km</Text> : null}
        </View>
      </View>
    );
  }

  // Native: if Mapbox failed to load at module level, show static fallback immediately
  if (!mapboxLoaded) {
    return (
      <View style={[styles.errorFallback, props.style]}>
        <Ionicons name="map-outline" size={48} color="#3B82F6" />
        <Text style={styles.errorTitle}>Map unavailable</Text>
        <Text style={styles.errorCoords}>{lat.toFixed(6)}, {lng.toFixed(6)}</Text>
        <Text style={styles.errorHint}>Native map library could not be loaded.</Text>
      </View>
    );
  }

  // Wrap in boundary to catch any runtime init exceptions from Mapbox
  return (
    <MapErrorBoundary lat={lat} lng={lng}>
      <MapboxMap {...props} />
    </MapErrorBoundary>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container:       { flex: 1, backgroundColor: '#0F172A' },
  map:             { flex: 1 },
  loadingOverlay:  { ...StyleSheet.absoluteFillObject, backgroundColor: '#0F172A', justifyContent: 'center', alignItems: 'center', zIndex: 10 },
  loadingText:     { color: '#94A3B8', marginTop: 12, fontSize: 14 },
  webFallback:     { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  coordsText:      { color: '#94A3B8', fontSize: 14, marginTop: 12 },
  radiusText:      { color: '#3B82F6', fontSize: 14, marginTop: 8, fontWeight: '500' },
  errorFallback:   { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#0F172A' },
  errorTitle:      { color: '#F59E0B', fontSize: 16, fontWeight: '700', marginTop: 12 },
  errorCoords:     { color: '#94A3B8', fontSize: 13, marginTop: 6 },
  errorHint:       { color: '#475569', fontSize: 12, marginTop: 8, textAlign: 'center', lineHeight: 18 },
  controlsContainer: { position: 'absolute', top: 10, right: 10, zIndex: 1 },
  controlButton:   { backgroundColor: 'rgba(15, 23, 42, 0.9)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: '#3B82F6', flexDirection: 'row', alignItems: 'center', gap: 6 },
  controlText:     { color: '#3B82F6', fontSize: 12, fontWeight: '600' },
  infoOverlay: {
    position: 'absolute',
    bottom: 10,
    left: 10,
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  infoText: {
    color: '#94A3B8',
    fontSize: 11,
  },
});

// Compact marker styles (used in native)
const compactStyles = StyleSheet.create({
  markerOuter: {
    alignItems: 'center',
  },
  markerInner: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: 'white',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 4,
  },
  markerDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'white',
  },
  markerLabel: {
    backgroundColor: 'rgba(15, 23, 42, 0.9)',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginTop: 4,
    maxWidth: 100,
  },
  markerLabelText: {
    color: 'white',
    fontSize: 10,
    fontWeight: '600',
  },
});