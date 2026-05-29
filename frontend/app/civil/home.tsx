import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, ActivityIndicator, BackHandler, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import { Audio } from 'expo-av';
import { getPendingCount, processQueue } from '../../utils/offlineQueue';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { getAuthToken, clearAuthData, getUserMetadata } from '../../utils/auth';
import BACKEND_URL from '../../utils/config';
import { setNativePanicActive } from '../../utils/nativePanicBridge';

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

  // ── Message sound alert (plays on new unread messages) ───────────────────
  const prevUnreadRef  = useRef(0);
  const msgSoundRef    = useRef<Audio.Sound | null>(null);

  // ── Android back: exit app from home (never go back to login) ────────────
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

        // Play sound alert when new messages arrive (if user hasn't disabled it)
        if (count > prevUnreadRef.current) {
          const soundEnabled = await AsyncStorage.getItem('msg_sound_enabled');
          // Default ON unless explicitly set to 'false'
          if (soundEnabled !== 'false') {
            playMessageAlert();
          }
        }
        prevUnreadRef.current = count;
      } catch (_) {}
    };

    poll(); // immediate on mount
    const id = setInterval(poll, 15000);
    return () => clearInterval(id);
  }, []);

  // Cleanup message sound on unmount
  useEffect(() => {
    return () => {
      if (msgSoundRef.current) {
        msgSoundRef.current.unloadAsync().catch(() => {});
        msgSoundRef.current = null;
      }
    };
  }, []);

  const playMessageAlert = async () => {
    try {
      // Unload previous instance first
      if (msgSoundRef.current) {
        await msgSoundRef.current.unloadAsync().catch(() => {});
        msgSoundRef.current = null;
      }
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true, staysActiveInBackground: false });
      const { sound } = await Audio.Sound.createAsync(
        { uri: 'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3' },
        { shouldPlay: true, volume: 0.85 }
      );
      msgSoundRef.current = sound;
      sound.setOnPlaybackStatusUpdate((status: any) => {
        if (status.isLoaded && status.didJustFinish) {
          sound.unloadAsync().catch(() => {});
          msgSoundRef.current = null;
          // FIX: Restore audio mode to neutral defaults once the alert tone
          // finishes. Without this, playsInSilentModeIOS:true persists in the
          // shared AudioSession — if the user opens AudioReport immediately
          // after a message alert, the mic session inherits the wrong mode.
          Audio.setAudioModeAsync({
            allowsRecordingIOS:         false,
            playsInSilentModeIOS:       false,
            staysActiveInBackground:    false,
            shouldDuckAndroid:          true,
            playThroughEarpieceAndroid: false,
          }).catch(() => {});
        }
      });
    } catch (_) {}
  };

  // Refresh on every screen focus using expo-router's useFocusEffect
  useFocusEffect(
    useCallback(() => {
      initializeScreen();
      // Immediately re-poll unread count on focus so badge clears right after
      // the user reads messages and returns to home.
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
    
    // Check authentication first
    const token = await getAuthToken();
    console.log('[CivilHome] Token exists:', !!token);
    
    if (!token) {
      console.log('[CivilHome] No token found, redirecting to login');
      router.replace('/auth/login');
      return;
    }

    // Check for active panic - sync with backend first, then fallback to local storage
    try {
      const response = await axios.get(`${BACKEND_URL}/api/panic/status`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5000
      });
      const backendHasPanic = response.data?.is_active === true;
      
      if (backendHasPanic) {
        // Sync local storage with backend
        await AsyncStorage.setItem('active_panic', JSON.stringify({
          panic_id: response.data.panic_id,
          activated_at: response.data.activated_at
        }));
        setHasActivePanic(true);
        console.log('[CivilHome] Active panic found on backend, synced locally');
      } else {
        // No active panic on backend — clear ALL panic keys so the
        // escape-hatch in panic-active.tsx doesn't bounce the user away
        await AsyncStorage.multiRemove([
          'active_panic', 'panic_active', 'panic_started_at', 'panic_id',
        ]);
        setHasActivePanic(false);
        console.log('[CivilHome] No active panic on backend, cleared all local panic state');
      }
    } catch (err) {
      // Fallback to local storage if backend check fails
      const activePanic = await AsyncStorage.getItem('active_panic');
      setHasActivePanic(!!activePanic);
      console.log('[CivilHome] Backend panic check failed, using local:', !!activePanic);
    }

    // Load app customization
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
      
      // Backend returns { reports: [...] } — unwrap the array
      const reports: any[] = Array.isArray(response.data)
        ? response.data
        : (response.data?.reports || []);
      setTotalReportCount(reports.length);
      setMyReports(reports.slice(0, 3)); // Show first 3 reports in preview
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

  const handlePanicPress = async () => {
    if (hasActivePanic) {
      // Deactivate directly — no confirmation dialog exposed to bystanders
      try {
        const token = await getAuthToken();

        // Stop background GPS task
        try {
          const taskRunning = await TaskManager.isTaskRegisteredAsync(PANIC_LOCATION_TASK).catch(() => false);
          if (taskRunning) {
            await Location.stopLocationUpdatesAsync(PANIC_LOCATION_TASK);
          }
        } catch (_) {}

        // Deactivate on backend
        if (token) {
          await axios.post(
            `${BACKEND_URL}/api/panic/deactivate`,
            {},
            { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
          );
        }

        // Clear all local panic state IMMEDIATELY before updating UI
        await AsyncStorage.multiRemove([
          'panic_active', 'panic_started_at', 'panic_id', 'active_panic',
        ]);

        // Update local state FIRST, then sync with backend
        setHasActivePanic(false);

        // CRITICAL FIX: Tell native service that panic is no longer active
        await setNativePanicActive(false);
        console.log('[CivilHome] Native panic active flag set to FALSE');

        // Force re-check with backend to ensure sync
        // This handles any race conditions where backend state wasn't updated yet
        if (token) {
          try {
            const statusRes = await axios.get(`${BACKEND_URL}/api/panic/status`, {
              headers: { Authorization: `Bearer ${token}` },
              timeout: 10000
            });
            const backendHasPanic = statusRes.data?.is_active === true;
            if (backendHasPanic) {
              // Backend still has active panic - this means deactivate failed silently
              // Retry deactivate once
              console.log('[CivilHome] Backend still has panic, retrying deactivate');
              await axios.post(
                `${BACKEND_URL}/api/panic/deactivate`,
                {},
                { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
              );
              // Verify after retry
              const retryRes = await axios.get(`${BACKEND_URL}/api/panic/status`, {
                headers: { Authorization: `Bearer ${token}` },
                timeout: 10000
              });
              if (retryRes.data?.is_active !== true) {
                setHasActivePanic(false);
              }
            } else {
              setHasActivePanic(false);
            }
          } catch (syncErr) {
            // Network error - trust local state since we cleared it
            console.log('[CivilHome] Backend sync check failed, trusting local state');
          }
        }
      } catch (err: any) {
        if (err?.response?.status === 401) {
          await clearAuthData();
          router.replace('/auth/login');
        } else {
          Alert.alert('Error', 'Failed to deactivate. Please try again.');
        }
      }
    } else {
      // Start new panic — navigate directly to category picker
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
          await clearAuthData();
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
      <ScrollView style={styles.scrollView}>
        <View style={styles.header}>
          <View>
            <Text style={styles.greeting}>Hello! {userName ? userName.split(' ')[0] : 'User'}</Text>
            <Text style={styles.subGreeting}>Stay safe with {appDisplayName}</Text>
          </View>
          <View style={styles.headerRight}>
            {/* Shake-to-panic active indicator */}
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

        {/* Panic Button */}
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

        {/* Quick Actions */}
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

        {/* My Reports Preview */}
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

        {/* Pending Uploads */}
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

        {/* Logout */}
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
