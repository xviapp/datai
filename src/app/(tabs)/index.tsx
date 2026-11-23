import Feather from '@expo/vector-icons/Feather';
import React, { useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SchemaEditorModal } from '@/components/dynamic-renderer/SchemaEditorModal';
import { TabPageHeader } from '@/components/layout/TabPageHeader';
import { Palette, ToneMap } from '@/constants/design-tokens';
import { useOmni } from '@/context/omni-context';
import type { LibraryRecord } from '@/db/repository';
import { useSafeNavigation } from '@/utils/navigation';

function formatShortRelativeTime(ts: number): string {
  const now = new Date();
  const d = new Date(ts);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTarget = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfToday - startOfTarget) / 86400000);
  if (diffDays <= 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays < 7) return `${diffDays}天前`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function HomeVaultScreen() {
  const nav = useSafeNavigation();
  const {
    repo,
    libraries,
    revision,
    hasApiKey,
    persistWarning,
    dismissPersistWarning,
    openOmniCapture,
  } = useOmni();
  const [globalSearch, setGlobalSearch] = useState('');
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [managingLibrary, setManagingLibrary] = useState<LibraryRecord | null>(null);

  const visibleLibraries = useMemo(
    () => libraries.filter((l) => l.showOnHome),
    [libraries]
  );

  const childLibsByParent = useMemo(() => {
    const map = new Map<string, LibraryRecord[]>();
    for (const l of libraries) {
      if (l.parentLibrarySlug) {
        const list = map.get(l.parentLibrarySlug) ?? [];
        list.push(l);
        map.set(l.parentLibrarySlug, list);
      }
    }
    return map;
  }, [libraries]);

  const totalEntryCount = libraries.reduce((sum, l) => sum + l.entryCount, 0);

  const searchHits = useMemo(() => {
    if (!repo || revision < 0 || !globalSearch.trim()) return [];
    return repo.searchEntrySummaries(globalSearch, 30);
  }, [repo, revision, globalSearch]);

  const recentHits = useMemo(() => {
    if (!repo || revision < 0) return [];
    return repo.listRecentEntrySummaries(6);
  }, [repo, revision]);

  const latestByLib = useMemo(() => {
    if (!repo || revision < 0) return new Map<string, { title: string; updatedAt: number }>();
    return repo.listLatestEntryByLibrary();
  }, [repo, revision]);

  return (
    <View style={styles.safeArea}>
      <TabPageHeader
        title="拾录"
        subtitle={`${visibleLibraries.length} 个主记录本 · 共 ${totalEntryCount} 条记录`}
        right={
          <>
            {!hasApiKey ? (
              <Pressable
                onPress={() => nav.navigate('/(tabs)/settings')}
                style={({ pressed }) => [styles.keyStatusPill, pressed && { opacity: 0.75, transform: [{ scale: 0.96 }] }]}
              >
                <View style={styles.statusDot} />
                <Text style={styles.keyStatusText}>连接助手</Text>
              </Pressable>
            ) : null}
            <Pressable
              id="btn-new-library"
              onPress={() => setCreateModalOpen(true)}
              style={({ pressed }) => [styles.newLibBtn, pressed && { opacity: 0.85, transform: [{ scale: 0.96 }] }]}
            >
              <Feather name="plus" size={16} color={Palette.inkInverse} />
              <Text style={styles.newLibBtnText}>新建</Text>
            </Pressable>
          </>
        }
      />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        {persistWarning ? (
          <View style={styles.warnBanner}>
            <Feather name="alert-triangle" size={15} color={Palette.danger} />
            <Text style={styles.warnText}>{persistWarning}</Text>
            <Pressable hitSlop={8} onPress={dismissPersistWarning}>
              <Feather name="x" size={15} color={Palette.danger} />
            </Pressable>
          </View>
        ) : null}

        {/* 全局搜索 */}
        <View style={styles.searchBar}>
          <Feather name="search" size={16} color={Palette.inkMuted} />
          <TextInput
            id="input-global-search"
            value={globalSearch}
            onChangeText={setGlobalSearch}
            placeholder="搜索全部记录与附属笔记..."
            placeholderTextColor={Palette.inkMuted}
            style={styles.searchInput}
          />
          {globalSearch ? (
            <Pressable hitSlop={8} onPress={() => setGlobalSearch('')}>
              <Feather name="x-circle" size={16} color={Palette.inkMuted} />
            </Pressable>
          ) : null}
        </View>

        {globalSearch.trim() ? (
          <View style={styles.searchResultSection}>
            <Text style={styles.sectionHeading}>搜索结果 ({searchHits.length})</Text>
            {searchHits.length === 0 ? (
              <Text style={styles.mutedTip}>没有找到包含 “{globalSearch}” 的记录</Text>
            ) : (
              searchHits.map((hit, idx) => (
                <Pressable
                  key={hit.id}
                  onPress={() => nav.push(`/entry/${hit.id}`)}
                  style={({ pressed }) => [
                    styles.searchHitRow,
                    idx === searchHits.length - 1 && { borderBottomWidth: 0 },
                    pressed && { opacity: 0.68 },
                  ]}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.searchHitTitle} numberOfLines={1}>
                      {hit.title}
                    </Text>
                    <Text style={styles.searchHitMeta}>
                      {hit.libraryIcon} {hit.libraryName} · {formatShortRelativeTime(hit.updatedAt)}
                    </Text>
                  </View>
                  <Feather name="chevron-right" size={15} color={Palette.inkMuted} />
                </Pressable>
              ))
            )}
          </View>
        ) : recentHits.length > 0 ? (
          <View style={styles.recentSection}>
            <Text style={styles.recentLabel}>最近更新</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.recentStrip}
            >
              {recentHits.map((hit) => (
                <Pressable
                  key={hit.id}
                  onPress={() => nav.push(`/entry/${hit.id}`)}
                  style={({ pressed }) => [
                    styles.recentPill,
                    pressed && { opacity: 0.78, transform: [{ scale: 0.97 }] },
                  ]}
                >
                  <Text style={styles.recentEmoji}>{hit.libraryIcon}</Text>
                  <Text style={styles.recentTitle} numberOfLines={1}>
                    {hit.title}
                  </Text>
                  <Text style={styles.recentTime}>{formatShortRelativeTime(hit.updatedAt)}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        ) : null}

        {/* 我的记录本 */}
        <View style={styles.sectionRow}>
          <Text style={styles.sectionHeading}>记录本</Text>
        </View>

        <View style={styles.libGrid}>
          {visibleLibraries.map((lib) => {
            const tone = ToneMap[lib.color] ?? ToneMap.teal;
            const childLibs = childLibsByParent.get(lib.slug) ?? [];
            const latest = latestByLib.get(lib.id);

            return (
              <Pressable
                key={lib.id}
                onPress={() => nav.push(`/library/${lib.slug}`)}
                onLongPress={() => setManagingLibrary(lib)}
                style={({ pressed }) => [styles.libCard, pressed && styles.libCardPressed]}
              >
                <View style={styles.libCardTop}>
                  <View style={[styles.libIconWrap, { backgroundColor: tone.soft }]}>
                    <Text style={styles.libEmoji}>{lib.icon}</Text>
                  </View>
                  <View style={styles.libCardTopRight}>
                    <View style={styles.countPill}>
                      <Text style={styles.countText}>{lib.entryCount} 条</Text>
                    </View>
                    <Pressable
                      hitSlop={8}
                      onPress={(e) => {
                        e.stopPropagation();
                        setManagingLibrary(lib);
                      }}
                      style={({ pressed }) => [styles.moreIconBtn, pressed && { opacity: 0.6 }]}
                      accessibilityLabel={`管理${lib.name}`}
                    >
                      <Feather name="more-horizontal" size={15} color={Palette.inkMuted} />
                    </Pressable>
                  </View>
                </View>

                <Text style={styles.libName} numberOfLines={1}>
                  {lib.name}
                </Text>
                {latest ? (
                  <View style={styles.latestPreviewWrap}>
                    <Text style={styles.latestPreviewTitle} numberOfLines={1}>
                      {latest.title}
                    </Text>
                    <Text style={styles.latestPreviewTime}>
                      {formatShortRelativeTime(latest.updatedAt)}更新
                    </Text>
                  </View>
                ) : (
                  <Text style={styles.libDesc} numberOfLines={2}>
                    {lib.description || '还没有记录，点进去记第一条'}
                  </Text>
                )}

                {childLibs.length > 0 ? (
                  <View style={styles.subLibsRow}>
                    {childLibs.map((child) => (
                      <Pressable
                        key={child.id}
                        onPress={(e) => {
                          e.stopPropagation();
                          nav.push(`/library/${child.slug}`);
                        }}
                        style={({ pressed }) => [
                          styles.subLibChip,
                          { backgroundColor: tone.soft },
                          pressed && { opacity: 0.72 },
                        ]}
                      >
                        <Text style={[styles.subLibChipText, { color: tone.ink }]} numberOfLines={1}>
                          ↳ {child.icon} {child.name} · {child.entryCount}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </Pressable>
            );
          })}

          {visibleLibraries.length === 0 || visibleLibraries.length % 2 === 1 ? (
            <Pressable
              onPress={() => setCreateModalOpen(true)}
              style={({ pressed }) => [styles.addLibCard, pressed && styles.libCardPressed]}
            >
              <View style={styles.addLibIconCircle}>
                <Feather name="plus" size={20} color={Palette.brand} />
              </View>
              <Text style={styles.addLibTitle}>新建记录本</Text>
              <Text style={styles.addLibHint}>自定义字段与样式</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>

      {/* 右下角统一悬浮主按钮（点击打开全局管家，长按直接开录音） */}
      <Pressable
        id="btn-open-omni-bar"
        accessibilityLabel="随手说与智能助手"
        onPress={() => openOmniCapture(undefined, 'text', undefined, 'home')}
        onLongPress={() => openOmniCapture(undefined, 'voice', undefined, 'home')}
        style={({ pressed }) => [
          styles.omniFab,
          pressed && { opacity: 0.9, transform: [{ scale: 0.94 }] },
        ]}
      >
        <Feather name="message-circle" size={24} color={Palette.inkInverse} />
      </Pressable>

      <SchemaEditorModal
        visible={createModalOpen || Boolean(managingLibrary)}
        existingLibrary={managingLibrary}
        onClose={() => {
          setCreateModalOpen(false);
          setManagingLibrary(null);
        }}
        onSaved={(newSlug) => {
          if (!managingLibrary) {
            nav.push(`/library/${newSlug}`);
          }
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Palette.bgCanvas,
  },
  scroll: {
    flex: 1,
  },
  container: {
    width: '100%',
    maxWidth: 880,
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingTop: 4,
    paddingBottom: 96,
    gap: 16,
  },
  warnBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Palette.dangerSoft,
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderRadius: 12,
  },
  warnText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    color: Palette.danger,
    lineHeight: 17,
  },
  keyStatusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Palette.warning,
  },
  keyStatusText: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  newLibBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    height: 36,
    backgroundColor: Palette.brand,
    paddingHorizontal: 14,
    borderRadius: 999,
  },
  newLibBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkInverse,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Palette.bgSurface,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: Palette.inkPrimary,
    paddingVertical: 0,
  },
  searchResultSection: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 8,
  },
  searchHitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Palette.borderHairline,
  },
  searchHitTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: Palette.inkPrimary,
  },
  searchHitMeta: {
    fontSize: 12,
    color: Palette.inkMuted,
    fontWeight: '500',
  },
  recentSection: {
    gap: 8,
  },
  recentLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.inkMuted,
    marginLeft: 2,
  },
  recentStrip: {
    flexDirection: 'row',
    gap: 8,
    paddingRight: 8,
  },
  recentPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    borderRadius: 12,
    paddingHorizontal: 11,
    paddingVertical: 8,
    maxWidth: 210,
  },
  recentEmoji: {
    fontSize: 14,
  },
  recentTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: Palette.inkPrimary,
    flexShrink: 1,
  },
  recentTime: {
    fontSize: 11,
    fontWeight: '600',
    color: Palette.inkMuted,
  },
  libCardTopRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  moreIconBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  latestPreviewWrap: {
    gap: 2,
    minHeight: 34,
    justifyContent: 'center',
  },
  latestPreviewTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  latestPreviewTime: {
    fontSize: 11,
    color: Palette.inkMuted,
  },
  mutedTip: {
    fontSize: 13,
    color: Palette.inkMuted,
  },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  sectionHeading: {
    fontSize: 16,
    fontWeight: '800',
    color: Palette.inkPrimary,
  },
  linkAction: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.brand,
  },
  libGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 12,
  },
  libCard: {
    width: '48.3%',
    backgroundColor: Palette.bgSurface,
    borderRadius: 20,
    padding: 15,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 9,
    shadowColor: '#181A19',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.03,
    shadowRadius: 8,
    elevation: 1,
  },
  libCardPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.985 }],
  },
  libCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  libIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  libEmoji: {
    fontSize: 21,
  },
  countPill: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: Palette.bgSubtle,
  },
  countText: {
    fontSize: 11,
    fontWeight: '700',
    color: Palette.inkSecondary,
  },
  libName: {
    fontSize: 16,
    fontWeight: '700',
    color: Palette.inkPrimary,
    marginTop: 2,
  },
  libDesc: {
    fontSize: 12,
    color: Palette.inkMuted,
    lineHeight: 18,
    minHeight: 36,
  },
  subLibsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 2,
  },
  subLibChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    maxWidth: '100%',
  },
  subLibChipText: {
    fontSize: 11,
    fontWeight: '700',
  },
  addLibCard: {
    width: '48.3%',
    backgroundColor: Palette.bgCanvas,
    borderRadius: 20,
    padding: 15,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: Palette.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 142,
  },
  addLibIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Palette.brandSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  addLibTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  addLibHint: {
    fontSize: 11,
    color: Palette.inkMuted,
  },
  omniFab: {
    position: 'absolute',
    right: 20,
    bottom: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Palette.brand,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0F766E',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.28,
    shadowRadius: 14,
    elevation: 8,
  },
});
