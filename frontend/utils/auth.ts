/**
 * Authentication Utility Module
 * Centralized authentication handling for SafeGuard app
 *
 * FIX (session-bleed / Access Denied / admin login):
 *   expo-secure-store does NOT have multiSet / multiGet / multiRemove.
 *   All calls to those methods threw exceptions that were silently swallowed,
 *   meaning role, userId, email were never reliably written or read.
 *   This caused:
 *     • getUserMetadata() always returning null role → "Access Denied" on admin dashboard
 *     • saveAuthData() silently skipping the per-user key writes → stale keys from the
 *       previous session surviving logout → Security dashboard data bleeding into Civil
 *   Fix: route every key through the asyncStorageShim which correctly implements
 *   multi* operations on top of SecureStore.getItemAsync / setItemAsync / deleteItemAsync.
 */

import AsyncStorage from './asyncStorageShim';
import { AudioManager } from './AudioManager';

// ── Auth event bus ────────────────────────────────────────────────────────────
// FIX GAP-4: _layout.tsx previously polled user_role from AsyncStorage only
// when route segments changed. If a logout navigated back to the SAME segment
// (e.g. /auth/login → /auth/login on session expiry), segments.join('/') did
// not change, setUserRole was never called, and the AudioManager reset effect
// never fired — leaving stale audio state from the previous role active.
//
// Solution: a lightweight event emitter that fires 'roleChange' whenever
// saveAuthData() or clearAuthData() completes. _layout.tsx subscribes to this
// and calls setUserRole() directly, independently of segment changes.
type AuthEventType = 'roleChange';
type AuthListener = (role: string | null) => void;

const _listeners: Map<AuthEventType, Set<AuthListener>> = new Map([
  ['roleChange', new Set()],
]);

export const authEvents = {
  on(event: AuthEventType, fn: AuthListener): () => void {
    _listeners.get(event)!.add(fn);
    return () => _listeners.get(event)!.delete(fn);
  },
  emit(event: AuthEventType, role: string | null): void {
    _listeners.get(event)!.forEach(fn => fn(role));
  },
};

const AUTH_TOKEN_KEY  = 'auth_token';
const USER_ID_KEY     = 'user_id';
const USER_ROLE_KEY   = 'user_role';
const IS_PREMIUM_KEY  = 'is_premium';
const USER_EMAIL_KEY  = 'user_email';

const SESSION_STATE_KEYS = [
  'panic_active',
  'panic_started_at',
  'panic_id',
  'active_panic',
  'active_escort',
];

// ── Token ─────────────────────────────────────────────────────────────────────

export const getAuthToken = async (): Promise<string | null> => {
  return AsyncStorage.getItem(AUTH_TOKEN_KEY);
};

// ── Save ──────────────────────────────────────────────────────────────────────

export const saveAuthData = async (data: {
  token: string;
  user_id: string;
  role: string;
  email?: string;
  is_premium?: boolean;
}): Promise<boolean> => {
  try {
    await AsyncStorage.multiSet([
      [AUTH_TOKEN_KEY,  data.token],
      [USER_ID_KEY,     data.user_id],
      [USER_ROLE_KEY,   data.role],
      [IS_PREMIUM_KEY,  String(data.is_premium || false)],
      [USER_EMAIL_KEY,  data.email || ''],
    ]);
    authEvents.emit('roleChange', data.role); // FIX GAP-4: notify _layout.tsx
    return true;
  } catch (error) {
    console.error('[Auth] Failed to save auth data:', error);
    return false;
  }
};

// ── Clear (logout) ────────────────────────────────────────────────────────────

/**
 * Clear ALL authentication data (logout).
 *
 * 1. Stops any active escort session on the backend (best-effort).
 * 2. Unregisters push token.
 * 3. Clears JWT + user keys from SecureStore via the shim.
 * 4. Clears all session-state keys so no data bleeds to the next session.
 */
export const clearAuthData = async (): Promise<boolean> => {
  try {
    const token = await getAuthToken();

    // FIX GAP-1: Stop all audio through the singleton so activeSound,
    // currentPriority, and the OS mode are ALL reset atomically before
    // the next session starts. The previous pattern called
    // Audio.setAudioModeAsync() directly, which changed the OS mode but
    // left AudioManager.activeSound populated — the orphan sound kept
    // playing and its onPlaybackStatusUpdate callback later called
    // _restoreToStandby(), overwriting the new session's audio mode.
    try {
      await AudioManager.stopAll();
      console.log('[Auth] AudioManager fully stopped on logout');
    } catch (_) {}

    if (token) {
      const { default: axios }       = await import('axios');
      const { default: BACKEND_URL } = await import('./config');

      try {
        await axios.post(
          `${BACKEND_URL}/api/escort/action`,
          { action: 'stop', location: { latitude: 0, longitude: 0, timestamp: new Date().toISOString() } },
          { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
        );
      } catch (_) {}

      try {
        await axios.delete(`${BACKEND_URL}/api/push-token/unregister`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 5000,
        });
      } catch (_) {}
    }

    // Clear every auth + session key so nothing bleeds into the next session
    await AsyncStorage.multiRemove([
      AUTH_TOKEN_KEY,
      USER_ID_KEY,
      USER_ROLE_KEY,
      IS_PREMIUM_KEY,
      USER_EMAIL_KEY,
      ...SESSION_STATE_KEYS,
    ]);

    authEvents.emit('roleChange', null); // FIX GAP-4: notify _layout.tsx
    return true;
  } catch {
    return false;
  }
};

// ── Read metadata ─────────────────────────────────────────────────────────────

export const getUserMetadata = async (): Promise<{
  userId: string | null;
  role: string | null;
  email: string | null;
  isPremium: boolean;
}> => {
  try {
    const results = await AsyncStorage.multiGet([
      USER_ID_KEY, USER_ROLE_KEY, IS_PREMIUM_KEY, USER_EMAIL_KEY,
    ]);
    const data: Record<string, string | null> = {};
    results.forEach(([key, value]) => { data[key] = value; });
    return {
      userId:    data[USER_ID_KEY]    ?? null,
      role:      data[USER_ROLE_KEY]  ?? null,
      email:     data[USER_EMAIL_KEY] ?? null,
      isPremium: data[IS_PREMIUM_KEY] === 'true',
    };
  } catch {
    return { userId: null, role: null, email: null, isPremium: false };
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export const isAuthenticated = async (): Promise<boolean> => {
  const token = await getAuthToken();
  return !!token;
};

export const getAuthHeader = async (): Promise<{ Authorization: string } | Record<string, never>> => {
  const token = await getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};
