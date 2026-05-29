/**
 * app/security/nearby.tsx
 *
 * Security Nearby — shows all security agents near the logged-in officer.
 *
 * Changes vs previous version:
 *  • "Ping" button next to each agent sends POST /api/security/ping-user/{id}
 *    which triggers the target's device to push a fresh GPS fix.
 *  • "Ping All" in the header pings every agent in the list at once via
 *    POST /api/admin/ping-all-security (security role allowed) OR loops
 *    individual pings as a graceful fallback.
 *  • After any ping a 6-second countdown fires a re-fetch so locations refresh.
 *  • Location-age colour indicator on each card (green < 5 min, amber < 30, red).
 *  • Map view unchanged — it already re-renders from updated nearbyUsers state.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, RefreshControl,
  Alert, Dimensions, ActivityIndicator, Platform, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import axios from 'axios';
import { getAuthToken, clearAuthData } from '../../utils/auth';
import { getLocation } from '../../utils/getLocation';
import { NativeMap } from '../../components/NativeMap';
import BACKEND_URL from '../../utils/config';

const { width } = Dimensions.get('window');

// ── Helpers ────────────────────────────────────────────────────────────────

function formatAge(isoString?: string): string {
  if (!isoString) return 'no location';
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function locationAgeColor(isoString?: string): string {
  if (!isoString) return '#64748B';
  const mins = (Date.now() - new Date(isoString).getTime()) / 60000;
  if (mins < 5)  return '#10B981';
  if (mins < 30) return '#F59E0B';
  return '#EF4444';
}

// ── Component ─────────────────────────────────────────────────────────────

export default function SecurityNearby() {
  const router = useRouter();

  const [currentUserId,  setCurrentUserId]  = useState<string | null>(null);
  const [nearbyUsers,    setNearbyUsers]     = useState<any[]>([]);
  const [myLocation,     setMyLocation]      = useState<any>(null);
  const [myRadius,       setMyRadius]        = useState(25);
  const [refreshing,     setRefreshing]      = useState(false);
  const [loading,        setLoading]         = useState(true);
  const [locationError,  setLocationError]   = useState('');
  const [viewMode,       setViewMode]        = useState<'list' | 'map'>('list');
  const [pingingAll,     setPingingAll]      = useState(false);
  const [pingCountdown,  setPingCountdown]   = useState(0);
  const [pingingUserId,  setPingingUserId]   = useState<string | null>(null);

  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const goBack = () => router.replace('/security/home');

  useEffect(() => {
    (async () => {
      try {
        const token = await getAuthToken();
        if (token) {
          const res = await axios.get(`${BACKEND_URL}/api/user/profile`, {
            headers: { Authorization: `Bearer ${token}` }, timeout: 8000,
          });
          setCurrentUserId(res.data?.user_id || res.data?.id || res.data?._id || null);
        }
      } catch (_) {}
    })();
    loadNearbyUsers();

    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, []);

  // ── Location update ────────────────────────────────────────────────────────

  const updateMyLocation = async () => {
    try {
      const coords = await getLocation('soft');
      if (!coords) {
        setLocationError('Unable to determine location. Please enable GPS and try again.');
        return false;
      }

      const token = await getAuthToken();
      if (!token) { router.replace('/auth/login'); return false; }

      await axios.post(`${BACKEND_URL}/api/security/update-location`, {
        latitude:  coords.latitude,
        longitude: coords.longitude,
        accuracy:  coords.accuracy,
      }, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000,
      });

      setMyLocation(coords);
      setLocationError('');
      return true;
    } catch (error: any) {
      console.error('Location update error:', error);
      setLocationError(error?.response?.data?.detail || error.message || 'Failed to update location');
      return false;
    }
  };

  // ── Load nearby ────────────────────────────────────────────────────────────

  const loadNearbyUsers = async () => {
    try {
      await updateMyLocation();

      const token = await getAuthToken();
      if (!token) { router.replace('/auth/login'); return; }

      const response = await axios.get(`${BACKEND_URL}/api/security/nearby-security`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15000,
      });

      setNearbyUsers(response.data.agents || []);
    } catch (error: any) {
      if (error?.response?.status === 401) {
        await clearAuthData();
        router.replace('/auth/login');
      } else if (error?.response?.status === 400) {
        setLocationError('Please update your location first');
      } else {
        setLocationError('Failed to load nearby security. Pull to refresh.');
      }
    } finally {
      setLoading(false);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await loadNearbyUsers();
    setRefreshing(false);
  };

  const handleUpdateLocation = async () => {
    const success = await updateMyLocation();
    if (success) {
      await loadNearbyUsers();
    } else {
      Alert.alert('Error', 'Failed to update location. Please enable GPS.');
    }
  };

  // ── Ping helpers ───────────────────────────────────────────────────────────

  /**
   * Start a countdown timer then re-fetch when it hits zero.
   * Called after any ping so the map/list updates with fresh coordinates.
   */
  const startRefreshCountdown = (seconds = 6) => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    let secs = seconds;
    setPingCountdown(secs);
    countdownRef.current = setInterval(() => {
      secs -= 1;
      setPingCountdown(secs);
      if (secs <= 0) {
        clearInterval(countdownRef.current!);
        setPingCountdown(0);
        loadNearbyUsers();
      }
    }, 1000);
  };

  /** Ping a single nearby agent to push a fresh GPS fix. */
  const pingSingleAgent = async (userId: string, name: string) => {
    try {
      setPingingUserId(userId);
      const token = await getAuthToken();
      if (!token) return;

      await axios.post(
        `${BACKEND_URL}/api/security/ping-user/${userId}`,
        {},
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
      );

      startRefreshCountdown(6);
    } catch (e: any) {
      Alert.alert('Ping Failed', e?.response?.data?.detail || `Could not ping ${name}.`);
    } finally {
      setPingingUserId(null);
    }
  };

  /**
   * Ping all visible nearby agents.
   * Tries POST /api/admin/ping-all-security first (works if the security
   * role is allowed there); falls back to individual pings.
   */
  const pingAll = async () => {
    try {
      setPingingAll(true);
      const token = await getAuthToken();
      if (!token) return;

      try {
        // Preferred: single batch endpoint
        await axios.post(
          `${BACKEND_URL}/api/admin/ping-all-security`,
          {},
          { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
        );
      } catch (_) {
        // Fallback: ping each agent individually
        await Promise.allSettled(
          nearbyUsers
            .filter(u => u.id !== currentUserId)
            .map(u =>
              axios.post(
                `${BACKEND_URL}/api/security/ping-user/${u.id}`,
                {},
                { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
              )
            )
        );
      }

      startRefreshCountdown(8);
    } catch (e: any) {
      Alert.alert('Ping Failed', e?.response?.data?.detail || 'Could not ping agents.');
    } finally {
      setPingingAll(false);
    }
  };

  // ── Chat / maps helpers ────────────────────────────────────────────────────

  const startChat = async (userId: string) => {
    try {
      const token = await getAuthToken();
      if (!token) { router.replace('/auth/login'); return; }

      const response = await axios.post(
        `${BACKEND_URL}/api/chat/start`,
        { to_user_id: userId },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
      );

      if (response.data?.conversation_id) {
        router.push(`/security/chat/${response.data.conversation_id}`);
      } else {
        Alert.alert('Error', 'Could not start conversation');
      }
    } catch (error: any) {
      if (error?.response?.status === 401) {
        await clearAuthData();
        router.replace('/auth/login');
      } else {
        Alert.alert('Error', error.response?.data?.detail || 'Failed to start conversation');
      }
    }
  };

  const openInMaps = (latitude: number, longitude: number, label: string) => {
    const url = Platform.select({
      ios:     `maps:?q=${label}&ll=${latitude},${longitude}`,
      android: `geo:${latitude},${longitude}?q=${latitude},${longitude}(${label})`,
    });
    if (url) Linking.openURL(url);
  };

  const getStatusColor = (status: string) => ({
    available: '#10B981',
    busy:      '#F59E0B',
    responding:'#EF4444',
    offline:   '#64748B',
  }[status] || '#64748B');

  // ── Map markers ───────────────────────────────────────────────────────────

  const getMapMarkers = () => {
    const markers: any[] = [];

    if (myLocation) {
      markers.push({
        id:          'my-location',
        latitude:    myLocation.latitude,
        longitude:   myLocation.longitude,
        title:       'You',
        description: 'Your current location',
        pinColor:    '#EF4444',
      });
    }

    nearbyUsers.forEach((user: any) => {
      if (user.id === currentUserId) return;
      const lat = user.latitude ?? user.location?.coordinates?.[1];
      const lng = user.longitude ?? user.location?.coordinates?.[0];
      if (lat != null && lng != null) {
        markers.push({
          id:          user.id,
          latitude:    lat,
          longitude:   lng,
          title:       user.full_name || 'Security Agent',
          description: user.status || 'Available',
          pinColor:    '#3B82F6',
        });
      }
    });

    return markers;
  };

  // ── Render a single user card ─────────────────────────────────────────────

  const renderUser = (user: any) => {
    const lat = user.latitude ?? user.location?.coordinates?.[1];
    const lng = user.longitude ?? user.location?.coordinates?.[0];
    const ageColor = locationAgeColor(user.location_updated_at || user.updated_at);
    const isPinging = pingingUserId === user.id;

    return (
      <View key={user.id} style={styles.userCard}>
        {/* Header row */}
        <View style={styles.userHeader}>
          <View style={styles.userAvatar}>
            <Ionicons name="shield" size={24} color="#F59E0B" />
          </View>
          <View style={styles.userInfo}>
            <Text style={styles.userName}>{user.full_name}</Text>
            <Text style={styles.userRole}>
              {user.security_sub_role === 'supervisor' ? '⭐ Supervisor' : 'Team Member'}
            </Text>
            {user.team_name && <Text style={styles.userTeam}>Team: {user.team_name}</Text>}
          </View>
          <View style={[styles.statusBadge, { backgroundColor: getStatusColor(user.status) + '20' }]}>
            <View style={[styles.statusDot, { backgroundColor: getStatusColor(user.status) }]} />
            <Text style={[styles.statusText, { color: getStatusColor(user.status) }]}>
              {user.status || 'offline'}
            </Text>
          </View>
        </View>

        {/* Location freshness */}
        <View style={styles.locationRow}>
          <View style={[styles.ageDot, { backgroundColor: ageColor }]} />
          <Text style={[styles.ageText, { color: ageColor }]}>
            {formatAge(user.location_updated_at || user.updated_at)}
          </Text>
          {lat != null && lng != null && (
            <Text style={styles.coordsSmall}>
              · {lat?.toFixed(4)}, {lng?.toFixed(4)}
            </Text>
          )}
        </View>

        {/* Action buttons */}
        <View style={styles.userActions}>
          <TouchableOpacity style={styles.actionButton} onPress={() => startChat(user.id)}>
            <Ionicons name="chatbubble" size={18} color="#3B82F6" />
            <Text style={styles.actionText}>Message</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => Alert.alert('Call', `Calling ${user.full_name}...`)}
          >
            <Ionicons name="call" size={18} color="#10B981" />
            <Text style={styles.actionText}>Call</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => {
              if (lat != null && lng != null) {
                openInMaps(lat, lng, user.full_name || 'Security Agent');
              } else {
                Alert.alert('Location', 'Location not available for this agent');
              }
            }}
          >
            <Ionicons name="location" size={18} color="#F59E0B" />
            <Text style={styles.actionText}>Navigate</Text>
          </TouchableOpacity>

          {/* Ping for fresh location */}
          <TouchableOpacity
            style={[styles.actionButton, styles.pingBtn]}
            onPress={() => pingSingleAgent(user.id, user.full_name || 'Agent')}
            disabled={isPinging}
          >
            {isPinging ? (
              <ActivityIndicator size="small" color="#0EA5E9" />
            ) : (
              <>
                <Ionicons name="radio" size={18} color="#0EA5E9" />
                <Text style={[styles.actionText, { color: '#0EA5E9' }]}>Ping</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ── JSX ───────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.container}>

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={goBack}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.title}>Nearby Security</Text>
        <View style={styles.headerRight}>
          {/* Ping All */}
          <TouchableOpacity
            style={[styles.pingAllBtn, (pingingAll || pingCountdown > 0) && styles.pingAllBtnDisabled]}
            onPress={pingAll}
            disabled={pingingAll || pingCountdown > 0}
          >
            {pingingAll ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : pingCountdown > 0 ? (
              <Text style={styles.pingAllText}>↻ {pingCountdown}s</Text>
            ) : (
              <>
                <Ionicons name="radio" size={14} color="#fff" />
                <Text style={styles.pingAllText}>Ping All</Text>
              </>
            )}
          </TouchableOpacity>

          {/* List / Map toggle */}
          <View style={styles.viewToggle}>
            <TouchableOpacity
              style={[styles.toggleButton, viewMode === 'list' && styles.toggleActive]}
              onPress={() => setViewMode('list')}
            >
              <Ionicons name="list" size={18} color={viewMode === 'list' ? '#fff' : '#64748B'} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.toggleButton, viewMode === 'map' && styles.toggleActive]}
              onPress={() => setViewMode('map')}
            >
              <Ionicons name="map" size={18} color={viewMode === 'map' ? '#fff' : '#64748B'} />
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Ping-refresh countdown banner */}
      {pingCountdown > 0 && (
        <View style={styles.pingBanner}>
          <Ionicons name="radio" size={14} color="#3B82F6" />
          <Text style={styles.pingBannerText}>
            Devices pinged — refreshing in {pingCountdown}s
          </Text>
        </View>
      )}

      {/* Location bar */}
      <View style={styles.locationBar}>
        <View style={styles.locationInfo}>
          <Ionicons name="location" size={16} color={myLocation ? '#10B981' : '#EF4444'} />
          <Text style={styles.locationText}>
            {myLocation
              ? `${myLocation.latitude?.toFixed(4)}, ${myLocation.longitude?.toFixed(4)}`
              : 'Location not set'}
          </Text>
        </View>
        <TouchableOpacity style={styles.updateButton} onPress={handleUpdateLocation}>
          <Ionicons name="refresh" size={16} color="#3B82F6" />
          <Text style={styles.updateButtonText}>Update</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.radiusInfo}>
        <Ionicons name="radio-outline" size={14} color="#64748B" />
        <Text style={styles.radiusText}>
          Within {myRadius}km · {nearbyUsers.length} agents found
        </Text>
      </View>

      {locationError ? (
        <View style={styles.errorBox}>
          <Ionicons name="warning" size={20} color="#EF4444" />
          <Text style={styles.errorText}>{locationError}</Text>
        </View>
      ) : null}

      {/* Map or List */}
      {viewMode === 'map' ? (
        <View style={styles.mapContainer}>
          {myLocation ? (
            <NativeMap
              region={{
                latitude:      myLocation.latitude,
                longitude:     myLocation.longitude,
                latitudeDelta: 0.1,
                longitudeDelta: 0.1,
              }}
              markers={getMapMarkers()}
              style={styles.map}
              initialMapStyle="satellite"
            />
          ) : (
            <View style={styles.mapPlaceholder}>
              <ActivityIndicator size="large" color="#3B82F6" />
              <Text style={styles.mapPlaceholderText}>Acquiring location…</Text>
            </View>
          )}
          <View style={styles.mapLegend}>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: '#EF4444' }]} />
              <Text style={styles.legendText}>You</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: '#3B82F6' }]} />
              <Text style={styles.legendText}>Security Agents</Text>
            </View>
          </View>
        </View>
      ) : (
        <ScrollView
          style={styles.usersList}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#F59E0B" />
          }
        >
          {nearbyUsers.length > 0 ? (
            nearbyUsers
              .filter(u => u.id !== currentUserId)
              .map(renderUser)
          ) : (
            <View style={styles.empty}>
              <Ionicons name="people-outline" size={48} color="#64748B" />
              <Text style={styles.emptyText}>
                {loading ? 'Loading nearby agents…' : 'No security agents nearby'}
              </Text>
              <Text style={styles.emptySubtext}>
                Update your location or increase radius in settings
              </Text>
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:           { flex: 1, backgroundColor: '#0F172A' },
  header:              { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14 },
  title:               { fontSize: 18, fontWeight: '600', color: '#fff', flex: 1, marginLeft: 8 },
  headerRight:         { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pingAllBtn:          { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#0EA5E9', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  pingAllBtnDisabled:  { backgroundColor: '#075985' },
  pingAllText:         { fontSize: 12, fontWeight: '600', color: '#fff' },
  pingBanner:          { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#0C2340', paddingHorizontal: 16, paddingVertical: 7 },
  pingBannerText:      { fontSize: 12, color: '#93C5FD' },
  locationBar:         { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, backgroundColor: '#1E293B' },
  locationInfo:        { flexDirection: 'row', alignItems: 'center', gap: 6 },
  locationText:        { fontSize: 13, color: '#94A3B8' },
  updateButton:        { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#3B82F620', borderRadius: 8 },
  updateButtonText:    { fontSize: 13, color: '#3B82F6', fontWeight: '500' },
  radiusInfo:          { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 16, paddingVertical: 6 },
  radiusText:          { fontSize: 12, color: '#64748B' },
  errorBox:            { flexDirection: 'row', alignItems: 'center', gap: 10, margin: 16, padding: 14, backgroundColor: '#EF444420', borderRadius: 10 },
  errorText:           { flex: 1, fontSize: 13, color: '#EF4444' },
  usersList:           { flex: 1, padding: 16 },
  userCard:            { backgroundColor: '#1E293B', borderRadius: 14, padding: 14, marginBottom: 12 },
  userHeader:          { flexDirection: 'row', alignItems: 'center' },
  userAvatar:          { width: 44, height: 44, borderRadius: 22, backgroundColor: '#F59E0B20', justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  userInfo:            { flex: 1 },
  userName:            { fontSize: 15, fontWeight: '600', color: '#fff' },
  userRole:            { fontSize: 12, color: '#94A3B8' },
  userTeam:            { fontSize: 11, color: '#64748B' },
  statusBadge:         { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 10 },
  statusDot:           { width: 7, height: 7, borderRadius: 4 },
  statusText:          { fontSize: 11, fontWeight: '500', textTransform: 'capitalize' },
  locationRow:         { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  ageDot:              { width: 7, height: 7, borderRadius: 4 },
  ageText:             { fontSize: 11, fontWeight: '500' },
  coordsSmall:         { fontSize: 11, color: '#475569' },
  userActions:         { flexDirection: 'row', marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#334155', gap: 6 },
  actionButton:        { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 8, borderRadius: 8, backgroundColor: '#0F172A' },
  pingBtn:             { backgroundColor: '#0EA5E910' },
  actionText:          { fontSize: 11, color: '#94A3B8' },
  empty:               { alignItems: 'center', paddingVertical: 60 },
  emptyText:           { fontSize: 15, color: '#64748B', marginTop: 12 },
  emptySubtext:        { fontSize: 13, color: '#475569', marginTop: 4, textAlign: 'center' },
  viewToggle:          { flexDirection: 'row', backgroundColor: '#1E293B', borderRadius: 8, padding: 3 },
  toggleButton:        { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 },
  toggleActive:        { backgroundColor: '#3B82F6' },
  mapContainer:        { flex: 1, margin: 12 },
  mapPlaceholder:      { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#1E293B', borderRadius: 12 },
  mapPlaceholderText:  { color: '#94A3B8', marginTop: 10, fontSize: 13 },
  map:                 { flex: 1, borderRadius: 12, overflow: 'hidden' },
  mapLegend:           { flexDirection: 'row', justifyContent: 'center', gap: 20, padding: 10, backgroundColor: '#1E293B', borderRadius: 8, marginTop: 6 },
  legendItem:          { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot:           { width: 10, height: 10, borderRadius: 5 },
  legendText:          { fontSize: 12, color: '#94A3B8' },
});
