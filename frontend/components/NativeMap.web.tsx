import React, { useState, useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

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
  markerCoords?: {
    latitude: number;
    longitude: number;
  };
  markers?: MarkerData[];
  radiusKm?: number;
  onPress?: (coords: { latitude: number; longitude: number }) => void;
  onMarkerChange?: (coords: { latitude: number; longitude: number }) => void;
  style?: any;
}

// Web version using Leaflet with direct DOM manipulation
export const NativeMap = forwardRef(function NativeMap(
  { region, markerCoords, markers, radiusKm, onPress, style }: NativeMapProps,
  ref: any
) {
  const [isLoading, setIsLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const leafletMarkersRef = useRef<any[]>([]);
  const radiusCircleRef = useRef<any>(null);

  const lat = markerCoords?.latitude ?? region.latitude;
  const lng = markerCoords?.longitude ?? region.longitude;
  const allMarkers = markers
    ? markers
    : markerCoords
    ? [{ id: 'main', latitude: lat, longitude: lng, title: 'Selected Location', pinColor: '#EF4444' }]
    : [];
  const markersJson = JSON.stringify(allMarkers);
  const radiusMeters = radiusKm ? radiusKm * 1000 : 0;

  useEffect(() => {
    if (typeof window === 'undefined' || !containerRef.current) return;

    let map: any = null;
    let leaflet: any = null;

    const initMap = async () => {
      try {
        // Dynamically load Leaflet CSS
        if (!document.getElementById('leaflet-css')) {
          const link = document.createElement('link');
          link.id = 'leaflet-css';
          link.rel = 'stylesheet';
          link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
          document.head.appendChild(link);
        }

        // Dynamically load Leaflet JS
        if (!(window as any).L) {
          await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
          });
        }

        leaflet = (window as any).L;
        if (!leaflet) {
          throw new Error('Leaflet not loaded');
        }

        // Clear previous map if exists
        if (mapRef.current) {
          mapRef.current.remove();
          mapRef.current = null;
        }

        // Clear container
        containerRef.current.innerHTML = '';

        // Calculate zoom level based on region delta
        const zoom = Math.max(1, Math.min(18, Math.round(Math.log2(360 / region.latitudeDelta))));

        // Initialize map
        map = leaflet.map(containerRef.current, {
          zoomControl: true,
          attributionControl: true,
        }).setView([region.latitude, region.longitude], zoom);

        // Add tile layer
        leaflet.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '© OpenStreetMap contributors'
        }).addTo(map);

        // Store map reference
        mapRef.current = map;

        // Add markers
        const markerData: MarkerData[] = JSON.parse(markersJson);
        leafletMarkersRef.current = [];

        markerData.forEach((m: MarkerData) => {
          const color = m.pinColor || '#3B82F6';
          // Compact marker design: small circle with dot
          const iconHtml = `
            <div style="
              width: 20px;
              height: 20px;
              background: ${color};
              border-radius: 50%;
              border: 2px solid white;
              box-shadow: 0 2px 4px rgba(0,0,0,0.3);
              display: flex;
              align-items: center;
              justify-content: center;
            ">
              <div style="
                width: 6px;
                height: 6px;
                background: white;
                border-radius: 50%;
              "></div>
            </div>
          `;
          const icon = leaflet.divIcon({
            html: iconHtml,
            className: '',
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          });

          const marker = leaflet
            .marker([m.latitude, m.longitude], { icon, draggable: false })
            .addTo(map);

          if (m.title) {
            marker.bindPopup(`<b>${m.title}</b>${m.description ? '<br>' + m.description : ''}`);
          }

          marker.on('click', () => {
            if (onPress) {
              onPress({ latitude: m.latitude, longitude: m.longitude });
            }
          });

          leafletMarkersRef.current.push(marker);
        });

        // Add radius circle if applicable
        if (radiusMeters > 0 && allMarkers.length > 0) {
          radiusCircleRef.current = leaflet.circle([lat, lng], {
            radius: radiusMeters,
            color: '#3B82F6',
            fillColor: '#3B82F6',
            fillOpacity: 0.15,
            weight: 2,
          }).addTo(map);
        }

        // Handle map clicks
        map.on('click', (e: any) => {
          if (onPress) {
            onPress({ latitude: e.latlng.lat, longitude: e.latlng.lng });
          }
        });

        setIsLoading(false);
      } catch (error) {
        console.error('[NativeMap] Failed to initialize map:', error);
        setIsLoading(false);
      }
    };

    initMap();

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [region.latitude, region.longitude, region.latitudeDelta]);

  // Update markers when they change
  useEffect(() => {
    if (!mapRef.current || !leaflet) return;

    const updateMarkers = () => {
      try {
        const L = (window as any).L;
        if (!L) return;

        // Remove existing markers
        leafletMarkersRef.current.forEach(m => m.remove());
        leafletMarkersRef.current = [];

        // Remove existing radius circle
        if (radiusCircleRef.current) {
          radiusCircleRef.current.remove();
          radiusCircleRef.current = null;
        }

        const markerData: MarkerData[] = allMarkers;

        markerData.forEach((m: MarkerData) => {
          const color = m.pinColor || '#3B82F6';
          // Compact marker design
          const iconHtml = `
            <div style="
              width: 20px;
              height: 20px;
              background: ${color};
              border-radius: 50%;
              border: 2px solid white;
              box-shadow: 0 2px 4px rgba(0,0,0,0.3);
              display: flex;
              align-items: center;
              justify-content: center;
            ">
              <div style="
                width: 6px;
                height: 6px;
                background: white;
                border-radius: 50%;
              "></div>
            </div>
          `;
          const icon = L.divIcon({
            html: iconHtml,
            className: '',
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          });

          const marker = L
            .marker([m.latitude, m.longitude], { icon, draggable: false })
            .addTo(mapRef.current);

          if (m.title) {
            marker.bindPopup(`<b>${m.title}</b>${m.description ? '<br>' + m.description : ''}`);
          }

          marker.on('click', () => {
            if (onPress) {
              onPress({ latitude: m.latitude, longitude: m.longitude });
            }
          });

          leafletMarkersRef.current.push(marker);
        });

        // Add radius circle if applicable
        if (radiusMeters > 0 && allMarkers.length > 0) {
          radiusCircleRef.current = L.circle([lat, lng], {
            radius: radiusMeters,
            color: '#3B82F6',
            fillColor: '#3B82F6',
            fillOpacity: 0.15,
            weight: 2,
          }).addTo(mapRef.current);
        }

        // Fit bounds if multiple markers
        if (markerData.length > 1) {
          const bounds = L.latLngBounds(markerData.map((m) => [m.latitude, m.longitude]));
          mapRef.current.fitBounds(bounds, { padding: [30, 30] });
        }
      } catch (error) {
        console.error('[NativeMap] Failed to update markers:', error);
      }
    };

    // Small delay to ensure Leaflet is fully initialized
    const timer = setTimeout(updateMarkers, 100);
    return () => clearTimeout(timer);
  }, [JSON.stringify(markers)]);

  return (
    <View style={[styles.container, style]}>
      {isLoading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#3B82F6" />
          <Text style={styles.loadingText}>Loading map...</Text>
        </View>
      )}
      <View
        ref={containerRef}
        style={styles.mapContainer}
      />
      {/* Map info overlay */}
      <View style={styles.infoOverlay}>
        <Ionicons name="location" size={14} color="#3B82F6" />
        <Text style={styles.infoText}>
          {lat.toFixed(4)}, {lng.toFixed(4)}
          {allMarkers.length > 0 && ` • ${allMarkers.length} marker${allMarkers.length > 1 ? 's' : ''}`}
        </Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
    minHeight: 300,
    borderRadius: 12,
    overflow: 'hidden',
    position: 'relative',
  },
  mapContainer: {
    flex: 1,
    width: '100%',
    height: '100%',
    backgroundColor: '#1E293B',
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(15, 23, 42, 0.9)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  loadingText: {
    color: '#94A3B8',
    marginTop: 12,
    fontSize: 14,
  },
  infoOverlay: {
    position: 'absolute',
    bottom: 10,
    left: 10,
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  infoText: {
    color: '#94A3B8',
    fontSize: 11,
  },
});