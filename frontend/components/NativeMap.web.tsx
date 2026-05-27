/**
 * components/NativeMap.web.tsx
 *
 * Web platform target — re-exports the unified WebView-based NativeMap.
 * Expo's bundler serves this file on web instead of NativeMap.tsx.
 * Since our NativeMap now uses an inline HTML+Leaflet approach (via WebView /
 * iframe on web), the same component works on all platforms.
 */
export { NativeMap } from './NativeMap';
