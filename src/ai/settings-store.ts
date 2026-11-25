import { getLocalKvItem, setLocalKvItem } from '@/engine/kv-store';

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

export async function getDeepSeekApiKey(): Promise<string> {
  const val = await getLocalKvItem(KEY_API_TOKEN);
  return val?.trim() ?? '';
}

export async function saveDeepSeekApiKey(apiKey: string): Promise<void> {
  await setLocalKvItem(KEY_API_TOKEN, apiKey.trim());
}

export async function getAiPreferences(): Promise<AiPreferences> {
  try {
    const raw = await getLocalKvItem(KEY_PREFS);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export async function saveAiPreferences(prefs: Partial<AiPreferences>): Promise<AiPreferences> {
  const merged = { ...(await getAiPreferences()), ...prefs };
  await setLocalKvItem(KEY_PREFS, JSON.stringify(merged));
  return merged;
}
