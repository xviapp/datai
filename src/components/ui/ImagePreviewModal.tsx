import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import React, { useEffect, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Palette } from '@/constants/design-tokens';

interface ImagePreviewModalProps {
  uri: string | null;
  caption?: string;
  onClose: () => void;
}

export function ImagePreviewModal({ uri, caption, onClose }: ImagePreviewModalProps) {
  const insets = useSafeAreaInsets();
  const visible = Boolean(uri);
  const [mounted, setMounted] = useState(visible);
  const [activeUri, setActiveUri] = useState<string | null>(uri);
  const [opacity] = useState(() => new Animated.Value(0));
  const [scale] = useState(() => new Animated.Value(0.94));

  if (visible && !mounted) {
    setMounted(true);
  }
  if (uri && uri !== activeUri) {
    setActiveUri(uri);
  }

  useEffect(() => {
    if (visible && mounted) {
      opacity.stopAnimation();
      scale.stopAnimation();
      opacity.setValue(0);
      scale.setValue(0.94);
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 180,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.spring(scale, {
          toValue: 1,
          damping: 24,
          stiffness: 280,
          useNativeDriver: true,
        }),
      ]).start();
    } else if (!visible && mounted) {
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: 150,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 0.94,
          duration: 150,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) {
          setMounted(false);
          setActiveUri(null);
        }
      });
    }
  }, [visible, mounted, opacity, scale]);

  if (!mounted || !activeUri) return null;

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <Animated.View style={[styles.backdrop, { opacity }]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityLabel="关闭大图预览"
        />

        <View
          style={[styles.topBar, { paddingTop: Math.max(insets.top, 16) + 8 }]}
          pointerEvents="box-none"
        >
          <View style={{ flex: 1 }} />
          <Pressable
            onPress={onClose}
            hitSlop={10}
            style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.7 }]}
            accessibilityLabel="关闭预览"
          >
            <Feather name="x" size={22} color={Palette.inkInverse} />
          </Pressable>
        </View>

        <Animated.View
          pointerEvents="none"
          style={[styles.imgWrap, { transform: [{ scale }] }]}
        >
          <Image
            source={{ uri: activeUri }}
            style={styles.fullImage}
            contentFit="contain"
          />
        </Animated.View>

        {caption ? (
          <View
            pointerEvents="none"
            style={[styles.captionWrap, { paddingBottom: Math.max(insets.bottom, 20) + 10 }]}
          >
            <Text style={styles.captionText} numberOfLines={2}>
              {caption}
            </Text>
          </View>
        ) : null}
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(10, 12, 12, 0.94)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    zIndex: 2,
  },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  imgWrap: {
    width: '94%',
    height: '76%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fullImage: {
    width: '100%',
    height: '100%',
  },
  captionWrap: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  captionText: {
    color: 'rgba(255, 255, 255, 0.88)',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
});
