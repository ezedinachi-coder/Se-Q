/**
 * admin/panics.tsx
 *
 * EXACT copy of security/panics.tsx — every card, GPS trail, audio player,
 * respond modal and style is identical.
 *
 * Admin-only deltas (only these things differ from security/panics.tsx):
 *   1. API endpoint  : /api/admin/all-panics  (security uses /api/security/nearby-panics)
 *   2. Response shape: res.data.panics        (security uses res.data directly)
 *   3. Auth redirect : /admin/login           (security uses /auth/login)
 *   4. Back nav      : /admin/dashboard       (security uses /security/home)
 *   5. Poll interval : 15 s                   (security uses 10 s)
 *   6. BackHandler   : Android back → dashboard
 *   7. RefreshControl: pull-to-refresh
 *   8. Date-range filter + Active-only toggle in header
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  ActivityIndicator, Alert, Linking, Platform, Modal,
  TextInput, KeyboardAvoidingView, BackHandler, RefreshControl, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import axios from 'axios';
import { getAuthToken, clearAuthData } from '../../utils/auth';
import { LocationMapModal } from '../../components/LocationMapModal';
import { TrailMapModal } from '../../components/TrailMapModal';
import BACKEND_URL from '../../utils/config';
import { AudioManager, AudioPriority } from '../../utils/AudioManager';

// ── Admin-only types ──────────────────────────────────────────────────────────
type DateFilter = 'all' | 'today' | 'last_week' | 'last_month' | 'last_3_months';

const DATE_LABELS: Record<DateFilter, string> = {
  all: 'All Time', today: 'Today', last_week: 'Last 7 Days',
  last_month: 'Last Month', last_3_months: 'Last 3 Months',
};

// Poll every 15 seconds (admin — slightly slower than security's 10 s)
const POLL_INTERVAL = 15000;

const EMERGENCY_CATEGORIES: Record<string, { label: string; icon: string; color: string }> = {
  violence:   { label: 'Violence/Assault',       icon: 'alert-circle', color: '#EF4444' },
  robbery:    { label: 'Armed Robbery',           icon: 'warning',      color: '#F97316' },
  kidnapping: { label: 'Kidnapping',              icon: 'body',         color: '#DC2626' },
  breakin:    { label: 'Break-in/Burglary',       icon: 'home',         color: '#8B5CF6' },
  harassment: { label: 'Harassment/Stalking',     icon: 'eye',          color: '#EC4899' },
  medical:    { label: 'Medical Emergency',       icon: 'medkit',       color: '#10B981' },
  fire:       { label: 'Fire Outbreak',           icon: 'flame',        color: '#F59E0B' },
  other:      { label: 'Other Emergency',         icon: 'help-circle',  color: '#64748B' },
};

interface GpsPt {
  latitude: number;
  longitude: number;
  accuracy?: number;
  timestamp: string;
}

export default function AdminPanics() {
  const router = useRouter();

  // ── Android back → dashboard ──────────────────────────────────────────────
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      router.replace('/admin/dashboard');
      return true;
    });
    return () => sub.remove();
  }, []);

  // ── State ──────────────────────────────────────────────────────────────
  const [panics,        setPanics]        = useState<any[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [refreshing,    setRefreshing]    = useState(false);
  const [locationModal, setLocationModal] = useState<{
    visible: boolean; lat: number; lng: number; title: string
  } | null>(null);
  const [trailModal, setTrailModal] = useState<{
    visible: boolean; points: any[]; title: string; subtitle: string
  } | null>(null);
  const [respondModal, setRespondModal] = useState<any>(null);
  const [countdown,    setCountdown]    = useState(15);
  const pollRef  = useRef<any>(null);
  const countRef = useRef<any>(null);

  // ── Auth ──────────────────────────────────────────────────────────────
  const [myUserId, setMyUserId] = useState<string | null>(null); // for first-responder lock
  useEffect(() => {
    (async () => {
      const token = await getAuthToken();
      if (!token) { router.replace('/admin/login'); return; }
      try {
        // FIX: Use /api/user/profile instead of /api/auth/me (doesn't exist)
        const res = await axios.get(`${BACKEND_URL}/api/user/profile`, {
          headers: { Authorization: `Bearer ${token}` }, timeout: 8000
        });
        setMyUserId(res.data?.user_id || res.data?.id || null);
      } catch (_) {}
    })();
  }, []);

  // ── Admin-only filter state ───────────────────────────────────────────────
  const [showActiveOnly, setShowActiveOnly] = useState(true);
  const [dateFilter,     setDateFilter]     = useState<DateFilter>('all');
  const [showDateMenu,   setShowDateMenu]   = useState(false);
  const [profilePhotoModal, setProfilePhotoModal] = useState<{visible: boolean; photoUrl: string; userName: string} | null>(null);

  // ── Ambient audio ─────────────────────────────────────────────────────
  const soundRef       = useRef<Audio.Sound | null>(null);
  const [playingId,    setPlayingId]    = useState<string | null>(null);
  const [audioLoading, setAudioLoading] = useState<string | null>(null);

  // ── In-app chat ───────────────────────────────────────────────────────
  const [chatConv,     setChatConv]     = useState<{
    convId: string; otherUserId: string; otherName: string;
  } | null>(null);
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [chatInput,    setChatInput]    = useState('');
  const [chatLoading,  setChatLoading]  = useState(false);
  const [chatSending,  setChatSending]  = useState(false);

  // ── Audio helpers ─────────────────────────────────────────────────────
  const resolveAudioUrl = (url: string): string => {
    if (!url) return '';
    if (url.startsWith('http')) return url;
    return `${BACKEND_URL}${url.startsWith('/') ? '' : '/'}${url}`;
  };

  const stopAudio = async () => {
    if (soundRef.current) {
      try { await soundRef.current.stopAsync(); } catch (_) {}
      try { await soundRef.current.unloadAsync(); } catch (_) {}
      soundRef.current = null;
    }
    // FIX SOUND-CLASH: release focus through AudioManager so the singleton
    // restores standby mode in a coordinated way. Raw setAudioModeAsync() calls
    // here bypassed AudioManager's state, leaving it out of sync after role-switches.
    try {
      await AudioManager.releaseFocus('admin_panics_audio');
    } catch (_) {}
    setPlayingId(null);
    setAudioLoading(null);
  };

  const playAmbientAudio = async (rawUrl: string, panicId: string) => {
    if (playingId === panicId) { await stopAudio(); return; }
    await stopAudio();
    const url = resolveAudioUrl(rawUrl);
    if (!url) return;
    setAudioLoading(panicId);
    try {
      // FIX SOUND-CLASH: request focus through AudioManager
      await AudioManager.requestFocus(AudioPriority.PLAYBACK, 'admin_panics_audio');
      const { sound } = await Audio.Sound.createAsync({ uri: url, downloadFirst: true }, { shouldPlay: true });
      soundRef.current = sound;
      setPlayingId(panicId);
      setAudioLoading(null);
      sound.setOnPlaybackStatusUpdate((status: any) => {
        if (status.isLoaded && status.didJustFinish) stopAudio();
        if (!status.isLoaded && status.error) { setAudioLoading(null); setPlayingId(null); }
      });
    } catch (err: any) {
      setAudioLoading(null);
      Alert.alert('Playback Error', 'Could not play ambient audio: ' + (err?.message || ''));
    }
  };

  useEffect(() => { return () => { stopAudio(); }; }, []);
  useFocusEffect(useCallback(() => { return () => { stopAudio(); }; }, []));

  // ── Polling — re-runs when admin filters change ───────────────────────────
  useFocusEffect(
    useCallback(() => {
      loadPanics();
      startPolling();
      return () => stopPolling();
    }, [showActiveOnly, dateFilter])
  );

  const startPolling = () => {
    stopPolling();
    setCountdown(15);
    pollRef.current  = setInterval(() => { loadPanics(); setCountdown(15); }, POLL_INTERVAL);
    countRef.current = setInterval(() => setCountdown(p => (p <= 1 ? 15 : p - 1)), 1000);
  };

  const stopPolling = () => {
    if (pollRef.current)  clearInterval(pollRef.current);
    if (countRef.current) clearInterval(countRef.current);
  };

  // ── Admin date-range helper ───────────────────────────────────────────────
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

  // ── Data fetch — admin endpoint + shape ───────────────────────────────────
  const loadPanics = async () => {
    try {
      const token = await getAuthToken();
      if (!token) { router.replace('/admin/login'); return; }
      
      console.log('[AdminPanics] Fetching panics with filters:', { showActiveOnly, dateFilter });
      
      const res = await axios.get(
        `${BACKEND_URL}/api/admin/all-panics?active_only=${showActiveOnly}&limit=100${getDateRange()}&t=${Date.now()}`,
        { headers: { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-cache' }, timeout: 15000 }
      );
      
      // CRITICAL FIX: Admin endpoint returns { panics: [...] } not the array directly
      let panicsData = res.data.panics || [];
      
      // Debug: Log the first panic to verify location_history
      if (panicsData.length > 0) {
        const firstPanic = panicsData[0];
        console.log('[AdminPanics] First panic ID:', firstPanic.id);
        console.log('[AdminPanics] location_history length:', firstPanic.location_history?.length);
        console.log('[AdminPanics] location_count:', firstPanic.location_count);
        if (firstPanic.location_history && firstPanic.location_history.length > 0) {
          console.log('[AdminPanics] First location point:', firstPanic.location_history[0]);
        } else {
          console.log('[AdminPanics] WARNING: location_history is empty or missing!');
          console.log('[AdminPanics] Panic keys:', Object.keys(firstPanic));
        }
      }
      
      setPanics(panicsData);
    } catch (err: any) {
      console.error('[AdminPanics] Error loading panics:', err?.response?.status, err?.message);
      if (err?.response?.status === 401) { await clearAuthData(); router.replace('/admin/login'); }
      else if (err?.response?.status === 403) { router.replace('/admin/login'); }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = () => { setRefreshing(true); loadPanics(); setCountdown(15); };

  // ── Helpers ───────────────────────────────────────────────────────────────
  const catInfo = (cat: string) => EMERGENCY_CATEGORIES[cat] || EMERGENCY_CATEGORIES.other;

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
      date: d.toLocaleDateString('en-US',  { month: 'short', day: 'numeric', year: 'numeric' }),
      time: d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    };
  };

  const getSenderName = (item: any) =>
    (item.full_name || item.user_name || '').trim() || item.user_email || item.email || 'Unknown User';

  const callUser = (phone: string) =>
    phone ? Linking.openURL(`tel:${phone}`) : Alert.alert('No Phone', 'Phone number not available');

  // ── Resolve photo URL helper ─────────────────────────────────────────────
  const resolvePhotoUrl = (url: string): string => {
    if (!url) return '';
    if (url.startsWith('http')) return url;
    return `${BACKEND_URL}${url.startsWith('/') ? '' : '/'}${url}`;
  };

  // ── In-app chat ───────────────────────────────────────────────────────────
  const openInAppChat = async (panicItem: any) => {
    setRespondModal(null);
    const token = await getAuthToken();
    if (!token) return;
    const otherUserId = panicItem.user_id;
    const otherName   = getSenderName(panicItem);
    setChatLoading(true);
    try {
      const startRes = await axios.post(
        `${BACKEND_URL}/api/chat/start`,
        { to_user_id: otherUserId },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      );
      const convId    = startRes.data?.conversation_id;
      const isNewConv = startRes.data?.existing === false;

      const cat = panicItem.emergency_category || 'emergency';
      const lat = panicItem.latitude?.toFixed(4) ?? '?';
      const lng = panicItem.longitude?.toFixed(4) ?? '?';

      // Send preset opening message if this is a new conversation OR if it has no messages yet
      let shouldSendPreset = isNewConv;
      if (!shouldSendPreset && convId) {
        try {
          const check = await axios.get(
            `${BACKEND_URL}/api/chat/${convId}/messages`,
            { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
          );
          shouldSendPreset = (check.data?.messages || []).length === 0;
        } catch (_) { shouldSendPreset = true; }
      }

      if (shouldSendPreset) {
        const PRESET_MSG =
          `🚨 SECURITY RESPONSE — ${cat.toUpperCase()} ALERT\n\n` +
          `We have received your emergency alert at coordinates ${lat}, ${lng}.\n\n` +
          `Please send us a brief Situation Report (SITREP) if you are able to communicate safely:\n` +
          `• Are you safe right now?\n` +
          `• What is happening?\n` +
          `• Do you need immediate physical response?\n\n` +
          `A security operative is being dispatched. Stay calm. Help is on the way. 🛡`;

        await axios.post(
          `${BACKEND_URL}/api/chat/send`,
          { to_user_id: otherUserId, content: PRESET_MSG, message_type: 'text' },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
        );
      }

      const msgRes = await axios.get(
        `${BACKEND_URL}/api/chat/${convId}/messages`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
      );
      setChatMessages(msgRes.data?.messages || []);
      setChatConv({ convId, otherUserId, otherName });

      // ── First-response claim (admin) ─────────────────────────────────────
      // Admin responding also registers as a response for audit trail.
      // Conditional write on backend is idempotent — safe to always call.
      try {
        // FIX: Also pass panic_id in body for better compatibility
        const respondRes = await axios.post(
          `${BACKEND_URL}/api/panic/${panicItem.id}/respond`,
          { panic_id: panicItem.id },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
        );
        const alreadyResponded = respondRes.data?.already_responded;
        const responderName = respondRes.data?.first_responder_name;

        // If another officer already responded, show a friendly message
        if (alreadyResponded && respondRes.data?.first_responder_id !== myUserId) {
          Alert.alert(
            'Already Responded',
            `${responderName || 'Another officer'} has already responded to this panic. The chat is still open if you need to communicate with the user.`
          );
        }

        loadPanics(); // refresh list so green indicators appear immediately
      } catch (err: any) {
        // Show the actual error message from the backend
        const statusCode = err?.response?.status;
        const detail = err?.response?.data?.detail;
        const message = err?.response?.data?.message;
        const errorMsg = detail || message || err?.message || 'Could not mark panic as responded.';
        console.error('[Admin Respond] Failed:', {
          status: statusCode,
          detail,
          message,
          fullError: err?.response?.data
        });
        Alert.alert('Response Error', errorMsg);
      }
    } catch (err: any) {
      Alert.alert('Error', err?.response?.data?.detail || 'Could not open chat');
    } finally {
      setChatLoading(false);
    }
  };

  const loadChatMessages = async (convId: string) => {
    const token = await getAuthToken();
    if (!token) return;
    try {
      const res = await axios.get(
        `${BACKEND_URL}/api/chat/${convId}/messages`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
      );
      setChatMessages(res.data?.messages || []);
    } catch (_) {}
  };

  const sendChatMessage = async () => {
    if (!chatInput.trim() || !chatConv) return;
    setChatSending(true);
    const token = await getAuthToken();
    if (!token) { setChatSending(false); return; }
    try {
      await axios.post(
        `${BACKEND_URL}/api/chat/send`,
        { to_user_id: chatConv.otherUserId, content: chatInput.trim(), message_type: 'text' },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
      );
      setChatInput('');
      await loadChatMessages(chatConv.convId);
    } catch (_) {} finally { setChatSending(false); }
  };

  // ── GPS timeline row ──────────────────────────────────────────────────────
  const renderGpsRow = (pt: GpsPt, index: number, total: number) => (
    <TouchableOpacity
      key={`${index}-${pt.timestamp}`}
      style={[gpsStyles.row, index === 0 && gpsStyles.rowLatest]}
      onPress={() =>
        setLocationModal({
          visible: true,
          lat: pt.latitude,
          lng: pt.longitude,
          title: `Location @ ${formatTime(pt.timestamp)}`,
        })
      }
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
      <Ionicons name="map-outline" size={16} color="#3B82F6" style={{ marginLeft: 6 }} />
    </TouchableOpacity>
  );

  // ── Panic card ────────────────────────────────────────────────────────────
  const renderPanic = ({ item }: any) => {
    const cat = catInfo(item.emergency_category);
    const dt  = formatDateTime(item.activated_at);
    const name = getSenderName(item);

    // CRITICAL FIX: Ensure we're accessing location_history correctly
    const history: GpsPt[] = item.location_history || [];

    // Also check if there's a locations array as fallback
    const fallbackHistory: GpsPt[] = item.locations || [];
    const finalHistory = history.length > 0 ? history : fallbackHistory;

    // Show most-recent first
    const chronoHistory = [...finalHistory].reverse();
    const isActive = item.is_active !== false;

    console.log(`[AdminPanics] Rendering panic ${item.id}: history length = ${finalHistory.length}`);

    // Resolve user photo URL
    const userPhotoUrl = resolvePhotoUrl(item.user_photo_url);

    return (
      <View style={[styles.card, { borderLeftColor: isActive ? '#EF4444' : '#334155' }]}>

        {/* Top badges */}
        <View style={styles.topRow}>
          <View style={[styles.activeBadge, { backgroundColor: isActive ? '#EF444420' : '#33415520' }]}>
            <Ionicons
              name={isActive ? 'alert-circle' : 'checkmark-circle'}
              size={14}
              color={isActive ? '#EF4444' : '#64748B'}
            />
            <Text style={[styles.activeBadgeText, { color: isActive ? '#EF4444' : '#64748B' }]}>
              {isActive ? 'ACTIVE PANIC' : 'RESOLVED'}
            </Text>
          </View>
          <View style={[styles.catBadge, { backgroundColor: `${cat.color}20` }]}>
            <Ionicons name={cat.icon as any} size={14} color={cat.color} />
            <Text style={[styles.catText, { color: cat.color }]}>{cat.label}</Text>
          </View>
        </View>

        {/* User info */}
        <View style={styles.userRow}>
          <TouchableOpacity
            style={styles.avatar}
            onPress={() => {
              if (userPhotoUrl) {
                setProfilePhotoModal({ visible: true, photoUrl: userPhotoUrl, userName: name });
              }
            }}
            activeOpacity={userPhotoUrl ? 0.7 : 1}
          >
            {userPhotoUrl ? (
              <Image source={{ uri: userPhotoUrl }} style={styles.avatarImg} />
            ) : (
              <Ionicons name="person-circle" size={44} color="#3B82F6" />
            )}
            {userPhotoUrl && (
              <View style={styles.avatarZoomBadge}>
                <Ionicons name="expand" size={12} color="#fff" />
              </View>
            )}
          </TouchableOpacity>
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

        {/* Details */}
        <View style={styles.details}>
          {[
            { icon: 'calendar', text: dt.date },
            { icon: 'time',     text: dt.time },
            { icon: 'location', text: `${item.latitude?.toFixed(4) || '?'}, ${item.longitude?.toFixed(4) || '?'}` },
            { icon: 'pulse',    text: `${item.location_count || 0} location updates`, color: '#10B981' },
          ].map((r, i) => (
            <View key={i} style={styles.detailRow}>
              <Ionicons name={r.icon as any} size={15} color={r.color || '#94A3B8'} />
              <Text style={[styles.detailText, r.color ? { color: r.color } : {}]}>{r.text}</Text>
            </View>
          ))}
          {item.deactivated_at && (
            <View style={styles.detailRow}>
              <Ionicons name="checkmark-circle" size={15} color="#10B981" />
              <Text style={[styles.detailText, { color: '#10B981' }]}>
                Ended: {formatTime(item.deactivated_at)}
              </Text>
            </View>
          )}
        </View>

        {/* ── LIVE GPS TRACK ── */}
        <View style={gpsStyles.container}>
          <View style={gpsStyles.header}>
            <Ionicons name="trail-sign" size={16} color="#F59E0B" />
            <Text style={gpsStyles.title}>Live GPS Track</Text>
            {finalHistory.length > 0 && (
              <View style={gpsStyles.countBadge}>
                <Text style={gpsStyles.countText}>{finalHistory.length}</Text>
              </View>
            )}
            <View style={gpsStyles.liveBadge}>
              <View style={gpsStyles.liveDot} />
              <Text style={gpsStyles.liveText}>LIVE · {countdown}s</Text>
            </View>
            {finalHistory.length > 1 && (
              <TouchableOpacity
                style={gpsStyles.trailBtn}
                onPress={() => {
                  const name = getSenderName(item);
                  setTrailModal({
                    visible: true,
                    points: [...finalHistory].reverse(),
                    title: `${name}'s Movement Trail`,
                    subtitle: `${finalHistory.length} GPS points`,
                  });
                }}
              >
                <Ionicons name="navigate" size={13} color="#3B82F6" />
                <Text style={gpsStyles.trailBtnText}>Show Trail</Text>
              </TouchableOpacity>
            )}
          </View>

          {chronoHistory.length === 0 ? (
            <View style={gpsStyles.empty}>
              <Ionicons name="time-outline" size={28} color="#334155" />
              <Text style={gpsStyles.emptyText}>No GPS coordinates yet</Text>
              <Text style={gpsStyles.emptySubtext}>Points will appear as user moves</Text>
            </View>
          ) : (
            <View>
              {chronoHistory.map((pt, i) => renderGpsRow(pt, i, chronoHistory.length))}
            </View>
          )}
        </View>

        {/* ── AMBIENT AUDIO ── */}
        {item.ambient_audio_url ? (
          <TouchableOpacity
            style={[audioStyles.btn, playingId === item.id && audioStyles.btnPlaying]}
            onPress={() => playAmbientAudio(item.ambient_audio_url, item.id)}
            disabled={audioLoading === item.id}
          >
            {audioLoading === item.id ? (
              <ActivityIndicator size="small" color="#F97316" />
            ) : (
              <Ionicons
                name={playingId === item.id ? 'stop-circle' : 'mic'}
                size={18}
                color={playingId === item.id ? '#fff' : '#F97316'}
              />
            )}
            <Text style={[audioStyles.btnText, playingId === item.id && audioStyles.btnTextPlaying]}>
              {audioLoading === item.id
                ? 'Loading…'
                : playingId === item.id
                  ? 'Stop Audio'
                  : '🎙 Ambient Audio (30s)'}
            </Text>
          </TouchableOpacity>
        ) : null}

        {/* Actions */}
        <View style={styles.actions}>
          {(() => {
            const isMe = item.first_responder_id === myUserId;
            const isOther = item.first_responder_id && !isMe;
            if (isMe) {
              return (
                <View style={[styles.respondBtn, { backgroundColor: '#10B981' }]}>
                  <Ionicons name="checkmark-circle" size={20} color="#fff" />
                  <Text style={styles.respondBtnText}>You Responded ✓</Text>
                </View>
              );
            }
            if (isOther) {
              return (
                <View style={[styles.respondBtn, { backgroundColor: '#10B981' }]}>
                  <Ionicons name="checkmark-circle" size={18} color="#fff" />
                  <View>
                    <Text style={[styles.respondBtnText, { color: '#fff', fontSize: 13, textTransform: 'uppercase', letterSpacing: 1 }]}>
                      RESPONDED
                    </Text>
                    <Text style={{ fontSize: 11, color: '#ffffff90' }}>by {item.first_responder_name || 'Agent'}</Text>
                  </View>
                </View>
              );
            }
            return (
              <TouchableOpacity
                style={styles.respondBtn}
                onPress={() => {
                  if (!item.latitude || !item.longitude) {
                    Alert.alert('Location Error', 'User location not available');
                    return;
                  }
                  setRespondModal(item);
                }}
              >
                <Ionicons name="navigate" size={20} color="#fff" />
                <Text style={styles.respondBtnText}>Respond</Text>
              </TouchableOpacity>
            );
          })()}
        </View>
        {item.first_responder_id && (
          <View style={styles.responderRow}>
            <Ionicons name="person-circle-outline" size={13} color="#10B981" />
            <Text style={styles.responderText}>
              {item.first_responder_name || 'Agent'}
              {item.response_time_seconds != null
                ? `  ·  ${item.response_time_seconds < 60
                    ? `${item.response_time_seconds}s`
                    : `${Math.round(item.response_time_seconds / 60)} min`} response time`
                : ''}
            </Text>
          </View>
        )}
      </View>
    );
  };

  // ── Inline chat view ──────────────────────────────────────────────────────
  if (chatConv) {
    return (
      <SafeAreaView style={styles.container}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={chatSt.header}>
            <TouchableOpacity
              onPress={() => { setChatConv(null); setChatMessages([]); setChatInput(''); }}
              style={{ padding: 4 }}
            >
              <Ionicons name="arrow-back" size={24} color="#fff" />
            </TouchableOpacity>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={chatSt.headerName}>{chatConv.otherName}</Text>
              <Text style={chatSt.headerSub}>Direct message · Civil user</Text>
            </View>
            <TouchableOpacity onPress={() => loadChatMessages(chatConv.convId)}>
              <Ionicons name="refresh" size={22} color="#3B82F6" />
            </TouchableOpacity>
          </View>

          {chatLoading ? (
            <View style={chatSt.loadBox}>
              <ActivityIndicator size="large" color="#3B82F6" />
              <Text style={chatSt.loadText}>Opening conversation…</Text>
            </View>
          ) : (
            <FlatList
              data={chatMessages}
              keyExtractor={item => item.id}
              style={{ flex: 1 }}
              contentContainerStyle={chatSt.messagesList}
              renderItem={({ item }) => (
                <View style={[chatSt.bubble, item.is_mine ? chatSt.mine : chatSt.theirs]}>
                  <Text style={[chatSt.bubbleText, item.is_mine && { color: '#fff' }]}>{item.content}</Text>
                  <Text style={[chatSt.bubbleTime, item.is_mine && { color: '#ffffff80' }]}>
                    {new Date(item.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                  </Text>
                </View>
              )}
              ListEmptyComponent={
                <View style={chatSt.emptyChat}>
                  <Ionicons name="chatbubbles-outline" size={48} color="#334155" />
                  <Text style={chatSt.emptyChatText}>No messages yet</Text>
                </View>
              }
            />
          )}

          <View style={chatSt.inputRow}>
            <TextInput
              style={chatSt.input}
              placeholder="Type a message…"
              placeholderTextColor="#64748B"
              value={chatInput}
              onChangeText={setChatInput}
              multiline
            />
            <TouchableOpacity
              style={[chatSt.sendBtn, !chatInput.trim() && chatSt.sendBtnOff]}
              onPress={sendChatMessage}
              disabled={!chatInput.trim() || chatSending}
            >
              {chatSending
                ? <ActivityIndicator size="small" color="#fff" />
                : <Ionicons name="send" size={20} color="#fff" />}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // ── Main view ─────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.container}>

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.replace('/admin/dashboard')} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>
          {showActiveOnly ? `Active Panics (${panics.length})` : `All Panics (${panics.length})`}
        </Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <TouchableOpacity onPress={() => setShowActiveOnly(v => !v)}>
            <Ionicons
              name={showActiveOnly ? 'filter' : 'filter-outline'}
              size={22}
              color={showActiveOnly ? '#EF4444' : '#fff'}
            />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { loadPanics(); setCountdown(15); }}>
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
          {showActiveOnly  && <Text style={styles.filterChip}>🔴 Active Only</Text>}
          {dateFilter !== 'all' && <Text style={styles.filterChip}>📅 {DATE_LABELS[dateFilter]}</Text>}
        </View>
      )}

      {loading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="large" color="#EF4444" />
        </View>
      ) : (
        <FlatList
          data={panics}
          renderItem={renderPanic}
          keyExtractor={item => item.id || item._id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#EF4444" />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="shield-checkmark" size={80} color="#64748B" />
              <Text style={styles.emptyText}>No panics found</Text>
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

      {/* Profile Photo Full-Size Modal */}
      {profilePhotoModal && (
        <Modal visible transparent animationType="slide" onRequestClose={() => setProfilePhotoModal(null)}>
          <TouchableOpacity
            style={profileModalStyles.overlay}
            activeOpacity={1}
            onPress={() => setProfilePhotoModal(null)}
          >
            <View style={profileModalStyles.container}>
              <View style={profileModalStyles.header}>
                <Text style={profileModalStyles.title}>Profile Photo</Text>
                <TouchableOpacity onPress={() => setProfilePhotoModal(null)} style={profileModalStyles.closeBtn}>
                  <Ionicons name="close-circle" size={28} color="#fff" />
                </TouchableOpacity>
              </View>
              <View style={profileModalStyles.imageContainer}>
                <Image
                  source={{ uri: profilePhotoModal.photoUrl }}
                  style={profileModalStyles.fullImage}
                  resizeMode="contain"
                />
              </View>
              <Text style={profileModalStyles.userName}>{profilePhotoModal.userName}</Text>
              <Text style={profileModalStyles.subtitle}>Facial Identification</Text>
            </View>
          </TouchableOpacity>
        </Modal>
      )}

      {/* Respond modal */}
      {respondModal && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setRespondModal(null)}>
          <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setRespondModal(null)}>
            <View style={styles.respondModal}>
              <Text style={styles.respondTitle}>🚨 Respond to Panic</Text>
              <Text style={styles.respondName}>{getSenderName(respondModal)}</Text>
              {(respondModal.user_phone || respondModal.phone) && (
                <Text style={styles.respondPhone}>📞 {respondModal.user_phone || respondModal.phone}</Text>
              )}
              <Text style={styles.respondCoords}>
                📍 {respondModal.latitude?.toFixed(4)}, {respondModal.longitude?.toFixed(4)}
              </Text>

              <TouchableOpacity
                style={[styles.respondBtn2, { backgroundColor: '#8B5CF6' }]}
                onPress={() => openInAppChat(respondModal)}
              >
                <Ionicons name="chatbubble-ellipses" size={18} color="#fff" />
                <Text style={styles.respondBtn2Text}>Message In-App</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.respondBtn2}
                onPress={() => {
                  setRespondModal(null);
                  setLocationModal({
                    visible: true,
                    lat: respondModal.latitude,
                    lng: respondModal.longitude,
                    title: `${getSenderName(respondModal)}'s Location`,
                  });
                }}
              >
                <Ionicons name="map" size={18} color="#fff" />
                <Text style={styles.respondBtn2Text}>View on Map</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.respondBtn2, { backgroundColor: '#10B981' }]}
                onPress={() => { setRespondModal(null); callUser(respondModal.user_phone || respondModal.phone); }}
              >
                <Ionicons name="call" size={18} color="#fff" />
                <Text style={styles.respondBtn2Text}>Call</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.respondBtn2, { backgroundColor: '#334155' }]}
                onPress={() => setRespondModal(null)}
              >
                <Ionicons name="close-circle" size={18} color="#fff" />
                <Text style={styles.respondBtn2Text}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Modal>
      )}
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container:        { flex: 1, backgroundColor: '#0F172A' },
  header:           { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: '#1E293B' },
  backBtn:          { padding: 4 },
  headerTitle:      { fontSize: 18, fontWeight: 'bold', color: '#fff' },
  loadingBox:       { flex: 1, justifyContent: 'center', alignItems: 'center' },
  list:             { padding: 16, paddingBottom: 40 },
  card:             { backgroundColor: '#1E293B', borderRadius: 16, padding: 16, marginBottom: 16, borderLeftWidth: 4, borderLeftColor: '#EF4444' },
  topRow:           { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  activeBadge:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, gap: 5 },
  activeBadgeText:  { fontSize: 11, fontWeight: '800' },
  catBadge:         { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, gap: 5 },
  catText:          { fontSize: 11, fontWeight: '600' },
  userRow:          { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 },
  avatar:           { width: 52, height: 52, borderRadius: 26, backgroundColor: '#3B82F620', justifyContent: 'center', alignItems: 'center', marginRight: 12, overflow: 'hidden' },
  avatarImg:        { width: 52, height: 52, borderRadius: 26, borderWidth: 2, borderColor: '#3B82F6' },
  userName:         { fontSize: 16, fontWeight: '700', color: '#fff', marginBottom: 3 },
  userEmail:        { fontSize: 12, color: '#94A3B8', marginBottom: 2 },
  userPhone:        { fontSize: 13, color: '#10B981', fontWeight: '600' },
  userPhoneEmpty:   { fontSize: 12, color: '#475569', fontStyle: 'italic' },
  details:          { backgroundColor: '#0F172A', borderRadius: 12, padding: 12, marginBottom: 12 },
  detailRow:        { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  detailText:       { fontSize: 13, color: '#94A3B8' },
  actions:          { flexDirection: 'row', marginTop: 12 },
  respondBtn:       { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 13, borderRadius: 12, backgroundColor: '#F59E0B' },
  respondBtnText:   { fontSize: 15, fontWeight: '700', color: '#fff' },
  responderRow:     { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6, paddingHorizontal: 4 },
  responderText:    { fontSize: 11, color: '#10B981', fontWeight: '600' },
  empty:            { alignItems: 'center', paddingVertical: 80 },
  emptyText:        { fontSize: 20, color: '#64748B', marginTop: 16, fontWeight: '600' },
  emptySubtext:     { fontSize: 14, color: '#475569', marginTop: 4 },
  refreshBar:       { height: 28, backgroundColor: '#0F172A', borderTopWidth: 1, borderTopColor: '#1E293B', flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  refreshBarText:   { fontSize: 11, color: '#475569' },
  modalOverlay:     { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  respondModal:     { backgroundColor: '#1E293B', borderRadius: 20, padding: 24, width: '100%', maxWidth: 360 },
  respondTitle:     { fontSize: 17, fontWeight: 'bold', color: '#EF4444', marginBottom: 8, textAlign: 'center' },
  respondName:      { fontSize: 19, fontWeight: '700', color: '#fff', marginBottom: 4, textAlign: 'center' },
  respondPhone:     { fontSize: 14, color: '#10B981', marginBottom: 4, textAlign: 'center' },
  respondCoords:    { fontSize: 12, color: '#94A3B8', marginBottom: 20, textAlign: 'center' },
  respondBtn2:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#3B82F6', paddingVertical: 13, borderRadius: 12, marginBottom: 10 },
  respondBtn2Text:  { fontSize: 15, fontWeight: '600', color: '#fff' },
  dateMenu:         { backgroundColor: '#1E293B', marginHorizontal: 16, marginTop: 4, borderRadius: 12, overflow: 'hidden', zIndex: 99 },
  dateMenuItem:     { paddingVertical: 12, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: '#0F172A' },
  dateMenuText:     { fontSize: 14, color: '#94A3B8' },
  filterBar:        { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  filterChip:       { fontSize: 12, color: '#94A3B8', backgroundColor: '#1E293B', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
});

const gpsStyles = StyleSheet.create({
  container:       { marginBottom: 4, backgroundColor: '#0F172A', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#F59E0B30' },
  header:          { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 10 },
  title:           { flex: 1, fontSize: 13, fontWeight: '600', color: '#F59E0B' },
  countBadge:      { backgroundColor: '#F59E0B', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10 },
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

const audioStyles = StyleSheet.create({
  btn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#F9731615', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 10,
    marginBottom: 10, borderWidth: 1, borderColor: '#F9731630',
  },
  btnPlaying:     { backgroundColor: '#F97316', borderColor: '#F97316' },
  btnText:        { fontSize: 13, fontWeight: '600', color: '#F97316', flex: 1 },
  btnTextPlaying: { color: '#fff' },
});

const chatSt = StyleSheet.create({
  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#1E293B' },
  headerName:    { fontSize: 17, fontWeight: '600', color: '#fff' },
  headerSub:     { fontSize: 12, color: '#94A3B8', marginTop: 2 },
  loadBox:       { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadText:      { color: '#94A3B8', marginTop: 12 },
  messagesList:  { padding: 16, paddingBottom: 8 },
  bubble:        { maxWidth: '80%', padding: 12, borderRadius: 16, marginBottom: 8 },
  mine:          { alignSelf: 'flex-end', backgroundColor: '#3B82F6', borderBottomRightRadius: 4 },
  theirs:        { alignSelf: 'flex-start', backgroundColor: '#1E293B', borderBottomLeftRadius: 4 },
  bubbleText:    { fontSize: 15, color: '#E2E8F0', lineHeight: 20 },
  bubbleTime:    { fontSize: 10, color: '#64748B', marginTop: 4, textAlign: 'right' },
  emptyChat:     { alignItems: 'center', paddingVertical: 60 },
  emptyChatText: { fontSize: 16, color: '#475569', marginTop: 12 },
  inputRow:      { flexDirection: 'row', alignItems: 'flex-end', padding: 12, borderTopWidth: 1, borderTopColor: '#1E293B', gap: 10 },
  input:         { flex: 1, backgroundColor: '#1E293B', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 12, color: '#fff', fontSize: 15, maxHeight: 100 },
  sendBtn:       { width: 44, height: 44, borderRadius: 22, backgroundColor: '#3B82F6', justifyContent: 'center', alignItems: 'center' },
  sendBtnOff:    { backgroundColor: '#334155' },
  // Avatar styles
  avatarZoomBadge: { position: 'absolute', bottom: 2, right: 2, backgroundColor: '#3B82F6', borderRadius: 8, width: 18, height: 18, justifyContent: 'center', alignItems: 'center' },
});

// Profile Photo Modal Styles
const profileModalStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', justifyContent: 'center', alignItems: 'center' },
  container: { width: '100%', alignItems: 'center', paddingHorizontal: 20 },
  header: { width: '100%', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  title: { fontSize: 18, fontWeight: '600', color: '#fff' },
  closeBtn: { padding: 4 },
  imageContainer: { width: '100%', aspectRatio: 1, maxWidth: 350, backgroundColor: '#1E293B', borderRadius: 20, overflow: 'hidden', marginBottom: 20 },
  fullImage: { width: '100%', height: '100%' },
  userName: { fontSize: 20, fontWeight: '700', color: '#fff', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#94A3B8' },
});
