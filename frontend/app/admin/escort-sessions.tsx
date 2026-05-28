/**
 * admin/escort-sessions.tsx
 *
 * Redesigned to match admin/panics.tsx:
 * - Date range filter + Active-only toggle in header
 * - Manual refresh button + countdown timer (auto-refresh every 15s)
 * - GPS trail with "Show Trail" button
 * - Same card styling as panics
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  RefreshControl, Platform, ActivityIndicator, BackHandler,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import { getAuthToken, clearAuthData } from '../../utils/auth';
import { LocationMapModal } from '../../components/LocationMapModal';
import { TrailMapModal } from '../../components/TrailMapModal';
import BACKEND_URL from '../../utils/config';

// ── Types ─────────────────────────────────────────────────────────────────────
type DateFilter = 'all' | 'today' | 'last_week' | 'last_month' | 'last_3_months';

const DATE_LABELS: Record<DateFilter, string> = {
  all: 'All Time', today: 'Today', last_week: 'Last 7 Days',
  last_month: 'Last Month', last_3_months: 'Last 3 Months',
};

const POLL_INTERVAL = 15000;

interface GpsPt {
  latitude: number;
  longitude: number;
  accuracy?: number;
  timestamp: string;
}

export default function AdminEscortSessions() {
  const router = useRouter();

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      router.replace('/admin/dashboard');
      return true;
    });
    return () => sub.remove();
  }, []);

  // ── State ──────────────────────────────────────────────────────────────────
  const [sessions,        setSessions]        = useState<any[]>([]);
  const [loading,        setLoading]         = useState(true);
  const [refreshing,     setRefreshing]      = useState(false);
  const [showActiveOnly, setShowActiveOnly]  = useState(true);
  const [dateFilter,     setDateFilter]      = useState<DateFilter>('all');
  const [showDateMenu,   setShowDateMenu]    = useState(false);
  const [locationModal,  setLocationModal]   = useState<{
    visible: boolean; lat: number; lng: number; title: string
  } | null>(null);
  const [trailModal, setTrailModal] = useState<{
    visible: boolean; points: any[]; title: string; subtitle: string
  } | null>(null);
  const [countdown,  setCountdown]  = useState(15);
  const pollRef  = useRef<any>(null);
  const countRef = useRef<any>(null);

  // ── Polling ───────────────────────────────────────────────────────────────
  useFocusEffect(useCallback(() => {
    loadSessions();
    startPolling();
    return () => stopPolling();
  }, [showActiveOnly, dateFilter]));

  const startPolling = () => {
    stopPolling();
    setCountdown(15);
    pollRef.current  = setInterval(() => { loadSessions(); setCountdown(15); }, POLL_INTERVAL);
    countRef.current = setInterval(() => setCountdown(p => (p <= 1 ? 15 : p - 1)), 1000);
  };

  const stopPolling = () => {
    if (pollRef.current)  clearInterval(pollRef.current);
    if (countRef.current) clearInterval(countRef.current);
  };

  // ── Date range helper ─────────────────────────────────────────────────────
  const getDateRange = () => {
    const now = new Date();
    const ranges: Record<string, Date | null> = {
      all: null,
      today:         new Date(now.getFullYear(), now.getMonth(), now.getDate()),
      last_week:     new Date(now.getTime() - 7  * 86400000),
      last_month:    new Date(now.getTime() - 30 * 86400000),
      last_3_months: new Date(now.getTime() - 90 * 86400000),
    };
    const d = ranges[dateFilter];
    return d ? `&start_date=${d.toISOString()}` : '';
  };

  // ── Data fetch ─────────────────────────────────────────────────────────────
  const loadSessions = async () => {
    try {
      const token = await getAuthToken();
      if (!token) { router.replace('/admin/login'); return; }

      const res = await axios.get(
        `${BACKEND_URL}/api/admin/escort-sessions?active_only=${showActiveOnly}&limit=100${getDateRange()}&t=${Date.now()}`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      );
      setSessions(res.data.sessions || []);
    } catch (err: any) {
      if (err?.response?.status === 401) { await clearAuthData(); router.replace('/admin/login'); }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = () => { setRefreshing(true); loadSessions(); setCountdown(15); };

  // ── Helpers ───────────────────────────────────────────────────────────────
  const formatTime = (ts: string) => {
    try {
      return new Date(ts).toLocaleString('en-US', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        month: 'short', day: 'numeric',
      });
    } catch { return ts; }
  };

  const getName = (item: any) =>
    (item.user_full_name || item.user_name || '').trim() || item.user_email || 'Unknown User';

  // ── GPS row ────────────────────────────────────────────────────────────────
  const renderGpsRow = (pt: GpsPt, index: number, total: number) => (
    <TouchableOpacity
      key={`${index}-${pt.timestamp}`}
      style={[gpsStyles.row, index === 0 && gpsStyles.rowLatest]}
      onPress={() => setLocationModal({
        visible: true, lat: pt.latitude, lng: pt.longitude,
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
          <Text style={gpsStyles.coords}>
            {pt.latitude.toFixed(6)}, {pt.longitude.toFixed(6)}
          </Text>
        </View>
        <Text style={gpsStyles.time}>{formatTime(pt.timestamp)}</Text>
        {pt.accuracy != null && (
          <Text style={gpsStyles.accuracy}>±{Math.round(pt.accuracy)}m</Text>
        )}
      </View>
      <Ionicons name="map-outline" size={16} color="#3B82F6" style={{ marginLeft: 6 }} />
    </TouchableOpacity>
  );

  // ── Session card ───────────────────────────────────────────────────────────
  const renderSession = ({ item }: any) => {
    const name = getName(item);
    const history: GpsPt[] = item.locations || item.location_history || [];
    const chrono = [...history].reverse();
    const isActive = item.is_active;

    return (
      <View style={[styles.card, { borderLeftColor: isActive ? '#10B981' : '#334155' }]}>

        {/* Top badges */}
        <View style={styles.topRow}>
          <View style={[styles.activeBadge, { backgroundColor: isActive ? '#10B98120' : '#33415520' }]}>
            <Ionicons
              name={isActive ? 'walk' : 'checkmark-circle'}
              size={14}
              color={isActive ? '#10B981' : '#64748B'}
            />
            <Text style={[styles.activeBadgeText, { color: isActive ? '#10B981' : '#64748B' }]}>
              {isActive ? 'ACTIVE ESCORT' : 'COMPLETED'}
            </Text>
          </View>
          <Text style={styles.duration}>
            {item.started_at ? formatTime(item.started_at) : '—'}
          </Text>
        </View>

        {/* User info */}
        <View style={styles.userRow}>
          <View style={styles.avatar}>
            <Ionicons name="person-circle" size={44} color="#3B82F6" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.userName}>{name}</Text>
            <Text style={styles.userEmail}>{item.user_email || 'No email'}</Text>
            {item.user_phone && <Text style={styles.userPhone}>{item.user_phone}</Text>}
          </View>
        </View>

        {/* Details */}
        {item.ended_at && (
          <View style={styles.detailRow}>
            <Ionicons name="checkmark-circle" size={15} color="#10B981" />
            <Text style={[styles.detailText, { color: '#10B981' }]}>
              Ended: {formatTime(item.ended_at)}
            </Text>
          </View>
        )}

        {/* ── LIVE GPS TRACK ── */}
        <View style={gpsStyles.container}>
          <View style={gpsStyles.header}>
            <Ionicons name="trail-sign" size={16} color="#10B981" />
            <Text style={gpsStyles.title}>Live GPS Track</Text>
            {history.length > 0 && (
              <View style={gpsStyles.countBadge}>
                <Text style={gpsStyles.countText}>{history.length}</Text>
              </View>
            )}
            <View style={gpsStyles.liveBadge}>
              <View style={gpsStyles.liveDot} />
              <Text style={gpsStyles.liveText}>LIVE · {countdown}s</Text>
            </View>
            {history.length > 1 && (
              <TouchableOpacity
                style={gpsStyles.trailBtn}
                onPress={() => {
                  setTrailModal({
                    visible: true,
                    points: [...history].reverse(),
                    title: `${name}'s Movement Trail`,
                    subtitle: `${history.length} GPS points`,
                  });
                }}
              >
                <Ionicons name="navigate" size={13} color="#3B82F6" />
                <Text style={gpsStyles.trailBtnText}>Show Trail</Text>
              </TouchableOpacity>
            )}
          </View>

          {chrono.length === 0 ? (
            <View style={gpsStyles.empty}>
              <Ionicons name="time-outline" size={28} color="#334155" />
              <Text style={gpsStyles.emptyText}>No GPS coordinates yet</Text>
              <Text style={gpsStyles.emptySubtext}>Points will appear as user moves</Text>
            </View>
          ) : (
            <View>
              {chrono.map((pt, i) => renderGpsRow(pt, i, chrono.length))}
            </View>
          )}
        </View>

      </View>
    );
  };

  // ── Main view ─────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.container}>

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.replace('/admin/dashboard')} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>
          {showActiveOnly ? `Active Escorts (${sessions.length})` : `Escort History (${sessions.length})`}
        </Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <TouchableOpacity onPress={() => setShowActiveOnly(v => !v)}>
            <Ionicons
              name={showActiveOnly ? 'filter' : 'filter-outline'}
              size={22}
              color={showActiveOnly ? '#10B981' : '#fff'}
            />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { loadSessions(); setCountdown(15); }}>
            <Ionicons name="refresh" size={22} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowDateMenu(v => !v)}>
            <Ionicons
              name="calendar-outline"
              size={22}
              color={dateFilter !== 'all' ? '#3B82F6' : '#fff'}
            />
          </TouchableOpacity>
        </View>
      </View>

      {/* Date filter dropdown */}
      {showDateMenu && (
        <View style={styles.dateMenu}>
          {(Object.keys(DATE_LABELS) as DateFilter[]).map(k => (
            <TouchableOpacity
              key={k}
              style={styles.dateMenuItem}
              onPress={() => { setDateFilter(k); setShowDateMenu(false); }}
            >
              <Text style={[styles.dateMenuText, dateFilter === k && { color: '#3B82F6', fontWeight: '700' }]}>
                {DATE_LABELS[k]}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Active filter chips */}
      {(showActiveOnly || dateFilter !== 'all') && (
        <View style={styles.filterBar}>
          {showActiveOnly  && <Text style={styles.filterChip}>🟢 Active Escorts</Text>}
          {dateFilter !== 'all' && <Text style={styles.filterChip}>📅 {DATE_LABELS[dateFilter]}</Text>}
        </View>
      )}

      {loading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="large" color="#10B981" />
        </View>
      ) : (
        <FlatList
          data={sessions}
          renderItem={renderSession}
          keyExtractor={item => item.id || item._id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#10B981" />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="navigate" size={80} color="#64748B" />
              <Text style={styles.emptyText}>No escort sessions found</Text>
              <Text style={styles.emptySubtext}>Try changing your filters</Text>
            </View>
          }
        />
      )}

      {/* Refresh bar */}
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

      {trailModal && (
        <TrailMapModal
          visible={trailModal.visible}
          onClose={() => setTrailModal(null)}
          points={trailModal.points}
          title={trailModal.title}
          subtitle={trailModal.subtitle}
        />
      )}

    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container:        { flex: 1, backgroundColor: '#0F172A' },
  header:           { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: '#1E293B' },
  backBtn:          { padding: 4 },
  headerTitle:      { fontSize: 18, fontWeight: 'bold', color: '#fff', flex: 1, marginHorizontal: 10 },
  loadingBox:       { flex: 1, justifyContent: 'center', alignItems: 'center' },
  list:             { padding: 16, paddingBottom: 40 },
  card:             { backgroundColor: '#1E293B', borderRadius: 16, padding: 16, marginBottom: 16, borderLeftWidth: 4 },
  topRow:           { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  activeBadge:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, gap: 5 },
  activeBadgeText:  { fontSize: 11, fontWeight: '800' },
  duration:         { fontSize: 12, color: '#94A3B8' },
  userRow:          { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 },
  avatar:           { width: 52, height: 52, borderRadius: 26, backgroundColor: '#3B82F620', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  userName:         { fontSize: 16, fontWeight: '700', color: '#fff', marginBottom: 3 },
  userEmail:        { fontSize: 12, color: '#94A3B8', marginBottom: 2 },
  userPhone:        { fontSize: 13, color: '#10B981', fontWeight: '600' },
  detailRow:        { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  detailText:       { fontSize: 13, color: '#94A3B8' },
  empty:            { alignItems: 'center', paddingVertical: 80 },
  emptyText:        { fontSize: 20, color: '#64748B', marginTop: 16, fontWeight: '600' },
  emptySubtext:     { fontSize: 14, color: '#475569', marginTop: 4 },
  refreshBar:       { height: 28, backgroundColor: '#0F172A', borderTopWidth: 1, borderTopColor: '#1E293B', flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  refreshBarText:   { fontSize: 11, color: '#475569' },
  dateMenu:         { backgroundColor: '#1E293B', marginHorizontal: 16, marginTop: 4, borderRadius: 12, overflow: 'hidden', zIndex: 99 },
  dateMenuItem:     { paddingVertical: 12, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: '#0F172A' },
  dateMenuText:     { fontSize: 14, color: '#94A3B8' },
  filterBar:        { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  filterChip:       { fontSize: 12, color: '#94A3B8', backgroundColor: '#1E293B', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
});

const gpsStyles = StyleSheet.create({
  container:       { marginBottom: 4, backgroundColor: '#0F172A', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#10B98130' },
  header:          { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 10, flexWrap: 'wrap' },
  title:           { fontSize: 13, fontWeight: '600', color: '#10B981', flex: 1 },
  countBadge:      { backgroundColor: '#10B981', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10 },
  countText:       { fontSize: 11, fontWeight: '700', color: '#fff' },
  liveBadge:       { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#10B98120', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  liveDot:         { width: 6, height: 6, borderRadius: 3, backgroundColor: '#10B981' },
  liveText:        { fontSize: 10, fontWeight: '700', color: '#10B981' },
  trailBtn:        { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#3B82F620', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1, borderColor: '#3B82F640' },
  trailBtnText:    { fontSize: 11, fontWeight: '600', color: '#3B82F6' },
  row:             { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#1E293B40', paddingHorizontal: 4 },
  rowLatest:       { backgroundColor: '#3B82F608', borderRadius: 8, paddingHorizontal: 8 },
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