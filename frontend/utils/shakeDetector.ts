/**
 * utils/shakeDetector.ts
 *
 * Reusable shake detection hook using expo-sensors Accelerometer.
 *
 * Algorithm:
 *  - Samples at 20Hz (every 50ms)
 *  - A "shake" is counted when total g-force magnitude exceeds threshold
 *  - FIVE shakes within the time window triggers the callback
 *  - 300ms debounce between individual shake counts prevents double-counting
 *  - 6-second cooldown after trigger prevents accidental re-fire
 *  - Timeout tracking ensures proper sync with native notification timeout
 *
 * Usage:
 *   useShakeDetector({ onTriggered: () => router.push('/civil/panic-shake'), enabled: isCivilUser });
 */

import { useEffect, useRef, useCallback } from 'react';
import { Accelerometer } from 'expo-sensors';

export interface ShakeDetectorOptions {
  /** g-force magnitude threshold for a single shake (default: 2.2) */
  threshold?: number;
  /** Number of shakes needed to trigger (default: 5) */
  requiredShakes?: number;
  /** Time window in ms within which shakes must occur (default: 3000) */
  windowMs?: number;
  /** Minimum ms between individual shake counts — prevents double-counting (default: 300) */
  debounceMs?: number;
  /** Cooldown in ms after trigger fires before it can fire again (default: 6000) */
  cooldownMs?: number;
  /** Called when the required shake pattern is detected */
  onTriggered: () => void;
  /** Whether the detector is active (default: true) */
  enabled?: boolean;
}

// Shared timeout tracking across all shake events
const activeTimeout = {
  timestamp: 0,
  timerId: null as ReturnType<typeof setTimeout> | null,
};

export function useShakeDetector({
  threshold = 2.2,
  requiredShakes = 5,
  windowMs = 3000,
  debounceMs = 300,
  cooldownMs = 6000,
  onTriggered,
  enabled = true,
}: ShakeDetectorOptions): void {
  const shakeTimestamps  = useRef<number[]>([]);
  const lastShakeMs      = useRef<number>(0);
  const lastTriggerMs    = useRef<number>(0);
  const subscriptionRef  = useRef<ReturnType<typeof Accelerometer.addListener> | null>(null);
  const onTriggeredRef   = useRef(onTriggered);

  // Keep callback ref fresh without re-creating the subscription
  useEffect(() => { onTriggeredRef.current = onTriggered; }, [onTriggered]);

  const handleAccelerometer = useCallback(
    ({ x, y, z }: { x: number; y: number; z: number }) => {
      const now = Date.now();

      // Respect cooldown
      if (now - lastTriggerMs.current < cooldownMs) return;

      // Total magnitude in g — earth gravity ≈ 1g; vigorous shake ≈ 2-4g
      const magnitude = Math.sqrt(x * x + y * y + z * z);
      if (magnitude < threshold) return;

      // Debounce: must be at least debounceMs since last counted shake
      if (now - lastShakeMs.current < debounceMs) return;
      lastShakeMs.current = now;

      // Prune old timestamps outside the window and add this one
      shakeTimestamps.current = [
        ...shakeTimestamps.current.filter(t => now - t < windowMs),
        now,
      ];

      if (shakeTimestamps.current.length >= requiredShakes) {
        shakeTimestamps.current  = [];
        lastTriggerMs.current    = now;
        onTriggeredRef.current();
      }
    },
    [threshold, requiredShakes, windowMs, debounceMs, cooldownMs]
  );

  useEffect(() => {
    if (!enabled) {
      subscriptionRef.current?.remove();
      subscriptionRef.current = null;
      return;
    }

    Accelerometer.setUpdateInterval(50); // 20 Hz
    subscriptionRef.current = Accelerometer.addListener(handleAccelerometer);

    return () => {
      subscriptionRef.current?.remove();
      subscriptionRef.current = null;
    };
  }, [enabled, handleAccelerometer]);
}

// ── Timeout utilities for native notification sync ──────────────────────────

/**
 * Start tracking a shake notification timeout.
 * Should be called when a shake is detected and the notification is shown.
 * Returns a cleanup function that should be called if user takes action.
 */
export function startShakeTimeout(onTimeout: () => void): () => void {
  // Clear any existing timeout
  if (activeTimeout.timerId) {
    clearTimeout(activeTimeout.timerId);
    activeTimeout.timerId = null;
  }

  const TIMEOUT_MS = 5000;
  activeTimeout.timestamp = Date.now();
  activeTimeout.timerId = setTimeout(() => {
    activeTimeout.timestamp = 0;
    activeTimeout.timerId = null;
    onTimeout();
  }, TIMEOUT_MS);

  // Return cleanup function
  return () => {
    if (activeTimeout.timerId) {
      clearTimeout(activeTimeout.timerId);
      activeTimeout.timerId = null;
    }
    activeTimeout.timestamp = 0;
  };
}

/**
 * Check if a shake timeout is currently active.
 */
export function isShakeTimeoutActive(): boolean {
  if (!activeTimeout.timerId || activeTimeout.timestamp === 0) return false;
  const elapsed = Date.now() - activeTimeout.timestamp;
  return elapsed < 5500; // Give a small buffer
}

/**
 * Cancel the active shake timeout (e.g., when user takes action).
 */
export function cancelShakeTimeout(): void {
  if (activeTimeout.timerId) {
    clearTimeout(activeTimeout.timerId);
    activeTimeout.timerId = null;
  }
  activeTimeout.timestamp = 0;
}
