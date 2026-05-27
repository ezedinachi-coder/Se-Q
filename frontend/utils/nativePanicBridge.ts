/**
 * utils/nativePanicBridge.ts
 *
 * JS wrapper around the native SeqPanicModule (Android only).
 *
 *   checkAndConsumePanic()   — reads + clears PREFS_KEY_PENDING; returns true once per event
 *   setNativePanicActive()   — tells the native service a panic is already running
 *   startShakeService()      — starts ShakeDetectionService as a foreground service
 *   isIgnoringBatteryOptimizations() — returns true if battery exemption is already granted
 *   requestIgnoreBatteryOptimizations() — opens the OS battery exemption dialog (native intent)
 *
 * iOS: all functions return safely without doing anything.
 */

import { NativeModules, Platform, PermissionsAndroid } from 'react-native';

const { SeqPanic } = NativeModules;

// ── checkAndConsumePanic ──────────────────────────────────────────────────────

export async function checkAndConsumePanic(): Promise<boolean> {
  if (Platform.OS !== 'android' || !SeqPanic) return false;
  try {
    const result = await SeqPanic.checkAndConsumePanic();
    return result === true;
  } catch {
    return false;
  }
}

// ── setNativePanicActive ──────────────────────────────────────────────────────

export async function setNativePanicActive(active: boolean): Promise<void> {
  if (Platform.OS !== 'android' || !SeqPanic?.setPanicActive) return;
  try {
    await SeqPanic.setPanicActive(active);
  } catch {
    // Non-fatal
  }
}

// ── startShakeService ─────────────────────────────────────────────────────────

export async function startShakeService(): Promise<boolean> {
  if (Platform.OS !== 'android' || !SeqPanic?.startShakeService) return false;
  try {
    const result = await SeqPanic.startShakeService();
    return result === true;
  } catch {
    return false;
  }
}

// ── stopShakeService ──────────────────────────────────────────────────────────
// Call when a non-civil role is active (admin / security) to ensure the
// ShakeDetectionService is not running and any stale SharedPrefs flags are cleared.

export async function stopShakeService(): Promise<boolean> {
  if (Platform.OS !== 'android' || !SeqPanic?.stopShakeService) return false;
  try {
    const result = await SeqPanic.stopShakeService();
    return result === true;
  } catch {
    return false;
  }
}

// ── isIgnoringBatteryOptimizations ────────────────────────────────────────────

export async function isIgnoringBatteryOptimizations(): Promise<boolean> {
  if (Platform.OS !== 'android' || !SeqPanic?.isIgnoringBatteryOptimizations) return true;
  try {
    const result = await SeqPanic.isIgnoringBatteryOptimizations();
    return result === true;
  } catch {
    return false;
  }
}

// ── requestIgnoreBatteryOptimizations ─────────────────────────────────────────
// Calls the native method which fires ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
// with the correct package URI — the only reliable way across OEMs.

export async function requestIgnoreBatteryOptimizations(): Promise<void> {
  if (Platform.OS !== 'android' || !SeqPanic?.requestIgnoreBatteryOptimizations) return;
  try {
    await SeqPanic.requestIgnoreBatteryOptimizations();
  } catch {
    // Swallow — some OEMs block this entirely
  }
}

// ── requestPostNotificationsPermission ────────────────────────────────────────
// Android 13+ requires POST_NOTIFICATIONS permission at runtime for heads-up
// alerts to appear. Call this once after login for civil users.

export async function requestPostNotificationsPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    if (parseInt(Platform.Version as string, 10) < 33) return true; // Not needed below API 33
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      {
        title: 'Enable Emergency Alerts',
        message:
          'Se-Q needs notification permission to alert you when a shake is detected ' +
          'while the app is in the background.',
        buttonPositive: 'Allow',
        buttonNegative: 'Not Now',
      }
    );
    return result === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}
