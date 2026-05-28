/**
 * components/NativeMap.web.tsx
 *
 * Web platform shim. react-native-maps does not support web, so this
 * file is served by Expo's bundler on Platform.OS === 'web' instead
 * of NativeMap.tsx. Shows coordinates + an "Open in Google Maps" link.
 */
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { NativeMapProps } from './NativeMap';

export function NativeMap({ region, markerCoords, markers, style }: NativeMapProps) {
  const lat = markerCoords?.latitude ?? markers?.[0]?.latitude ?? region.latitude;
  const lng = markerCoords?.longitude ?? markers?.[0]?.longitude ?? region.longitude;

  return (
    <View style={[st.wrap, style]}>
      <Ionicons name="map-outline" size={52} color="#3B82F6" />
      <Text style={st.coords}>{lat.toFixed(6)}, {lng.toFixed(6)}</Text>
      <TouchableOpacity
        style={st.btn}
        onPress={() =>
          Linking.openURL(`https://www.google.com/maps?q=${lat},${lng}`)
        }
      >
        <Ionicons name="open-outline" size={16} color="#fff" />
        <Text style={st.btnText}>Open in Google Maps</Text>
      </TouchableOpacity>
    </View>
  );
}

export default NativeMap;

const st = StyleSheet.create({
  wrap:    { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0F172A', gap: 12 },
  coords:  { color: '#94A3B8', fontSize: 14 },
  btn:     { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#3B82F6', paddingVertical: 10, paddingHorizontal: 20, borderRadius: 8 },
  btnText: { color: '#fff', fontWeight: '600' },
});
