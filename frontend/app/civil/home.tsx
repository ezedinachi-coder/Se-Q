import React, { useState, useEffect, useCallback, useRef } from 'react';
import AsyncStorage from '../../utils/asyncStorageShim';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, ActivityIndicator, BackHandler, Image, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import { getPendingCount, processQueue } from '../../utils/offlineQueue';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { getAuthToken, clearAuthData, getUserMetadata } from '../../utils/auth';
import BACKEND_URL from '../../utils/config';
import { setNativePanicActive } from '../../utils/nativePanicBridge';
// FIX BUG-03: removed direct `Audio` import — all sound operations now go
// through AudioManager so the priority/focus system is actually enforced.
// FIX BUG-01+02: removed setAlertAudioMode / restorePlaybackAudioMode imports.
// These standalone helpers bypassed the manager and caused:
//   BUG-01: message-chime completion reset the session, killing the looping
//           panic alarm on iOS.
//   BUG-02: setAlertAudioMode set allowsRecordingIOS:false while the ambient
//           recorder was capturing a 30-second clip, silently voiding it.
import { AudioManager, AudioPriority } from '../../utils/AudioManager';

const PANIC_LOCATION_TASK = 'background-location-panic';

export default function CivilHome() {
  const router = useRouter();
  const [isPremium, setIsPremium] = useState(false);
  const [pendingUploads, setPendingUploads] = useState(0);
  const [userName, setUserName] = useState('');
  const [myReports, setMyReports] = useState<any[]>([]);
  const [totalReportCount, setTotalReportCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [hasActivePanic, setHasActivePanic] = useState(false);
  const [appDisplayName, setAppDisplayName] = useState('Se-Q');
  const [appDisplayIcon, setAppDisplayIcon] = useState('shield');
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [profilePhoto, setProfilePhoto] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const prevUnreadRef = useRef(0);
  // FIX BUG-03: msgSoundRef removed — AudioManager.playSound() owns the
  // Sound object lifecycle internally. No local ref needed, no orphan risk.

  // ── Android back: exit app from home ─────────────────────────────────────
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      BackHandler.exitApp();
      return true;
    });
    return () => sub.remove();
  }, []);

  // ── Unread message polling (every 15 s) ───────────────────────────────────
  useEffect(() => {
    const poll = async () => {
      try {
        const token = await getAuthToken();
        if (!token) return;
        const res = await axios.get(`${BACKEND_URL}/api/chat/unread-count`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 8000,
        });
        const count: number = res.data?.count ?? 0;
        setUnreadMessages(count);

        if (count > prevUnreadRef.current) {
          const soundEnabled = await AsyncStorage.getItem('msg_sound_enabled');
          if (soundEnabled !== 'false') {
            playMessageAlert();
          }
        }
        prevUnreadRef.current = count;
      } catch (_) {}
    };

    poll();
    const id = setInterval(poll, 15000);
    return () => clearInterval(id);
  }, []);

  // ── Message sound alert ───────────────────────────────────────────────────
  //
  // FIX BUG-02 + BUG-01 + BUG-03:
  //
  // Previously this called setAlertAudioMode() + Audio.Sound.createAsync()
  // directly, creating a race with ambientRecorder.ts when a message arrived
  // during the 30-second ambient capture window:
  //
  //   t=0s   Shake panic → ambientRecorder starts → allowsRecordingIOS:true
  //   t≤15s  New message from security officer
  //   t≤15s  playMessageAlert() → setAlertAudioMode() → allowsRecordingIOS:false
  //   t≤15s  iOS kills the in-progress Audio.Recording silently
  //   t=30s  recording.stopAndUnloadAsync() returns empty/truncated clip
  //
  // Fix 1 (BUG-02): Check AudioManager.isRecording() before doing anything.
  //   If the ambient recorder holds RECORDING-priority focus, skip the chime.
  //   A security officer's reply arriving during a panic is expected — the
  //   user is in the middle of activating emergency mode and does not need an
  //   audio chime competing with that. The message badge will update anyway.
  //
  // Fix 2 (BUG-01): AudioManager.playSound() owns the full lifecycle, so
  //   there is no manual restorePlaybackAudioMode() call in a completion
  //   callback that could reset the session under a concurrent sound.
  //
  // Fix 3 (BUG-03): No local msgSoundRef — AudioManager tracks the Sound
  //   object internally and cleans it up when the chime finishes naturally.
  const playMessageAlert = async () => {
    // FIX BUG-02: do not touch the audio session while the ambient recorder
    // is capturing. isRecording() returns true when 'ambient_recorder' holds
    // RECORDING-priority focus (the highest priority level).
    if (AudioManager.isRecording()) return;

    try {
      await AudioManager.playSound(
        'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3',
        AudioPriority.ALERT,
        'message_alert',
        { isLooping: false, volume: 0.85, downloadFirst: true }
      );
    } catch (_) {}
  };

  // useFocusEffect: refresh all data every time the screen comes into focus
  useFocusEffect(
    useCallback(() => {
      initializeScreen();
      const repoll = async () => {
        try {
          const token = await getAuthToken();
          if (!token) return;
          const res = await axios.get(`${BACKEND_URL}/api/chat/unread-count`, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 8000,
          });
          const count: number = res.data?.count ?? 0;
          setUnreadMessages(count);
          prevUnreadRef.current = count;
        } catch (_) {}
      };
      repoll();
    }, [])
  );

  const initializeScreen = async () => {
    setLoading(true);
    console.log('[CivilHome] Initializing screen...');

    const token = await getAuthToken();
    console.log('[CivilHome] Token exists:', !!token);

    if (!token) {
      console.log('[CivilHome] No token found, redirecting to login');
      router.replace('/auth/login');
      return;
    }

    const metadata = await getUserMetadata();
    if (metadata.role === 'security') {
      router.replace('/security/home');
      return;
    }
    if (metadata.role === 'admin') {
      router.replace('/admin/dashboard');
      return;
    }

    try {
      const response = await axios.get(`${BACKEND_URL}/api/panic/status`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5000
      });
      const backendHasPanic = response.data?.is_active === true;

      if (backendHasPanic) {
        await AsyncStorage.setItem('active_panic', JSON.stringify({
          panic_id: response.data.panic_id,
          activated_at: response.data.activated_at
        }));
        setHasActivePanic(true);
        console.log('[CivilHome] Active panic found on backend, synced locally');
      } else {
        await AsyncStorage.multiRemove([
          'active_panic', 'panic_active', 'panic_started_at', 'panic_id',
        ]);
        setHasActivePanic(false);
        console.log('[CivilHome] No active panic on backend, cleared all local panic state');
      }
    } catch (err) {
      const activePanic = await AsyncStorage.getItem('active_panic');
      setHasActivePanic(!!activePanic);
      console.log('[CivilHome] Backend panic check failed, using local:', !!activePanic);
    }

    try {
      const customization = await AsyncStorage.getItem('app_customization');
      if (customization) {
        const { app_name, app_logo } = JSON.parse(customization);
        if (app_name) setAppDisplayName(app_name);
        if (app_logo) setAppDisplayIcon(app_logo);
      }
    } catch (e) {}

    await Promise.all([
      checkUserStatus(),
      checkPendingUploads(),
      loadMyReports()
    ]);
    setLoading(false);
  };

  const checkUserStatus = async () => {
    try {
      const metadata = await getUserMetadata();
      setIsPremium(metadata.isPremium);
      console.log('[CivilHome] Local metadata premium:', metadata.isPremium);

      const token = await getAuthToken();
      if (token) {
        try {
          const response = await axios.get(`${BACKEND_URL}/api/user/profile?t=${Date.now()}`, {
            headers: { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-cache' },
            timeout: 10000
          });

          console.log('[CivilHome] Backend profile response:', response.data?.is_premium);
          const backendPremium = response.data?.is_premium === true;
          setIsPremium(backendPremium);

          if (response.data?.full_name) {
            setUserName(response.data.full_name);
          }
          if (response.data?.profile_photo_url) {
            const url = response.data.profile_photo_url;
            setProfilePhoto(url.startsWith('http') ? url : `${BACKEND_URL}${url}`);
          }
        } catch (apiError: any) {
          console.log('[CivilHome] Could not verify with backend:', apiError?.response?.status);
          if (apiError?.response?.status === 401) {
            console.log('[CivilHome] Token invalid, clearing and redirecting');
            await clearAuthData();
            router.replace('/auth/login');
          }
        }
      }
    } catch (error) {
      console.error('[CivilHome] Error checking user status:', error);
    }
  };

  const loadMyReports = async () => {
    try {
      const token = await getAuthToken();
      if (!token) return;

      const response = await axios.get(`${BACKEND_URL}/api/report/my-reports?t=${Date.now()}`, {
        headers: { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-cache' },
        timeout: 10000
      });

      const reports: any[] = Array.isArray(response.data)
        ? response.data
        : (response.data?.reports || []);
      setTotalReportCount(reports.length);
      setMyReports(reports.slice(0, 3));
    } catch (error) {
      console.log('[CivilHome] Could not load reports:', error);
    }
  };

  const checkPendingUploads = async () => {
    const count = await getPendingCount();
    setPendingUploads(count);
  };

  const handleProcessQueue = async () => {
    const results = await processQueue();
    checkPendingUploads();
    Alert.alert('Upload Complete', `Processed ${results.length} items`);
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    console.log('[CivilHome] Pull-to-refresh triggered');
    try {
      await initializeScreen();
      console.log('[CivilHome] Refresh completed successfully');
    } catch (error) {
      console.error('[CivilHome] Refresh failed:', error);
      Alert.alert('Refresh Failed', 'Unable to refresh. Please check your internet connection.');
    } finally {
      setRefreshing(false);
    }
  }, []);

  const handlePanicPress = async () => {
    if (hasActivePanic) {
      try {
        const token = await getAuthToken();

        try {
          const taskRunning = await TaskManager.isTaskRegisteredAsync(PANIC_LOCATION_TASK).catch(() => false);
          if (taskRunning) {
            await Location.stopLocationUpdatesAsync(PANIC_LOCATION_TASK);
          }
        } catch (_) {}

        if (token) {
          await axios.post(
            `${BACKEND_URL}/api/panic/deactivate`,
            {},
            { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
          );
        }

        await AsyncStorage.multiRemove([
          'panic_active', 'panic_started_at', 'panic_id', 'active_panic',
        ]);

        await setNativePanicActive(false);
        console.log('[CivilHome] Native panic active flag set to FALSE');

        setHasActivePanic(false);

        Alert.alert(
          "You're Safe",
          "Panic deactivated. Security has been notified that you are safe."
        );
      } catch (err: any) {
        if (err?.response?.status === 401) {
          await clearAuthData();
          router.replace('/auth/login');
        } else {
          Alert.alert('Error', 'Failed to deactivate. Please try again.');
        }
      }
    } else {
      router.push('/civil/panic-active');
    }
  };

  const handleLogout = async () => {
    Alert.alert('Logout', 'Are you sure you want to logout?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Logout',
        style: 'destructive',
        onPress: async () => {
          console.log('[CivilHome] Logout initiated');
          // FIX SOUND-CLASH: stop all AudioManager-tracked sounds before clearing
          // auth so no orphan sounds bleed into the next dashboard session.
          await AudioManager.stopAll();
          await clearAuthData(); // also calls AudioManager.stopAll() internally
          router.replace('/auth/login');
        }
      }
    ]);
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#3B82F6" />
          <Text style={styles.loadingText}>Loading...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="#6366F1"
              colors={['#6366F1', '#8B5CF6', '#A78BFA']}
              progressBackgroundColor="#1E293B"
            />
          }
        >
        <View style={styles.header}>
          <View>
            <Text style={styles.greeting}>Hello! {userName ? userName.split(' ')[0] : 'User'}</Text>
            <Text style={styles.subGreeting}>Stay safe with {appDisplayName}</Text>
          </View>
          <View style={styles.headerRight}>
            <View style={styles.shakeIndicator}>
              <Ionicons name="radio" size={14} color="#10B981" />
              <Text style={styles.shakeIndicatorText}>SHAKE</Text>
            </View>
            <TouchableOpacity onPress={() => router.push('/settings')}>
              {profilePhoto ? (
                <Image source={{ uri: profilePhoto }} style={styles.headerAvatar} />
              ) : (
                <Ionicons name="settings-outline" size={28} color="#fff" />
              )}
            </TouchableOpacity>
          </View>
        </View>

        <TouchableOpacity
          style={[styles.panicButton, hasActivePanic && styles.panicButtonActive]}
          onPress={handlePanicPress}
        >
          <Ionicons name={hasActivePanic ? "shield-checkmark" : "alert-circle"} size={48} color="#fff" />
          <Text style={styles.panicText}>
            {hasActivePanic ? "I'm Safe Now" : 'PANIC BUTTON'}
          </Text>
          <Text style={styles.panicSubtext}>
            {hasActivePanic ? 'Tap to stop tracking' : 'Tap in emergency'}
          </Text>
        </TouchableOpacity>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Quick Actions</Text>
          <View style={styles.actionsGrid}>
            <TouchableOpacity style={styles.actionCard} onPress={() => router.push('/report')}>
              <View style={[styles.actionIcon, { backgroundColor: '#10B98120' }]}>
                <Ionicons name="videocam" size={28} color="#10B981" />
              </View>
              <Text style={styles.actionText}>Video Report</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionCard} onPress={() => router.push('/report/audio')}>
              <View style={[styles.actionIcon, { backgroundColor: '#8B5CF620' }]}>
                <Ionicons name="mic" size={28} color="#8B5CF6" />
              </View>
              <Text style={styles.actionText}>Audio Report</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionCard}
              onPress={() => {
                if (isPremium) {
                  router.push('/civil/escort');
                } else {
                  Alert.alert(
                    'Premium Feature',
                    'Security Escort requires premium. Upgrade now?',
                    [
                      { text: 'Later', style: 'cancel' },
                      { text: 'Upgrade', onPress: () => router.push('/premium') }
                    ]
                  );
                }
              }}
            >
              <View style={[styles.actionIcon, { backgroundColor: '#3B82F620' }]}>
                <Ionicons name="walk" size={28} color="#3B82F6" />
              </View>
              <Text style={styles.actionText}>Security Escort</Text>
              {!isPremium && <Text style={styles.premiumBadge}>⭐ Premium</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionCard} onPress={() => router.push('/civil/messages')}>
              <View style={[styles.actionIcon, { backgroundColor: '#F59E0B20' }]}>
                <Ionicons name="chatbubbles" size={28} color="#F59E0B" />
                {unreadMessages > 0 && (
                  <View style={styles.msgBadge}>
                    <Text style={styles.msgBadgeText}>
                      {unreadMessages > 99 ? '99+' : unreadMessages}
                    </Text>
                  </View>
                )}
              </View>
              <Text style={styles.actionText}>Message Centre</Text>
              {unreadMessages > 0 && (
                <Text style={styles.msgBadgeLabel}>{unreadMessages} unread</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>My Reports ({totalReportCount})</Text>
            <TouchableOpacity onPress={() => router.push('/report/list')}>
              <Text style={styles.viewAll}>View All</Text>
            </TouchableOpacity>
          </View>
          {myReports.length === 0 ? (
            <Text style={styles.placeholderText}>Your submitted reports will appear here</Text>
          ) : (
            myReports.map((report: any) => (
              <View key={report.id || report._id} style={styles.reportItem}>
                <Ionicons
                  name={report.type === 'video' ? 'videocam' : 'mic'}
                  size={20}
                  color={report.type === 'video' ? '#10B981' : '#8B5CF6'}
                />
                <View style={styles.reportInfo}>
                  <Text style={styles.reportType}>{report.type?.toUpperCase()} Report</Text>
                  <Text style={styles.reportDate}>
                    {new Date(report.created_at).toLocaleDateString()}
                  </Text>
                </View>
                <View style={[styles.statusBadge, (report.file_url && !report.file_url.startsWith('file://')) ? styles.uploadedBadge : styles.pendingBadge]}>
                  <Text style={styles.statusBadgeText}>
                    {(report.file_url && !report.file_url.startsWith('file://')) ? 'Uploaded' : 'Pending'}
                  </Text>
                </View>
              </View>
            ))
          )}
        </View>

        {pendingUploads > 0 && (
          <View style={styles.section}>
            <View style={styles.pendingCard}>
              <Ionicons name="cloud-upload" size={24} color="#F59E0B" />
              <Text style={styles.pendingText}>{pendingUploads} pending upload(s)</Text>
              <TouchableOpacity style={styles.uploadButton} onPress={handleProcessQueue}>
                <Text style={styles.uploadButtonText}>Upload Now</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
          <Ionicons name="log-out-outline" size={24} color="#EF4444" />
          <Text style={styles.logoutText}>Logout</Text>
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F172A' },
  scrollContent: { flexGrow: 1 },
  loadingContainer:    { flex: 1, justifyContent: 'center', alignItems: 'center' },
  headerRight:         { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerAvatar:        { width: 36, height: 36, borderRadius: 18, borderWidth: 2, borderColor: '#3B82F6' },
  shakeIndicator:      { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#10B98115', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: '#10B98130' },
  shakeIndicatorText:  { fontSize: 9, color: '#10B981', fontWeight: '700', letterSpacing: 1.5 },
  loadingText: { color: '#94A3B8', marginTop: 12 },
  scrollView: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20 },
  greeting: { fontSize: 28, fontWeight: 'bold', color: '#fff' },
  subGreeting: { fontSize: 16, color: '#94A3B8', marginTop: 4 },
  panicButton: { margin: 20, backgroundColor: '#EF4444', borderRadius: 24, padding: 32, alignItems: 'center' },
  panicButtonActive: { backgroundColor: '#10B981' },
  panicText: { fontSize: 24, fontWeight: 'bold', color: '#fff', marginTop: 12 },
  panicSubtext: { fontSize: 14, color: '#ffffff90', marginTop: 4 },
  section: { padding: 20, paddingTop: 0 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  sectionTitle: { fontSize: 20, fontWeight: '600', color: '#fff', marginBottom: 12 },
  viewAll: { fontSize: 14, color: '#3B82F6', fontWeight: '600' },
  actionsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  actionCard: { width: '47%', backgroundColor: '#1E293B', borderRadius: 16, padding: 16, alignItems: 'center' },
  actionIcon: { width: 56, height: 56, borderRadius: 16, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  actionText: { fontSize: 14, color: '#fff', fontWeight: '500', textAlign: 'center' },
  premiumBadge: { fontSize: 11, color: '#F59E0B', marginTop: 4 },
  msgBadge: { position: 'absolute', top: -4, right: -4, backgroundColor: '#EF4444', borderRadius: 10, minWidth: 20, height: 20, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 4, borderWidth: 2, borderColor: '#0F172A' },
  msgBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  msgBadgeLabel: { fontSize: 11, color: '#EF4444', fontWeight: '700', marginTop: 2 },
  placeholderText: { fontSize: 14, color: '#64748B', textAlign: 'center', paddingVertical: 20 },
  reportItem: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E293B', padding: 12, borderRadius: 12, marginBottom: 8, gap: 12 },
  reportInfo: { flex: 1 },
  reportType: { fontSize: 14, fontWeight: '500', color: '#fff' },
  reportDate: { fontSize: 12, color: '#64748B' },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  uploadedBadge: { backgroundColor: '#10B98120' },
  pendingBadge: { backgroundColor: '#F59E0B20' },
  statusBadgeText: { fontSize: 12, fontWeight: '600', color: '#10B981' },
  pendingCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F59E0B20', borderRadius: 12, padding: 16, gap: 12 },
  pendingText: { flex: 1, fontSize: 14, color: '#F59E0B', fontWeight: '500' },
  uploadButton: { backgroundColor: '#F59E0B', paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8 },
  uploadButtonText: { color: '#fff', fontWeight: '600' },
  logoutButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 16, marginHorizontal: 20, backgroundColor: '#1E293B', borderRadius: 12, gap: 8 },
  logoutText: { fontSize: 16, color: '#EF4444', fontWeight: '600' },
});
