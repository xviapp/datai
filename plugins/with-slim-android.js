const { withGradleProperties } = require('expo/config-plugins');

/**
 * 持久化 Android Release 瘦身配置：
 * - 开启 APK 原生 .so 压缩（expo.useLegacyPackaging=true）
 * - 开启 R8 代码压缩与无用资源裁剪
 * - 关闭 React Native 默认 Image 的多余 GIF/WebP 解码器（图片统一走 expo-image）
 */
module.exports = function withSlimAndroid(config) {
  return withGradleProperties(config, (mod) => {
    const desired = {
      'android.enableMinifyInReleaseBuilds': 'true',
      'android.enableShrinkResourcesInReleaseBuilds': 'true',
      'expo.useLegacyPackaging': 'true',
      'expo.gif.enabled': 'false',
      'expo.webp.enabled': 'false',
    };

    for (const [key, value] of Object.entries(desired)) {
      const existing = mod.modResults.find(
        (item) => item.type === 'property' && item.key === key
      );
      if (existing) {
        existing.value = value;
      } else {
        mod.modResults.push({ type: 'property', key, value });
      }
    }

    return mod;
  });
};
