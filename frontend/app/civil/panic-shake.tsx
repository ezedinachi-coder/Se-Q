/**
 * civil/panic-shake.tsx
 *
 * FIX #3 — PRIVACY & SAFETY
 *   - Push-notification payload sent on activation changed to neutral strings
 *     (was "Se-Q — Emergency Active" / "Your location is being shared with security").
 *   - Foreground service notification changed to neutral "Se-Q / Location tracking active".
 *   - Vibration restored on activation (was removed — now uses three short pulses
 *     identical to panic-active.tsx so user gets tactile confirmation).
 *   - No visible in-app banners or alerts added here — the shake banner lives
 *     entirely in _layout.tsx.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import AsyncStorage from '../../utils/asyncStorageShim';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Animated, BackHandler, Platform,
  AppState, AppStateStatus,
  ScrollView, Vibration,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import axios from 'axios';
import { getAuthToken, clearAuthData } from '../../utils/auth';
import { getLocation } from '../../utils/getLocation';
import BACKEND_URL from '../../utils/config';
import { beginAmbientCapture } from '../../utils/ambientRecorder';
import { setNativePanicActive } from '../../utils/nativePanicBridge';

const LOCATION_TASK       = 'background-location-panic';
const AUTO_ACTIVATE_SECONDS = 5;
const AUTO_CATEGORY       = 'violence';

// ── Background GPS task (must be at module scope) ──────────────────────────────
if (!TaskManager.isTaskDefined(LOCATION_TASK)) {
  TaskManager.defineTask(LOCATION_TASK, async ({ data, error }: any) => {
    if (error || !data?.locations?.[0]) return;
    const loc = data.locations[0];
    try {
      const token = await AsyncStorage.getItem('auth_token');
      if (token) {
        await axios.post(
          `${BACKEND_URL}/api/panic/location`,
          {
            latitude:  loc.coords.latitude,
            longitude: loc.coords.longitude,
            accuracy:  loc.coords.accuracy,
            timestamp: new Date().toISOString(),
          },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
        );
      }
    } catch (_) {}
  });
}

// ── Emergency categories ───────────────────────────────────────────────────────
const CATEGORIES = [
  { id: 'violence',   icon: 'warning',      label: 'Violence / Assault',    color: '#EF4444' },
  { id: 'kidnapping', icon: 'car',          label: 'Kidnapping / Abduction', color: '#B91C1C' },
  { id: 'robbery',    icon: 'hand-right',   label: 'Armed Robbery',          color: '#DC2626' },
  { id: 'harassment', icon: 'person',       label: 'Harassment / Stalking',  color: '#F97316' },
  { id: 'burglary',   icon: 'home',         label: 'Break-in / Burglary',    color: '#F59E0B' },
  { id: 'medical',    icon: 'medical',      label: 'Medical Emergency',      color: '#3B82F6' },
  { id: 'fire',       icon: 'flame',        label: 'Fire / Accident',        color: '#F97316' },
  { id: 'other',      icon: 'alert-circle', label: 'Other Emergency',        color: '#64748B' },
];

// ── Persist panic to AsyncStorage ─────────────────────────────────────────────
const saveLocalPanic = async (panicId: string, category: string) => {
  await AsyncStorage.multiSet([
    ['panic_active',     'true'],
    ['panic_started_at', Date.now().toString()],
    ['panic_id',          panicId],
    ['active_panic',      JSON.stringify({
      id: panicId, panic_id: panicId, category,
      activated_at: new Date().toISOString(),
    })],
  ]);
};

// ── Component ──────────────────────────────────────────────────────────────────
export default function PanicShake() {
  const router = useRouter();

  const [countdown,  setCountdown]  = useState(AUTO_ACTIVATE_SECONDS);
  const [activating, setActivating] = useState(false);
  const [activated,  setActivated]  = useState(false);
  const [dismissed,  setDismissed]  = useState(false);

  const countdownRef  = useRef(AUTO_ACTIVATE_SECONDS);
  const activatingRef = useRef(false);
  const timerRef      = useRef<ReturnType<typeof setInterval> | null>(null);

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const bgFlash   = useRef(new Animated.Value(0)).current;

  // ── Escape-hatch ──────────────────────────────────────────────────────────
  // Runs on mount AND every time the app foregrounds. If AsyncStorage already
  // shows a completed panic (written by a prior activation that succeeded but
  // then crashed before navigating), route home immediately.
  //
  // FIX: Removed the `if (!activatingRef.current) return` gate that was here.
  // That gate meant the check only ran if activateWithCategory() had already
  // been called — i.e. never on a fresh mount caused by checkNativePanic
  // re-routing here after a banner mishandle. The user would land here, the
  // gate would short-circuit, and they'd be trapped with no exit.
  useEffect(() => {
    const check = async () => {
      const panicActive = await AsyncStorage.getItem('panic_active');
      const activePanic = await AsyncStorage.getItem('active_panic');
      if (panicActive === 'true' || !!activePanic) {
        router.replace('/civil/home');
        return;
      }
      // Also escape if a previous activation attempt left a panic_error
      // sentinel — clear it and go home rather than looping.
      const panicError = await AsyncStorage.getItem('panic_error');
      if (panicError === 'true') {
        await AsyncStorage.removeItem('panic_error');
        router.replace('/civil/home');
      }
    };

    check();

    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') check();
    });

    return () => sub.remove();
  }, []);

  // ── On mount: pulse + countdown ────────────────────────────────────────────
  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.12, duration: 400, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1.0,  duration: 400, useNativeDriver: true }),
      ])
    );
    pulse.start();

    const flash = Animated.loop(
      Animated.sequence([
        Animated.timing(bgFlash, { toValue: 1, duration: 500, useNativeDriver: false }),
        Animated.timing(bgFlash, { toValue: 0, duration: 500, useNativeDriver: false }),
      ])
    );
    flash.start();

    timerRef.current = setInterval(() => {
      countdownRef.current -= 1;
      setCountdown(countdownRef.current);
      if (countdownRef.current <= 0) {
        clearInterval(timerRef.current!);
        if (!activatingRef.current) activateWithCategory(AUTO_CATEGORY);
      }
    }, 1000);

    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => true);

    return () => {
      clearInterval(timerRef.current!);
      pulse.stop();
      flash.stop();
      backHandler.remove();
    };
  }, []);

  // ── Activate ───────────────────────────────────────────────────────────────
  const activateWithCategory = useCallback(async (category: string) => {
    if (activatingRef.current) return;
    activatingRef.current = true;
    setActivating(true);
    clearInterval(timerRef.current!);

    const capture = beginAmbientCapture();

    // FIX #3: Three short vibration pulses — confirms activation tactilely
    // without any visible on-screen indicator.
    Vibration.vibrate([0, 400, 100, 400, 100, 400]);

    try {
      // Request permissions — getLocation() will re-request foreground internally,
      // but we also need background permission for the GPS task that runs after activation.
      try { await Location.requestBackgroundPermissionsAsync(); } catch (_) {}
      const bgStatus = await Location.requestBackgroundPermissionsAsync().catch(() => ({ status: 'denied' }));

      // FIX: Use shared getLocation() utility.
      // Old code: let lat = 0, lng = 0; try { ... } catch (_) {}
      //   → silently sent latitude=0, longitude=0 whenever GPS was cold or slow.
      // New code: getLocation('panic') returns null if GPS is unavailable.
      //   We never send 0,0. If coords are null we omit them from the payload
      //   and the backend records the panic without a location; the background
      //   GPS task will deliver the real fix seconds later.
      const coords = await getLocation('panic');

      const token = await getAuthToken();
      if (!token) {
        clearAuthData();
        router.replace('/auth/login');
        return;
      }

      const response = await axios.post(
        `${BACKEND_URL}/api/panic/activate`,
        {
          emergency_category: category,
          // Send null fields rather than 0,0 when GPS is unavailable
          latitude:  coords?.latitude  ?? null,
          longitude: coords?.longitude ?? null,
          accuracy:  coords?.accuracy  ?? null,
        },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      );

      const panicId = response.data?.panic_id || 'unknown';
      await saveLocalPanic(panicId, category);
      await AsyncStorage.setItem('auth_token', token);
      capture.attachToPanic(panicId, token);

      await setNativePanicActive(true);

      if (bgStatus.status === 'granted') {
        try {
          const isRunning = await TaskManager.isTaskRegisteredAsync(LOCATION_TASK).catch(() => false);
          if (!isRunning) {
            await Location.startLocationUpdatesAsync(LOCATION_TASK, {
              accuracy:         Location.Accuracy.High,
              timeInterval:     60000,
              distanceInterval: 0,
              foregroundService: {
                // FIX #3: Neutral strings — nothing that reveals this is a
                // security/emergency app if the notification shade is seen.
                notificationTitle: 'Se-Q',
                notificationBody:  'Se-Q Active',
                notificationColor: '#EF4444',
              },
              pausesUpdatesAutomatically:        false,
              showsBackgroundLocationIndicator:  true,
            });
          }
        } catch (_) {}
      }

      setActivated(true);

      setTimeout(() => {
        if (Platform.OS === 'android') {
          BackHandler.exitApp();
        } else {
          router.replace('/civil/home');
        }
      }, 800);

    } catch (err: any) {
      activatingRef.current = false;
      setActivating(false);
      if (err?.response?.status === 401) {
        await clearAuthData();
        router.replace('/auth/login');
      } else {
        // FIX: write a sentinel so the escape-hatch on next mount routes home
        // instead of looping, and consume the native pending flag so
        // checkNativePanic on cold-start doesn't re-route to panic-shake.
        try {
          await AsyncStorage.setItem('panic_error', 'true');
          const { checkAndConsumePanic } = await import('../../utils/nativePanicBridge');
          await checkAndConsumePanic().catch(() => {});
        } catch (_) {}
        // Navigate home — don't fake-show "activated" for a failed attempt
        router.replace('/civil/home');
      }
    }
  }, []);

  const handleCategoryPress = (categoryId: string) => {
    if (activating || activated || dismissed) return;
    activateWithCategory(categoryId);
  };

  const handleFalseAlarm = () => {
    clearInterval(timerRef.current!);
    setDismissed(true);
    router.replace('/civil/home');
  };

  const bgColor = bgFlash.interpolate({
    inputRange:  [0, 1],
    outputRange: ['#0F172A', '#1A0A0A'],
  });

  if (activating || activated) {
    return (
      <Animated.View style={[styles.fullScreen, { backgroundColor: bgColor }]}>
        <SafeAreaView style={styles.centered}>
          <Animated.View style={[styles.activatingRing, { transform: [{ scale: pulseAnim }] }]}>
            <Ionicons name="shield" size={60} color="#EF4444" />
          </Animated.View>
          <Text style={styles.activatingTitle}>
            {activated ? '🚨 EMERGENCY ACTIVATED' : 'ACTIVATING...'}
          </Text>
          <Text style={styles.activatingSubtitle}>
            {activated
              ? 'Security is being alerted.\nYour location is being tracked.'
              : 'Alerting security response...'}
          </Text>
          {activated && (
            <Text style={styles.activatingNote}>
              App will close. GPS tracking continues silently.
            </Text>
          )}
        </SafeAreaView>
      </Animated.View>
    );
  }

  return (
    <Animated.View style={[styles.fullScreen, { backgroundColor: bgColor }]}>
      <SafeAreaView style={styles.safeArea}>

        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Ionicons name="radio" size={18} color="#EF4444" />
            <Text style={styles.headerLabel}>5 SHAKES DETECTED</Text>
          </View>
          <TouchableOpacity style={styles.falseAlarmBtn} onPress={handleFalseAlarm}>
            <Text style={styles.falseAlarmText}>✕  False Alarm</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.countdownSection}>
          <Animated.View style={[styles.countdownRing, { transform: [{ scale: pulseAnim }] }]}>
            <Text style={styles.countdownNumber}>{countdown}</Text>
            <Text style={styles.countdownLabel}>seconds</Text>
          </Animated.View>
          <Text style={styles.autoActivateText}>
            Auto-activating{' '}
            <Text style={{ color: '#EF4444', fontWeight: '700' }}>Violence/Assault</Text>
            {'\n'}unless you select a category below
          </Text>
        </View>

        <Text style={styles.selectLabel}>TAP TO ACTIVATE IMMEDIATELY</Text>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {CATEGORIES.map((cat) => {
            const isDefault = cat.id === AUTO_CATEGORY;
            return (
              <TouchableOpacity
                key={cat.id}
                style={[styles.catButton, isDefault && styles.catButtonDefault]}
                onPress={() => handleCategoryPress(cat.id)}
                activeOpacity={0.75}
              >
                <View style={[styles.catIcon, { backgroundColor: cat.color + '25' }]}>
                  <Ionicons name={cat.icon as any} size={22} color={cat.color} />
                </View>
                <Text style={[styles.catLabel, isDefault && styles.catLabelDefault]}>
                  {cat.label}
                </Text>
                {isDefault && (
                  <View style={styles.defaultBadge}>
                    <Text style={styles.defaultBadgeText}>AUTO</Text>
                  </View>
                )}
                <Ionicons name="chevron-forward" size={18} color="#475569" />
              </TouchableOpacity>
            );
          })}
        </ScrollView>

      </SafeAreaView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fullScreen:         { flex: 1 },
  safeArea:           { flex: 1 },
  centered:           { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },

  header:             { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#1E293B' },
  headerLeft:         { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerLabel:        { fontSize: 13, fontWeight: '700', color: '#EF4444', letterSpacing: 2 },
  falseAlarmBtn:      { backgroundColor: '#1E293B', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  falseAlarmText:     { fontSize: 13, color: '#94A3B8', fontWeight: '500' },

  countdownSection:   { alignItems: 'center', paddingVertical: 20 },
  countdownRing:      { width: 110, height: 110, borderRadius: 55, borderWidth: 4, borderColor: '#EF4444', justifyContent: 'center', alignItems: 'center', backgroundColor: '#EF444415', marginBottom: 12 },
  countdownNumber:    { fontSize: 46, fontWeight: '900', color: '#EF4444', lineHeight: 52 },
  countdownLabel:     { fontSize: 10, color: '#EF4444', letterSpacing: 2, fontWeight: '600' },
  autoActivateText:   { fontSize: 13, color: '#94A3B8', textAlign: 'center', lineHeight: 20 },

  selectLabel:        { fontSize: 9, color: '#475569', letterSpacing: 3, textAlign: 'center', marginBottom: 8 },
  scroll:             { flex: 1 },
  scrollContent:      { paddingHorizontal: 16, paddingBottom: 20, gap: 8 },
  catButton:          { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E293B', borderRadius: 14, padding: 14, gap: 12, borderWidth: 1, borderColor: '#334155' },
  catButtonDefault:   { borderColor: '#EF4444', backgroundColor: '#EF444410' },
  catIcon:            { width: 40, height: 40, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  catLabel:           { flex: 1, fontSize: 15, fontWeight: '600', color: '#E2E8F0' },
  catLabelDefault:    { color: '#EF4444' },
  defaultBadge:       { backgroundColor: '#EF4444', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, marginRight: 4 },
  defaultBadgeText:   { fontSize: 9, fontWeight: '800', color: '#fff', letterSpacing: 1 },

  activatingRing:     { width: 120, height: 120, borderRadius: 60, borderWidth: 3, borderColor: '#EF4444', justifyContent: 'center', alignItems: 'center', backgroundColor: '#EF444415', marginBottom: 24 },
  activatingTitle:    { fontSize: 20, fontWeight: '800', color: '#EF4444', textAlign: 'center', marginBottom: 12, letterSpacing: 1 },
  activatingSubtitle: { fontSize: 14, color: '#94A3B8', textAlign: 'center', lineHeight: 22, marginBottom: 16 },
  activatingNote:     { fontSize: 12, color: '#475569', textAlign: 'center' },
});
