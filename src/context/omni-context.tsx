import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { AssistantScene, CaptureEntryContext } from '@/ai/agents';
import { getDeepSeekApiKey } from '@/ai/settings-store';
import { getPlatformSqlDriver } from '@/db/driver';
import type { LibraryRecord } from '@/db/models';
import { OmniRepository } from '@/db/repository';

export type OmniLaunchAction = 'text' | 'voice' | 'camera';

export interface RepositoryContextValue {
  ready: boolean;
  error: string | null;
  persistWarning: string | null;
  dismissPersistWarning: () => void;
  repo: OmniRepository | null;
  libraries: LibraryRecord[];
  revision: number;
  hasApiKey: boolean;
  refreshApiKeyState: () => Promise<void>;
}

export interface OmniModalStateValue {
  omniModalVisible: boolean;
  omniScene: AssistantScene;
  omniTargetSlug?: string;
  omniEntryContext?: CaptureEntryContext;
  omniInitialAction: OmniLaunchAction;
}

export interface OmniModalActionsValue {
  openOmniCapture: (
    targetSlug?: string,
    initialAction?: OmniLaunchAction,
    entryContext?: CaptureEntryContext,
    scene?: AssistantScene
  ) => void;
  closeOmniCapture: () => void;
  clearOmniEntryContext: () => void;
}

const RepositoryContext = createContext<RepositoryContextValue>({
  ready: false,
  error: null,
  persistWarning: null,
  dismissPersistWarning: () => {},
  repo: null,
  libraries: [],
  revision: 0,
  hasApiKey: false,
  refreshApiKeyState: async () => {},
});

const WidgetRevisionContext = createContext<number>(0);

const OmniModalStateContext = createContext<OmniModalStateValue>({
  omniModalVisible: false,
  omniScene: 'home',
  omniTargetSlug: undefined,
  omniEntryContext: undefined,
  omniInitialAction: 'text',
});

const OmniModalActionsContext = createContext<OmniModalActionsValue>({
  openOmniCapture: () => {},
  closeOmniCapture: () => {},
  clearOmniEntryContext: () => {},
});

/**
 * 拆分数据层（RepositoryContext）与全局助手弹窗态（OmniModalState / OmniModalActions）：
 * 打开/关闭随手说弹窗不会触发底层业务页面与图表卡片整树重渲染。
 */
export function OmniProvider({ children }: { children: React.ReactNode }) {
  const [repo, setRepo] = useState<OmniRepository | null>(null);
  const [libraries, setLibraries] = useState<LibraryRecord[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [persistWarning, setPersistWarning] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [widgetRevision, setWidgetRevision] = useState(0);
  const [hasApiKey, setHasApiKey] = useState(false);

  const [modalState, setModalState] = useState<OmniModalStateValue>({
    omniModalVisible: false,
    omniScene: 'home',
    omniTargetSlug: undefined,
    omniEntryContext: undefined,
    omniInitialAction: 'text',
  });

  const refreshApiKeyState = useCallback(async () => {
    const key = await getDeepSeekApiKey();
    setHasApiKey(Boolean(key));
  }, []);

  const dismissPersistWarning = useCallback(() => {
    setPersistWarning(null);
  }, []);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let unsubWidgets: (() => void) | undefined;
    let unsubPersist: (() => void) | undefined;
    (async () => {
      try {
        const driver = await getPlatformSqlDriver();
        if (driver.subscribePersistError) {
          unsubPersist = driver.subscribePersistError((msg) => {
            setPersistWarning(msg);
          });
        }
        const instance = new OmniRepository(driver);
        instance.seedIfEmpty();
        setLibraries(instance.listLibraries());
        unsub = instance.subscribe(() => {
          setLibraries(instance.listLibraries());
          setRevision((r) => r + 1);
        });
        unsubWidgets = instance.subscribeWidgets(() => {
          setWidgetRevision((r) => r + 1);
        });
        setRepo(instance);
        await refreshApiKeyState();
        setReady(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      unsub?.();
      unsubWidgets?.();
      unsubPersist?.();
    };
  }, [refreshApiKeyState]);

  const openOmniCapture = useCallback(
    (
      targetSlug?: string,
      initialAction: OmniLaunchAction = 'text',
      entryContext?: CaptureEntryContext,
      scene?: AssistantScene
    ) => {
      const resolvedScene: AssistantScene =
        scene ?? (entryContext ? 'entry' : targetSlug ? 'library' : 'home');
      setModalState({
        omniModalVisible: true,
        omniScene: resolvedScene,
        omniTargetSlug: targetSlug,
        omniEntryContext: entryContext,
        omniInitialAction: initialAction,
      });
    },
    []
  );

  const clearOmniEntryContext = useCallback(() => {
    setModalState((prev) => ({
      ...prev,
      omniEntryContext: undefined,
      omniScene:
        prev.omniScene === 'entry'
          ? prev.omniTargetSlug
            ? 'library'
            : 'home'
          : prev.omniScene,
    }));
  }, []);

  const closeOmniCapture = useCallback(() => {
    setModalState((prev) => ({
      ...prev,
      omniModalVisible: false,
      omniEntryContext: undefined,
      omniInitialAction: 'text',
    }));
  }, []);

  const repoValue = useMemo<RepositoryContextValue>(
    () => ({
      ready,
      error,
      persistWarning,
      dismissPersistWarning,
      repo,
      libraries,
      revision,
      hasApiKey,
      refreshApiKeyState,
    }),
    [
      ready,
      error,
      persistWarning,
      dismissPersistWarning,
      repo,
      libraries,
      revision,
      hasApiKey,
      refreshApiKeyState,
    ]
  );

  const modalActions = useMemo<OmniModalActionsValue>(
    () => ({
      openOmniCapture,
      closeOmniCapture,
      clearOmniEntryContext,
    }),
    [openOmniCapture, closeOmniCapture, clearOmniEntryContext]
  );

  return (
    <RepositoryContext.Provider value={repoValue}>
      <WidgetRevisionContext.Provider value={widgetRevision}>
        <OmniModalActionsContext.Provider value={modalActions}>
          <OmniModalStateContext.Provider value={modalState}>
            {children}
          </OmniModalStateContext.Provider>
        </OmniModalActionsContext.Provider>
      </WidgetRevisionContext.Provider>
    </RepositoryContext.Provider>
  );
}

export function useRepository(): RepositoryContextValue {
  return useContext(RepositoryContext);
}

export function useWidgetRevision(): number {
  return useContext(WidgetRevisionContext);
}

export function useOmniModalState(): OmniModalStateValue {
  return useContext(OmniModalStateContext);
}

export function useOmniModalActions(): OmniModalActionsValue {
  return useContext(OmniModalActionsContext);
}
