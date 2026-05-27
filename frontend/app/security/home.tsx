import React, { useState, useEffect, useRef, useCallback } from 'react';
import AsyncStorage from '../../utils/asyncStorageShim';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, TextInput, ActivityIndicator, BackHandler, AppState, AppStateStatus, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import axios from 'axios';
import { getAuthToken, clearAuthData, getUserMetadata } from '../../utils/auth';
import BACKEND_URL from '../../utils/config';
import { AudioManager, AudioPriority } from '../../utils/AudioManager';


export default function SecurityHome() {
  const router = useRouter();
  const [teamLocation, setTeamLocation] = useState<any>(null);
  const [nearbyReports, setNearbyReports] = useState([]);
  const [nearbyPanics, setNearbyPanics] = useState([]);
  const [radiusKm, setRadiusKm] = useState(10);
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(true);
  const [searchLoading, setSearchLoading] = useState(false);
  const [agentName, setAgentName] = useState('Agent');
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [messageSoundEnabled, setMessageSoundEnabled] = useState(true);
  const [responseStats, setResponseStats] = useState<{
    my_avg_seconds: number | null;
    team_avg_seconds: number | null;
    my_response_count: number;
    team_response_count: number;
  } | null>(null);

  // DEBUG: Log nearby panics data whenever it changes
  useEffect(() => {
    console.log('[SecurityHome] nearbyPanics updated:', JSON.stringify(nearbyPanics, null, 2));
    const unrespondedCount = nearbyPanics.filter(p => !p.first_responder_id).length;
    const respondedCount = nearbyPanics.filter(p => p.first_responder_id).length;
    console.log(`[SecurityHome] Total: ${nearbyPanics.length}, Unresponded: ${unrespondedCount}, Responded: ${respondedCount}`);
  }, [nearbyPanics]);

  // ── Unread message polling (every 15 s) with sound alert ─────────────────
  useEffect(() => {
    // Load sound preference from AsyncStorage
    const loadSoundPreference = async () => {
      try {
        const enabled = await AsyncStorage.getItem('msg_sound_enabled');
        setMessageSoundEnabled(enabled !== 'false'); // Default ON
      } catch (_) {}
    };
    loadSoundPreference();

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

        // Play sound alert when new messages arrive
        if (count > prevUnreadRef.current && messageSoundEnabled) {
          playMessageAlert();
        }
        prevUnreadRef.current = count;
      } catch (_) {}
    };
    poll();
    const id = setInterval(poll, 15000);
    return () => clearInterval(id);
  }, []);

  // ── Message sound alert function ─────────────────────────────────────────
  // FIX SOUND-CLASH: Route through AudioManager instead of calling
  // setAlertAudioMode() + Audio.Sound.createAsync() directly. The old pattern
  // bypassed AudioManager's singleton state, creating orphan sounds and
  // corrupting the audio session that persists across role-switches.
  // AudioManager.playSound() owns the full lifecycle (mode, playback, cleanup).
  const playMessageAlert = async () => {
    try {
      await AudioManager.playSound(
        'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3',
        AudioPriority.ALERT,
        'security_msg_alert',
        { isLooping: false, volume: 0.85, downloadFirst: true }
      );
    } catch (_) {}
  };

  // ── Panic alarm ──────────────────────────────────────────────────────────
  //
  // Design rules (leak-free):
  //
  // 1. The alarm is SCOPED TO THIS SCREEN ONLY via isFocusedRef.
  //    useFocusEffect starts it on focus and stops it on blur — no bleed into
  //    /security/panics, settings, chat, messages, or any other route.
  //
  // 2. stopAlarm() ALWAYS resets the AudioSession to safe defaults after
  //    unloading the sound.  This plugs the audio-mode leak: previously
  //    staysActiveInBackground:true persisted in the shared audio session
  //    across screens, role switches, and re-logins.
  //
  // 3. Cold-start / foreground-return: the AppState listener restarts the
  //    alarm when the app becomes active, but ONLY while this screen is
  //    focused (isFocusedRef guard).  The count-change effect is similarly
  //    guarded so arriving panics only ring here, not behind another route.
  //
  // 4. A new panic (count increase) overrides any prior silence so the agent
  //    cannot miss a fresh emergency.
  //
  // FIX SOUND-CLASH Bug-02: startAlarm() used to call requestFocus() then
  // create Audio.Sound directly outside AudioManager, leaving activeSound
  // null. stopAlarm() then called releaseFocus() which did nothing because
  // the guard this.activeSound && this.activeSound.tag === tag was false —
  // audio mode was never restored to standby and currentPriority stayed ALERT.
  //
  // FIX: ALL alarm lifecycle goes through AudioManager.playSound() /
  // AudioManager.releaseFocus(). AudioManager owns the sound reference,
  // activeSound.tag is tracked, and releaseFocus() works correctly.
  const [alarmOn, setAlarmOn] = useState(false);
  const alarmSilencedRef  = useRef(false);
  const lastPanicCountRef = useRef(0);
  const nearbyPanicsRef   = useRef<any[]>([]);
  const isFocusedRef      = useRef(false); // true only while this screen has nav focus
  const prevUnreadRef     = useRef(0);

  // Keep ref in sync for closure-safe reads
  useEffect(() => {
    nearbyPanicsRef.current = nearbyPanics;
  }, [nearbyPanics]);

  const startAlarm = async () => {
    // FIX SOUND-CLASH Bug-02: Delegate the ENTIRE alarm lifecycle to
    // AudioManager.playSound(). This keeps activeSound, currentPriority,
    // and the audio mode in sync. We never touch Audio.Sound directly
    // here — it is an implementation detail AudioManager manages.
    try {
      const sound = await AudioManager.playSound(
        'https://assets.mixkit.co/active_storage/sfx/212/212-preview.mp3',
        AudioPriority.ALERT,
        'security_alarm',
        { isLooping: true, volume: 1.0, downloadFirst: true }
      );
      if (sound) {
        setAlarmOn(true);
        console.log('[SecurityHome] Alarm started via AudioManager');
      }
    } catch (err) {
      console.warn('[SecurityHome] Could not start panic alarm:', err);
    }
  };

  const stopAlarm = async () => {
    // FIX SOUND-CLASH Bug-02: Now that startAlarm() delegates to
    // AudioManager.playSound(), the sound is stored in activeSound with
    // tag='security_alarm'. releaseFocus() will find it, stop it, unload it,
    // restore standby mode, and clear currentPriority — all correctly.
    await AudioManager.releaseFocus('security_alarm');
    setAlarmOn(false);
  };

  const silenceAlarm = async () => {
    await stopAlarm();
    alarmSilencedRef.current = true;
    // Track unresponded count so "new panic" detection after silence is accurate
    lastPanicCountRef.current = nearbyPanicsRef.current.filter((p: any) => !p.first_responder_id).length;
  };

  // React to panic count changes — guarded by isFocusedRef so this never
  // rings the alarm while the agent is on another screen.
  //
  // AUTO-DISARM FIX: The alarm keys off UNRESPONDED panic count, not total
  // panic count.  A panic with first_responder_id set means another officer
  // has already responded via "Message In-App".  The backend marks it and
  // the next 10-s poll returns the updated first_responder_id on ALL security
  // dashboards.  By counting only unresponded panics, the alarm automatically
  // silences on every dashboard as soon as that poll lands — without requiring
  // each officer to manually silence it.
  const unrespondedPanics = (nearbyPanics as any[]).filter(p => !p.first_responder_id);

  useEffect(() => {
    const count = unrespondedPanics.length;
    if (count === 0) {
      // All panics responded to (or none active) — disarm on this dashboard
      stopAlarm();
      alarmSilencedRef.current = false;
      lastPanicCountRef.current = 0;
      return;
    }
    const newArrived = count > lastPanicCountRef.current;
    if (newArrived) {
      // New unresponded panic — override any existing silence so agent cannot miss it
      alarmSilencedRef.current = false;
      lastPanicCountRef.current = count;
    }
    if ((!alarmSilencedRef.current || newArrived) && isFocusedRef.current) {
      // ALARM BLEED FIX: Defer startAlarm by one tick to let the navigation
      // transition settle.  During a transition isFocusedRef.current is still
      // true for a brief window after the user has effectively left the screen.
      // Re-checking isFocusedRef inside the timeout closes that race window so
      // the alarm never fires on a screen the officer has already navigated away from.
      const t = setTimeout(() => {
        if (isFocusedRef.current) startAlarm();
      }, 150);
      return () => clearTimeout(t);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unrespondedPanics.length]);

  // ── Screen focus/blur — primary alarm lifecycle gate ─────────────────────
  // ON FOCUS : restart alarm if unsilenced panics exist (covers cold-start,
  //            app foreground from notification, return from any sub-route).
  // ON BLUR  : stop alarm + reset audio mode.  This is the core fix that
  //            prevents the alarm from bleeding to any other screen.
  useFocusEffect(
    useCallback(() => {
      isFocusedRef.current = true;

      // ALARM STALE-REF FIX: Always re-fetch nearby data on focus before
      // deciding whether to (re)start the alarm. Without this, nearbyPanicsRef
      // holds the state from before the officer navigated away — so a panic
      // that was responded to inside /security/panics still appears unresponded
      // here, causing the alarm to restart the moment the officer returns home.
      //
      // The existing unrespondedPanics effect will fire with fresh data once
      // loadNearbyData() resolves and calls setNearbyPanics(), at which point
      // the count-based logic decides correctly whether to start or stop the alarm.
      loadNearbyData();

      return () => {
        isFocusedRef.current = false;
        stopAlarm(); // also resets AudioSession — zero bleed guarantee
      };
    }, [])
  );

  // ── AppState: refresh data on foreground only if this screen is focused ──
  // With staysActiveInBackground:false the OS suspends audio when backgrounded.
  // On foreground-return we re-fetch so the stale ref cannot trigger a phantom
  // alarm for a panic that was already responded to while the app was backgrounded.
  // The unrespondedPanics effect will (re)start the alarm only if fresh data
  // still shows unresponded panics.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active' && isFocusedRef.current) {
        loadNearbyData();
      }
    });
    return () => sub.remove();
  }, []);

  // ── Re-poll unread count on focus ─────────────────────────────────────────
  useFocusEffect(
    useCallback(() => {
      const pollUnread = async () => {
        try {
          const token = await getAuthToken();
          if (!token) return;
          const res = await axios.get(`${BACKEND_URL}/api/chat/unread-count`, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 8000,
          });
          setUnreadMessages(res.data?.count ?? 0);
        } catch (_) {}
      };
      pollUnread();
      // Refresh response stats every time screen comes into focus so the card
      // stays accurate after the officer responds to panics on other screens.
      loadResponseStats();
      return () => {};
    }, [])
  );

  // ── Android back: exit app from home ─────────────────────────────────────
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      BackHandler.exitApp();
      return true;
    });
    return () => sub.remove();
  }, []);

  // Safety net: full cleanup on unmount (stopAlarm resets audio mode too)
  useEffect(() => { return () => { stopAlarm(); }; }, []);

  useEffect(() => {
    initializeScreen();
    const interval = setInterval(loadNearbyData, 10000);
    return () => clearInterval(interval);
  }, []);

  const initializeScreen = async () => {
    setLoading(true);

    const token = await getAuthToken();
    if (!token) {
      router.replace('/auth/login');
      return;
    }

    // FIX (session-bleed): enforce role — a civil or admin user who somehow
    // lands on /security/home must be redirected to their own dashboard.
    const metadata = await getUserMetadata();
    if (metadata.role === 'civil') {
      router.replace('/civil/home');
      return;
    }
    if (metadata.role === 'admin') {
      router.replace('/admin/dashboard');
      return;
    }
    setCurrentUserId(metadata?.userId || null);

    await loadAgentProfile();
    await loadTeamLocation();
    await loadNearbyData();
    loadResponseStats(); // non-blocking — card renders when ready
    setLoading(false);
  };

  const loadResponseStats = async () => {
    try {
      const token = await getAuthToken();
      if (!token) return;
      const res = await axios.get(`${BACKEND_URL}/api/security/response-stats`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 10000,
      });
      setResponseStats(res.data);
    } catch (_) {}
  };

  const loadAgentProfile = async () => {
    try {
      const token = await getAuthToken();
      if (!token) return;
      
      const response = await axios.get(`${BACKEND_URL}/api/user/profile`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000
      });
      if (response.data?.full_name) {
        const firstName = response.data.full_name.split(' ')[0];
        setAgentName(firstName);
      }
    } catch (error) {
      console.log('[SecurityHome] Could not load profile');
    }
  };

  const loadTeamLocation = async () => {
    try {
      const token = await getAuthToken();
      if (!token) return;
      
      const response = await axios.get(`${BACKEND_URL}/api/security/team-location`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000
      });
      setTeamLocation(response.data);
      setRadiusKm(response.data.radius_km || 10);
    } catch (error: any) {
      if (error?.response?.status === 401) {
        await clearAuthData();
        router.replace('/auth/login');
      }
    }
  };

  const loadNearbyData = async () => {
    try {
      const token = await getAuthToken();
      if (!token) return;
      
      const [reportsRes, panicsRes] = await Promise.all([
        axios.get(`${BACKEND_URL}/api/security/nearby-reports`, { 
          headers: { Authorization: `Bearer ${token}` },
          timeout: 15000 
        }),
        axios.get(`${BACKEND_URL}/api/security/nearby-panics`, { 
          headers: { Authorization: `Bearer ${token}` },
          timeout: 15000 
        })
      ]);
      setNearbyReports(reportsRes.data || []);
      console.log('[loadNearbyData] Received panics:', JSON.stringify(panicsRes.data, null, 2));
      setNearbyPanics(panicsRes.data || []);
    } catch (error: any) {
      if (error?.response?.status === 401) {
        await clearAuthData();
        router.replace('/auth/login');
      }
    }
  };

  const handleSearch = async () => {
    if (!searchTerm.trim()) {
      Alert.alert('Error', 'Please enter phone or email');
      return;
    }

    setSearchLoading(true);
    try {
      const token = await getAuthToken();
      if (!token) {
        router.replace('/auth/login');
        return;
      }
      
      const response = await axios.get(
        `${BACKEND_URL}/api/security/search-user?query=${encodeURIComponent(searchTerm.trim())}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 15000,
        }
      );
      
      router.push({
        pathname: '/security/user-track',
        params: { userData: JSON.stringify(response.data) }
      });
    } catch (error: any) {
      if (error?.response?.status === 401) {
        Alert.alert('Session Expired', 'Please login again');
        await clearAuthData();
        router.replace('/auth/login');
      } else {
        Alert.alert('Not Found', error.response?.data?.detail || 'User not found');
      }
    } finally {
      setSearchLoading(false);
    }
  };

  const handleLogout = async () => {
    Alert.alert(
      'Logout',
      'Are you sure you want to logout?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Logout',
          style: 'destructive',
          onPress: async () => {
            await stopAlarm(); // stops alarm + releases focus via AudioManager
            // FIX SOUND-CLASH: full AudioManager teardown before logout so
            // no orphan sounds or stale audio modes survive into the next session.
            await AudioManager.stopAll();
            await clearAuthData(); // clearAuthData also calls AudioManager.stopAll()
            router.replace('/auth/login');
          }
        }
      ]
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#3B82F6" />
          <Text style={styles.loadingText}>Loading Dashboard...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View>
              <Text style={styles.greeting}>Hello, Agent {agentName}</Text>
              <Text style={styles.appName}>Security Dashboard</Text>
            </View>
          </View>
          {alarmOn ? (
            <TouchableOpacity style={styles.silenceBtn} onPress={silenceAlarm}>
              <Ionicons name="volume-mute" size={18} color="#fff" />
              <Text style={styles.silenceBtnText}>Silence</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.settingsButton} onPress={handleLogout}>
              <Ionicons name="log-out-outline" size={24} color="#fff" />
            </TouchableOpacity>
          )}
        </View>

        {alarmOn && (
          <TouchableOpacity
            style={styles.alarmBanner}
            onPress={() => router.push('/security/panics')}
            activeOpacity={0.85}
          >
            <Ionicons name="alarm" size={18} color="#fff" />
            <Text style={styles.alarmBannerText}>
              🔴 {unrespondedPanics.length} ACTIVE PANIC{unrespondedPanics.length !== 1 ? 'S' : ''} — Tap to respond
            </Text>
            <Ionicons name="chevron-forward" size={18} color="#ffffff90" />
          </TouchableOpacity>
        )}

        {(!teamLocation || (teamLocation.latitude === 0 && teamLocation.longitude === 0)) && (
          <View style={styles.warningBanner}>
            <Ionicons name="warning" size={24} color="#F59E0B" />
            <Text style={styles.warningText}>
              ⚠️ Set your team location to see nearby panics and reports!
            </Text>
          </View>
        )}

        <View style={styles.quickActions}>
          <TouchableOpacity style={styles.quickAction} onPress={() => router.push('/security/nearby')}>
            <View style={[styles.quickActionIcon, { backgroundColor: '#F59E0B20' }]}>
              <Ionicons name="people" size={24} color="#F59E0B" />
            </View>
            <Text style={styles.quickActionText}>Nearby</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.quickAction} onPress={() => router.push('/security/messages')}>
            <View style={[styles.quickActionIcon, { backgroundColor: '#3B82F620' }]}>
              <Ionicons name="chatbubbles" size={24} color="#3B82F6" />
              {unreadMessages > 0 && (
                <View style={styles.msgBadge}>
                  <Text style={styles.msgBadgeText}>{unreadMessages > 99 ? '99+' : unreadMessages}</Text>
                </View>
              )}
            </View>
            <Text style={styles.quickActionText}>Message Centre</Text>
            {unreadMessages > 0 && (
              <Text style={styles.msgBadgeLabel}>{unreadMessages} unread</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.quickAction} onPress={() => router.push('/security/escort-sessions')}>
            <View style={[styles.quickActionIcon, { backgroundColor: '#10B98120' }]}>
              <Ionicons name="navigate" size={24} color="#10B981" />
            </View>
            <Text style={styles.quickActionText}>Escorts</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.quickAction} onPress={() => router.push('/security/settings')}>
            <View style={[styles.quickActionIcon, { backgroundColor: '#8B5CF620' }]}>
              <Ionicons name="settings" size={24} color="#8B5CF6" />
            </View>
            <Text style={styles.quickActionText}>Settings</Text>
          </TouchableOpacity>
        </View>
        
        <TouchableOpacity style={styles.locationCard} onPress={() => router.push('/security/set-location')}>
          <View style={styles.cardHeader}>
            <Ionicons name="location" size={32} color="#3B82F6" />
            <View style={styles.cardHeaderText}>
              <Text style={styles.cardTitle}>Team Location</Text>
              <Text style={styles.cardSubtitle}>
                {teamLocation && teamLocation.latitude !== 0 ? `Radius: ${radiusKm}km` : '⚠️ Not Set - Click to Set'}
              </Text>
            </View>
          </View>
          <Text style={styles.cardAction}>Tap to set/update location</Text>
        </TouchableOpacity>

        <View style={styles.searchCard}>
          <Text style={styles.sectionTitle}>Search & Track User</Text>
          <View style={styles.searchContainer}>
            <Ionicons name="search" size={20} color="#64748B" />
            <TextInput
              style={styles.searchInput}
              placeholder="Phone or Email"
              placeholderTextColor="#64748B"
              value={searchTerm}
              onChangeText={setSearchTerm}
              autoCapitalize="none"
              onSubmitEditing={handleSearch}
              returnKeyType="search"
            />
            <TouchableOpacity style={styles.searchButton} onPress={handleSearch} disabled={searchLoading}>
              {searchLoading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="arrow-forward" size={20} color="#fff" />
              )}
            </TouchableOpacity>
          </View>
        </View>


        {/* ── All Nearby Panics (responded + unresponded) ─────────────────── */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>🚨 Nearby Panics ({nearbyPanics.length})</Text>
            <TouchableOpacity onPress={() => router.push('/security/panics')}>
              <Text style={styles.viewAll}>View All</Text>
            </TouchableOpacity>
          </View>
          {nearbyPanics.length === 0 ? (
            <Text style={styles.emptyText}>No active panics nearby</Text>
          ) : (
            nearbyPanics.slice(0, 5).map((panic: any) => {
              const isMe = panic.first_responder_id === currentUserId;
              const isOther = panic.first_responder_id && !isMe;
              const hasResponded = !!panic.first_responder_id;
              const iconColor = hasResponded ? '#10B981' : '#EF4444';
              const borderColor = hasResponded ? '#10B981' : '#EF4444';
              const cardBgColor = hasResponded ? '#0F172A' : '#1E293B';
              const statusText = isMe ? 'You responded' : isOther ? `${panic.first_responder_name}` : 'Unresponded';
              const statusColor = hasResponded ? '#10B981' : '#F59E0B';
              // Resolve user photo URL
              const userPhotoUrl = panic.user_photo_url
                ? (panic.user_photo_url.startsWith('http')
                  ? panic.user_photo_url
                  : `${BACKEND_URL}${panic.user_photo_url.startsWith('/') ? '' : '/'}${panic.user_photo_url}`)
                : '';
              return (
                <TouchableOpacity
                  key={panic.id}
                  style={[styles.panicCard, { borderLeftColor: borderColor, backgroundColor: cardBgColor }]}
                  onPress={() => router.push('/security/panics')}
                >
                  <View style={styles.panicCardLeft}>
                    {userPhotoUrl ? (
                      <Image source={{ uri: userPhotoUrl }} style={styles.panicAvatar} />
                    ) : (
                      <Ionicons name={hasResponded ? 'checkmark-circle' : 'alert-circle'} size={28} color={iconColor} />
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={styles.panicEmail}>
                        {panic.full_name || panic.user_email}
                      </Text>
                      <Text style={[styles.panicStatusText, { color: statusColor, fontWeight: '600' }]}>
                        {hasResponded ? `✓ ${statusText}` : statusText}
                      </Text>
                    </View>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color="#64748B" />
                </TouchableOpacity>
              );
            })
          )}
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Nearby Reports ({nearbyReports.length})</Text>
            <TouchableOpacity onPress={() => router.push('/security/reports')}>
              <Text style={styles.viewAll}>View All</Text>
            </TouchableOpacity>
          </View>
          {nearbyReports.length === 0 ? (
            <Text style={styles.emptyText}>No reports in your area</Text>
          ) : (
            nearbyReports.slice(0, 3).map((report: any) => (
              <TouchableOpacity
                key={report.id}
                style={styles.reportCard}
                onPress={() => router.push('/security/reports')}
              >
                <Ionicons
                  name={report.type === 'video' ? 'videocam' : 'mic'}
                  size={24}
                  color={report.type === 'video' ? '#10B981' : '#8B5CF6'}
                />
                <View style={styles.reportInfo}>
                  <Text style={styles.reportType}>{report.type.toUpperCase()} Report</Text>
                  <Text style={styles.reportCaption} numberOfLines={1}>
                    {report.caption || 'No caption'}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color="#64748B" />
              </TouchableOpacity>
            ))
          )}
        </View>
        {/* ── Response Time Score Card ── sits at the bottom per UX requirement ── */}
        {responseStats && (
          <View style={[styles.statsCard, { marginBottom: 8 }]}>
            <View style={styles.statsHeader}>
              <Ionicons name="timer-outline" size={18} color="#3B82F6" />
              <Text style={styles.statsTitle}>Response Time Score</Text>
              <Text style={styles.statsPeriod}>Last 90 days</Text>
            </View>
            <View style={styles.statsRow}>
              <View style={styles.statBox}>
                <Text style={styles.statValue}>
                  {responseStats.my_avg_seconds == null
                    ? '—'
                    : responseStats.my_avg_seconds < 60
                      ? `${responseStats.my_avg_seconds}s`
                      : `${Math.round(responseStats.my_avg_seconds / 60)} min`}
                </Text>
                <Text style={styles.statLabel}>My Avg</Text>
                <Text style={styles.statSub}>{responseStats.my_response_count} response{responseStats.my_response_count !== 1 ? 's' : ''}</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statBox}>
                <Text style={[styles.statValue, { color: '#F59E0B' }]}>
                  {responseStats.team_avg_seconds == null
                    ? '—'
                    : responseStats.team_avg_seconds < 60
                      ? `${responseStats.team_avg_seconds}s`
                      : `${Math.round(responseStats.team_avg_seconds / 60)} min`}
                </Text>
                <Text style={styles.statLabel}>Team Avg</Text>
                <Text style={styles.statSub}>{responseStats.team_response_count} total</Text>
              </View>
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F172A' },
  scrollContent: { padding: 20 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },

  greeting: { fontSize: 16, color: '#94A3B8' },
  appName: { fontSize: 28, fontWeight: 'bold', color: '#fff', marginTop: 4 },
  settingsButton: { padding: 8 },
  silenceBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#EF444430', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: 1, borderColor: '#EF4444' },
  silenceBtnText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  alarmBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#EF4444', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, marginBottom: 16 },
  alarmBannerText: { flex: 1, fontSize: 13, fontWeight: '700', color: '#fff' },
  warningBanner: { backgroundColor: '#FEF3C7', borderRadius: 12, padding: 16, marginBottom: 16, flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: '#F59E0B' },
  warningText: { flex: 1, fontSize: 14, color: '#92400E', fontWeight: '600' },
  quickActions: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 24 },
  quickAction: { alignItems: 'center', gap: 8 },
  quickActionIcon: { width: 56, height: 56, borderRadius: 16, justifyContent: 'center', alignItems: 'center' },
  quickActionText: { fontSize: 12, color: '#94A3B8', fontWeight: '500' },
  msgBadge: { position: 'absolute', top: -4, right: -4, backgroundColor: '#EF4444', borderRadius: 10, minWidth: 20, height: 20, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 4, borderWidth: 2, borderColor: '#0F172A' },
  msgBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  msgBadgeLabel: { fontSize: 11, color: '#EF4444', fontWeight: '700', marginTop: 2 },
  locationCard: { backgroundColor: '#1E293B', borderRadius: 16, padding: 20, marginBottom: 24, borderWidth: 2, borderColor: '#3B82F6' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 12 },
  cardHeaderText: { flex: 1 },
  cardTitle: { fontSize: 18, fontWeight: '600', color: '#fff', marginBottom: 4 },
  cardSubtitle: { fontSize: 14, color: '#94A3B8' },
  cardAction: { fontSize: 14, color: '#3B82F6', marginTop: 8 },
  searchCard: { backgroundColor: '#1E293B', borderRadius: 16, padding: 20, marginBottom: 24 },
  searchContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0F172A', borderRadius: 12, paddingHorizontal: 16, marginTop: 12, borderWidth: 1, borderColor: '#334155' },
  searchInput: { flex: 1, color: '#fff', fontSize: 16, paddingVertical: 14, marginLeft: 12 },
  searchButton: { backgroundColor: '#3B82F6', borderRadius: 8, padding: 10 },
  section: { marginBottom: 32 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  sectionTitle: { fontSize: 18, fontWeight: '600', color: '#fff' },
  viewAll: { fontSize: 14, color: '#3B82F6', fontWeight: '600' },
  emptyText: { fontSize: 14, color: '#64748B', textAlign: 'center', paddingVertical: 24 },
  panicCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#1E293B', padding: 16, borderRadius: 12, marginBottom: 12, borderLeftWidth: 4, borderLeftColor: '#EF4444' },
  panicCardLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  panicAvatar: { width: 40, height: 40, borderRadius: 20, borderWidth: 2, borderColor: '#3B82F6' },
  panicEmail: { fontSize: 16, fontWeight: '600', color: '#fff', marginBottom: 4 },
  panicStatusText: { fontSize: 14, fontWeight: '600' },
  reportCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#1E293B', padding: 16, borderRadius: 12, marginBottom: 12 },
  reportInfo: { flex: 1 },
  reportType: { fontSize: 14, fontWeight: '600', color: '#fff', marginBottom: 4 },
  reportCaption: { fontSize: 12, color: '#94A3B8' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { color: '#94A3B8', marginTop: 16, fontSize: 16 },
  // Response Time Score card
  statsCard:    { backgroundColor: '#1E293B', borderRadius: 16, padding: 16, marginBottom: 24, borderWidth: 1, borderColor: '#3B82F630' },
  statsHeader:  { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  statsTitle:   { flex: 1, fontSize: 15, fontWeight: '600', color: '#fff' },
  statsPeriod:  { fontSize: 11, color: '#475569' },
  statsRow:     { flexDirection: 'row', alignItems: 'center' },
  statBox:      { flex: 1, alignItems: 'center' },
  statValue:    { fontSize: 26, fontWeight: '800', color: '#3B82F6' },
  statLabel:    { fontSize: 12, color: '#94A3B8', marginTop: 2, fontWeight: '600' },
  statSub:      { fontSize: 11, color: '#475569', marginTop: 2 },
  statDivider:  { width: 1, height: 48, backgroundColor: '#334155' },
});
