/**
 * components/TrailMapModal.web.tsx
 *
 * Web platform shim for TrailMapModal.
 *
 * WHY THIS EXISTS:
 *   react-native-maps does not support web (Platform.OS === 'web'). The
 *   native TrailMapModal.tsx imports MapView, Marker, Polyline directly
 *   from 'react-native-maps', so without this shim the Metro bundler
 *   (or webpack) would try to resolve the native module on web and fail
 *   with "Unable to resolve module react-native-maps".
 *
 *   Expo's platform-specific extension resolution loads TrailMapModal.web.tsx
 *   instead of TrailMapModal.tsx on web builds — identical to how
 *   NativeMap.web.tsx shields NativeMap.tsx.
 *
 * BEHAVIOUR:
 *   Shows a coordinate list and an "Open in Google Maps" deep-link for
 *   the first and last point of the trail (start → end), which is the
 *   most actionable information available without a native map renderer.
 */

import React from 'react';
import {
  Modal, View, Text, TouchableOpacity, StyleSheet, ScrollView, Linking,
} from 'react-native';
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

export function TrailMapModal({ visible, onClose, points, title, subtitle }: TrailMapModalProps) {
  const first = points[0];
  const last  = points[points.length - 1];

  const openInMaps = (point: GpsPoint, label: string) => {
    Linking.openURL(
      `https://www.google.com/maps?q=${point.latitude},${point.longitude}&label=${encodeURIComponent(label)}`
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent={false}>
      <View style={st.container}>

        {/* Header */}
        <View style={st.header}>
          <View style={st.headerText}>
            <Text style={st.title}>{title ?? 'Trail Map'}</Text>
            {subtitle ? <Text style={st.subtitle}>{subtitle}</Text> : null}
          </View>
          <TouchableOpacity onPress={onClose} style={st.closeBtn}>
            <Ionicons name="close" size={24} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Map unavailable notice */}
        <View style={st.notice}>
          <Ionicons name="map-outline" size={48} color="#3B82F6" />
          <Text style={st.noticeTitle}>Map not available on web</Text>
          <Text style={st.noticeBody}>
            The native trail map requires the Android or iOS app.
            Use the links below to view individual points in Google Maps.
          </Text>
        </View>

        {/* Start / End quick links */}
        {first && (
          <TouchableOpacity style={st.mapLink} onPress={() => openInMaps(first, 'Trail Start')}>
            <Ionicons name="location" size={20} color="#22C55E" />
            <View style={st.linkText}>
              <Text style={st.linkLabel}>Start point</Text>
              <Text style={st.linkCoords}>
                {first.latitude.toFixed(6)}, {first.longitude.toFixed(6)}
              </Text>
            </View>
            <Ionicons name="open-outline" size={16} color="#94A3B8" />
          </TouchableOpacity>
        )}
        {last && last !== first && (
          <TouchableOpacity style={st.mapLink} onPress={() => openInMaps(last, 'Trail End')}>
            <Ionicons name="flag" size={20} color="#EF4444" />
            <View style={st.linkText}>
              <Text style={st.linkLabel}>End point</Text>
              <Text style={st.linkCoords}>
                {last.latitude.toFixed(6)}, {last.longitude.toFixed(6)}
              </Text>
            </View>
            <Ionicons name="open-outline" size={16} color="#94A3B8" />
          </TouchableOpacity>
        )}

        {/* Full point list */}
        <Text style={st.sectionHead}>{points.length} GPS points recorded</Text>
        <ScrollView style={st.list} contentContainerStyle={st.listContent}>
          {points.map((p, i) => (
            <View key={i} style={st.row}>
              <Text style={st.rowIndex}>{i + 1}</Text>
              <Text style={st.rowCoords}>
                {p.latitude.toFixed(6)}, {p.longitude.toFixed(6)}
              </Text>
              {p.timestamp ? (
                <Text style={st.rowTime}>
                  {new Date(p.timestamp).toLocaleTimeString()}
                </Text>
              ) : null}
            </View>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

export default TrailMapModal;

const st = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#0F172A' },
  header:       { flexDirection: 'row', alignItems: 'center', padding: 16, paddingTop: 48, borderBottomWidth: 1, borderBottomColor: '#1E293B' },
  headerText:   { flex: 1 },
  title:        { color: '#F1F5F9', fontSize: 18, fontWeight: '700' },
  subtitle:     { color: '#94A3B8', fontSize: 13, marginTop: 2 },
  closeBtn:     { padding: 8 },
  notice:       { alignItems: 'center', padding: 32, gap: 12 },
  noticeTitle:  { color: '#F1F5F9', fontSize: 16, fontWeight: '600' },
  noticeBody:   { color: '#94A3B8', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  mapLink:      { flexDirection: 'row', alignItems: 'center', gap: 12, margin: 8, marginHorizontal: 16, backgroundColor: '#1E293B', borderRadius: 10, padding: 14 },
  linkText:     { flex: 1 },
  linkLabel:    { color: '#F1F5F9', fontWeight: '600', fontSize: 14 },
  linkCoords:   { color: '#94A3B8', fontSize: 12, marginTop: 2 },
  sectionHead:  { color: '#64748B', fontSize: 12, fontWeight: '600', marginHorizontal: 16, marginTop: 20, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 },
  list:         { flex: 1 },
  listContent:  { paddingHorizontal: 16, paddingBottom: 32 },
  row:          { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#1E293B' },
  rowIndex:     { color: '#475569', fontSize: 12, width: 28, textAlign: 'right' },
  rowCoords:    { flex: 1, color: '#CBD5E1', fontSize: 13, fontFamily: 'monospace' },
  rowTime:      { color: '#64748B', fontSize: 12 },
});
