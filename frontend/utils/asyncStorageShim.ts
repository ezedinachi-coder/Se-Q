/**
 * AsyncStorage shim — backed by expo-secure-store.
 *
 * The codebase references AsyncStorage (from @react-native-async-storage/async-storage)
 * but that package is not installed.  expo-secure-store is already a dependency and
 * provides the same getItem / setItem / removeItem / multiGet / multiSet / multiRemove
 * surface we need, so this shim maps the calls across.
 *
 * NOTE: expo-secure-store has a 2 048-byte value limit on some platforms.
 * All values stored via this shim should be short strings or compact JSON.
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// SecureStore keys must match [A-Za-z0-9._-]
// Replace any character not in that set with '_'
const sanitizeKey = (key: string): string => key.replace(/[^A-Za-z0-9._-]/g, '_');

const getItem = async (key: string): Promise<string | null> => {
  try {
    const k = sanitizeKey(key);
    if (Platform.OS !== 'web') {
      try {
        const v = await SecureStore.getItemAsync(k);
        if (v !== undefined) return v;
      } catch (_) {}
    }
    return await SecureStore.getItem(k);
  } catch {
    return null;
  }
};

const setItem = async (key: string, value: string): Promise<void> => {
  try {
    const k = sanitizeKey(key);
    if (Platform.OS !== 'web') {
      try {
        await SecureStore.setItemAsync(k, value);
        return;
      } catch (_) {}
    }
    await SecureStore.setItem(k, value);
  } catch (_) {}
};

const removeItem = async (key: string): Promise<void> => {
  try {
    const k = sanitizeKey(key);
    if (Platform.OS !== 'web') {
      try { await SecureStore.deleteItemAsync(k); return; } catch (_) {}
    }
    await SecureStore.deleteItem(k);
  } catch (_) {}
};

const multiGet = async (keys: string[]): Promise<[string, string | null][]> => {
  const results = await Promise.all(keys.map(async (k) => [k, await getItem(k)] as [string, string | null]));
  return results;
};

const multiSet = async (pairs: [string, string][]): Promise<void> => {
  await Promise.all(pairs.map(([k, v]) => setItem(k, v)));
};

const multiRemove = async (keys: string[]): Promise<void> => {
  await Promise.all(keys.map((k) => removeItem(k)));
};

const AsyncStorage = {
  getItem,
  setItem,
  removeItem,
  multiGet,
  multiSet,
  multiRemove,
};

export default AsyncStorage;
