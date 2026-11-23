import Feather from '@expo/vector-icons/Feather';
import React, { useEffect, useState } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Palette } from '@/constants/design-tokens';

export interface SegmentedTabOption {
  key: string;
  label: string;
  icon?: React.ComponentProps<typeof Feather>['name'];
  emoji?: string;
}

interface SlidingSegmentedBarProps {
  items: SegmentedTabOption[];
  activeIndex: number;
  onSelect: (index: number) => void;
  /** 激活滑块填充色，默认 Palette.brand */
  activeColor?: string;
  /** 激活态文字与图标色，默认 Palette.inkInverse */
  activeInkColor?: string;
  /** 可选：绑定横向 Pager 的 Animated.Value 实现跟手 1:1 滑动 */
  scrollX?: Animated.Value;
  /** 配合 scrollX 使用的单页宽度 */
  pageWidth?: number;
  style?: StyleProp<ViewStyle>;
  compact?: boolean;
}

const BAR_PADDING = 4;

export function SlidingSegmentedBar({
  items,
  activeIndex,
  onSelect,
  activeColor = Palette.brand,
  activeInkColor = Palette.inkInverse,
  scrollX,
  pageWidth,
  style,
  compact = false,
}: SlidingSegmentedBarProps) {
  const [barWidth, setBarWidth] = useState(0);
  const [springIndex] = useState(() => new Animated.Value(activeIndex));

  useEffect(() => {
    if (scrollX) return;
    Animated.spring(springIndex, {
      toValue: activeIndex,
      damping: 24,
      stiffness: 320,
      mass: 0.8,
      useNativeDriver: true,
    }).start();
  }, [activeIndex, scrollX, springIndex]);

  const count = Math.max(1, items.length);
  const innerWidth = Math.max(0, barWidth - BAR_PADDING * 2);
  const segmentWidth = innerWidth / count;
  const maxTranslate = Math.max(0, (count - 1) * segmentWidth);

  let translateX: Animated.AnimatedInterpolation<number> | number = 0;
  if (segmentWidth > 0 && count > 1) {
    if (scrollX && pageWidth && pageWidth > 0) {
      translateX = scrollX.interpolate({
        inputRange: [0, (count - 1) * pageWidth],
        outputRange: [0, maxTranslate],
        extrapolate: 'clamp',
      });
    } else {
      translateX = springIndex.interpolate({
        inputRange: [0, count - 1],
        outputRange: [0, maxTranslate],
        extrapolate: 'clamp',
      });
    }
  }

  const handleLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0 && Math.abs(w - barWidth) > 0.5) {
      setBarWidth(w);
    }
  };

  return (
    <View onLayout={handleLayout} style={[styles.bar, style]}>
      {segmentWidth > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.indicator,
            {
              width: segmentWidth,
              backgroundColor: activeColor,
              transform: [{ translateX }],
            },
          ]}
        />
      ) : null}

      {items.map((item, idx) => {
        const active = idx === activeIndex;
        return (
          <Pressable
            key={item.key}
            onPress={() => onSelect(idx)}
            style={({ pressed }) => [
              styles.tabItem,
              compact && styles.tabItemCompact,
              pressed && !active && styles.tabItemPressed,
            ]}
          >
            {item.emoji ? (
              <Text style={styles.emoji}>{item.emoji}</Text>
            ) : item.icon ? (
              <Feather
                name={item.icon}
                size={13}
                color={active ? activeInkColor : Palette.inkSecondary}
              />
            ) : null}
            <Text
              numberOfLines={1}
              style={[
                styles.label,
                compact && styles.labelCompact,
                active && { color: activeInkColor },
              ]}
            >
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Palette.bgSurface,
    borderRadius: 14,
    padding: BAR_PADDING,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  indicator: {
    position: 'absolute',
    top: BAR_PADDING,
    bottom: BAR_PADDING,
    left: BAR_PADDING,
    borderRadius: 10,
  },
  tabItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 10,
    zIndex: 1,
  },
  tabItemCompact: {
    paddingVertical: 7,
  },
  tabItemPressed: {
    opacity: 0.65,
  },
  emoji: {
    fontSize: 13,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkSecondary,
    flexShrink: 1,
  },
  labelCompact: {
    fontSize: 12,
  },
});
