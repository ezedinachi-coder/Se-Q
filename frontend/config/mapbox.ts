/**
 * config/mapbox.ts — DEPRECATED
 *
 * This file is kept as a no-op shim so any lingering import
 * of MAPBOX_TOKEN or MAP_STYLES doesn't cause a compile error
 * while you migrate. It can be deleted once no file imports it.
 *
 * @rnmapbox/maps has been removed. All maps now use the
 * Google Maps JavaScript API via react-native-webview (NativeMap.tsx).
 */

export const MAPBOX_TOKEN = '';
export const MAP_STYLES = {
  SATELLITE: '',
  STREETS: '',
  DARK: '',
  LIGHT: '',
};
export default MAPBOX_TOKEN;
