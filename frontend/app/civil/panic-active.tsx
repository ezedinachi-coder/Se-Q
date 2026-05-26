/**
 * civil/panic-active.tsx
 *
 * FIX #3 — PRIVACY & SAFETY
 *   - Foreground service notification text changed to a neutral/discreet string.
 *     The previous title "🚨 SafeGuard Emergency Active" was visible in the
 *     Android notification shade and would reveal the app's purpose.
 *   - Device vibration restored on panic activation (confirms activation to the
 *     user without requiring any visible on-screen text).
 */
import React, { useState, useEffect, useRef } from 'react';
import AsyncStorage from '../../utils/asyncStorageShim';
import {
  View, Text, StyleSheet, Alert, BackHandler, Platform, Linking,
  AppState, AppStateStatus, Vibration,
} from 'react-native';
import { TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import axios from 'axios';
import EmergencyCategoryModal from '../../components/EmergencyCategoryModal';
import { getAuthToken, clearAuthData } from '../../utils/auth';
import { getLocation } from '../../utils/getLocation';
import BACKEND_URL from '../../utils/config';
import { beginAmbientCapture } from '../../utils/ambientRecorder';
import { setNativePanicActive } from '../../utils/nativePanicBridge';

const LOCATION_TASK = 'background-location-panic';

// ── Background task — must be at module level ─────────────────────────────────
if (!TaskManager.isTaskDefined(LOCATION_TASK)) {
  TaskManager.defineTask(LOCATION_TASK, async ({ data, error }: any) => {
    if (error) return;
    if (data?.locations?.[0]) {
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
    }
  });
}

const EMERGENCY_SERVICES: Record<string, { name: string; number: string }[]> = {
  ambulance: [
    { name: 'National Emergency', number: '112' },
    { name: 'Ambulance Service', number: '911' },
  ],
  fire: [
    { name: 'Fire Service', number: '101' },
    { name: 'Emergency',    number: '112' },
  ],
};

const SECURITY_EMERGENCIES = [
  'violence', 'robbery', 'kidnapping', 'breakin', 'burglary', 'harassment', 'other',
];

type Screen = 'category' | 'activating' | 'emergency_contacts';

const writeLocalPanic = async (panicId: string, category: string) => {
  const data = JSON.stringify({
    id: panicId,
    panic_id: panicId,
    category,
    activated_at: new Date().toISOString(),
  });
  await AsyncStorage.multiSet([
    ['panic_active',    'true'],
    ['panic_started_at', Date.now().toString()],
    ['panic_id',         panicId],
    ['active_panic',     data],
  ]);
};

export const clearLocalPanic = async () => {
  await AsyncStorage.multiRemove([
    'panic_active', 'panic_started_at', 'panic_id', 'active_panic',
  ]);
};

// ── Component ─────────────────────────────────────────────────────────────────
export default function PanicActive() {
  const router = useRouter();
  const [screen, setScreen] = useState<Screen>('category');
  const [emergencyType, setEmergencyType] = useState<'ambulance' | 'fire' | null>(null);

  // ── Escape-hatch: only fires when screen is 'activating' ─────────────────
  const screenRef = React.useRef(screen);
  React.useEffect(() => { screenRef.current = screen; }, [screen]);

  useEffect(() => {
    const checkIfAlreadyActivated = async () => {
      if (screenRef.current !== 'activating') return;
      const panicActive = await AsyncStorage.getItem('panic_active');
      const activePanic = await AsyncStorage.getItem('active_panic');
      if (panicActive === 'true' || !!activePanic) {
        router.replace('/civil/home');
      }
    };

    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') checkIfAlreadyActivated();
    });

    return () => sub.remove();
  }, []);

  useEffect(() => {
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen === 'activating') return true;
      return false;
    });
    return () => handler.remove();
  }, [screen]);

  // ── Category selected ──────────────────────────────────────────────────────
  const handleCategorySelect = async (category: string) => {
    if (category === 'medical') {
      setEmergencyType('ambulance');
      setScreen('emergency_contacts');
    } else if (category === 'fire') {
      setEmergencyType('fire');
      setScreen('emergency_contacts');
    } else if (SECURITY_EMERGENCIES.includes(category)) {
      const capture = beginAmbientCapture();
      await activatePanic(category, capture);
    }
  };

  // ── Activate → close app ───────────────────────────────────────────────────
  const activatePanic = async (category: string, capture: ReturnType<typeof beginAmbientCapture>) => {
    setScreen('activating');
    try {
      // FIX: replaced BestForNavigation (hangs indefinitely on Android on cold GPS)
      // with the shared getLocation('panic') utility that:
      //   1. Uses Accuracy.High with an 8-second timeout
      //   2. Falls back to last-known position (≤5 min)
      //   3. Returns null rather than hanging forever or sending 0,0
      try { await Location.requestBackgroundPermissionsAsync(); } catch (_) {}

      const coords = await getLocation('panic');
      // coords may be null if GPS is completely unavailable — that is acceptable.
      // We send null fields rather than 0,0. The background task will post the
      // real fix once GPS warms up.

      const token = await getAuthToken();
      if (!token) { router.replace('/auth/login'); return; }

      const res = await axios.post(
        `${BACKEND_URL}/api/panic/activate`,
        {
          latitude:           coords?.latitude  ?? null,
          longitude:          coords?.longitude ?? null,
          accuracy:           coords?.accuracy  ?? null,
          timestamp:          new Date().toISOString(),
          emergency_category: category,
        },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      );

      const pid = res.data.panic_id;
      await writeLocalPanic(pid, category);
      await AsyncStorage.setItem('auth_token', token);
      capture.attachToPanic(pid, token);

      await setNativePanicActive(true);

      // FIX #3: Vibrate to confirm activation without displaying visible text.
      // Three pulses — felt by the user, invisible to an observer.
      Vibration.vibrate([0, 400, 100, 400, 100, 400]);

      try {
        await Location.startLocationUpdatesAsync(LOCATION_TASK, {
          accuracy:        Location.Accuracy.High,
          timeInterval:    60000,
          distanceInterval: 0,
          foregroundService: {
            // FIX #3: Neutral title — reveals no security/emergency context
            // in the Android notification shade.
            notificationTitle: 'Se-Q',
            notificationBody:  'Se-Q Active',
          },
          pausesUpdatesAutomatically: false,
        });
      } catch (_) {}

      if (Platform.OS === 'android') {
        BackHandler.exitApp();
      } else {
        router.replace('/civil/home');
      }
    } catch (err: any) {
      if (err?.response?.status === 401) {
        await clearAuthData();
        router.replace('/auth/login');
      } else {
        Alert.alert('Error', 'Failed to activate panic mode. Please try again.');
        router.back();
      }
    }
  };

  const callEmergency = (number: string) => Linking.openURL(`tel:${number}`);

  // ── SCREEN: Category picker ────────────────────────────────────────────────
  if (screen === 'category') {
    return (
      <SafeAreaView style={styles.container}>
        <EmergencyCategoryModal
          visible={true}
          onSelect={handleCategorySelect}
          onCancel={() => router.back()}
        />
      </SafeAreaView>
    );
  }

  // ── SCREEN: Activating ─────────────────────────────────────────────────────
  if (screen === 'activating') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <View style={styles.iconRing}>
            <Ionicons name="alert-circle" size={80} color="#EF4444" />
          </View>
          <Text style={styles.activatingTitle}>Activating Emergency…</Text>
          <Text style={styles.activatingSubtitle}>
            Notifying security services{'\n'}and starting GPS tracking
          </Text>
          <Text style={styles.closingNote}>
            The app will close automatically once activated.{'\n'}
            GPS tracking continues silently in the background.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── SCREEN: Emergency contacts (medical / fire) ────────────────────────────
  if (screen === 'emergency_contacts' && emergencyType) {
    const services = EMERGENCY_SERVICES[emergencyType];
    const title = emergencyType === 'ambulance' ? 'Ambulance Services' : 'Fire Services';
    const icon  = emergencyType === 'ambulance' ? 'medkit' : 'flame';
    const color = emergencyType === 'ambulance' ? '#10B981' : '#F59E0B';

    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => setScreen('category')}>
            <Ionicons name="arrow-back" size={24} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{title}</Text>
          <View style={{ width: 24 }} />
        </View>
        <View style={styles.center}>
          <View style={[styles.iconRing, { backgroundColor: `${color}20` }]}>
            <Ionicons name={icon as any} size={60} color={color} />
          </View>
          <Text style={styles.activatingTitle}>{title}</Text>
          <Text style={styles.activatingSubtitle}>
            Tap to call emergency services immediately
          </Text>
          {services.map((s, i) => (
            <TouchableOpacity
              key={i}
              style={[styles.callBtn, { backgroundColor: color }]}
              onPress={() => callEmergency(s.number)}
            >
              <Ionicons name="call" size={24} color="#fff" />
              <View style={{ marginLeft: 16 }}>
                <Text style={styles.callName}>{s.name}</Text>
                <Text style={styles.callNumber}>{s.number}</Text>
              </View>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={styles.backHomeBtn} onPress={() => router.replace('/civil/home')}>
            <Text style={styles.backHomeText}>Back to Home</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  container:          { flex: 1, backgroundColor: '#0F172A' },
  header:             { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20 },
  headerTitle:        { fontSize: 20, fontWeight: 'bold', color: '#fff' },
  center:             { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 28 },
  iconRing:           { width: 140, height: 140, borderRadius: 70, backgroundColor: '#EF444420', justifyContent: 'center', alignItems: 'center', marginBottom: 28 },
  activatingTitle:    { fontSize: 26, fontWeight: 'bold', color: '#EF4444', marginBottom: 12, textAlign: 'center' },
  activatingSubtitle: { fontSize: 16, color: '#94A3B8', textAlign: 'center', lineHeight: 24, marginBottom: 24 },
  closingNote:        { fontSize: 14, color: '#475569', textAlign: 'center', lineHeight: 22, marginTop: 8, backgroundColor: '#1E293B', borderRadius: 12, padding: 16 },
  callBtn:            { flexDirection: 'row', alignItems: 'center', width: '100%', padding: 20, borderRadius: 16, marginBottom: 16 },
  callName:           { fontSize: 18, fontWeight: '600', color: '#fff' },
  callNumber:         { fontSize: 24, fontWeight: 'bold', color: '#fff' },
  backHomeBtn:        { marginTop: 24, paddingVertical: 16, paddingHorizontal: 32 },
  backHomeText:       { fontSize: 16, color: '#64748B' },
});
