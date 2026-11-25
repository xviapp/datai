import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * 轻量本地 KV 存储封装（原生端走 expo-secure-store，Web 端走 localStorage）
 */
export async function getLocalKvItem(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}

export async function setLocalKvItem(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') {
      if (value) window.localStorage.setItem(key, value);
      else window.localStorage.removeItem(key);
    }
    return;
  }
  if (value) {
    await SecureStore.setItemAsync(key, value);
  } else {
    await SecureStore.deleteItemAsync(key);
  }
}
