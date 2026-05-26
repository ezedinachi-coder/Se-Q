import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Slot, useRouter, useSegments } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  AppState, AppStateStatus,
  View, Text, TouchableOpacity, Animated, StyleSheet,
  Alert, Platform,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Notifications from 'expo-notifications';
import { startQueueProcessor } from '../utils/offlineQueue';
import {
  useShakeDetector,
  startShakeTimeout,
  cancelShakeTimeout,
  isShakeTimeoutActive,
} from '../utils/shakeDetector';
import {
  checkAndConsumePanic,
  startShakeService,
  isIgnoringBatteryOptimizations,
  requestIgnoreBatteryOptimizations,
  requestPostNotificationsPermission,
} from '../utils/nativePanicBridge';
import BACKEND_URL from '../utils/config';
import { getAuthToken } from '../utils/auth';
import * as Location from 'expo-location';
import { getLocation } from '../utils/getLocation';
import { AudioManager } from '../utils/AudioManager';
import AsyncStorage from '../utils/asyncStorageShim';

// ── In-app shake banner (shown only when app is foregrounded) ─────────────────

interface ShakeBannerProps { onTap: () => void; onDismiss: () => void; }

function ShakeBanner({ onTap, onDismiss }: ShakeBannerProps) {
  const translateY = useRef(new Animated.Value(-80)).current;

  useEffect(() => {
    Animated.spring(translateY, {
      toValue: 0, useNativeDriver: true, tension: 80, friction: 10,
    }).start();
  }, []);

  const handleDismiss = useCallback(() => {
    Animated.timing(translateY, { toValue: -80, duration: 200, useNativeDriver: true })
      .start(onDismiss);
  }, [onDismiss]);

  const handleTap = useCallback(() => {
    Animated.timing(translateY, { toValue: -80, duration: 150, useNativeDriver: true })
      .start(onTap);
  }, [onTap]);

  return (
    <Animated.View
      style={[bannerStyles.wrapper, { transform: [{ translateY }] }]}
      pointerEvents="box-none"
    >
      <TouchableOpacity style={bannerStyles.banner} onPress={handleTap} activeOpacity={0.85}>
        <View style={bannerStyles.dot} />
        <View style={bannerStyles.textCol}>
          <Text style={bannerStyles.title}>Tap to activate emergency</Text>
          <Text style={bannerStyles.sub}>Swipe away or wait 5 s to cancel</Text>
        </View>
        <TouchableOpacity
          onPress={handleDismiss}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Text style={bannerStyles.x}>✕</Text>
        </TouchableOpacity>
      </TouchableOpacity>
    </Animated.View>
  );
}

const bannerStyles = StyleSheet.create({
  wrapper: {
    position: 'absolute', top: 44, left: 16, right: 16,
    zIndex: 9999, elevation: 20,
  },
  banner: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#1E293B', borderRadius: 14,
    paddingHorizontal: 16, paddingVertical: 12, gap: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4, shadowRadius: 8,
    borderWidth: 1, borderColor: '#EF4444',
  },
  dot:     { width: 8, height: 8, borderRadius: 4, backgroundColor: '#EF4444' },
  textCol: { flex: 1 },
  title:   { fontSize: 14, fontWeight: '700', color: '#fff' },
  sub:     { fontSize: 11, color: '#64748B', marginTop: 1 },
  x:       { fontSize: 14, color: '#475569', fontWeight: '600' },
});

// ── App content ───────────────────────────────────────────────────────────────

function AppContent() {
  const router   = useRouter();
  const segments = useSegments();

  const queueCleanup   = useRef<(() => void) | null>(null);
  const initialized    = useRef(false);
  const serviceStarted = useRef(false);
  const batteryChecked = useRef(false);
  const notifChecked   = useRef(false);

  const [userRole,      setUserRole]      = useState<string | null>(null);
  const [bannerVisible, setBannerVisible] = useState(false);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Banner helpers ─────────────────────────────────────────────────────────

  const showShakeBanner = useCallback(() => {
    // Cancel any existing timeout
    cancelShakeTimeout();

    setBannerVisible(true);
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);

    // Start tracking the timeout - if no action within 5s, auto-dismiss
    startShakeTimeout(() => {
      // This runs on timeout - dismiss the banner
      setBannerVisible(false);
    });

    // Also set the banner auto-dismiss timer for the in-app notification (5s)
    bannerTimerRef.current = setTimeout(() => setBannerVisible(false), 5000);
  }, []);

  const handleBannerTap = useCallback(() => {
    // Cancel the timeout since user is taking action
    cancelShakeTimeout();
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    setBannerVisible(false);
    try { router.push('/civil/panic-shake'); } catch (_) {}
  }, []);

  const handleBannerDismiss = useCallback(() => {
    // Cancel the timeout since user dismissed
    cancelShakeTimeout();
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    setBannerVisible(false);
  }, []);

  useEffect(() => () => {
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
  }, []);

  // ── Load user role ─────────────────────────────────────────────────────────

  useEffect(() => {
    AsyncStorage.getItem('user_role').then(role => setUserRole(role));
  }, [segments.join('/')]);

  // ── Shake detection (foreground) ───────────────────────────────────────────

  const currentRoute    = segments.join('/');
  const isOnPanicScreen = currentRoute.includes('panic-shake') || currentRoute.includes('panic-active');
  const shakeEnabled    = userRole === 'civil' && !isOnPanicScreen;

  const handleShakeTrigger = useCallback(async () => {
    if (isOnPanicScreen) return;
    try {
      const panicActive = await AsyncStorage.getItem('panic_active');
      const activePanic = await AsyncStorage.getItem('active_panic');
      if (panicActive === 'true' || !!activePanic) return;
    } catch (_) {}
    showShakeBanner();
  }, [isOnPanicScreen, showShakeBanner]);

  useShakeDetector({
    enabled:        shakeEnabled,
    threshold:      2.2,
    requiredShakes: 5,
    windowMs:       3000,
    cooldownMs:     6000,
    onTriggered:    handleShakeTrigger,
  });

  // ── Start native ShakeDetectionService (civil users, Android only) ─────────

  useEffect(() => {
    if (userRole !== 'civil' || serviceStarted.current || Platform.OS !== 'android') return;
    serviceStarted.current = true;

    (async () => {
      try {
        const started = await startShakeService();
        console.log('[Layout] ShakeDetectionService started:', started);
      } catch (e) {
        console.warn('[Layout] Could not start ShakeDetectionService:', e);
      }
    })();
  }, [userRole]);

  // ── Android 13+ notification permission ───────────────────────────────────
  // Must be granted for the shake heads-up notification to appear when
  // the app is backgrounded. Ask once after the user role is known.

  useEffect(() => {
    if (userRole !== 'civil' || notifChecked.current || Platform.OS !== 'android') return;
    notifChecked.current = true;

    (async () => {
      try {
        const granted = await requestPostNotificationsPermission();
        console.log('[Layout] POST_NOTIFICATIONS permission:', granted ? 'granted' : 'denied');
      } catch (e) {
        console.warn('[Layout] Notification permission check failed:', e);
      }
    })();
  }, [userRole]);

  // ── Battery optimization prompt (first-launch, civil users only) ──────────

  useEffect(() => {
    if (userRole !== 'civil' || batteryChecked.current || Platform.OS !== 'android') return;
    batteryChecked.current = true;

    (async () => {
      try {
        const alreadyExempt = await isIgnoringBatteryOptimizations();
        if (alreadyExempt) {
          console.log('[Layout] Battery optimization already disabled — skipping prompt');
          return;
        }

        // Check if we've asked before — but don't mark BEFORE showing
        const hasPrompted = await AsyncStorage.getItem('battery_prompt_shown');
        if (hasPrompted === 'true') return;

        Alert.alert(
          '⚡ Enable Unrestricted Access',
          'For shake-to-panic and background protection to work reliably, Se-Q needs to run ' +
          'without battery restrictions.\n\nTap "Allow" on the next screen to grant unrestricted ' +
          'background access.',
          [
            {
              text: 'Allow (Recommended)',
              style: 'default',
              onPress: async () => {
                // Mark only after user actually taps Allow
                await AsyncStorage.setItem('battery_prompt_shown', 'true');
                await requestIgnoreBatteryOptimizations();
              },
            },
            {
              text: 'Skip',
              style: 'cancel',
              onPress: async () => {
                // Mark as shown so we don't re-prompt every launch, but
                // allow re-prompt on next fresh install by not marking on dismiss above
                await AsyncStorage.setItem('battery_prompt_shown', 'true');
              },
            },
          ],
          { cancelable: false }
        );
      } catch (e) {
        console.warn('[Layout] Battery optimization check failed:', e);
      }
    })();
  }, [userRole]);

  // ── Native panic bridge ────────────────────────────────────────────────────
  // When the app is backgrounded/killed and the user taps the shake heads-up
  // notification, MainActivity launches with seq_action=panic.
  // checkAndConsumePanic() reads + clears the SharedPrefs flag and we route
  // to /civil/panic-shake.
  //
  // Also polled on every AppState 'active' event so that if the user taps
  // the notification while the app is backgrounded (not killed), it works too.

  useEffect(() => {
    let isMounted  = true;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 300;

    const checkNativePanic = async () => {
      try {
        const pending = await checkAndConsumePanic();
        if (!pending || !isMounted) return;
        const role = await AsyncStorage.getItem('user_role');
        if (role !== 'civil') return;
        const route = segments.join('/');
        if (route.includes('panic-shake') || route.includes('panic-active')) return;
        router.replace('/civil/panic-shake');
      } catch (error) {
        if (retryCount < MAX_RETRIES) {
          retryCount++;
          setTimeout(checkNativePanic, RETRY_DELAY);
        }
      }
    };

    const coldStartTimer = setTimeout(checkNativePanic, 500);
    const appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        retryCount = 0;
        checkNativePanic();
      }
    });

    return () => {
      isMounted = false;
      clearTimeout(coldStartTimer);
      appStateSub.remove();
    };
  }, [segments]);

  // ── Queue processor ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!initialized.current) {
      initialized.current  = true;
      queueCleanup.current = startQueueProcessor();
    }
    return () => { queueCleanup.current?.(); queueCleanup.current = null; };
  }, []);

  // ── Location ping (push-notification triggered) ───────────────────────────

  const sendPingLocation = useCallback(async () => {
    try {
      const token = await getAuthToken();
      if (!token) return;
      const coords = await getLocation('soft');
      if (!coords) return;
      await fetch(`${BACKEND_URL}/api/location/ping-update`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          latitude:  coords.latitude,
          longitude: coords.longitude,
          accuracy:  coords.accuracy,
        }),
      });
    } catch (err) {
      console.error('[Ping] Location transmission failed:', err);
    }
  }, []);

  useEffect(() => {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: false,
        shouldPlaySound: false,
        shouldSetBadge:  false,
      }),
    });
    const subscription = Notifications.addNotificationReceivedListener((notification) => {
      const data = notification.request.content.data;
      if (data?.type === 'ping') sendPingLocation();
    });
    return () => subscription.remove();
  }, [sendPingLocation]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <View style={{ flex: 1 }}>
      <Slot />
      {bannerVisible && (
        <ShakeBanner onTap={handleBannerTap} onDismiss={handleBannerDismiss} />
      )}
    </View>
  );
}

// ── Root layout ───────────────────────────────────────────────────────────────

export default function RootLayout() {
  useEffect(() => {
    const initAudio = async () => {
      try {
        // FIX SOUND-CLASH: Always do a full cleanup then re-initialize on
        // RootLayout mount. This fires after every navigation to /auth/login
        // (i.e. on every logout), so when the next role logs in they get a
        // guaranteed-clean AudioManager with no stale focus or orphan sounds
        // from the previous session.
        await AudioManager.cleanup(); // stops all, resets isInitialized
        await AudioManager.initialize(); // re-applies STANDBY_MODE
        console.log('[RootLayout] AudioManager reset and re-initialized to standby');
      } catch (err) {
        console.warn('[RootLayout] AudioManager initialization failed:', err);
      }
    };
    initAudio();
  }, []);

  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: '#0F172A' }}>
        <AppContent />
      </View>
    </SafeAreaProvider>
  );
}
