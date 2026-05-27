/**
 * components/NativeMap.web.tsx
 *
 * Web platform shim — re-exports the unified WebView-based NativeMap.
 * Expo's bundler serves this file on web (Platform.OS === 'web') instead
 * of NativeMap.tsx. The Google Maps JS API loads fine inside a web iframe.
 */
export { NativeMap, NativeMap as default } from './NativeMap';
export type { NativeMapProps, MarkerData, GoogleMapType } from './NativeMap';
