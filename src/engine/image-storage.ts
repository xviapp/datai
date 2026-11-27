import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';
import { createId } from './id';

const MAX_LONG_EDGE = 1600;
const JPEG_QUALITY = 0.75;
const IMAGES_SUBDIR = 'images';

export interface PickedImageAsset {
  uri: string;
  width?: number;
  height?: number;
  base64?: string | null;
  mimeType?: string | null;
}

function isDirectImageUri(val: string): boolean {
  return (
    val.startsWith('data:') ||
    val.startsWith('http://') ||
    val.startsWith('https://') ||
    val.startsWith('file://') ||
    val.startsWith('blob:') ||
    val.startsWith('content://') ||
    val.startsWith('ph://') ||
    val.startsWith('assets-library://')
  );
}

/**
 * 将 data_json 中存储的图片值解析为 <Image> 可直接渲染的 URI：
 * - 直接透传 base64 data URL、网络 URL 或完整 file:// URI
 * - 原生端将相对路径（如 images/img_xxx.jpg）拼接到 Paths.document，避免 iOS 沙盒路径变化失效
 */
export function resolveImageUri(stored: unknown): string {
  const raw = typeof stored === 'string' ? stored.trim() : '';
  if (!raw) return '';
  if (isDirectImageUri(raw) || Platform.OS === 'web') {
    return raw;
  }
  try {
    return new File(Paths.document, raw).uri;
  } catch {
    return raw;
  }
}

async function resizeAndCompressImage(
  asset: PickedImageAsset,
  options: { includeBase64: boolean; maxLongEdge?: number; compress?: number }
): Promise<{ uri: string; base64?: string }> {
  const maxEdge = options.maxLongEdge ?? MAX_LONG_EDGE;
  const compress = options.compress ?? JPEG_QUALITY;

  const ctx = ImageManipulator.manipulate(asset.uri);
  const w = asset.width ?? 0;
  const h = asset.height ?? 0;

  if (w > maxEdge || h > maxEdge) {
    if (w >= h) {
      ctx.resize({ width: maxEdge });
    } else {
      ctx.resize({ height: maxEdge });
    }
  }

  const rendered = await ctx.renderAsync();
  try {
    const saved = await rendered.saveAsync({
      format: SaveFormat.JPEG,
      compress,
      base64: options.includeBase64,
    });
    return { uri: saved.uri, base64: saved.base64 };
  } finally {
    rendered.release();
    ctx.release();
  }
}

/**
 * 将用户选中的图片缩放压缩并持久化：
 * - 原生端：压缩到长边 <= 1600px JPEG，写入 Paths.document/images/，返回相对路径（不膨胀 SQLite）
 * - Web 端：压缩到长边 <= 1600px JPEG，返回压缩后的 data URL（随 IndexedDB 持久化）
 */
export async function savePickedImageToStorage(asset: PickedImageAsset): Promise<string> {
  if (Platform.OS === 'web') {
    try {
      const result = await resizeAndCompressImage(asset, { includeBase64: true });
      if (result.base64) {
        return `data:image/jpeg;base64,${result.base64}`;
      }
      return result.uri;
    } catch {
      if (asset.base64) {
        return `data:${asset.mimeType || 'image/jpeg'};base64,${asset.base64}`;
      }
      return asset.uri;
    }
  }

  let sourceUri = asset.uri;
  let shouldCleanupTemp = false;

  try {
    const compressed = await resizeAndCompressImage(asset, { includeBase64: false });
    if (compressed.uri) {
      sourceUri = compressed.uri;
      shouldCleanupTemp = compressed.uri !== asset.uri;
    }
  } catch {
    // 压缩失败时降级直接拷贝原图到文档目录，不丢用户图片
  }

  const imagesDir = new Directory(Paths.document, IMAGES_SUBDIR);
  imagesDir.create({ idempotent: true, intermediates: true });

  const fileName = `${createId('img')}.jpg`;
  const targetFile = new File(imagesDir, fileName);
  const sourceFile = new File(sourceUri);

  await sourceFile.copy(targetFile);

  if (shouldCleanupTemp) {
    try {
      sourceFile.delete();
    } catch {
      // 缓存临时文件清理失败不影响主流程
    }
  }

  return `${IMAGES_SUBDIR}/${fileName}`;
}

/**
 * 压缩图片为适合发送给 DeepSeek 视觉模型的轻量 data URL（长边 <= 1600px）
 */
export async function compressImageForAiVision(asset: PickedImageAsset): Promise<string> {
  try {
    const result = await resizeAndCompressImage(asset, { includeBase64: true });
    if (result.base64) {
      if (Platform.OS !== 'web' && result.uri && result.uri !== asset.uri) {
        try {
          new File(result.uri).delete();
        } catch {
          // ignore temp cleanup error
        }
      }
      return `data:image/jpeg;base64,${result.base64}`;
    }
  } catch {
    // fallback below
  }

  if (asset.base64) {
    return `data:${asset.mimeType || 'image/jpeg'};base64,${asset.base64}`;
  }

  if (Platform.OS !== 'web') {
    const b64 = await new File(asset.uri).base64();
    return `data:${asset.mimeType || 'image/jpeg'};base64,${b64}`;
  }

  return asset.uri;
}

/**
 * 统一封装相册选图 / 相机拍照（自动处理相机权限与 Web base64 标志）
 */
export async function pickImageAsset(
  fromCamera: boolean,
  cameraDeniedMessage = '需要相机权限才能直接拍照'
): Promise<PickedImageAsset | null> {
  if (fromCamera) {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      throw new Error(cameraDeniedMessage);
    }
  }
  const launcher = fromCamera
    ? ImagePicker.launchCameraAsync
    : ImagePicker.launchImageLibraryAsync;
  const res = await launcher({
    mediaTypes: ['images'],
    quality: 0.85,
    base64: Platform.OS === 'web',
  });
  if (res.canceled || !res.assets[0]) {
    return null;
  }
  return res.assets[0];
}

/**
 * 清理本地文档目录中不再被任何条目或快照引用的孤儿图片文件（仅原生端生效）
 */
export function cleanupOrphanedImages(referencedRelativePaths: Set<string>): number {
  if (Platform.OS === 'web') return 0;
  try {
    const imagesDir = new Directory(Paths.document, IMAGES_SUBDIR);
    if (!imagesDir.exists) return 0;
    let deletedCount = 0;
    for (const item of imagesDir.list()) {
      if (!(item instanceof File)) continue;
      const relPath = `${IMAGES_SUBDIR}/${item.name}`;
      if (!referencedRelativePaths.has(relPath)) {
        try {
          item.delete();
          deletedCount += 1;
        } catch {
          // 单个文件删除失败不影响后续清理
        }
      }
    }
    return deletedCount;
  } catch {
    return 0;
  }
}
