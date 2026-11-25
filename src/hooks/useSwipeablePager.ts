import { type ComponentRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
  useWindowDimensions,
} from 'react-native';

export interface UseSwipeablePagerOptions {
  /** 总页数 */
  pageCount: number;
  /** 当前受控的页码索引 */
  activeIndex: number;
  /** 手势滑动或点击切换页码时回调 */
  onIndexChange: (index: number) => void;
  /** 是否开启手势监听（默认 pageCount > 1） */
  enabled?: boolean;
  /** 初始宽度覆盖（如居中弹窗最大宽度） */
  initialWidth?: number;
  /** 当该签名变化时无动画同步滚动位置到 activeIndex */
  syncKey?: string;
}

/**
 * 统一的横向手势分页 Hook：
 * 管理 pagerWidth、跟手 Animated.Value(scrollX)、380ms 程序滚动防回弹锁、
 * 横向胶囊自动居中滚动与卸载清理。
 */
export function useSwipeablePager({
  pageCount,
  activeIndex,
  onIndexChange,
  enabled = pageCount > 1,
  initialWidth,
  syncKey,
}: UseSwipeablePagerOptions) {
  const { width: screenWidth } = useWindowDimensions();
  const fallbackWidth = initialWidth ?? screenWidth;

  const [pagerWidth, setPagerWidth] = useState(fallbackWidth);
  const [pagerScrollX] = useState(() => new Animated.Value(0));
  const pagerRef = useRef<ComponentRef<typeof Animated.ScrollView>>(null);
  const chipsScrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const chipLayoutsRef = useRef<Record<number, { x: number; width: number }>>({});
  const programmaticScrollRef = useRef(false);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onIndexChangeRef = useRef(onIndexChange);
  const activeIndexRef = useRef(activeIndex);

  useEffect(() => {
    onIndexChangeRef.current = onIndexChange;
  }, [onIndexChange]);

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  const effectiveWidth = pagerWidth > 0 ? pagerWidth : fallbackWidth;

  const scrollChipIntoView = useCallback(
    (idx: number) => {
      const layout = chipLayoutsRef.current[idx];
      if (!layout || !chipsScrollRef.current) return;
      const targetX = Math.max(0, layout.x - effectiveWidth / 2 + layout.width / 2);
      chipsScrollRef.current.scrollTo({ x: targetX, animated: true });
    },
    [effectiveWidth]
  );

  // 当 syncKey 或分页宽度变化时，对齐到目标索引位置
  useEffect(() => {
    if (!enabled || syncKey === undefined) return;
    const clampedIdx = Math.max(0, Math.min(Math.max(0, pageCount - 1), activeIndexRef.current));
    const targetX = clampedIdx * effectiveWidth;
    programmaticScrollRef.current = false;
    pagerScrollX.setValue(targetX);
    const frame = requestAnimationFrame(() => {
      pagerRef.current?.scrollTo({ x: targetX, animated: false });
      scrollChipIntoView(clampedIdx);
    });
    return () => cancelAnimationFrame(frame);
  }, [enabled, syncKey, effectiveWidth, pageCount, pagerScrollX, scrollChipIntoView]);

  // 手势滑动过半即时同步选中索引
  useEffect(() => {
    if (!enabled || pageCount <= 1) return;
    const listenerId = pagerScrollX.addListener(({ value }) => {
      if (programmaticScrollRef.current) return;
      const nextIdx = Math.max(
        0,
        Math.min(pageCount - 1, Math.round(value / Math.max(1, effectiveWidth)))
      );
      if (nextIdx !== activeIndexRef.current) {
        activeIndexRef.current = nextIdx;
        onIndexChangeRef.current(nextIdx);
        scrollChipIntoView(nextIdx);
      }
    });
    return () => {
      pagerScrollX.removeListener(listenerId);
    };
  }, [enabled, pageCount, effectiveWidth, pagerScrollX, scrollChipIntoView]);

  useEffect(() => {
    return () => {
      if (scrollTimerRef.current) {
        clearTimeout(scrollTimerRef.current);
      }
    };
  }, []);

  const selectPage = useCallback(
    (idx: number) => {
      const clamped = Math.max(0, Math.min(Math.max(0, pageCount - 1), idx));
      programmaticScrollRef.current = true;
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = setTimeout(() => {
        programmaticScrollRef.current = false;
      }, 380);
      activeIndexRef.current = clamped;
      onIndexChangeRef.current(clamped);
      pagerRef.current?.scrollTo({ x: clamped * effectiveWidth, animated: true });
      scrollChipIntoView(clamped);
    },
    [pageCount, effectiveWidth, scrollChipIntoView]
  );

  const jumpToPage = useCallback(
    (idx: number) => {
      const clamped = Math.max(0, Math.min(Math.max(0, pageCount - 1), idx));
      programmaticScrollRef.current = false;
      if (scrollTimerRef.current) {
        clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = null;
      }
      activeIndexRef.current = clamped;
      pagerScrollX.setValue(clamped * effectiveWidth);
      pagerRef.current?.scrollTo({ x: clamped * effectiveWidth, animated: false });
      scrollChipIntoView(clamped);
    },
    [pageCount, effectiveWidth, pagerScrollX, scrollChipIntoView]
  );

  const handlePagerLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const w = e.nativeEvent.layout.width;
      if (w > 0 && Math.abs(w - pagerWidth) > 0.5) {
        setPagerWidth(w);
      }
    },
    [pagerWidth]
  );

  const handlePagerMomentumEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      programmaticScrollRef.current = false;
      if (scrollTimerRef.current) {
        clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = null;
      }
      const offsetX = e.nativeEvent.contentOffset.x;
      const nextIdx = Math.max(
        0,
        Math.min(Math.max(0, pageCount - 1), Math.round(offsetX / Math.max(1, effectiveWidth)))
      );
      if (nextIdx !== activeIndexRef.current) {
        activeIndexRef.current = nextIdx;
        onIndexChangeRef.current(nextIdx);
      }
      scrollChipIntoView(nextIdx);
    },
    [pageCount, effectiveWidth, scrollChipIntoView]
  );

  const handleChipLayout = useCallback(
    (idx: number) => (e: LayoutChangeEvent) => {
      const { x, width } = e.nativeEvent.layout;
      chipLayoutsRef.current[idx] = { x, width };
    },
    []
  );

  const onPagerScroll = useMemo(
    () =>
      Animated.event([{ nativeEvent: { contentOffset: { x: pagerScrollX } } }], {
        useNativeDriver: true,
      }),
    [pagerScrollX]
  );

  return {
    pagerRef,
    pagerScrollX,
    effectiveWidth,
    chipsScrollRef,
    selectPage,
    jumpToPage,
    handlePagerLayout,
    handlePagerMomentumEnd,
    handleChipLayout,
    scrollChipIntoView,
    onPagerScroll,
  };
}
