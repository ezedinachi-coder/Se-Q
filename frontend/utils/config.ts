/**
 * config.ts — Single source of truth for BACKEND_URL.
 *
 * Priority order (highest → lowest):
 *   1. app.json  expo.extra.backendUrl   — set this per EAS build profile ✅ (YOU HAVE THIS)
 *   2. EXPO_PUBLIC_BACKEND_URL           — set in frontend/.env for local dev
 *   3. FALLBACK_URL                      — fallback for local dev only
 *
 * ── How to configure ────────────────────────────────────────────────────────
 *
 * PRODUCTION (EAS Build):
 *   ✅ Already set in app.json → expo.extra.backendUrl
 *   ✅ Current value: https://se-q-production.up.railway.app
 *
 * LOCAL DEV (Codespaces):
 *   Create frontend/.env:
 *     EXPO_PUBLIC_BACKEND_URL=https://<your-codespace>-8001.app.github.dev
 *   Then restart Expo with: npx expo start --clear
 */

import Constants from 'expo-constants';

// Fallback for local development only (when no other method is set)
const FALLBACK_URL = '';  // Keep empty, you have app.json configured

// Read from app.json first (this is your production URL)
const appJsonUrl = Constants.expoConfig?.extra?.backendUrl as string | undefined;

// For local development, you can also use environment variable
const envUrl = process.env.EXPO_PUBLIC_BACKEND_URL;

// Use app.json URL if available, otherwise env var, otherwise fallback
export const BACKEND_URL: string = appJsonUrl || envUrl || FALLBACK_URL;

// Debug log to confirm which URL is being used
if (__DEV__) {
  console.log('[config] BACKEND_URL source:', appJsonUrl ? 'app.json' : (envUrl ? '.env' : 'fallback'));
  console.log('[config] BACKEND_URL value:', BACKEND_URL);
}

if (!BACKEND_URL) {
  console.warn(
    '[config] BACKEND_URL is not set! ' +
    'Check app.json extra.backendUrl or set EXPO_PUBLIC_BACKEND_URL in .env'
  );
}

export default BACKEND_URL;
