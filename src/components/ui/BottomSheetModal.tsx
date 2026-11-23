import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  type GestureResponderHandlers,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Palette } from '@/constants/design-tokens';

interface BottomSheetModalProps {
  visible: boolean;
  onClose: () => void;
  /** 固定在顶部的标题栏内容，支持整个标题栏区域下拉关闭 */
  header?: React.ReactNode;
  children: React.ReactNode;
  /** 面板最大高度（如 '90%' / '92%'），默认 '90%' */
  maxHeight?: ViewStyle['maxHeight'];
  /** 面板最大宽度，默认 680 */
  maxWidth?: number;
  /** 是否显示顶部拖拽胶囊，默认 true */
  showHandle?: boolean;
  /** 点击遮罩是否关闭，默认 true */
  dismissOnBackdropPress?: boolean;
  sheetStyle?: StyleProp<ViewStyle>;
}

const DISMISS_DISTANCE = 92;
const DISMISS_VELOCITY = 0.65;

export function BottomSheetModal({
  visible,
  onClose,
  header,
  children,
  maxHeight = '90%',
  maxWidth = 680,
  showHandle = true,
  dismissOnBackdropPress = true,
  sheetStyle,
}: BottomSheetModalProps) {
  const initialOffscreen = Math.max(Dimensions.get('window').height * 0.72, 420);
  const [mounted, setMounted] = useState(visible);

  // 当 visible 从 false 变为 true 时同步挂载 Modal，避免在 useEffect 中同步 setState
  if (visible && !mounted) {
    setMounted(true);
  }

  const [backdropAnim] = useState(() => new Animated.Value(0));
  const [translateY] = useState(() => new Animated.Value(initialOffscreen));
  const [panHandlers, setPanHandlers] = useState<GestureResponderHandlers>({});

  const sheetHeightRef = useRef(initialOffscreen);
  const closingRef = useRef(false);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const animateIn = useCallback(() => {
    closingRef.current = false;
    backdropAnim.stopAnimation();
    translateY.stopAnimation();

    const startOffset = Math.max(sheetHeightRef.current, 380);
    backdropAnim.setValue(0);
    translateY.setValue(startOffset);

    Animated.parallel([
      Animated.timing(backdropAnim, {
        toValue: 1,
        duration: 210,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.spring(translateY, {
        toValue: 0,
        damping: 26,
        stiffness: 290,
        mass: 0.9,
        overshootClamping: false,
        useNativeDriver: true,
      }),
    ]).start();
  }, [backdropAnim, translateY]);

  const animateOut = useCallback(
    (notifyParent: boolean) => {
      if (closingRef.current) return;
      closingRef.current = true;
      backdropAnim.stopAnimation();
      translateY.stopAnimation();

      const targetOffset = Math.max(sheetHeightRef.current, 420);
      Animated.parallel([
        Animated.timing(backdropAnim, {
          toValue: 0,
          duration: 180,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: targetOffset,
          duration: 190,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (!finished) return;
        closingRef.current = false;
        setMounted(false);
        if (notifyParent) {
          onCloseRef.current();
        }
      });
    },
    [backdropAnim, translateY]
  );

  useEffect(() => {
    if (visible && mounted) {
      animateIn();
    } else if (!visible && mounted) {
      animateOut(false);
    }
  }, [visible, mounted, animateIn, animateOut]);

  useEffect(() => {
    const responder = PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gs) =>
        gs.dy > 6 && Math.abs(gs.dy) > Math.abs(gs.dx) * 1.15,
      onPanResponderMove: (_, gs) => {
        const clampedY = Math.max(0, gs.dy);
        translateY.setValue(clampedY);
        const ratio = Math.min(1, clampedY / Math.max(sheetHeightRef.current * 0.75, 240));
        backdropAnim.setValue(1 - ratio * 0.85);
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dy > DISMISS_DISTANCE || gs.vy > DISMISS_VELOCITY) {
          animateOut(true);
        } else {
          Animated.parallel([
            Animated.spring(translateY, {
              toValue: 0,
              damping: 26,
              stiffness: 320,
              mass: 0.85,
              useNativeDriver: true,
            }),
            Animated.timing(backdropAnim, {
              toValue: 1,
              duration: 140,
              useNativeDriver: true,
            }),
          ]).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.parallel([
          Animated.spring(translateY, {
            toValue: 0,
            damping: 26,
            stiffness: 320,
            mass: 0.85,
            useNativeDriver: true,
          }),
          Animated.timing(backdropAnim, {
            toValue: 1,
            duration: 140,
            useNativeDriver: true,
          }),
        ]).start();
      },
    });
    setPanHandlers(responder.panHandlers);
  }, [animateOut, backdropAnim, translateY]);

  const handleRequestDismiss = useCallback(() => {
    animateOut(true);
  }, [animateOut]);

  if (!mounted) {
    return null;
  }

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={handleRequestDismiss}
    >
      <View style={styles.root}>
        <Animated.View
          style={[
            styles.backdrop,
            {
              opacity: backdropAnim,
            },
          ]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            disabled={!dismissOnBackdropPress}
            onPress={handleRequestDismiss}
            accessibilityLabel="关闭弹窗"
          />
        </Animated.View>

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.kav}
          pointerEvents="box-none"
        >
          <Animated.View
            onLayout={(e) => {
              const h = e.nativeEvent.layout.height;
              if (h > 0) sheetHeightRef.current = h;
            }}
            style={[
              styles.sheet,
              { maxHeight, maxWidth, transform: [{ translateY }] },
              sheetStyle,
            ]}
          >
            <View {...panHandlers}>
              {showHandle ? (
                <View style={styles.handleZone}>
                  <View style={styles.handleBar} />
                </View>
              ) : null}
              {header}
            </View>
            {children}
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(18, 24, 23, 0.46)',
  },
  kav: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Palette.bgSurface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    width: '100%',
    alignSelf: 'center',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 18,
  },
  handleZone: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 10,
    paddingBottom: 2,
  },
  handleBar: {
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: Palette.borderStrong,
  },
});
