import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import type { FullBackupBundle } from '@/db/models';
import { formatLocalDate } from './date';
import { getLocalKvItem, setLocalKvItem } from './kv-store';

const KEY_LAST_BACKUP_AT = 'folio_last_backup_at_v1';

export async function getLastBackupAt(): Promise<number | null> {
  try {
    const raw = await getLocalKvItem(KEY_LAST_BACKUP_AT);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export async function saveLastBackupAt(timestamp = Date.now()): Promise<void> {
  await setLocalKvItem(KEY_LAST_BACKUP_AT, String(timestamp));
}

export interface ExportBackupResult {
  filename: string;
  exportedAt: number;
  message: string;
}

/**
 * 将全量离线备份 JSON 导出至本地设备（Web 触发下载，原生端调用系统分享）
 */
export async function exportBackupBundleToDevice(
  bundle: FullBackupBundle
): Promise<ExportBackupResult> {
  const jsonStr = JSON.stringify(bundle, null, 2);
  const filename = `folio_backup_${formatLocalDate()}.json`;
  const exportedAt = Date.now();

  if (Platform.OS === 'web') {
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    return {
      filename,
      exportedAt,
      message: `已下载备份文件 ${filename}`,
    };
  }

  const outFile = new File(Paths.cache, filename);
  outFile.write(jsonStr);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(outFile.uri, { mimeType: 'application/json' });
  }
  return {
    filename,
    exportedAt,
    message: '已打开系统分享导出备份',
  };
}

/**
 * 选择并解析本地 JSON 备份文件，取消选择时返回 null
 */
export async function pickBackupBundleFromDevice(): Promise<FullBackupBundle | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: 'application/json',
    copyToCacheDirectory: true,
  });
  if (res.canceled || !res.assets[0]) {
    return null;
  }

  const asset = res.assets[0];
  const content =
    Platform.OS === 'web' && asset.file
      ? await asset.file.text()
      : await new File(asset.uri).text();

  const parsed = JSON.parse(content) as FullBackupBundle;
  if (
    !Array.isArray(parsed.libraries) ||
    !Array.isArray(parsed.libraryViews) ||
    !Array.isArray(parsed.entries) ||
    !Array.isArray(parsed.widgets)
  ) {
    throw new Error('备份文件格式不正确');
  }
  return parsed;
}
