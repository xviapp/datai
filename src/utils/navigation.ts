import { type Href, useNavigation, useRouter } from 'expo-router';
import { useCallback, useRef } from 'react';

const NAV_THROTTLE_MS = 320;

interface StackRouteLike {
  name?: string;
  params?: Record<string, unknown>;
}

/**
 * 统一的防抖与智能路由跳转 Hook：
 * 1. 防止 Android 上双击卡片导致重复 push 同一页面；
 * 2. 防止连续误点返回键弹出多层页面；
 * 3. 从详情页点击顶部所属记录本时，若上一页恰好是该记录本则直接优雅返回，避免形成循环堆叠。
 */
export function useSafeNavigation() {
  const router = useRouter();
  const navigation = useNavigation();
  const lastPushRef = useRef<{ key: string; at: number }>({ key: '', at: 0 });
  const lastBackAtRef = useRef(0);

  const push = useCallback(
    (href: Href) => {
      const now = Date.now();
      const key = typeof href === 'string' ? href : JSON.stringify(href);
      if (now - lastPushRef.current.at < NAV_THROTTLE_MS) {
        return;
      }
      if (lastPushRef.current.key === key && now - lastPushRef.current.at < 520) {
        return;
      }
      lastPushRef.current = { key, at: now };
      router.push(href);
    },
    [router]
  );

  const navigate = useCallback(
    (href: Href) => {
      const now = Date.now();
      if (now - lastPushRef.current.at < 180) {
        return;
      }
      lastPushRef.current = {
        key: typeof href === 'string' ? href : JSON.stringify(href),
        at: now,
      };
      router.navigate(href);
    },
    [router]
  );

  const back = useCallback(() => {
    const now = Date.now();
    if (now - lastBackAtRef.current < 260) {
      return;
    }
    lastBackAtRef.current = now;
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)');
    }
  }, [router]);

  const openLibrary = useCallback(
    (slug: string) => {
      const state = navigation.getState?.() as
        | { index?: number; routes?: StackRouteLike[] }
        | undefined;
      if (state?.routes && typeof state.index === 'number' && state.index > 0) {
        const prevRoute = state.routes[state.index - 1];
        if (
          prevRoute?.name === 'library/[slug]' &&
          String(prevRoute.params?.slug ?? '') === slug
        ) {
          back();
          return;
        }
      }
      push(`/library/${slug}` as Href);
    },
    [navigation, back, push]
  );

  return {
    router,
    push,
    navigate,
    back,
    openLibrary,
    replace: router.replace,
    setParams: router.setParams,
  };
}
