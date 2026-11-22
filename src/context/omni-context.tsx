import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getDeepSeekApiKey } from '@/ai/settings-store';
import { getPlatformSqlDriver } from '@/db/driver';
import { OmniRepository, type LibraryRecord } from '@/db/repository';

export type OmniLaunchAction = 'text' | 'voice' | 'camera';

interface OmniContextValue {
  ready: boolean;
  error: string | null;
  persistWarning: string | null;
  dismissPersistWarning: () => void;
  repo: OmniRepository | null;
  libraries: LibraryRecord[];
  revision: number;
  hasApiKey: boolean;
  refreshApiKeyState: () => Promise<void>;
  omniModalVisible: boolean;
  omniTargetSlug?: string;
  omniInitialAction: OmniLaunchAction;
  openOmniCapture: (targetSlug?: string, initialAction?: OmniLaunchAction) => void;
  closeOmniCapture: () => void;
}

const OmniContext = createContext<OmniContextValue>({
  ready: false,
  error: null,
  persistWarning: null,
  dismissPersistWarning: () => {},
  repo: null,
  libraries: [],
  revision: 0,
  hasApiKey: false,
  refreshApiKeyState: async () => {},
  omniModalVisible: false,
  omniTargetSlug: undefined,
  omniInitialAction: 'text',
  openOmniCapture: () => {},
  closeOmniCapture: () => {},
});

export function OmniProvider({ children }: { children: React.ReactNode }) {
  const [repo, setRepo] = useState<OmniRepository | null>(null);
  const [libraries, setLibraries] = useState<LibraryRecord[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [persistWarning, setPersistWarning] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [omniModalVisible, setOmniModalVisible] = useState(false);
  const [omniTargetSlug, setOmniTargetSlug] = useState<string | undefined>(undefined);
  const [omniInitialAction, setOmniInitialAction] = useState<OmniLaunchAction>('text');

  const refreshApiKeyState = useCallback(async () => {
    const key = await getDeepSeekApiKey();
    setHasApiKey(Boolean(key));
  }, []);

  const dismissPersistWarning = useCallback(() => {
    setPersistWarning(null);
  }, []);

  useEffect(() => {
    let unsub: (() => void) | undefined;
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
        setRepo(instance);
        await refreshApiKeyState();
        setReady(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      unsub?.();
      unsubPersist?.();
    };
  }, [refreshApiKeyState]);

  const openOmniCapture = useCallback(
    (targetSlug?: string, initialAction: OmniLaunchAction = 'text') => {
      setOmniTargetSlug(targetSlug);
      setOmniInitialAction(initialAction);
      setOmniModalVisible(true);
    },
    []
  );

  const closeOmniCapture = useCallback(() => {
    setOmniModalVisible(false);
    setOmniInitialAction('text');
  }, []);

  const value = useMemo<OmniContextValue>(
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
      omniModalVisible,
      omniTargetSlug,
      omniInitialAction,
      openOmniCapture,
      closeOmniCapture,
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
      omniModalVisible,
      omniTargetSlug,
      omniInitialAction,
      openOmniCapture,
      closeOmniCapture,
    ]
  );

  return <OmniContext.Provider value={value}>{children}</OmniContext.Provider>;
}

export function useOmni() {
  return useContext(OmniContext);
}
