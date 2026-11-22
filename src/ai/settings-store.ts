import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const KEY_API_TOKEN = 'deepseek_api_key_v1';
const KEY_PREFS = 'deepseek_prefs_v1';

export type ReasoningEffort = 'low' | 'high' | 'max';

export interface AiPreferences {
  baseUrl: string;
  model: string;
  architectEffort: ReasoningEffort;
  enableWebEnrich: boolean;
}

const DEFAULT_PREFS: AiPreferences = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  architectEffort: 'high',
  enableWebEnrich: true,
};

async function getRawItem(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  }
  return SecureStore.getItemAsync(key);
}

async function setRawItem(key: string, value: string): Promise<void> {
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

export async function getDeepSeekApiKey(): Promise<string> {
  const val = await getRawItem(KEY_API_TOKEN);
  return val?.trim() ?? '';
}

export async function saveDeepSeekApiKey(apiKey: string): Promise<void> {
  await setRawItem(KEY_API_TOKEN, apiKey.trim());
}

export async function getAiPreferences(): Promise<AiPreferences> {
  try {
    const raw = await getRawItem(KEY_PREFS);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export async function saveAiPreferences(prefs: Partial<AiPreferences>): Promise<AiPreferences> {
  const merged = { ...(await getAiPreferences()), ...prefs };
  await setRawItem(KEY_PREFS, JSON.stringify(merged));
  return merged;
}
