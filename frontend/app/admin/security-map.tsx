/**
 * app/admin/security-map.tsx
 *
 * Admin Security Map — live view of all security personnel.
 *
 * Changes vs previous version:
 *  • "Ping All" button: hits POST /api/admin/ping-all-security, which tells every
 *    security user's device to call POST /api/security/update-location and push a
 *    fresh GPS fix.  Each device responds automatically (see nearby.tsx).
 *  • "Ping Selected" on the detail modal: pings a single user.
 *  • After pinging, a 5-second countdown fires a re-fetch so the map updates with
 *    the fresh coordinates that just arrived from devices.
 *  • Last-updated timestamp shown on each card and in the detail modal.
 *  • Auto-refresh every 20 s (unchanged).
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  RefreshControl, Modal, BackHandler, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import { getAuthToken, clearAuthData } from '../../utils/auth';
import { NativeMap } from '../../components/NativeMap';
import BACKEND_URL from '../../utils/config';

// ── Status colours ─────────────────────────────────────────────────────────
const STATUS_COLORS: Record<string, string> = {
  responding: '#EF4444',
  available:  '#3B82F6',
  busy:       '#F59E0B',
  offline:    '#64748B',
};

// ── Helpers ────────────────────────────────────────────────────────────────

function formatAge(isoString?: string): string {
  if (!isoString) return 'never';
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function locationAgeColor(isoString?: string): string {
  if (!isoString) return '#64748B';
  const mins = (Date.now() - new Date(isoString).getTime()) / 60000;
  if (mins < 5)  return '#10B981'; // fresh  → green
  if (mins < 30) return '#F59E0B'; // stale  → amber
  return '#EF4444';                // old    → red
}

// ── Component ─────────────────────────────────────────────────────────────

export default function AdminSecurityMap() {
  const router = useRouter();

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      router.replace('/admin/dashboard');
      return true;
    });
    return () => sub.remove();
  }, []);

  const [securityUsers, setSecurityUsers]   = useState<any[]>([]);
  const [refreshing,    setRefreshing]       = useState(false);
  const [pinging,       setPinging]          = useState(false);
  const [pingCountdown, setPingCountdown]    = useState(0);
  const [selectedUser,  setSelectedUser]     = useState<any>(null);
  const [pingingUser,   setPingingUser]      = useState(false);
  const [mapRegion,     setMapRegion]        = useState({
    latitude: 9.082, longitude: 8.6753, latitudeDelta: 0.5, longitudeDelta: 0.5,
  });

  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useFocusEffect(
    useCallback(() => {
      loadData();
      const interval = setInterval(loadData, 20000);
      return () => {
        clearInterval(interval);
        if (countdownRef.current) clearInterval(countdownRef.current);
      };
    }, [])
  );

  // ── Data fetch ────────────────────────────────────────────────────────────

  const loadData = async () => {
    try {
      const token = await getAuthToken();
      if (!token) { router.replace('/admin/login'); return; }

      const response = await axios.get(`${BACKEND_URL}/api/admin/security-map`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000,
      });

      const users = response.data.security_users || [];
      setSecurityUsers(users);

      const withLoc = users.find((u: any) => u.location?.coordinates);
      if (withLoc) {
        setMapRegion({
          latitude:      withLoc.location.coordinates[1],
          longitude:     withLoc.location.coordinates[0],
          latitudeDelta: 0.3,
          longitudeDelta: 0.3,
        });
      }
    } catch (e: any) {
      if (e?.response?.status === 401) {
        await clearAuthData();
        router.replace('/admin/login');
      }
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  // ── Ping all security ─────────────────────────────────────────────────────
  //
  // Calls POST /api/admin/ping-all-security → the backend sends a silent push
  // to every security device.  Each device's background handler calls
  // POST /api/security/update-location with fresh GPS.
  // We wait 8 s then re-fetch so the new coordinates appear on the map.

  const pingAll = async () => {
    try {
      setPinging(true);
      const token = await getAuthToken();
      if (!token) return;

      await axios.post(
        `${BACKEND_URL}/api/admin/ping-all-security`,
        {},
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
      );

      // Countdown 8 s then auto-refresh
      let secs = 8;
      setPingCountdown(secs);
      countdownRef.current = setInterval(() => {
        secs -= 1;
        setPingCountdown(secs);
        if (secs <= 0) {
          if (countdownRef.current) clearInterval(countdownRef.current);
          setPingCountdown(0);
          loadData();
        }
      }, 1000);
    } catch (e: any) {
      Alert.alert('Ping Failed', e?.response?.data?.detail || 'Could not ping security devices.');
    } finally {
      setPinging(false);
    }
  };

  // ── Ping single security user ─────────────────────────────────────────────

  const pingSingleUser = async (userId: string) => {
    try {
      setPingingUser(true);
      const token = await getAuthToken();
      if (!token) return;

      await axios.post(
        `${BACKEND_URL}/api/security/ping-user/${userId}`,
        {},
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
      );

      Alert.alert('Pinged', 'Location request sent. Map will refresh in a moment.');
      setTimeout(() => loadData(), 6000);
    } catch (e: any) {
      Alert.alert('Ping Failed', e?.response?.data?.detail || 'Could not ping user.');
    } finally {
      setPingingUser(false);
    }
  };

  // ── Map markers ───────────────────────────────────────────────────────────

  const mapMarkers = securityUsers
    .filter(u => u.location?.coordinates)
    .map(u => ({
      id:          `sec_${u.id}`,
      latitude:    u.location.coordinates[1],
      longitude:   u.location.coordinates[0],
      title:       u.full_name || u.email || 'Security',
      description: u.status || '',
      pinColor:    STATUS_COLORS[u.status] || '#3B82F6',
    }));

  const grouped = {
    responding: securityUsers.filter(u => u.status === 'responding'),
    available:  securityUsers.filter(u => u.status === 'available'),
    busy:       securityUsers.filter(u => u.status === 'busy'),
    offline:    securityUsers.filter(u => !u.status || u.status === 'offline'),
  };

  const handleUserPress = (user: any) => {
    setSelectedUser(user);
    if (user.location?.coordinates) {
      setMapRegion({
        latitude:      user.location.coordinates[1],
        longitude:     user.location.coordinates[0],
        latitudeDelta: 0.01,  // zoom into ~1 km view when selecting a user
        longitudeDelta: 0.01,
      });
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.container}>

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.replace('/admin/dashboard')} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>Security Map</Text>
        <View style={styles.headerRight}>
          {/* Ping All button */}
          <TouchableOpacity
            style={[styles.pingAllBtn, pinging && styles.pingAllBtnDisabled]}
            onPress={pingAll}
            disabled={pinging || pingCountdown > 0}
          >
            {pinging ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : pingCountdown > 0 ? (
              <Text style={styles.pingAllText}>↻ {pingCountdown}s</Text>
            ) : (
              <>
                <Ionicons name="radio" size={16} color="#fff" />
                <Text style={styles.pingAllText}>Ping All</Text>
              </>
            )}
          </TouchableOpacity>
          {/* Manual refresh */}
          <TouchableOpacity onPress={onRefresh} style={styles.refreshBtn}>
            <Ionicons name="refresh" size={22} color="#94A3B8" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Ping status banner */}
      {pingCountdown > 0 && (
        <View style={styles.pingBanner}>
          <Ionicons name="radio" size={16} color="#3B82F6" />
          <Text style={styles.pingBannerText}>
            Pinging all devices… refreshing map in {pingCountdown}s
          </Text>
        </View>
      )}

      {/* Map */}
      <View style={styles.mapWrapper}>
        <NativeMap
          region={mapRegion}
          markers={mapMarkers}
          style={styles.map}
          initialMapStyle="satellite"
        />
      </View>

      {/* Legend */}
      <View style={styles.legend}>
        {[
          { c: '#3B82F6', l: `Online (${securityUsers.filter(u => u.location?.coordinates).length})` },
          { c: '#EF4444', l: `Responding (${grouped.responding.length})` },
          { c: '#F59E0B', l: `Busy (${grouped.busy.length})` },
          { c: '#64748B', l: `Offline (${grouped.offline.length})` },
        ].map(i => (
          <View key={i.l} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: i.c }]} />
            <Text style={styles.legendText}>{i.l}</Text>
          </View>
        ))}
      </View>

      {/* Personnel list */}
      <Text style={styles.sectionTitle}>
        Security Personnel ({securityUsers.length})
      </Text>

      <ScrollView
        style={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#3B82F6" />
        }
      >
        {securityUsers.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="people-outline" size={48} color="#64748B" />
            <Text style={styles.emptyText}>No security users with location data</Text>
          </View>
        ) : (
          securityUsers.map(u => {
            const ageColor = locationAgeColor(u.updated_at);
            return (
              <TouchableOpacity
                key={u.id}
                style={[styles.card, { borderLeftColor: STATUS_COLORS[u.status] || '#3B82F6' }]}
                onPress={() => handleUserPress(u)}
              >
                <View style={styles.cardHeader}>
                  <View style={[styles.avatar, { backgroundColor: `${STATUS_COLORS[u.status] || '#3B82F6'}20` }]}>
                    <Ionicons name="shield" size={20} color={STATUS_COLORS[u.status] || '#3B82F6'} />
                  </View>
                  <View style={styles.cardInfo}>
                    <Text style={styles.cardName}>{u.full_name || u.email || 'Unknown'}</Text>
                    <Text style={styles.cardSub}>
                      {u.security_sub_role === 'supervisor' ? 'Supervisor' : 'Team Member'}
                      {u.team_name ? ` · ${u.team_name}` : ''}
                    </Text>
                  </View>
                  <View style={[styles.statusBadge, { backgroundColor: `${STATUS_COLORS[u.status] || '#3B82F6'}20` }]}>
                    <View style={[styles.statusDot, { backgroundColor: STATUS_COLORS[u.status] || '#3B82F6' }]} />
                    <Text style={[styles.statusText, { color: STATUS_COLORS[u.status] || '#3B82F6' }]}>
                      {u.status || 'offline'}
                    </Text>
                  </View>
                </View>

                {/* Location freshness row */}
                <View style={styles.cardFooter}>
                  {u.location?.coordinates ? (
                    <Text style={styles.cardCoords}>
                      {u.location.coordinates[1]?.toFixed(4)}, {u.location.coordinates[0]?.toFixed(4)}
                    </Text>
                  ) : (
                    <Text style={[styles.cardCoords, { color: '#64748B' }]}>No location</Text>
                  )}
                  <View style={styles.ageRow}>
                    <View style={[styles.ageDot, { backgroundColor: ageColor }]} />
                    <Text style={[styles.ageText, { color: ageColor }]}>
                      {formatAge(u.updated_at)}
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>
            );
          })
        )}
        <View style={{ height: 24 }} />
      </ScrollView>

      {/* User Detail Modal */}
      {selectedUser && (
        <Modal visible transparent animationType="slide" onRequestClose={() => setSelectedUser(null)}>
          <View style={styles.modalOverlay}>
            <View style={styles.detailModal}>
              <View style={styles.detailHeader}>
                <Text style={styles.detailTitle}>Security Personnel</Text>
                <TouchableOpacity onPress={() => setSelectedUser(null)}>
                  <Ionicons name="close" size={28} color="#fff" />
                </TouchableOpacity>
              </View>

              <ScrollView style={styles.detailScroll}>
                <View style={styles.detailContent}>
                  <View style={[styles.detailAvatar, { backgroundColor: `${STATUS_COLORS[selectedUser.status] || '#3B82F6'}20` }]}>
                    <Ionicons name="shield-checkmark" size={48} color={STATUS_COLORS[selectedUser.status] || '#3B82F6'} />
                  </View>
                  <Text style={styles.detailName}>{selectedUser.full_name || 'Unknown'}</Text>
                  <View style={[styles.detailStatusBadge, { backgroundColor: `${STATUS_COLORS[selectedUser.status] || '#3B82F6'}20` }]}>
                    <View style={[styles.statusDot, { backgroundColor: STATUS_COLORS[selectedUser.status] || '#3B82F6' }]} />
                    <Text style={[styles.detailStatusText, { color: STATUS_COLORS[selectedUser.status] || '#3B82F6' }]}>
                      {selectedUser.status?.toUpperCase() || 'OFFLINE'}
                    </Text>
                  </View>

                  <View style={styles.detailSection}>
                    {selectedUser.email && (
                      <View style={styles.detailRow}>
                        <Ionicons name="mail"     size={18} color="#3B82F6" />
                        <Text style={styles.detailRowText}>{selectedUser.email}</Text>
                      </View>
                    )}
                    {selectedUser.phone && (
                      <View style={styles.detailRow}>
                        <Ionicons name="call"     size={18} color="#10B981" />
                        <Text style={styles.detailRowText}>{selectedUser.phone}</Text>
                      </View>
                    )}
                    <View style={styles.detailRow}>
                      <Ionicons name="person"   size={18} color="#F59E0B" />
                      <Text style={styles.detailRowText}>
                        {selectedUser.security_sub_role === 'supervisor' ? 'Supervisor' : 'Team Member'}
                      </Text>
                    </View>
                    {selectedUser.team_name && (
                      <View style={styles.detailRow}>
                        <Ionicons name="people"  size={18} color="#8B5CF6" />
                        <Text style={styles.detailRowText}>{selectedUser.team_name}</Text>
                      </View>
                    )}
                    {selectedUser.location?.coordinates && (
                      <View style={styles.detailRow}>
                        <Ionicons name="location" size={18} color="#EF4444" />
                        <Text style={styles.detailRowText}>
                          {selectedUser.location.coordinates[1]?.toFixed(6)},{' '}
                          {selectedUser.location.coordinates[0]?.toFixed(6)}
                        </Text>
                      </View>
                    )}
                    <View style={styles.detailRow}>
                      <Ionicons name="time" size={18} color={locationAgeColor(selectedUser.updated_at)} />
                      <Text style={[styles.detailRowText, { color: locationAgeColor(selectedUser.updated_at) }]}>
                        Location: {formatAge(selectedUser.updated_at)}
                      </Text>
                    </View>
                  </View>

                  {/* Ping single user */}
                  <TouchableOpacity
                    style={styles.pingUserBtn}
                    onPress={() => pingSingleUser(selectedUser.id)}
                    disabled={pingingUser}
                  >
                    {pingingUser ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <>
                        <Ionicons name="radio" size={18} color="#fff" />
                        <Text style={styles.pingUserBtnText}>Ping for Fresh Location</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
              </ScrollView>

              <TouchableOpacity style={styles.closeBtn} onPress={() => setSelectedUser(null)}>
                <Text style={styles.closeBtnText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}
    </SafeAreaView>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:         { flex: 1, backgroundColor: '#0F172A' },
  header:            { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#1E293B' },
  backBtn:           { padding: 4 },
  title:             { fontSize: 18, fontWeight: '600', color: '#fff', flex: 1, marginLeft: 8 },
  headerRight:       { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pingAllBtn:        { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#3B82F6', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8 },
  pingAllBtnDisabled:{ backgroundColor: '#1E40AF' },
  pingAllText:       { fontSize: 13, fontWeight: '600', color: '#fff' },
  refreshBtn:        { padding: 4 },
  pingBanner:        { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#1E3A5F', paddingHorizontal: 16, paddingVertical: 8 },
  pingBannerText:    { fontSize: 13, color: '#93C5FD' },
  mapWrapper:        { height: 280, backgroundColor: '#1E293B' },
  map:               { flex: 1 },
  legend:            { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: '#1E293B' },
  legendItem:        { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot:         { width: 10, height: 10, borderRadius: 5 },
  legendText:        { fontSize: 11, color: '#94A3B8' },
  sectionTitle:      { fontSize: 14, fontWeight: '600', color: '#94A3B8', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  list:              { flex: 1, paddingHorizontal: 16 },
  card:              { backgroundColor: '#1E293B', borderRadius: 12, padding: 14, marginBottom: 10, borderLeftWidth: 4 },
  cardHeader:        { flexDirection: 'row', alignItems: 'center' },
  avatar:            { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  cardInfo:          { flex: 1 },
  cardName:          { fontSize: 15, fontWeight: '600', color: '#fff' },
  cardSub:           { fontSize: 12, color: '#94A3B8', marginTop: 2 },
  cardFooter:        { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
  cardCoords:        { fontSize: 11, color: '#3B82F6' },
  ageRow:            { flexDirection: 'row', alignItems: 'center', gap: 4 },
  ageDot:            { width: 7, height: 7, borderRadius: 4 },
  ageText:           { fontSize: 11, fontWeight: '500' },
  statusBadge:       { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12 },
  statusDot:         { width: 8, height: 8, borderRadius: 4 },
  statusText:        { fontSize: 11, fontWeight: '500', textTransform: 'capitalize' },
  empty:             { alignItems: 'center', paddingVertical: 40 },
  emptyText:         { fontSize: 15, color: '#64748B', marginTop: 8 },
  // Modal
  modalOverlay:      { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  detailModal:       { backgroundColor: '#1E293B', borderRadius: 20, width: '100%', maxWidth: 380, maxHeight: '85%', overflow: 'hidden' },
  detailHeader:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, backgroundColor: '#0F172A' },
  detailTitle:       { fontSize: 18, fontWeight: '600', color: '#fff' },
  detailScroll:      { flexGrow: 0 },
  detailContent:     { padding: 24, alignItems: 'center' },
  detailAvatar:      { width: 100, height: 100, borderRadius: 50, justifyContent: 'center', alignItems: 'center', marginBottom: 16 },
  detailName:        { fontSize: 24, fontWeight: '700', color: '#fff', marginBottom: 8 },
  detailStatusBadge: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, marginBottom: 20 },
  detailStatusText:  { fontSize: 14, fontWeight: '700' },
  detailSection:     { width: '100%' },
  detailRow:         { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#334155' },
  detailRowText:     { flex: 1, fontSize: 14, color: '#E2E8F0' },
  pingUserBtn:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#0EA5E9', marginTop: 20, paddingVertical: 12, borderRadius: 10, width: '100%' },
  pingUserBtnText:   { fontSize: 15, fontWeight: '600', color: '#fff' },
  closeBtn:          { backgroundColor: '#3B82F6', margin: 20, marginTop: 0, paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  closeBtnText:      { fontSize: 16, fontWeight: '600', color: '#fff' },
});
