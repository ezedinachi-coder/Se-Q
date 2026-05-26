import React, { useState, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform, Modal, ActivityIndicator, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NativeMap } from './NativeMap';

// Timeout for map loading (ms)
const MAP_TIMEOUT = 8000;

interface LocationMapModalProps {
  visible: boolean;
  onClose: () => void;
  latitude: number;
  longitude: number;
  title?: string;
  subtitle?: string;
}

export function LocationMapModal({ visible, onClose, latitude, longitude, title, subtitle }: LocationMapModalProps) {
  const [mapLoading, setMapLoading] = useState(true);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);

  // Track mounted state to prevent state updates on unmounted component
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Clear timeout on visibility change and set new timeout when visible
  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (!visible) {
      setMapLoading(true);
      return;
    }
    // Start timeout timer - force map to show after timeout
    timeoutRef.current = setTimeout(() => {
      if (isMountedRef.current) {
        console.log('[LocationMapModal] Map timeout reached, showing map');
        setMapLoading(false);
      }
    }, MAP_TIMEOUT);
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [visible]);

  const handleMapLoaded = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (isMountedRef.current) {
      setMapLoading(false);
    }
  };

  const openExternalMaps = () => {
    const url = Platform.OS === 'ios'
      ? `maps:?q=${encodeURIComponent(title || 'Location')}&ll=${latitude},${longitude}`
      : `geo:${latitude},${longitude}?q=${latitude},${longitude}(${encodeURIComponent(title || 'Location')})`;
    Linking.openURL(url).catch(() => {
      Linking.openURL(`https://www.google.com/maps?q=${latitude},${longitude}`);
    });
  };

  // Default region centered on the location
  const region = {
    latitude,
    longitude,
    latitudeDelta: 0.01,
    longitudeDelta: 0.01,
  };

  // For web, show coordinate fallback
  if (Platform.OS === 'web') {
    return (
      <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
        <View style={styles.container}>
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Ionicons name="close" size={28} color="#fff" />
            </TouchableOpacity>
            <View style={styles.headerInfo}>
              <Text style={styles.headerTitle}>{title || 'Location'}</Text>
              {subtitle && <Text style={styles.headerSubtitle}>{subtitle}</Text>}
            </View>
            <TouchableOpacity onPress={openExternalMaps} style={styles.closeButton}>
              <Ionicons name="open-outline" size={24} color="#3B82F6" />
            </TouchableOpacity>
          </View>
          <View style={styles.webContainer}>
            <Ionicons name="location" size={60} color="#3B82F6" />
            <Text style={styles.coordsText}>{latitude.toFixed(6)}, {longitude.toFixed(6)}</Text>
            <TouchableOpacity style={styles.openMapsButton} onPress={openExternalMaps}>
              <Ionicons name="open-outline" size={20} color="#fff" />
              <Text style={styles.openMapsText}>Open in Google Maps</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.bottomInfo}>
            <View style={styles.coordsCard}>
              <Ionicons name="navigate" size={24} color="#3B82F6" />
              <View style={styles.coordsInfo}>
                <Text style={styles.coordsLabel}>Coordinates</Text>
                <Text style={styles.coordsValue}>{latitude.toFixed(6)}, {longitude.toFixed(6)}</Text>
              </View>
            </View>
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Ionicons name="close" size={28} color="#fff" />
          </TouchableOpacity>
          <View style={styles.headerInfo}>
            <Text style={styles.headerTitle}>{title || 'Location'}</Text>
            {subtitle && <Text style={styles.headerSubtitle}>{subtitle}</Text>}
          </View>
          <TouchableOpacity onPress={openExternalMaps} style={styles.closeButton}>
            <Ionicons name="open-outline" size={24} color="#3B82F6" />
          </TouchableOpacity>
        </View>
        <View style={styles.mapContainer}>
          {mapLoading && (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator size="large" color="#3B82F6" />
              <Text style={styles.loadingText}>Loading Map...</Text>
            </View>
          )}
          <NativeMap
            region={region}
            markerCoords={{ latitude, longitude }}
            markers={[
              {
                id: 'location-marker',
                latitude,
                longitude,
                title: title || 'Location',
                pinColor: '#EF4444',
              },
            ]}
            style={styles.map}
            onMarkerChange={() => {}}
          />
        </View>
        <View style={styles.bottomInfo}>
          <View style={styles.coordsCard}>
            <Ionicons name="navigate" size={24} color="#3B82F6" />
            <View style={styles.coordsInfo}>
              <Text style={styles.coordsLabel}>Coordinates</Text>
              <Text style={styles.coordsValue}>{latitude.toFixed(6)}, {longitude.toFixed(6)}</Text>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F172A' },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingTop: Platform.OS === 'ios' ? 50 : 16, paddingBottom: 16,
    backgroundColor: '#1E293B',
  },
  closeButton: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  headerInfo: { flex: 1, alignItems: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '600', color: '#fff' },
  headerSubtitle: { fontSize: 14, color: '#94A3B8', marginTop: 2 },
  mapContainer: { flex: 1, position: 'relative' },
  map: { flex: 1 },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject, backgroundColor: '#0F172A',
    justifyContent: 'center', alignItems: 'center', zIndex: 10,
  },
  loadingText: { color: '#94A3B8', marginTop: 12 },
  webContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#1E293B' },
  coordsText: { color: '#94A3B8', fontSize: 16, marginTop: 16 },
  openMapsButton: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#3B82F6',
    paddingVertical: 12, paddingHorizontal: 24, borderRadius: 8, marginTop: 24,
  },
  openMapsText: { color: '#fff', fontWeight: '600' },
  bottomInfo: { backgroundColor: '#1E293B', padding: 16, paddingBottom: Platform.OS === 'ios' ? 34 : 16 },
  coordsCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#0F172A', padding: 16, borderRadius: 12 },
  coordsInfo: { flex: 1 },
  coordsLabel: { color: '#64748B', fontSize: 12 },
  coordsValue: { color: '#fff', fontSize: 14, fontWeight: '500', marginTop: 2 },
});