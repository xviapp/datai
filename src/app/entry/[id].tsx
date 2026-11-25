import Feather from '@expo/vector-icons/Feather';
import { useLocalSearchParams } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  DynamicEntryFormModal,
  type LockedRelationContext,
} from '@/components/dynamic-renderer/DynamicEntryFormModal';
import { BacklinkGroupCard } from '@/components/entry-detail/BacklinkGroupCard';
import { ChildTimelineSection } from '@/components/entry-detail/ChildTimelineSection';
import { EntryDetailInfoCard } from '@/components/entry-detail/EntryDetailInfoCard';
import { EntryHeroCard } from '@/components/entry-detail/EntryHeroCard';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { FloatingAssistantButton } from '@/components/ui/FloatingAssistantButton';
import { ImagePreviewModal } from '@/components/ui/ImagePreviewModal';
import { SlidingSegmentedBar } from '@/components/ui/SlidingSegmentedBar';
import { Palette, ToneMap } from '@/constants/design-tokens';
import { useOmniModalActions, useRepository } from '@/context/omni-context';
import type { BacklinkGroupSection, ChildLibrarySection, LibraryRecord } from '@/db/models';
import { useSwipeablePager } from '@/hooks/useSwipeablePager';
import { useSafeNavigation } from '@/utils/navigation';

type DetailTabItem =
  | { key: 'detail'; label: string; icon: 'file-text' }
  | {
      key: `child:${string}`;
      label: string;
      count: number;
      emoji: string;
      section: ChildLibrarySection;
    }
  | { key: 'backlinks'; label: string; count: number; icon: 'link-2' };

export default function EntryDetailScreen() {
  const { id, tab } = useLocalSearchParams<{ id: string; tab?: string }>();
  const nav = useSafeNavigation();
  const insets = useSafeAreaInsets();
  const { repo, revision } = useRepository();
  const { openOmniCapture } = useOmniModalActions();

  const entryIdStr = id ? String(id) : '';
  const requestedTab = tab ? String(tab) : '';
  const routeSignature = `${entryIdStr}::${requestedTab}`;

  const [selectedTabKey, setSelectedTabKey] = useState<string>(() =>
    requestedTab ? requestedTab : 'detail'
  );
  const [prevRouteSignature, setPrevRouteSignature] = useState(routeSignature);
  if (prevRouteSignature !== routeSignature) {
    setPrevRouteSignature(routeSignature);
    setSelectedTabKey(requestedTab ? requestedTab : 'detail');
  }

  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ uri: string; caption?: string } | null>(null);
  const [subModalOpen, setSubModalOpen] = useState(false);
  const [subModalTarget, setSubModalTarget] = useState<{
    childLibrary: LibraryRecord;
    lockedRelation: LockedRelationContext;
    initialData?: Record<string, unknown>;
  } | null>(null);
  const [clearDraftTokens, setClearDraftTokens] = useState<Record<string, number>>({});

  const hydratedBundle = useMemo(
    () => (!repo || revision < 0 || !entryIdStr ? null : repo.getHydratedEntryById(entryIdStr)),
    [repo, revision, entryIdStr]
  );

  const childSections: ChildLibrarySection[] = useMemo(() => {
    if (!repo || revision < 0 || !hydratedBundle) return [];
    return repo.listChildSectionsForEntry(hydratedBundle.entry.id, hydratedBundle.library.slug);
  }, [repo, revision, hydratedBundle]);

  const backlinkGroups: BacklinkGroupSection[] = useMemo(() => {
    if (!repo || revision < 0 || !hydratedBundle) return [];
    const childSlugSet = new Set(childSections.map((s) => s.childLibrary.slug));
    return repo.listBacklinkGroupsForEntry(hydratedBundle.entry.id, childSlugSet);
  }, [repo, revision, hydratedBundle, childSections]);

  const totalBacklinkCount = useMemo(
    () => backlinkGroups.reduce((sum, g) => sum + g.entries.length, 0),
    [backlinkGroups]
  );

  const detailTabs: DetailTabItem[] = useMemo(
    () => [
      { key: 'detail', label: '详情', icon: 'file-text' },
      ...childSections.map(
        (section): DetailTabItem => ({
          key: `child:${section.childLibrary.slug}`,
          label: section.childLibrary.name,
          count: section.entries.length,
          emoji: section.childLibrary.icon,
          section,
        })
      ),
      ...(totalBacklinkCount > 0
        ? ([
            {
              key: 'backlinks',
              label: childSections.length > 0 ? '关联引用' : '关联记录',
              count: totalBacklinkCount,
              icon: 'link-2',
            },
          ] as DetailTabItem[])
        : []),
    ],
    [childSections, totalBacklinkCount]
  );

  const hasMultipleTabs = detailTabs.length > 1;
  const activeTabKey = (() => {
    if (!hasMultipleTabs) return 'detail';
    if (selectedTabKey === 'relations') {
      return detailTabs[1]?.key ?? 'detail';
    }
    if (detailTabs.some((t) => t.key === selectedTabKey)) {
      return selectedTabKey;
    }
    return 'detail';
  })();

  const activeTabIndex = Math.max(
    0,
    detailTabs.findIndex((t) => t.key === activeTabKey)
  );

  const handleTabIndexChange = useCallback(
    (idx: number) => {
      const targetTab = detailTabs[idx];
      if (targetTab) {
        setSelectedTabKey(targetTab.key);
      }
    },
    [detailTabs]
  );

  const {
    pagerRef,
    pagerScrollX,
    effectiveWidth,
    chipsScrollRef,
    selectPage,
    handlePagerLayout,
    handlePagerMomentumEnd,
    handleChipLayout,
    onPagerScroll,
  } = useSwipeablePager({
    pageCount: detailTabs.length,
    activeIndex: activeTabIndex,
    onIndexChange: handleTabIndexChange,
    enabled: hasMultipleTabs,
    syncKey: routeSignature,
  });

  if (!hydratedBundle || !repo) {
    return (
      <View style={[styles.safeArea, { paddingTop: insets.top }]}>
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>该记录不存在或已被删除</Text>
          <Pressable
            onPress={nav.back}
            style={({ pressed }) => [styles.primaryPill, pressed && styles.pressedSoft]}
          >
            <Text style={styles.primaryPillText}>返回上一页</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const { entry, library } = hydratedBundle;

  const activeChildTab = detailTabs.find(
    (t): t is Extract<DetailTabItem, { key: `child:${string}` }> =>
      'section' in t && t.key === activeTabKey
  );

  const tone = ToneMap[library.color] ?? ToneMap.teal;
  const baseFields = library.fields.filter(
    (f) => f.type !== 'relation' && f.type !== 'rollup' && f.type !== 'formula'
  );
  const computedFields = library.fields.filter(
    (f) => f.type === 'rollup' || f.type === 'formula'
  );
  const relationFields = library.fields.filter((f) => f.type === 'relation');

  const handleDelete = () => {
    repo.deleteEntry(entry.id);
    nav.back();
  };

  const handleOpenLockedModal = (
    targetLibrary: LibraryRecord,
    relationFieldKey: string,
    prefill?: Record<string, unknown>
  ) => {
    setSubModalTarget({
      childLibrary: targetLibrary,
      lockedRelation: {
        fieldKey: relationFieldKey,
        targetEntryId: entry.id,
        targetTitle: entry.titleSummary,
        targetLibraryIcon: library.icon,
      },
      initialData: prefill,
    });
    setSubModalOpen(true);
  };

  const entryAiContext = {
    entryId: entry.id,
    title: entry.titleSummary,
    librarySlug: library.slug,
    libraryName: library.name,
    libraryIcon: library.icon,
    activeTab: activeTabKey,
    activeChildSlug: activeChildTab?.section.childLibrary.slug,
    activeChildName: activeChildTab?.section.childLibrary.name,
  };

  const detailInfoNode = (
    <EntryDetailInfoCard
      entry={entry}
      baseFields={baseFields}
      relationFields={relationFields}
      onPreviewImage={(uri, caption) => setPreviewImage({ uri, caption })}
      onOpenEntry={(targetId) => nav.push(`/entry/${targetId}`)}
    />
  );

  return (
    <View style={styles.safeArea}>
      <View style={[styles.topNavOuter, { paddingTop: insets.top }]}>
        <View style={styles.topNav}>
          <Pressable
            onPress={nav.back}
            hitSlop={6}
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pressedScale]}
            accessibilityLabel="返回"
          >
            <Feather name="arrow-left" size={19} color={Palette.inkPrimary} />
          </Pressable>

          <Pressable
            onPress={() => nav.openLibrary(library.slug)}
            style={({ pressed }) => [
              styles.libTagBtn,
              { backgroundColor: tone.soft },
              pressed && styles.pressedScale,
            ]}
          >
            <Text style={[styles.libTagText, { color: tone.ink }]}>
              {library.icon} {library.name}
            </Text>
          </Pressable>

          <View style={{ flex: 1 }} />

          <Pressable
            onPress={() => setEditOpen(true)}
            style={({ pressed }) => [styles.editBtn, pressed && styles.pressedScale]}
          >
            <Feather name="edit-2" size={14} color={Palette.inkPrimary} />
            <Text style={styles.editBtnText}>编辑</Text>
          </Pressable>

          <Pressable
            onPress={() => setConfirmDelete(true)}
            hitSlop={6}
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pressedScale]}
            accessibilityLabel="删除记录"
          >
            <Feather name="trash-2" size={17} color={Palette.danger} />
          </Pressable>
        </View>
      </View>

      {!hasMultipleTabs ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.container, { paddingBottom: 92 + insets.bottom }]}
          keyboardShouldPersistTaps="handled"
        >
          <EntryHeroCard
            entry={entry}
            library={library}
            computedFields={computedFields}
            compact={false}
          />
          {detailInfoNode}
        </ScrollView>
      ) : (
        <>
          <View style={styles.multiTabHeader}>
            <EntryHeroCard
              entry={entry}
              library={library}
              computedFields={computedFields}
              compact
            />

            {detailTabs.length <= 3 ? (
              <SlidingSegmentedBar
                items={detailTabs.map((t) => ({
                  key: t.key,
                  label: `${t.label}${'count' in t ? ` (${t.count})` : ''}`,
                  emoji: 'emoji' in t ? t.emoji : undefined,
                  icon: 'icon' in t ? t.icon : undefined,
                }))}
                activeIndex={activeTabIndex}
                onSelect={selectPage}
                activeColor={tone.solid}
                scrollX={pagerScrollX}
                pageWidth={effectiveWidth}
              />
            ) : (
              <ScrollView
                ref={chipsScrollRef}
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.detailTabsScroll}
                contentContainerStyle={styles.detailTabsScrollContent}
              >
                {detailTabs.map((t, idx) => {
                  const active = idx === activeTabIndex;
                  return (
                    <Pressable
                      key={t.key}
                      onLayout={handleChipLayout(idx)}
                      onPress={() => selectPage(idx)}
                      style={({ pressed }) => [
                        styles.detailTabScrollPill,
                        active && { backgroundColor: tone.solid },
                        pressed && !active && styles.pressedSoft,
                      ]}
                    >
                      {'emoji' in t ? (
                        <Text style={styles.detailTabEmoji}>{t.emoji}</Text>
                      ) : (
                        <Feather
                          name={t.icon}
                          size={13}
                          color={active ? Palette.inkInverse : Palette.inkSecondary}
                        />
                      )}
                      <Text
                        style={[
                          styles.detailTabText,
                          active && { color: Palette.inkInverse },
                        ]}
                      >
                        {t.label}
                        {'count' in t ? ` (${t.count})` : ''}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
          </View>

          <Animated.ScrollView
            ref={pagerRef}
            horizontal
            pagingEnabled
            nestedScrollEnabled
            showsHorizontalScrollIndicator={false}
            scrollEventThrottle={16}
            onLayout={handlePagerLayout}
            onScroll={onPagerScroll}
            onMomentumScrollEnd={handlePagerMomentumEnd}
            style={styles.scroll}
          >
            {detailTabs.map((t) => (
              <ScrollView
                key={t.key}
                nestedScrollEnabled
                keyboardShouldPersistTaps="handled"
                style={{ width: effectiveWidth }}
                contentContainerStyle={[
                  styles.pagerPageContent,
                  { paddingBottom: 92 + insets.bottom },
                ]}
              >
                {t.key === 'detail' ? detailInfoNode : null}
                {'section' in t ? (
                  <ChildTimelineSection
                    parentEntryId={entry.id}
                    section={t.section}
                    clearDraftToken={clearDraftTokens[t.section.childLibrary.slug] ?? 0}
                    onOpenLibrary={nav.openLibrary}
                    onOpenEntry={(targetId) => nav.push(`/entry/${targetId}`)}
                    onOpenFullModal={handleOpenLockedModal}
                    onPreviewImage={(uri, caption) => setPreviewImage({ uri, caption })}
                  />
                ) : null}
                {t.key === 'backlinks'
                  ? backlinkGroups.map((group) => (
                      <BacklinkGroupCard
                        key={`${group.sourceLibrary.slug}::${group.relationFieldKey}`}
                        group={group}
                        onOpenLibrary={nav.openLibrary}
                        onOpenEntry={(targetId) => nav.push(`/entry/${targetId}`)}
                        onAddLinkedEntry={(srcLib, relKey) =>
                          handleOpenLockedModal(srcLib, relKey)
                        }
                      />
                    ))
                  : null}
              </ScrollView>
            ))}
          </Animated.ScrollView>
        </>
      )}

      <FloatingAssistantButton
        accessibilityLabel="针对当前记录使用随行助理"
        backgroundColor={tone.solid}
        bottomOffset={Math.max(insets.bottom, 16) + 8}
        onPress={() => openOmniCapture(library.slug, 'text', entryAiContext, 'entry')}
        onLongPress={() => openOmniCapture(library.slug, 'voice', entryAiContext, 'entry')}
      />

      <DynamicEntryFormModal
        visible={editOpen}
        library={library}
        initialData={entry.rawData}
        editingEntryId={entry.id}
        onClose={() => setEditOpen(false)}
      />

      {subModalTarget ? (
        <DynamicEntryFormModal
          visible={subModalOpen}
          library={subModalTarget.childLibrary}
          initialData={subModalTarget.initialData}
          lockedRelation={subModalTarget.lockedRelation}
          onClose={() => setSubModalOpen(false)}
          onSaved={() => {
            const targetSlug = subModalTarget.childLibrary.slug;
            setClearDraftTokens((prev) => ({ ...prev, [targetSlug]: (prev[targetSlug] ?? 0) + 1 }));
          }}
        />
      ) : null}

      <ConfirmDialog
        visible={confirmDelete}
        title="删除这条记录？"
        summary={`「${entry.titleSummary}」`}
        description={
          entry.backlinks.length > 0
            ? `删除后将保留 ${entry.backlinks.length} 条关联记录，并可从设置页操作记录中撤销。`
            : '删除后仍可从设置页「最近操作记录」中撤销恢复。'
        }
        confirmLabel="确认删除"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          handleDelete();
        }}
      />

      <ImagePreviewModal
        uri={previewImage?.uri ?? null}
        caption={previewImage?.caption}
        onClose={() => setPreviewImage(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Palette.bgCanvas,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  primaryPill: {
    backgroundColor: Palette.brand,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
  },
  primaryPillText: {
    color: Palette.inkInverse,
    fontWeight: '700',
  },
  topNavOuter: {
    width: '100%',
    backgroundColor: Palette.bgSurface,
    borderBottomWidth: 1,
    borderBottomColor: Palette.borderHairline,
  },
  topNav: {
    width: '100%',
    maxWidth: 820,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  pressedScale: {
    opacity: 0.78,
    transform: [{ scale: 0.95 }],
  },
  pressedSoft: {
    opacity: 0.72,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Palette.bgSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  libTagBtn: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
  },
  libTagText: {
    fontSize: 12,
    fontWeight: '700',
  },
  editBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: Palette.bgSubtle,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  editBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  scroll: {
    flex: 1,
  },
  container: {
    width: '100%',
    maxWidth: 820,
    alignSelf: 'center',
    padding: 16,
    gap: 14,
  },
  multiTabHeader: {
    width: '100%',
    maxWidth: 820,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 10,
  },
  pagerPageContent: {
    width: '100%',
    maxWidth: 820,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingTop: 6,
    gap: 14,
  },
  detailTabsScroll: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  detailTabsScrollContent: {
    flexDirection: 'row',
    padding: 4,
    gap: 4,
  },
  detailTabScrollPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  detailTabEmoji: {
    fontSize: 13,
  },
  detailTabText: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkSecondary,
  },
});
