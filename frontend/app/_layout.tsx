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
  stopShakeService,
  isIgnoringBatteryOptimizations,
  requestIgnoreBatteryOptimizations,
  requestPostNotificationsPermission,
} from '../utils/nativePanicBridge';
import BACKEND_URL from '../utils/config';
import { getAuthToken, authEvents } from '../utils/auth';
import * as Location from 'expo-location';
import { getLocation } from '../utils/getLocation';
import { AudioManager } from '../utils/AudioManager';
import AsyncStorage from '../utils/asyncStorageShim';

// ── In-app shake banner (shown only when app is foregrounded) ─────────────────

/**
 * FIX SOUND-CLASH Bug-01: AudioManager.cleanup()+initialize() only ran on
 * component MOUNT, never on role change. The singleton carried stale state
 * (currentPriority, isInitialized, OS mode) from the previous session into
 * the next. A new security user logging in after a civil user left a sound
 * stuck would inherit the stale state and the audio session would never
 * restore to standby.
 *
 * This effect watches userRole changes. On every change (login, logout,
 * role switch), it performs a full AudioManager teardown + re-init so the
 * next session always starts from a guaranteed-clean state.
 */

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

    // Start tracking the 5-second timeout. On expiry:
    //  • hide the banner
    //  • cross-cancel bannerTimerRef so it doesn't double-fire
    //  • drain any native PREFS_KEY_PENDING flag the ShakeDetectionService
    //    wrote simultaneously — prevents checkNativePanic from force-routing
    //    to panic-shake when the user navigates after a dismissed shake.
    startShakeTimeout(() => {
      if (bannerTimerRef.current) {
        clearTimeout(bannerTimerRef.current);
        bannerTimerRef.current = null;
      }
      setBannerVisible(false);
      checkAndConsumePanic().catch(() => {}); // drain native flag silently
    });

    // Backup timer — cross-cancelled by the startShakeTimeout callback above
    // if that fires first; kept as a safety net in case of timer skew.
    bannerTimerRef.current = setTimeout(() => {
      bannerTimerRef.current = null;
      setBannerVisible(false);
      checkAndConsumePanic().catch(() => {}); // drain native flag silently
    }, 5000);
  }, []);

  const handleBannerTap = useCallback(() => {
    // Cancel the timeout since user is taking action
    cancelShakeTimeout();
    if (bannerTimerRef.current) {
      clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = null;
    }
    setBannerVisible(false);
    // replace (not push) — avoids stacking panic-shake on top of the current
    // screen, which would leave a ghost entry in the history that
    // checkNativePanic could re-trigger on segments change.
    try { router.replace('/civil/panic-shake'); } catch (_) {}
  }, []);

  const handleBannerDismiss = useCallback(() => {
    // Cancel the timeout since user dismissed
    cancelShakeTimeout();
    if (bannerTimerRef.current) {
      clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = null;
    }
    setBannerVisible(false);
    // Drain any native PREFS_KEY_PENDING the ShakeDetectionService wrote for
    // this same physical shake — prevents checkNativePanic from seeing a
    // stale flag and force-routing to panic-shake on the next navigation.
    checkAndConsumePanic().catch(() => {});
  }, []);

  useEffect(() => () => {
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
  }, []);

  // ── Load user role ─────────────────────────────────────────────────────────
  // FIX GAP-4: Two complementary triggers — segment changes AND auth events.
  //
  // The segment-change poll was the only trigger before this fix. It silently
  // skipped the AudioManager reset whenever logout navigated back to the same
  // /auth/login segment (session expiry re-login), because segments.join('/')
  // didn't change so the effect dependency didn't fire.
  //
  // authEvents.on('roleChange') fires from saveAuthData() and clearAuthData()
  // regardless of navigation — it is the authoritative source of truth for
  // role transitions and makes the segment poll a secondary safety net only.

  useEffect(() => {
    // Initial read on mount / segment change (keeps backward compat)
    AsyncStorage.getItem('user_role').then(role => setUserRole(role));
  }, [segments.join('/')]);

  useEffect(() => {
    // Event-driven update — fires on every login and logout
    const unsub = authEvents.on('roleChange', (role) => {
      setUserRole(role);
    });
    return unsub; // cleanup on unmount
  }, []);

  // ── Shake detection (foreground) ───────────────────────────────────────────

  const currentRoute    = segments.join('/');
  const isOnPanicScreen = currentRoute.includes('panic-shake') || currentRoute.includes('panic-active');
  const shakeEnabled    = userRole === 'civil' && !isOnPanicScreen;

  // Live ref so async closures (checkNativePanic, AppState handlers) always
  // read the *current* route rather than a stale closure capture.
  const segmentsRef = useRef(currentRoute);
  useEffect(() => { segmentsRef.current = currentRoute; }, [currentRoute]);

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

  // ── AudioManager reset on role change ────────────────────────────────────
  // FIX SOUND-CLASH Bug-01: Every time the user role changes (e.g. Security
  // logs out, Admin takes over, Civil re-logs) we do a full teardown so no
  // orphan sounds, stale currentPriority flag, or wrong OS audio mode bleeds
  // into the next session.  This is the primary guard against the singleton
  // carrying state across sessions.
  useEffect(() => {
    if (userRole === null) return; // not yet loaded from storage

    const resetAudio = async () => {
      try {
        await AudioManager.cleanup();   // stops all, nulls activeSound + currentPriority
        await AudioManager.initialize(); // re-applies STANDBY_MODE
        console.log('[Layout] AudioManager reset complete for role:', userRole);
      } catch (err) {
        console.warn('[Layout] AudioManager reset failed on role change:', err);
      }
    };
    resetAudio();
  }, [userRole]);

  // ── Start / stop native ShakeDetectionService based on role ───────────────
  // START_STICKY services keep running until explicitly stopped. Without the
  // stop call, a civil user who logs out and hands the phone to an admin/security
  // user would leave the service running — admin/security shakes would post the
  // "Emergency Detected" heads-up notification and set PREFS_KEY_PENDING.

  useEffect(() => {
    if (Platform.OS !== 'android' || userRole === null) return;

    if (userRole === 'civil') {
      if (serviceStarted.current) return; // already running
      serviceStarted.current = true;
      (async () => {
        try {
          const started = await startShakeService();
          console.log('[Layout] ShakeDetectionService started:', started);
        } catch (e) {
          console.warn('[Layout] Could not start ShakeDetectionService:', e);
        }
      })();
    } else {
      // Admin / Security / any other role — ensure the service is stopped and
      // any stale SharedPrefs flag is cleared (stopShakeService handles both).
      if (!serviceStarted.current) return; // was never started, nothing to do
      serviceStarted.current = false;
      (async () => {
        try {
          await stopShakeService();
          console.log('[Layout] ShakeDetectionService stopped for non-civil role:', userRole);
        } catch (e) {
          console.warn('[Layout] Could not stop ShakeDetectionService:', e);
        }
      })();
    }
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
  // FIXES:
  //   1. Route guard now reads segmentsRef.current (live) not a stale closure.
  //      With [segments] as dependency the guard captured the route at effect-
  //      creation time; on cold start segments=[] so the guard always missed
  //      and the user was re-trapped on every app open.
  //   2. AsyncStorage panic_active / active_panic check added — if a panic
  //      already completed we never re-route to panic-shake regardless of
  //      what the native flag says (handles partial-failure edge case).
  //   3. Dependency array changed from [segments] to [] — the effect must
  //      live for the full component lifetime. The AppState listener was
  //      being torn down and re-registered on every route change, creating
  //      duplicate listeners that could double-fire checkNativePanic.
  //   4. panic_error sentinel cleared here so a previous failed activation
  //      doesn't permanently block the route.

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

        // If a panic already completed (or failed+cleaned), never re-route.
        const panicActive = await AsyncStorage.getItem('panic_active');
        const activePanic = await AsyncStorage.getItem('active_panic');
        if (panicActive === 'true' || !!activePanic) return;

        // Use live segmentsRef — NOT the stale segments closure from effect creation.
        const liveRoute = segmentsRef.current;
        if (liveRoute.includes('panic-shake') || liveRoute.includes('panic-active')) return;

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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — intentionally runs once

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

  // ── Location refresh (push-notification triggered by nearby security/admin) ──
  // When Security/Admin views NEARBY SECURITY or SECURITY MAP, the backend sends
  // push notifications to all active security agents to refresh their locations.

  const refreshMyLocation = useCallback(async () => {
    try {
      const token = await getAuthToken();
      if (!token) return;
      const coords = await getLocation('soft');
      if (!coords) return;
      await fetch(`${BACKEND_URL}/api/security/update-location`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          latitude:  coords.latitude,
          longitude: coords.longitude,
          accuracy:  coords.accuracy,
        }),
      });
      console.log('[LocationRefresh] Location updated for security map');
    } catch (err) {
      console.error('[LocationRefresh] Location update failed:', err);
    }
  }, []);

  useEffect(() => {
    // Configure notification handling - return shouldShowAlert: true for critical notifications
    // so they show alerts when app is in foreground
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const data = notification.request.content.data;
        const isCritical = data?.type === 'panic' || data?.type === 'chat_message' || data?.type === 'message';
        return {
          shouldShowAlert: true,  // Show alerts for all notifications in foreground
          shouldPlaySound: isCritical,  // Play sound for critical (panic/chat) notifications
          shouldSetBadge: true,
        };
      },
      handleSuccessSubscription: (notification) => {
        console.log('[Notifications] Success subscription:', notification);
      },
      handleError: (error, notification) => {
        console.error('[Notifications] Error:', error, notification);
      },
    });

    // Listen for notifications when app is in foreground
    // For background/closed state, the OS handles notification delivery with system sound
    const subscription = Notifications.addNotificationReceivedListener((notification) => {
      const data = notification.request.content.data;
      console.log('[Notifications] Received notification in foreground:', data);

      if (data?.type === 'ping') sendPingLocation();
      // Handle location refresh request from security map
      if (data?.type === 'location_refresh') refreshMyLocation();

      // Handle panic alerts - play emergency sound
      if (data?.type === 'panic') {
        console.log('[Notifications] Panic alert received - showing emergency');
      }

      // Handle chat messages
      if (data?.type === 'chat_message' || data?.type === 'message') {
        console.log('[Notifications] Chat message received');
      }
    });

    // Handle notification interactions (when user taps the notification)
    const responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data;
      console.log('[Notifications] Notification tapped:', data);

      if (data?.type === 'panic' && data?.panic_id) {
        // Navigate to panic details
        router.push('/civil/panic-active');
      } else if ((data?.type === 'chat_message' || data?.type === 'message') && data?.conversation_id) {
        // Navigate to chat
        router.push(`/security/chat/${data.conversation_id}`);
      }
    });

    return () => {
      subscription.remove();
      responseSubscription.remove();
    };
  }, [sendPingLocation, refreshMyLocation]);

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
