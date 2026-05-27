/**
 * civil/escort.tsx — v4
 *
 * CHANGES vs v3:
 * 1. ETA panel → restored as a floating Modal popup (taps "Start Escort" to open,
 *    user picks duration, then confirms). Options: 15min, 30min, 45min, 1hr, Xhr Ymin.
 * 2. Timer bug fixed — server returns `datetime.utcnow().isoformat()` with NO "Z"
 *    suffix, so JS parses it as local time, adding UTC offset (e.g. +60 min in Nigeria).
 *    Fix: append "Z" before parsing so it's always treated as UTC.
 * 3. All other logic (GPS, background task, session restore) unchanged.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import AsyncStorage from '../../utils/asyncStorageShim';
import {
  View, Text, TouchableOpacity, StyleSheet, Alert, ActivityIndicator,
  AppState, Dimensions, Platform, Modal, TextInput, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Haptics from 'expo-haptics';
import axios from 'axios';
import Animated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming,
  withDelay, withSequence, interpolate, Easing, FadeIn,
  FadeInDown, FadeInUp, ZoomIn,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { getAuthToken, getUserMetadata, clearAuthData } from '../../utils/auth';
import { getLocation } from '../../utils/getLocation';
import BACKEND_URL from '../../utils/config';

const { width: W, height: H } = Dimensions.get('window');
const ESCORT_TASK = 'background-location-escort';

// ── Timezone-safe ISO parser ──────────────────────────────────────────────────
// The backend returns datetime.utcnow().isoformat() which has NO "Z" suffix,
// e.g. "2025-01-27T09:00:00.123456". Without a suffix, JS engines parse this
// as LOCAL time, adding the device's UTC offset to the calculation.
// Fix: always ensure the string ends with "Z" before parsing.
function parseUtcIso(isoString: string): number {
  if (!isoString) return Date.now();
  const normalized = isoString.endsWith('Z') || isoString.includes('+')
    ? isoString
    : isoString + 'Z';
  const ms = new Date(normalized).getTime();
  return isNaN(ms) ? Date.now() : ms;
}

// ── Background task ───────────────────────────────────────────────────────────
if (!TaskManager.isTaskDefined(ESCORT_TASK)) {
  TaskManager.defineTask(ESCORT_TASK, async ({ data, error }: any) => {
    if (error) return;
    if (data?.locations?.[0]) {
      const loc = data.locations[0];
      try {
        const token = await AsyncStorage.getItem('auth_token');
        if (token) {
          await axios.post(
            `${BACKEND_URL}/api/escort/location`,
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
    }
  });
}

// ── Duration option type ──────────────────────────────────────────────────────
interface DurationOption {
  label: string;
  hours: number;
  minutes: number; // total in minutes for display; hours field for API
}

const QUICK_OPTIONS: DurationOption[] = [
  { label: '15 min',  hours: 0.25, minutes: 15 },
  { label: '30 min',  hours: 0.5,  minutes: 30 },
  { label: '45 min',  hours: 0.75, minutes: 45 },
  { label: '1 hr',    hours: 1,    minutes: 60 },
];

// ── ETA Picker Modal ──────────────────────────────────────────────────────────
interface EtaPickerProps {
  visible: boolean;
  onClose: () => void;
  onConfirm: (durationHours: number, label: string) => void;
}

function EtaPicker({ visible, onClose, onConfirm }: EtaPickerProps) {
  const [selected, setSelected]       = useState<number | null>(null); // index into QUICK_OPTIONS
  const [customHrs, setCustomHrs]     = useState('');
  const [customMins, setCustomMins]   = useState('');

  const isCustomFilled = customHrs.length > 0 || customMins.length > 0;
  const activeSelection = isCustomFilled ? 'custom' : selected;

  const handleConfirm = () => {
    if (isCustomFilled) {
      const h = parseInt(customHrs || '0', 10);
      const m = parseInt(customMins || '0', 10);
      const totalHours = h + m / 60;
      if (totalHours <= 0) {
        Alert.alert('Invalid Duration', 'Please enter a valid duration.');
        return;
      }
      const label = [h > 0 && `${h} hr`, m > 0 && `${m} min`].filter(Boolean).join(' ');
      onConfirm(totalHours, label);
    } else if (selected !== null) {
      const opt = QUICK_OPTIONS[selected];
      onConfirm(opt.hours, opt.label);
    } else {
      Alert.alert('Select Duration', 'Please choose how long you need escort for.');
    }
  };

  const reset = () => {
    setSelected(null);
    setCustomHrs('');
    setCustomMins('');
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* Scrim */}
      <TouchableOpacity
        style={eta.scrim}
        activeOpacity={1}
        onPress={onClose}
      />

      {/* Sheet */}
      <View style={eta.sheet}>
        {/* Handle */}
        <View style={eta.handle} />

        {/* Header */}
        <View style={eta.sheetHeader}>
          <View>
            <Text style={eta.sheetTitle}>How long do you need escort?</Text>
            <Text style={eta.sheetSub}>Select a duration or enter a custom time</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={eta.closeBtn}>
            <Ionicons name="close" size={20} color="#64748B" />
          </TouchableOpacity>
        </View>

        {/* Quick options */}
        <View style={eta.quickGrid}>
          {QUICK_OPTIONS.map((opt, i) => {
            const active = activeSelection === i;
            return (
              <TouchableOpacity
                key={i}
                style={[eta.quickBtn, active && eta.quickBtnActive]}
                onPress={() => {
                  setSelected(i);
                  setCustomHrs('');
                  setCustomMins('');
                }}
                activeOpacity={0.75}
              >
                <Ionicons
                  name="time-outline"
                  size={18}
                  color={active ? '#fff' : '#64748B'}
                />
                <Text style={[eta.quickLabel, active && eta.quickLabelActive]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Divider */}
        <View style={eta.dividerRow}>
          <View style={eta.dividerLine} />
          <Text style={eta.dividerText}>or custom</Text>
          <View style={eta.dividerLine} />
        </View>

        {/* Custom input */}
        <View style={[eta.customBox, isCustomFilled && eta.customBoxActive]}>
          <Ionicons name="create-outline" size={16} color={isCustomFilled ? '#3B82F6' : '#64748B'} />
          <View style={eta.customField}>
            <TextInput
              style={eta.customInput}
              value={customHrs}
              onChangeText={(t) => setCustomHrs(t.replace(/[^0-9]/g, ''))}
              placeholder="0"
              placeholderTextColor="#475569"
              keyboardType="numeric"
              maxLength={2}
              selectTextOnFocus
            />
            <Text style={eta.customUnit}>hrs</Text>
          </View>
          <Text style={eta.customSep}>:</Text>
          <View style={eta.customField}>
            <TextInput
              style={eta.customInput}
              value={customMins}
              onChangeText={(t) => {
                const n = parseInt(t.replace(/[^0-9]/g, '') || '0', 10);
                setCustomMins(String(Math.min(59, n)));
              }}
              placeholder="00"
              placeholderTextColor="#475569"
              keyboardType="numeric"
              maxLength={2}
              selectTextOnFocus
            />
            <Text style={eta.customUnit}>min</Text>
          </View>
        </View>

        {/* Confirm */}
        <TouchableOpacity
          style={[eta.confirmBtn, activeSelection === null && eta.confirmBtnDisabled]}
          onPress={handleConfirm}
          activeOpacity={0.85}
        >
          <LinearGradient
            colors={activeSelection !== null ? ['#2563EB', '#1d4ed8'] : ['#1E293B', '#1E293B']}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
            style={eta.confirmGrad}
          >
            <Ionicons name="navigate" size={18} color="#fff" />
            <Text style={eta.confirmText}>
              {activeSelection === null
                ? 'Select a duration'
                : isCustomFilled
                  ? `Start — ${customHrs || '0'}h ${customMins || '0'}m`
                  : `Start — ${QUICK_OPTIONS[selected!].label}`}
            </Text>
          </LinearGradient>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const eta = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#0F172A',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingBottom: Platform.OS === 'ios' ? 40 : 28,
    borderTopWidth: 1,
    borderColor: '#1E293B',
  },
  handle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: '#334155',
    alignSelf: 'center',
    marginTop: 12, marginBottom: 20,
  },
  sheetHeader: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'flex-start', marginBottom: 22,
  },
  sheetTitle: { fontSize: 18, fontWeight: '700', color: '#F1F5F9', marginBottom: 4 },
  sheetSub:   { fontSize: 13, color: '#64748B' },
  closeBtn:   { width: 36, height: 36, borderRadius: 10, backgroundColor: '#1E293B', justifyContent: 'center', alignItems: 'center' },
  quickGrid:  { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 },
  quickBtn:   {
    flex: 1, minWidth: '44%', flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#1E293B', borderRadius: 12, paddingVertical: 14,
    paddingHorizontal: 14, borderWidth: 1.5, borderColor: '#334155',
  },
  quickBtnActive: { backgroundColor: '#2563EB', borderColor: '#3B82F6' },
  quickLabel:     { fontSize: 15, fontWeight: '600', color: '#94A3B8' },
  quickLabelActive: { color: '#fff' },
  dividerRow:   { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  dividerLine:  { flex: 1, height: 1, backgroundColor: '#1E293B' },
  dividerText:  { fontSize: 12, color: '#475569', fontWeight: '600' },
  customBox: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#1E293B', borderRadius: 12, padding: 14,
    borderWidth: 1.5, borderColor: '#334155', marginBottom: 20,
  },
  customBoxActive: { borderColor: '#3B82F6', backgroundColor: '#172033' },
  customField: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  customInput: {
    fontSize: 28, fontWeight: '700', color: '#F1F5F9',
    minWidth: 44, textAlign: 'center',
    fontVariant: ['tabular-nums' as any],
  },
  customUnit:   { fontSize: 13, color: '#64748B', fontWeight: '600' },
  customSep:    { fontSize: 24, color: '#334155', fontWeight: '300', paddingHorizontal: 4 },
  confirmBtn:    { borderRadius: 14, overflow: 'hidden' },
  confirmBtnDisabled: { opacity: 0.5 },
  confirmGrad:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 16 },
  confirmText:   { fontSize: 16, fontWeight: '700', color: '#fff' },
});

// ── Animated pulse ring ───────────────────────────────────────────────────────
function PulseRing({ delay = 0, color = '#3B82F6' }: { delay?: number; color?: string }) {
  const scale   = useSharedValue(0.4);
  const opacity = useSharedValue(0.7);
  useEffect(() => {
    scale.value   = withDelay(delay, withRepeat(withTiming(1.8, { duration: 2200, easing: Easing.out(Easing.quad) }), -1, false));
    opacity.value = withDelay(delay, withRepeat(withTiming(0,   { duration: 2200, easing: Easing.out(Easing.quad) }), -1, false));
  }, []);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }], opacity: opacity.value }));
  return <Animated.View style={[StyleSheet.absoluteFillObject, style, { borderRadius: 999, borderWidth: 2, borderColor: color }]} />;
}

// ── Radar sweep ───────────────────────────────────────────────────────────────
function RadarSweep({ active }: { active: boolean }) {
  const rotation = useSharedValue(0);
  useEffect(() => {
    if (active) {
      rotation.value = withRepeat(withTiming(360, { duration: 3000, easing: Easing.linear }), -1, false);
    } else { rotation.value = 0; }
  }, [active]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));
  return (
    <Animated.View style={[StyleSheet.absoluteFillObject, style, { borderRadius: 999, overflow: 'hidden' }]}>
      <LinearGradient
        colors={['transparent', 'transparent', active ? '#3B82F630' : 'transparent', active ? '#3B82F660' : 'transparent']}
        start={{ x: 0.5, y: 0.5 }} end={{ x: 1, y: 0 }}
        style={StyleSheet.absoluteFillObject}
      />
    </Animated.View>
  );
}

// ── Shield orb ────────────────────────────────────────────────────────────────
function ShieldOrb({ active }: { active: boolean }) {
  const glow      = useSharedValue(0.5);
  const iconScale = useSharedValue(1);
  const ORB_SIZE  = 140;
  useEffect(() => {
    if (active) {
      glow.value      = withRepeat(withSequence(withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.sin) }), withTiming(0.5, { duration: 1500, easing: Easing.inOut(Easing.sin) })), -1, false);
      iconScale.value = withRepeat(withSequence(withTiming(1.08, { duration: 1200 }), withTiming(1, { duration: 1200 })), -1, false);
    } else { glow.value = 1; iconScale.value = 1; }
  }, [active]);
  const glowStyle = useAnimatedStyle(() => ({ shadowOpacity: interpolate(glow.value, [0.5, 1], [0.3, 0.85]), shadowRadius: interpolate(glow.value, [0.5, 1], [8, 28]) }));
  const iconStyle = useAnimatedStyle(() => ({ transform: [{ scale: iconScale.value }] }));
  return (
    <View style={{ width: ORB_SIZE, height: ORB_SIZE, alignItems: 'center', justifyContent: 'center' }}>
      {active && (<><PulseRing delay={0} color="#3B82F6" /><PulseRing delay={700} color="#3B82F6" /><PulseRing delay={1400} color="#3B82F6" /></>)}
      <RadarSweep active={active} />
      <Animated.View style={[{ width: ORB_SIZE, height: ORB_SIZE, borderRadius: ORB_SIZE / 2, justifyContent: 'center', alignItems: 'center', shadowColor: active ? '#3B82F6' : '#1E293B', shadowOffset: { width: 0, height: 0 }, elevation: 20, overflow: 'hidden' }, glowStyle]}>
        <LinearGradient colors={active ? ['#1d4ed8', '#1E3A5F', '#0F172A'] : ['#1E3A5F', '#162032', '#0F172A']} style={[StyleSheet.absoluteFillObject, { borderRadius: ORB_SIZE / 2 }]} />
        <View style={{ position: 'absolute', width: ORB_SIZE - 16, height: ORB_SIZE - 16, borderRadius: (ORB_SIZE - 16) / 2, borderWidth: 1, borderColor: active ? '#3B82F640' : '#ffffff15' }} />
        <Animated.View style={iconStyle}>
          <Ionicons name={active ? 'shield-checkmark' : 'shield-outline'} size={52} color={active ? '#60A5FA' : '#3B82F6'} />
        </Animated.View>
      </Animated.View>
    </View>
  );
}

// ── Feature pill ──────────────────────────────────────────────────────────────
function FeaturePill({ icon, text, index }: { icon: string; text: string; index: number }) {
  return (
    <Animated.View entering={FadeInUp.delay(400 + index * 100).springify()} style={pill.wrap}>
      <View style={pill.iconBox}><Ionicons name={icon as any} size={16} color="#3B82F6" /></View>
      <Text style={pill.text}>{text}</Text>
    </Animated.View>
  );
}
const pill = StyleSheet.create({
  wrap:    { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingHorizontal: 16, backgroundColor: '#ffffff08', borderRadius: 12, borderWidth: 1, borderColor: '#ffffff10', marginBottom: 10 },
  iconBox: { width: 30, height: 30, borderRadius: 8, backgroundColor: '#3B82F615', justifyContent: 'center', alignItems: 'center' },
  text:    { color: '#CBD5E1', fontSize: 13.5, fontWeight: '500', flex: 1 },
});

// ── GPS chip ──────────────────────────────────────────────────────────────────
function GpsChip({ gps }: { gps: { lat: number; lng: number; updatedAt: string } | null }) {
  const dot = useSharedValue(1);
  useEffect(() => {
    dot.value = withRepeat(withSequence(withTiming(0.2, { duration: 700 }), withTiming(1, { duration: 700 })), -1, false);
  }, []);
  const dotStyle = useAnimatedStyle(() => ({ opacity: dot.value }));
  return (
    <BlurView intensity={18} tint="dark" style={chip.wrap}>
      <View style={chip.header}><Animated.View style={[chip.dot, dotStyle]} /><Text style={chip.label}>LIVE GPS</Text></View>
      {gps ? (
        <View>
          <Text style={chip.coords}>{gps.lat.toFixed(5)}, {gps.lng.toFixed(5)}</Text>
          <Text style={chip.updated}>Last ping · {gps.updatedAt}</Text>
        </View>
      ) : (<Text style={chip.waiting}>Acquiring signal…</Text>)}
      <Text style={chip.note}>Broadcast every 60 s · background-safe</Text>
    </BlurView>
  );
}
const chip = StyleSheet.create({
  wrap:    { borderRadius: 16, overflow: 'hidden', padding: 16, borderWidth: 1, borderColor: '#3B82F630', marginTop: 4 },
  header:  { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  dot:     { width: 8, height: 8, borderRadius: 4, backgroundColor: '#22D3EE' },
  label:   { fontSize: 10, fontWeight: '700', color: '#22D3EE', letterSpacing: 2 },
  coords:  { fontSize: 13, color: '#F1F5F9', fontVariant: ['tabular-nums' as any], marginBottom: 3 },
  updated: { fontSize: 11, color: '#64748B' },
  waiting: { fontSize: 13, color: '#64748B', fontStyle: 'italic', marginBottom: 4 },
  note:    { fontSize: 10, color: '#334155', marginTop: 10 },
});

// ── Timer display ─────────────────────────────────────────────────────────────
function ElapsedTimer({ seconds }: { seconds: number }) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return (
    <View style={tmr.wrap}>
      <Text style={tmr.label}>ACTIVE FOR</Text>
      <Text style={tmr.value}>
        {h > 0 && <>{String(h).padStart(2, '0')}<Text style={tmr.sep}>:</Text></>}
        {String(m).padStart(2, '0')}
        <Text style={tmr.sep}>:</Text>
        {String(s).padStart(2, '0')}
      </Text>
    </View>
  );
}
const tmr = StyleSheet.create({
  wrap:  { alignItems: 'center', paddingVertical: 8 },
  label: { fontSize: 10, fontWeight: '700', color: '#64748B', letterSpacing: 3, marginBottom: 4 },
  value: { fontSize: 52, fontWeight: '700', color: '#F1F5F9', fontVariant: ['tabular-nums' as any], letterSpacing: -2 },
  sep:   { color: '#3B82F6' },
});

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════
export default function Escort() {
  const router = useRouter();

  // Core state
  const [isTracking,       setIsTracking]       = useState(false);
  const [loading,          setLoading]           = useState(false);
  const [checkingPremium,  setCheckingPremium]   = useState(true);
  const [isPremium,        setIsPremium]         = useState(false);
  const [sessionId,        setSessionId]         = useState<string | null>(null);
  const [startTime,        setStartTime]         = useState<string | null>(null);
  const [elapsedSeconds,   setElapsedSeconds]    = useState(0);
  const [currentGps,       setCurrentGps]        = useState<{ lat: number; lng: number; updatedAt: string } | null>(null);

  // ETA picker modal
  const [etaModalVisible,  setEtaModalVisible]   = useState(false);

  const intervalRef        = useRef<any>(null);
  const timerRef           = useRef<any>(null);
  const tokenRef           = useRef<string | null>(null);
  const trackingStartedRef = useRef(false);
  const isTrackingRef      = useRef(false);
  const appStateRef        = useRef(AppState.currentState);

  useEffect(() => { isTrackingRef.current = isTracking; }, [isTracking]);

  // ── Timer (BUG FIX: use parseUtcIso to normalise server timestamps) ─────────
  useEffect(() => {
    if (isTracking && startTime) {
      const startMs = parseUtcIso(startTime);
      const tick = () => setElapsedSeconds(Math.floor((Date.now() - startMs) / 1000));
      tick(); // immediate first tick
      timerRef.current = setInterval(tick, 1000);
    } else {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setElapsedSeconds(0);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isTracking, startTime]);

  // ── AppState: foreground ↔ background swap ───────────────────────────────
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (nextState) => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;
      if (!isTrackingRef.current || !tokenRef.current) return;
      if (prev === 'active' && nextState === 'background') {
        if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
        try {
          const running = await Location.hasStartedLocationUpdatesAsync(ESCORT_TASK).catch(() => false);
          if (!running) {
            await Location.startLocationUpdatesAsync(ESCORT_TASK, {
              accuracy: Location.Accuracy.High,
              timeInterval: 60_000,
              distanceInterval: 0,
              foregroundService: {
                notificationTitle: '🛡 Se-Q Escort Active',
                notificationBody: 'Security can see your location.',
              },
              pausesUpdatesAutomatically: false,
            });
          }
        } catch (_) {}
      } else if (nextState === 'active' && prev !== 'active') {
        try { await Location.stopLocationUpdatesAsync(ESCORT_TASK); } catch (_) {}
        if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
        postGpsPoint(tokenRef.current!);
        intervalRef.current = setInterval(() => postGpsPoint(tokenRef.current!), 60_000);
      }
    });
    return () => sub.remove();
  }, []);

  // ── Focus ─────────────────────────────────────────────────────────────────
  useFocusEffect(
    useCallback(() => {
      if (isTrackingRef.current) {
        if (!intervalRef.current && tokenRef.current) {
          intervalRef.current = setInterval(() => postGpsPoint(tokenRef.current!), 60_000);
        }
      } else {
        trackingStartedRef.current = false;
        checkActiveEscort();
      }
      return () => { if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; } };
    }, [])
  );

  // ── Check / restore session ───────────────────────────────────────────────
  const checkActiveEscort = async () => {
    setCheckingPremium(true);
    try {
      const token = await getAuthToken();
      if (!token) { router.replace('/auth/login'); return; }
      tokenRef.current = token;

      try {
        const statusRes = await axios.get(`${BACKEND_URL}/api/escort/status`, {
          headers: { Authorization: `Bearer ${token}` }, timeout: 8000,
        });
        if (statusRes.data?.is_active && statusRes.data?.session_id) {
          const sid = statusRes.data.session_id;
          const sat = statusRes.data.started_at || new Date().toISOString();
          await AsyncStorage.multiSet([
            ['active_escort', JSON.stringify({ session_id: sid, started_at: sat })],
            ['auth_token', token],
          ]);
          setSessionId(sid); setStartTime(sat);
          setIsTracking(true); isTrackingRef.current = true;
          startLocationTracking(token);
        } else {
          await AsyncStorage.removeItem('active_escort');
        }
      } catch (_statusErr) {
        const stored = await AsyncStorage.getItem('active_escort');
        if (stored) {
          try {
            const data = JSON.parse(stored);
            setIsTracking(true); isTrackingRef.current = true;
            setSessionId(data.session_id); setStartTime(data.started_at);
            startLocationTracking(token);
          } catch (_) { await AsyncStorage.removeItem('active_escort'); }
        }
      }

      const metadata = await getUserMetadata();
      if (metadata.isPremium) {
        setIsPremium(true);
      } else {
        const res = await axios.get(`${BACKEND_URL}/api/user/profile`, {
          headers: { Authorization: `Bearer ${token}` }, timeout: 10000,
        });
        const premium = res.data?.is_premium === true;
        setIsPremium(premium);
        if (!premium && !isTrackingRef.current) {
          Alert.alert(
            'Premium Feature',
            'Security Escort is a premium feature. Would you like to upgrade?',
            [
              { text: 'Go Back', onPress: () => router.back() },
              { text: 'Upgrade', onPress: () => router.replace('/premium') },
            ]
          );
        }
      }
    } catch (err: any) {
      if (err?.response?.status === 401) { await clearAuthData(); router.replace('/auth/login'); }
    } finally {
      setCheckingPremium(false);
    }
  };

  // ── Start escort (called from ETA picker) ────────────────────────────────
  const startEscort = async (durationHours: number, durationLabel: string) => {
    setEtaModalVisible(false);
    if (!isPremium) { Alert.alert('Premium Required', 'Please upgrade to use Security Escort.'); return; }
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    setLoading(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'Location permission required');
        setLoading(false);
        return;
      }
      try { await Location.requestBackgroundPermissionsAsync(); } catch (_) {}

      const startCoords = await getLocation('soft');
      if (!startCoords) {
        Alert.alert('Location Required', 'Unable to get your location. Please enable GPS and try again.');
        setLoading(false);
        return;
      }
      const token = await getAuthToken();
      if (!token) { router.replace('/auth/login'); return; }
      tokenRef.current = token;

      const res = await axios.post(
        `${BACKEND_URL}/api/escort/action`,
        {
          action: 'start',
          duration_hours: durationHours,
          location: {
            latitude:  startCoords.latitude,
            longitude: startCoords.longitude,
            accuracy:  startCoords.accuracy,
            timestamp: new Date().toISOString(),
          },
        },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      );

      const newSessionId = res.data.session_id;
      // Use client-side ISO timestamp (always has Z, always correct)
      const startedAt    = new Date().toISOString();
      await AsyncStorage.multiSet([
        ['active_escort', JSON.stringify({ session_id: newSessionId, started_at: startedAt, duration_hours: durationHours })],
        ['auth_token', token],
      ]);
      setSessionId(newSessionId); setStartTime(startedAt);
      setIsTracking(true); isTrackingRef.current = true;
      trackingStartedRef.current = false;
      startLocationTracking(token);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      if (err?.response?.status === 401) { await clearAuthData(); router.replace('/auth/login'); return; }
      try {
        const tok = await getAuthToken();
        if (tok) {
          const check = await axios.get(`${BACKEND_URL}/api/escort/status`, {
            headers: { Authorization: `Bearer ${tok}` }, timeout: 8000,
          });
          if (check.data?.is_active && check.data?.session_id) {
            const sid = check.data.session_id;
            const sat = new Date().toISOString(); // use client time (correct)
            await AsyncStorage.multiSet([
              ['active_escort', JSON.stringify({ session_id: sid, started_at: sat })],
              ['auth_token', tok],
            ]);
            tokenRef.current = tok;
            setSessionId(sid); setStartTime(sat);
            setIsTracking(true); isTrackingRef.current = true;
            trackingStartedRef.current = false;
            startLocationTracking(tok);
            return;
          }
        }
      } catch (_) {}
      Alert.alert('Error', err.response?.data?.detail || 'Failed to start escort. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // ── GPS post ─────────────────────────────────────────────────────────────
  const postGpsPoint = async (token: string) => {
    try {
      const loc = await getLocation('soft');
      if (!loc) return;
      setCurrentGps({ lat: loc.latitude, lng: loc.longitude, updatedAt: new Date().toLocaleTimeString() });
      await axios.post(
        `${BACKEND_URL}/api/escort/location`,
        { latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy, timestamp: new Date().toISOString() },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
      );
    } catch (_) {}
  };

  // ── Start location tracking ───────────────────────────────────────────────
  const startLocationTracking = async (token: string) => {
    if (trackingStartedRef.current) return;
    trackingStartedRef.current = true;
    tokenRef.current = token;
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    await postGpsPoint(token);
    intervalRef.current = setInterval(() => postGpsPoint(token), 60_000);
  };

  // ── Stop escort ───────────────────────────────────────────────────────────
  const stopEscort = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert('Arrived Safely?', 'This will stop tracking and remove all route data.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Yes, I Arrived',
        onPress: async () => {
          setLoading(true);
          try {
            if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
            try { await Location.stopLocationUpdatesAsync(ESCORT_TASK); } catch (_) {}
            trackingStartedRef.current = false;
            const token = await getAuthToken();
            if (token) {
              await axios.post(
                `${BACKEND_URL}/api/escort/action`,
                { action: 'stop', location: { latitude: 0, longitude: 0, timestamp: new Date().toISOString() } },
                { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
              );
            }
            await AsyncStorage.removeItem('active_escort');
            setIsTracking(false); isTrackingRef.current = false;
            setSessionId(null); setStartTime(null);
            await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            Alert.alert('Arrived Safely!', 'Tracking stopped. Route data deleted.', [
              { text: 'OK', onPress: () => router.back() },
            ]);
          } catch (_) {
            Alert.alert('Error', 'Failed to stop escort. Please try again.');
          } finally {
            setLoading(false);
          }
        },
      },
    ]);
  };

  // ── Loading screen ────────────────────────────────────────────────────────
  if (checkingPremium) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0A0F1C' }}>
        <LinearGradient colors={['#0A0F1C', '#0F172A', '#0A0F1C']} style={StyleSheet.absoluteFillObject} />
        <SafeAreaView style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color="#3B82F6" />
          <Text style={{ color: '#64748B', marginTop: 14, fontSize: 13, letterSpacing: 1 }}>AUTHENTICATING</Text>
        </SafeAreaView>
      </View>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────────
  return (
    <View style={{ flex: 1, backgroundColor: '#0A0F1C' }}>
      <LinearGradient
        colors={isTracking ? ['#051024', '#0c1a35', '#071322'] : ['#0A0F1C', '#0F172A', '#0A0F1C']}
        style={StyleSheet.absoluteFillObject}
      />

      {/* Grid texture */}
      <View style={st.gridOverlay} pointerEvents="none">
        {Array.from({ length: 8 }).map((_, i) => (
          <View key={i} style={[st.gridLine, { top: `${i * 14}%` as any }]} />
        ))}
      </View>

      <SafeAreaView style={{ flex: 1 }}>
        {/* Header */}
        <Animated.View entering={FadeInDown.duration(400)} style={st.header}>
          <TouchableOpacity style={st.backBtn} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={22} color="#94A3B8" />
          </TouchableOpacity>
          <View style={st.headerCenter}>
            <Text style={st.headerTitle}>SECURITY ESCORT</Text>
            {isTracking && (
              <Animated.View entering={ZoomIn.delay(100)} style={st.liveBadge}>
                <View style={st.liveDot} />
                <Text style={st.liveText}>LIVE</Text>
              </Animated.View>
            )}
          </View>
          <View style={st.premiumBadge}>
            <Ionicons name="star" size={11} color="#F59E0B" />
            <Text style={st.premiumText}>PRO</Text>
          </View>
        </Animated.View>

        {/* ── IDLE STATE ── */}
        {!isTracking ? (
          <ScrollView
            contentContainerStyle={st.body}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* Orb */}
            <Animated.View entering={ZoomIn.delay(100).springify()} style={st.orbWrap}>
              <ShieldOrb active={false} />
            </Animated.View>

            {/* Headline */}
            <Animated.View entering={FadeInUp.delay(200)} style={st.headlineWrap}>
              <Text style={st.headline}>Ready to Escort</Text>
              <Text style={st.subheadline}>
                Activate tracking so nearby security operatives can monitor your journey in real time.
              </Text>
            </Animated.View>

            {/* Feature pills */}
            <View style={st.pillsWrap}>
              {[
                { icon: 'location-outline',  text: 'GPS broadcasted every 60 seconds' },
                { icon: 'shield-outline',    text: 'Runs safely in the background' },
                { icon: 'people-outline',    text: 'Visible to all nearby security' },
                { icon: 'trash-outline',     text: 'Route deleted on arrival' },
              ].map((f, i) => <FeaturePill key={i} icon={f.icon} text={f.text} index={i} />)}
            </View>

            {/* CTA — opens ETA picker */}
            <Animated.View entering={FadeInUp.delay(600)} style={st.ctaWrap}>
              <TouchableOpacity
                onPress={() => setEtaModalVisible(true)}
                disabled={loading}
                activeOpacity={0.85}
                style={st.startBtnWrap}
              >
                <LinearGradient
                  colors={loading ? ['#1E3A5F', '#1E3A5F'] : ['#2563EB', '#1d4ed8', '#1e40af']}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                  style={st.startBtn}
                >
                  {loading ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <>
                      <View style={st.startIconBox}>
                        <Ionicons name="navigate" size={20} color="#fff" />
                      </View>
                      <Text style={st.startBtnText}>Start Escort</Text>
                      <Ionicons name="chevron-up" size={18} color="#93C5FD" style={{ marginLeft: 4 }} />
                    </>
                  )}
                </LinearGradient>
              </TouchableOpacity>
            </Animated.View>
          </ScrollView>
        ) : (
          /* ── ACTIVE STATE ── */
          <Animated.View entering={FadeIn.duration(500)} style={st.body}>
            <View style={st.orbWrap}><ShieldOrb active={true} /></View>

            <Animated.View entering={FadeInDown.delay(150)}>
              <ElapsedTimer seconds={elapsedSeconds} />
            </Animated.View>

            <Animated.View entering={FadeInUp.delay(200)} style={st.statusRow}>
              <View style={st.statusChip}>
                <Ionicons name="checkmark-circle" size={14} color="#10B981" />
                <Text style={st.statusChipText}>Security notified</Text>
              </View>
              <View style={[st.statusChip, { borderColor: '#3B82F630', backgroundColor: '#3B82F610' }]}>
                <Ionicons name="wifi" size={14} color="#3B82F6" />
                <Text style={[st.statusChipText, { color: '#3B82F6' }]}>Broadcasting</Text>
              </View>
            </Animated.View>

            <Animated.View entering={FadeInUp.delay(300)} style={{ width: '100%' }}>
              <GpsChip gps={currentGps} />
            </Animated.View>

            <Animated.View entering={FadeInUp.delay(400)} style={st.tipBox}>
              <Ionicons name="information-circle-outline" size={16} color="#64748B" />
              <Text style={st.tipText}>
                Keep the app open or in the background. Tap "Arrived" when you reach your destination.
              </Text>
            </Animated.View>

            <Animated.View entering={FadeInUp.delay(500)} style={st.ctaWrap}>
              <TouchableOpacity onPress={stopEscort} disabled={loading} activeOpacity={0.85} style={st.startBtnWrap}>
                <LinearGradient
                  colors={loading ? ['#1E293B', '#1E293B'] : ['#059669', '#047857', '#065f46']}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                  style={st.startBtn}
                >
                  {loading ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <>
                      <View style={[st.startIconBox, { backgroundColor: '#ffffff20' }]}>
                        <Ionicons name="checkmark" size={20} color="#fff" />
                      </View>
                      <Text style={st.startBtnText}>I've Arrived Safely</Text>
                    </>
                  )}
                </LinearGradient>
              </TouchableOpacity>
            </Animated.View>
          </Animated.View>
        )}
      </SafeAreaView>

      {/* ETA Picker — floating modal */}
      <EtaPicker
        visible={etaModalVisible}
        onClose={() => setEtaModalVisible(false)}
        onConfirm={startEscort}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const st = StyleSheet.create({
  gridOverlay:  { position: 'absolute', inset: 0, overflow: 'hidden' },
  gridLine:     { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: '#ffffff06' },
  header:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16 },
  backBtn:      { width: 38, height: 38, borderRadius: 10, backgroundColor: '#ffffff0a', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#ffffff10' },
  headerCenter: { flex: 1, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 10 },
  headerTitle:  { fontSize: 12, fontWeight: '700', color: '#94A3B8', letterSpacing: 3 },
  liveBadge:    { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#EF444420', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: '#EF444440' },
  liveDot:      { width: 5, height: 5, borderRadius: 3, backgroundColor: '#EF4444' },
  liveText:     { fontSize: 9, fontWeight: '800', color: '#EF4444', letterSpacing: 1.5 },
  premiumBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#F59E0B15', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: '#F59E0B30' },
  premiumText:  { fontSize: 10, fontWeight: '700', color: '#F59E0B', letterSpacing: 1 },
  body:         { flexGrow: 1, paddingHorizontal: 24, paddingTop: 8, alignItems: 'center' },
  orbWrap:      { marginBottom: 28, marginTop: 8 },
  headlineWrap: { alignItems: 'center', marginBottom: 28 },
  headline:     { fontSize: 26, fontWeight: '700', color: '#F1F5F9', textAlign: 'center', marginBottom: 10, letterSpacing: -0.5 },
  subheadline:  { fontSize: 14, color: '#64748B', textAlign: 'center', lineHeight: 21, maxWidth: 300 },
  pillsWrap:    { width: '100%', marginBottom: 28 },
  statusRow:    { flexDirection: 'row', gap: 10, marginBottom: 18 },
  statusChip:   { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 7, paddingHorizontal: 13, borderRadius: 20, backgroundColor: '#10B98110', borderWidth: 1, borderColor: '#10B98130' },
  statusChipText: { fontSize: 12, fontWeight: '600', color: '#10B981' },
  tipBox:       { flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: '#ffffff06', borderRadius: 12, padding: 14, marginTop: 14, borderWidth: 1, borderColor: '#ffffff0a', width: '100%' },
  tipText:      { flex: 1, fontSize: 12, color: '#64748B', lineHeight: 18 },
  ctaWrap:      { width: '100%', marginTop: 'auto' as any, paddingBottom: Platform.OS === 'ios' ? 8 : 16, paddingTop: 8 },
  startBtnWrap: { width: '100%', borderRadius: 16, overflow: 'hidden', shadowColor: '#3B82F6', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 12 },
  startBtn:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 18, paddingHorizontal: 24, gap: 12 },
  startIconBox: { width: 32, height: 32, borderRadius: 8, backgroundColor: '#ffffff20', justifyContent: 'center', alignItems: 'center' },
  startBtnText: { fontSize: 16, fontWeight: '700', color: '#fff', letterSpacing: 0.3 },
});
