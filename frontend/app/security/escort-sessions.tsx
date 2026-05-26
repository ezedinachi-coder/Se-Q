/**
 * security/escort-sessions.tsx
 *
 * Design is an EXACT match of security/panics.tsx:
 * - Same card layout, GPS trail, refresh bar, location modal
 * - Same poll interval (10s), countdown bar, empty state
 * - Call + Navigate actions replace the panic Respond button
 * - Green accent (#10B981) instead of panic red (#EF4444)
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  ActivityIndicator, Alert, Linking, Platform, BackHandler,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import { getAuthToken, clearAuthData, getUserMetadata } from '../../utils/auth';
import { LocationMapModal } from '../../components/LocationMapModal';
import BACKEND_URL from '../../utils/config';

const POLL_INTERVAL = 10000;  // 10 seconds — matches panics.tsx

interface GpsPt {
  latitude: number;
  longitude: number;
  accuracy?: number;
  timestamp: string;
}

export default function EscortSessions() {
  const router    = useRouter();
  const [sessions,  setSessions]  = useState<any[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [locationModal, setLocationModal] = useState<{
    visible: boolean; lat: number; lng: number; title: string;
  } | null>(null);
  const [userRole, setUserRole]   = useState<string | null>(null);
  const [countdown, setCountdown] = useState(10);
  const pollRef    = useRef<any>(null);
  const countRef   = useRef<any>(null);

  // Android back → correct dashboard
  useEffect(() => {
    getUserMetadata().then(m => setUserRole(m.role));
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      router.replace(userRole === 'admin' ? '/admin/dashboard' : '/security/home');
      return true;
    });
    return () => sub.remove();
  }, [userRole]);

  useFocusEffect(
    useCallback(() => {
      loadSessions();
      startPolling();
      return () => stopPolling();
    }, [])
  );

  const startPolling = () => {
    stopPolling();
    setCountdown(10);
    pollRef.current  = setInterval(() => { loadSessions(); setCountdown(10); }, POLL_INTERVAL);
    countRef.current = setInterval(() => setCountdown(p => (p <= 1 ? 10 : p - 1)), 1000);
  };

  const stopPolling = () => {
    if (pollRef.current)  clearInterval(pollRef.current);
    if (countRef.current) clearInterval(countRef.current);
  };

  const loadSessions = async () => {
    try {
      const token = await getAuthToken();
      if (!token) { router.replace('/auth/login'); return; }
      const res = await axios.get(
        `${BACKEND_URL}/api/security/escort-sessions?t=${Date.now()}`,
        { headers: { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-cache' }, timeout: 15000 }
      );
      setSessions(res.data || []);
    } catch (err: any) {
      if (err?.response?.status === 401) { await clearAuthData(); router.replace('/auth/login'); }
    } finally {
      setLoading(false);
    }
  };

  // ── Helpers ───────────────────────────────────────────────────────────────
  const formatTime = (ts: string) => {
    try {
      return new Date(ts).toLocaleString('en-US', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        month: 'short', day: 'numeric',
      });
    } catch { return ts; }
  };

  const formatDateTime = (ts: string) => {
    const d = new Date(ts);
    return {
      date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      time: d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    };
  };

  const callUser  = (phone: string) =>
    phone ? Linking.openURL(`tel:${phone}`) : Alert.alert('No phone', 'Phone number not available');

  const openMaps  = (lat: number, lng: number, name: string) => {
    const url = Platform.select({
      ios:     `maps:?q=${encodeURIComponent(name)}&ll=${lat},${lng}`,
      android: `geo:${lat},${lng}?q=${lat},${lng}(${encodeURIComponent(name)})`,
    });
    if (url) Linking.openURL(url).catch(() => Alert.alert('Error', 'Could not open maps'));
  };

  // ── GPS timeline row — identical to panics.tsx ─────────────────────────
  const renderGpsRow = (pt: GpsPt, index: number, total: number) => (
    <TouchableOpacity
      key={`${index}-${pt.timestamp}`}
      style={[gpsStyles.row, index === 0 && gpsStyles.rowLatest]}
      onPress={() => setLocationModal({
        visible: true,
        lat: pt.latitude,
        lng: pt.longitude,
        title: `Location @ ${formatTime(pt.timestamp)}`,
      })}
      activeOpacity={0.7}
    >
      <View style={gpsStyles.trail}>
        <View style={[gpsStyles.dot, index === 0 && gpsStyles.dotLatest]} />
        {index < total - 1 && <View style={gpsStyles.line} />}
      </View>
      <View style={gpsStyles.content}>
        <View style={gpsStyles.topRow}>
          {index === 0 && (
            <View style={gpsStyles.latestBadge}>
              <Text style={gpsStyles.latestBadgeText}>LATEST</Text>
            </View>
          )}
          <Text style={gpsStyles.coords} numberOfLines={1}>
            {pt.latitude.toFixed(6)}, {pt.longitude.toFixed(6)}
          </Text>
        </View>
        <Text style={gpsStyles.time}>{formatTime(pt.timestamp)}</Text>
        {pt.accuracy != null && (
          <Text style={gpsStyles.accuracy}>±{Math.round(pt.accuracy)}m accuracy</Text>
        )}
      </View>
      <Ionicons name="map-outline" size={16} color="#10B981" style={{ marginLeft: 6 }} />
    </TouchableOpacity>
  );

  // ── Escort card — mirrors panic card structure exactly ────────────────────
  const renderSession = ({ item }: any) => {
    const dt    = formatDateTime(item.started_at);
    const name  = (item.user_name || '').trim() || item.user_email || 'Unknown User';
    const trail: GpsPt[] = [...(item.route || [])].reverse(); // newest first

    return (
      <View style={styles.card}>

        {/* Top badges — mirrors panic topRow */}
        <View style={styles.topRow}>
          <View style={styles.activeBadge}>
            <View style={styles.liveDot} />
            <Text style={styles.activeBadgeText}>LIVE ESCORT</Text>
          </View>
          <View style={styles.countBadgeOuter}>
            <Ionicons name="location" size={12} color="#10B981" />
            <Text style={styles.countBadgeText}>{item.location_count || 0} pts</Text>
          </View>
        </View>

        {/* User info — identical to panic userRow */}
        <View style={styles.userRow}>
          <View style={styles.avatar}>
            <Ionicons name="person-circle" size={44} color="#10B981" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.userName}>{name}</Text>
            <Text style={styles.userEmail}>{item.user_email || 'No email'}</Text>
            {item.user_phone ? (
              <Text style={styles.userPhone}>{item.user_phone}</Text>
            ) : (
              <Text style={styles.userPhoneEmpty}>No phone on file</Text>
            )}
          </View>
        </View>

        {/* Details — identical to panic details block */}
        <View style={styles.details}>
          {[
            { icon: 'calendar', text: dt.date },
            { icon: 'time',     text: dt.time },
            { icon: 'location', text: trail[0]
                ? `${trail[0].latitude?.toFixed(4)}, ${trail[0].longitude?.toFixed(4)}`
                : 'Awaiting first GPS update…' },
            { icon: 'pulse',    text: `${item.location_count || 0} location updates`, color: '#10B981' },
          ].map((r, i) => (
            <View key={i} style={styles.detailRow}>
              <Ionicons name={r.icon as any} size={15} color={r.color || '#94A3B8'} />
              <Text style={[styles.detailText, r.color ? { color: r.color } : {}]}>{r.text}</Text>
            </View>
          ))}
        </View>

        {/* ── LIVE GPS TRACK — identical structure to panic GPS block ── */}
        <View style={gpsStyles.container}>
          <View style={gpsStyles.header}>
            <Ionicons name="trail-sign" size={16} color="#10B981" />
            <Text style={[gpsStyles.title, { color: '#10B981' }]}>Live GPS Trail</Text>
            {trail.length > 0 && (
              <View style={[gpsStyles.countBadge, { backgroundColor: '#10B981' }]}>
                <Text style={gpsStyles.countText}>{trail.length}</Text>
              </View>
            )}
            <View style={[gpsStyles.liveBadge, { backgroundColor: '#10B98120' }]}>
              <View style={[gpsStyles.liveDot, { backgroundColor: '#10B981' }]} />
              <Text style={[gpsStyles.liveText, { color: '#10B981' }]}>LIVE · {countdown}s</Text>
            </View>
          </View>

          {trail.length === 0 ? (
            <View style={gpsStyles.empty}>
              <Ionicons name="time-outline" size={28} color="#334155" />
              <Text style={gpsStyles.emptyText}>No GPS coordinates yet</Text>
              <Text style={gpsStyles.emptySubtext}>Points will appear as user moves</Text>
            </View>
          ) : (
            <View>
              {trail.map((pt, i) => renderGpsRow(pt, i, trail.length))}
            </View>
          )}
        </View>

        {/* Actions — Call + Navigate (replaces panic Respond button) */}
        <View style={styles.actions}>
          {item.user_phone ? (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: '#10B981' }]}
              onPress={() => callUser(item.user_phone)}
            >
              <Ionicons name="call" size={18} color="#fff" />
              <Text style={styles.actionBtnText}>Call User</Text>
            </TouchableOpacity>
          ) : null}
          {trail[0] ? (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: '#3B82F6', marginLeft: item.user_phone ? 8 : 0 }]}
              onPress={() => openMaps(trail[0].latitude, trail[0].longitude, name)}
            >
              <Ionicons name="navigate" size={18} color="#fff" />
              <Text style={styles.actionBtnText}>Navigate</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Header — identical to panics.tsx header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.replace(userRole === 'admin' ? '/admin/dashboard' : '/security/home')}
          style={styles.backBtn}
        >
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Active Escorts ({sessions.length})</Text>
        <TouchableOpacity onPress={() => { loadSessions(); setCountdown(10); }}>
          <Ionicons name="refresh" size={24} color="#fff" />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="large" color="#10B981" />
        </View>
      ) : (
        <FlatList
          data={sessions}
          renderItem={renderSession}
          keyExtractor={item => item.session_id || item._id}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="navigate-outline" size={80} color="#64748B" />
              <Text style={styles.emptyText}>No active escort sessions</Text>
              <Text style={styles.emptySubtext}>Live GPS routes appear here when users activate Security Escort</Text>
            </View>
          }
        />
      )}

      {/* Refresh bar — identical to panics.tsx */}
      <View style={styles.refreshBar}>
        <Ionicons name="sync-outline" size={11} color="#475569" style={{ marginRight: 5 }} />
        <Text style={styles.refreshBarText}>Live GPS — next update in {countdown}s</Text>
      </View>

      {locationModal && (
        <LocationMapModal
          visible={locationModal.visible}
          onClose={() => setLocationModal(null)}
          latitude={locationModal.lat}
          longitude={locationModal.lng}
          title={locationModal.title}
        />
      )}
    </SafeAreaView>
  );
}

// ── Styles — mirrors security/panics.tsx exactly, green accent ───────────────
const styles = StyleSheet.create({
  container:        { flex: 1, backgroundColor: '#0F172A' },
  header:           { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: '#1E293B' },
  backBtn:          { padding: 4 },
  headerTitle:      { fontSize: 18, fontWeight: 'bold', color: '#fff' },
  loadingBox:       { flex: 1, justifyContent: 'center', alignItems: 'center' },
  list:             { padding: 16, paddingBottom: 40 },
  card:             { backgroundColor: '#1E293B', borderRadius: 16, padding: 16, marginBottom: 16, borderLeftWidth: 4, borderLeftColor: '#10B981' },
  topRow:           { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  activeBadge:      { flexDirection: 'row', alignItems: 'center', backgroundColor: '#10B98120', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, gap: 5 },
  liveDot:          { width: 6, height: 6, borderRadius: 3, backgroundColor: '#10B981' },
  activeBadgeText:  { fontSize: 11, fontWeight: '800', color: '#10B981' },
  countBadgeOuter:  { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#10B98115', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12 },
  countBadgeText:   { fontSize: 11, fontWeight: '600', color: '#10B981' },
  userRow:          { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 },
  avatar:           { width: 52, height: 52, borderRadius: 26, backgroundColor: '#10B98120', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  userName:         { fontSize: 16, fontWeight: '700', color: '#fff', marginBottom: 3 },
  userEmail:        { fontSize: 12, color: '#94A3B8', marginBottom: 2 },
  userPhone:        { fontSize: 13, color: '#10B981', fontWeight: '600' },
  userPhoneEmpty:   { fontSize: 12, color: '#475569', fontStyle: 'italic' },
  details:          { backgroundColor: '#0F172A', borderRadius: 12, padding: 12, marginBottom: 12 },
  detailRow:        { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  detailText:       { fontSize: 13, color: '#94A3B8' },
  actions:          { flexDirection: 'row', marginTop: 12 },
  actionBtn:        { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 13, borderRadius: 12 },
  actionBtnText:    { fontSize: 15, fontWeight: '700', color: '#fff' },
  empty:            { alignItems: 'center', paddingVertical: 80 },
  emptyText:        { fontSize: 20, color: '#64748B', marginTop: 16, fontWeight: '600' },
  emptySubtext:     { fontSize: 14, color: '#475569', marginTop: 4, textAlign: 'center', paddingHorizontal: 32 },
  refreshBar:       { height: 28, backgroundColor: '#0F172A', borderTopWidth: 1, borderTopColor: '#1E293B', flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  refreshBarText:   { fontSize: 11, color: '#475569' },
});

// GPS trail styles — identical to panics.tsx gpsStyles
const gpsStyles = StyleSheet.create({
  container:       { marginBottom: 4, backgroundColor: '#0F172A', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#10B98130' },
  header:          { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 10 },
  title:           { flex: 1, fontSize: 13, fontWeight: '600', color: '#10B981' },
  countBadge:      { backgroundColor: '#10B981', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10 },
  countText:       { fontSize: 11, fontWeight: '700', color: '#fff' },
  liveBadge:       { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#10B98120', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  liveDot:         { width: 6, height: 6, borderRadius: 3, backgroundColor: '#10B981' },
  liveText:        { fontSize: 10, fontWeight: '700', color: '#10B981' },
  row:             { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#1E293B40', paddingHorizontal: 4 },
  rowLatest:       { backgroundColor: '#10B98108', borderRadius: 8, paddingHorizontal: 8 },
  trail:           { width: 20, alignItems: 'center', marginRight: 10, paddingTop: 2 },
  dot:             { width: 9, height: 9, borderRadius: 5, backgroundColor: '#334155' },
  dotLatest:       { width: 11, height: 11, borderRadius: 6, backgroundColor: '#10B981' },
  line:            { width: 2, height: 26, backgroundColor: '#1E293B', marginTop: 2 },
  content:         { flex: 1 },
  topRow:          { flexDirection: 'row', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
  latestBadge:     { backgroundColor: '#10B98130', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 5 },
  latestBadgeText: { color: '#10B981', fontSize: 9, fontWeight: '700' },
  coords:          { fontSize: 12, color: '#E2E8F0', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  time:            { fontSize: 11, color: '#64748B', marginTop: 2 },
  accuracy:        { fontSize: 10, color: '#475569', marginTop: 1 },
  empty:           { alignItems: 'center', paddingVertical: 24 },
  emptyText:       { color: '#475569', fontSize: 13, marginTop: 8 },
  emptySubtext:    { color: '#334155', fontSize: 11, marginTop: 3 },
});
