import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, type StyleProp, type ViewStyle } from 'react-native';

interface ContentTransitionViewProps {
  /** 每次切换视图/Tab/月份时变化的 key，驱动轻量平滑过渡 */
  transitionKey: string;
  /**
   * 滑动方向：
   * - 1：向后/向右切，新内容从右侧滑入
   * - -1：向前/向左切，新内容从左侧滑入
   * - 0（默认）：轻量纵向微浮淡入
   */
  slideDirection?: -1 | 0 | 1;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function ContentTransitionView({
  transitionKey,
  slideDirection = 0,
  children,
  style,
}: ContentTransitionViewProps) {
  const [opacity] = useState(() => new Animated.Value(1));
  const [translateX] = useState(() => new Animated.Value(0));
  const [translateY] = useState(() => new Animated.Value(0));
  const prevKeyRef = useRef(transitionKey);

  useEffect(() => {
    if (prevKeyRef.current === transitionKey) return;
    prevKeyRef.current = transitionKey;

    opacity.stopAnimation();
    translateX.stopAnimation();
    translateY.stopAnimation();

    opacity.setValue(0.32);
    if (slideDirection !== 0) {
      translateX.setValue(slideDirection * 18);
      translateY.setValue(0);
    } else {
      translateX.setValue(0);
      translateY.setValue(6);
    }

    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 175,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(translateX, {
        toValue: 0,
        duration: 185,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 175,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [transitionKey, slideDirection, opacity, translateX, translateY]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity,
          transform: [{ translateX }, { translateY }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}
