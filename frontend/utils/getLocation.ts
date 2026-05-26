/**
 * getLocation.ts — Single source of truth for GPS acquisition
 *
 * WHY THIS EXISTS
 * ---------------
 * Across the app, location was acquired in three broken patterns:
 *
 *   Pattern A (panic-shake):
 *     let lat = 0, lng = 0;
 *     try { const loc = await getCurrentPositionAsync(...); lat = ...; lng = ...; } catch (_) {}
 *     → Silently sends 0,0 to the backend when GPS is cold or slow.
 *       This is exactly why panics arrived with latitude=0, longitude=0.
 *
 *   Pattern B (panic-active):
 *     const location = await getCurrentPositionAsync({ accuracy: BestForNavigation });
 *     → No timeout. BestForNavigation hangs indefinitely on Android when GPS is
 *       warming up (fresh boot, or first fix after a long sleep). The entire panic
 *       activation hangs with it.
 *
 *   Pattern C (audio report):
 *     catch { currentLocation = { coords: { latitude: 9.0820, longitude: 8.6753 } }; }
 *     → Silently substitutes the geographic center of Nigeria as the report location
 *       whenever GPS fails. Reports appear at a fixed wrong point on every map.
 *
 * STRATEGY
 * --------
 * 1. Try getCurrentPositionAsync with a 12-second timeout.
 *    - Uses Accuracy.High (not BestForNavigation which hangs on Android).
 * 2. On timeout or error, fall back to getLastKnownPositionAsync (≤5 min old).
 * 3. If neither works:
 *    - For PANIC calls (mode='panic'): return null — caller must NOT send 0,0.
 *      The backend will record the panic without a location rather than pinning
 *      it to the ocean or Nigeria. The background task will deliver the real
 *      location seconds later once GPS warms up.
 *    - For NON-PANIC calls (mode='soft'): return null — caller decides whether
 *      to skip, queue, or show an error. Never substitute 0,0 or a hardcoded coord.
 *
 * USAGE
 * -----
 *   import { getLocation } from '../../utils/getLocation';
 *
 *   // Panic path — must not block or send 0,0:
 *   const coords = await getLocation('panic');
 *   // coords is { latitude, longitude, accuracy } | null
 *   // Send whatever we have; if null, omit from payload or send null fields.
 *
 *   // Normal path — block until we have a fix or show error:
 *   const coords = await getLocation('soft');
 *   if (!coords) { Alert.alert('Location Required', '...'); return; }
 */

import * as Location from 'expo-location';

export interface Coords {
  latitude:  number;
  longitude: number;
  accuracy:  number | null;
}

/**
 * Acquire the device's current GPS coordinates.
 *
 * @param mode
 *   'panic' — speed-optimised for emergency activation.
 *              Returns null (never 0,0) if GPS is unavailable.
 *   'soft'  — normal path. Returns null if GPS is unavailable;
 *              caller decides what to do.
 *
 * @returns Coords | null
 */
export async function getLocation(mode: 'panic' | 'soft'): Promise<Coords | null> {
  // ── 1. Permission ──────────────────────────────────────────────────────────
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;
  } catch {
    return null;
  }

  // ── 2. Fresh fix with timeout ──────────────────────────────────────────────
  //    Accuracy.High is reliable on both iOS and Android.
  //    BestForNavigation can hang indefinitely on Android on first GPS lock.
  const TIMEOUT_MS = mode === 'panic' ? 8000 : 12000;

  let location: Location.LocationObject | null = null;

  try {
    location = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('GPS timeout')), TIMEOUT_MS)
      ),
    ]) as Location.LocationObject;
  } catch {
    // GPS timed out or threw — try last-known before giving up
  }

  // ── 3. Last-known fallback (≤5 min) ───────────────────────────────────────
  if (!location) {
    try {
      location = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60 * 1000 });
    } catch {
      location = null;
    }
  }

  if (!location) return null;

  return {
    latitude:  location.coords.latitude,
    longitude: location.coords.longitude,
    accuracy:  location.coords.accuracy ?? null,
  };
}
