import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getDeepSeekApiKey } from '@/ai/settings-store';
import { getPlatformSqlDriver } from '@/db/driver';
import { OmniRepository, type LibraryRecord } from '@/db/repository';

interface OmniContextValue {
  ready: boolean;
  error: string | null;
  repo: OmniRepository | null;
  libraries: LibraryRecord[];
  revision: number;
  hasApiKey: boolean;
  refreshApiKeyState: () => Promise<void>;
  omniModalVisible: boolean;
  omniTargetSlug?: string;
  openOmniCapture: (targetSlug?: string) => void;
  closeOmniCapture: () => void;
}

const OmniContext = createContext<OmniContextValue>({
  ready: false,
  error: null,
  repo: null,
  libraries: [],
  revision: 0,
  hasApiKey: false,
  refreshApiKeyState: async () => {},
  omniModalVisible: false,
  omniTargetSlug: undefined,
  openOmniCapture: () => {},
  closeOmniCapture: () => {},
});

export function OmniProvider({ children }: { children: React.ReactNode }) {
  const [repo, setRepo] = useState<OmniRepository | null>(null);
  const [libraries, setLibraries] = useState<LibraryRecord[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [omniModalVisible, setOmniModalVisible] = useState(false);
  const [omniTargetSlug, setOmniTargetSlug] = useState<string | undefined>(undefined);

  const refreshApiKeyState = useCallback(async () => {
    const key = await getDeepSeekApiKey();
    setHasApiKey(Boolean(key));
  }, []);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      try {
        const driver = await getPlatformSqlDriver();
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
    };
  }, [refreshApiKeyState]);

  const openOmniCapture = useCallback((targetSlug?: string) => {
    setOmniTargetSlug(targetSlug);
    setOmniModalVisible(true);
  }, []);

  const closeOmniCapture = useCallback(() => {
    setOmniModalVisible(false);
  }, []);

  const value = useMemo<OmniContextValue>(
    () => ({
      ready,
      error,
      repo,
      libraries,
      revision,
      hasApiKey,
      refreshApiKeyState,
      omniModalVisible,
      omniTargetSlug,
      openOmniCapture,
      closeOmniCapture,
    }),
    [
      ready,
      error,
      repo,
      libraries,
      revision,
      hasApiKey,
      refreshApiKeyState,
      omniModalVisible,
      omniTargetSlug,
      openOmniCapture,
      closeOmniCapture,
    ]
  );

  return <OmniContext.Provider value={value}>{children}</OmniContext.Provider>;
}

export function useOmni() {
  return useContext(OmniContext);
}
