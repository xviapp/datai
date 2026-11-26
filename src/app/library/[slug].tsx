import Feather from '@expo/vector-icons/Feather';
import { useLocalSearchParams } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import {
  Animated,
  FlatList,
  LayoutAnimation,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SqlWidgetCard } from '@/components/charts/SqlWidgetCard';
import { DynamicEntryFormModal } from '@/components/dynamic-renderer/DynamicEntryFormModal';
import {
  DynamicCalendarView,
  DynamicCardEmptyState,
  DynamicEntryCard,
  DynamicGalleryView,
} from '@/components/dynamic-renderer/DynamicViews';
import { SchemaEditorModal } from '@/components/dynamic-renderer/SchemaEditorModal';
import { ContentTransitionView } from '@/components/ui/ContentTransitionView';
import { FloatingAssistantButton } from '@/components/ui/FloatingAssistantButton';
import {
  type SegmentedTabOption,
  SlidingSegmentedBar,
} from '@/components/ui/SlidingSegmentedBar';
import { Palette, ToneMap } from '@/constants/design-tokens';
import { VIEW_TYPE_META } from '@/constants/schema-meta';
import { useOmniModalActions, useRepository, useWidgetRevision } from '@/context/omni-context';
import type { HydratedEntry, LibraryViewRecord } from '@/db/models';
import {
  filterAndSortLibraryEntries,
  type LibrarySortModeId,
} from '@/engine/library-view-rules';
import { useSwipeablePager } from '@/hooks/useSwipeablePager';
import type {
  CalendarViewConfig,
  CardViewConfig,
  GalleryViewConfig,
} from '@/schema/view-dsl';
import { useSafeNavigation } from '@/utils/navigation';

function CardSeparator() {
  return <View style={{ height: 10 }} />;
}

function LibraryStatsTabPage({
  librarySlug,
  tone,
  shouldLoad,
  paused,
  bottomInset,
  pageStyle,
  onOpenCustomize,
}: {
  librarySlug: string;
  tone: (typeof ToneMap)['teal'];
  shouldLoad: boolean;
  paused: boolean;
  bottomInset: number;
  pageStyle: { width: number } | typeof styles.singlePage;
  onOpenCustomize: () => void;
}) {
  const { repo } = useRepository();
  const widgetRevision = useWidgetRevision();

  const designedStatsWidgets = useMemo(
    () =>
      !repo || widgetRevision < 0 || !shouldLoad
        ? []
        : repo.listWidgetsForLibrary(librarySlug),
    [repo, widgetRevision, librarySlug, shouldLoad]
  );

  return (
    <ScrollView
      nestedScrollEnabled
      keyboardShouldPersistTaps="handled"
      style={pageStyle}
      contentContainerStyle={[styles.pageContent, { paddingBottom: 88 + bottomInset }]}
    >
      {designedStatsWidgets.length === 0 ? (
        <View style={styles.emptyStatsCard}>
          <View style={[styles.emptyStatsIcon, { backgroundColor: tone.soft }]}>
            <Feather name="bar-chart-2" size={20} color={tone.solid} />
          </View>
          <Text style={styles.emptyStatsDesc}>
            告诉助手你想看的指标或图表，生成后展示在这里
          </Text>
          <Pressable
            onPress={onOpenCustomize}
            style={({ pressed }) => [
              styles.emptyStatsBtn,
              { backgroundColor: tone.solid },
              pressed && styles.pressedScale,
            ]}
          >
            <Text style={styles.emptyStatsBtnText}>去定制统计</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.statsWrap}>
          {designedStatsWidgets.some((w) => w.chartType === 'kpi_number') ? (
            <View style={styles.kpiRow}>
              {designedStatsWidgets
                .filter((w) => w.chartType === 'kpi_number')
                .map((w) => (
                  <SqlWidgetCard
                    key={w.id}
                    widget={w}
                    compact
                    paused={paused}
                    pinnedOverview={w.pinnedOverview}
                    onToggleOverview={(id, next) => repo?.setWidgetPinnedOverview(id, next)}
                    onDelete={(id) => repo?.deleteDashboardWidget(id)}
                  />
                ))}
            </View>
          ) : null}
          {designedStatsWidgets
            .filter((w) => w.chartType !== 'kpi_number')
            .map((w) => (
              <SqlWidgetCard
                key={w.id}
                widget={w}
                paused={paused}
                pinnedOverview={w.pinnedOverview}
                onToggleOverview={(id, next) => repo?.setWidgetPinnedOverview(id, next)}
                onDelete={(id) => repo?.deleteDashboardWidget(id)}
              />
            ))}
        </View>
      )}
    </ScrollView>
  );
}

export default function LibraryWorkspaceScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const nav = useSafeNavigation();
  const insets = useSafeAreaInsets();
  const { repo, revision } = useRepository();
  const { openOmniCapture } = useOmniModalActions();

  const slugStr = slug ? String(slug) : '';
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [selectedFilterVal, setSelectedFilterVal] = useState<string>('');
  const [sortMode, setSortMode] = useState<LibrarySortModeId>('view_default');
  const [entryModalOpen, setEntryModalOpen] = useState(false);
  const [schemaModalOpen, setSchemaModalOpen] = useState(false);
  const [createSubForParent, setCreateSubForParent] = useState<string | null>(null);

  const library = useMemo(
    () => (!repo || revision < 0 || !slugStr ? null : repo.getLibraryBySlug(slugStr)),
    [repo, revision, slugStr]
  );

  const fieldMap = useMemo(
    () => new Map((library?.fields ?? []).map((f) => [f.key, f])),
    [library]
  );

  // 直接由独立 library_views 表驱动本记录本按需展现的视图列表
  const activeViews: LibraryViewRecord[] = useMemo(() => library?.viewList ?? [], [library]);

  const safeTabIndex = Math.min(activeTabIndex, Math.max(0, activeViews.length - 1));
  const currentView = activeViews[safeTabIndex];
  const hasMultipleViews = activeViews.length > 1;
  const statsViewIdx = activeViews.findIndex((v) => v.viewType === 'stats');

  const {
    pagerRef,
    pagerScrollX,
    effectiveWidth,
    selectPage,
    jumpToPage,
    handlePagerLayout,
    handlePagerMomentumEnd,
    onPagerScroll,
  } = useSwipeablePager({
    pageCount: activeViews.length,
    activeIndex: safeTabIndex,
    onIndexChange: setActiveTabIndex,
    enabled: hasMultipleViews,
  });

  const segmentedItems: SegmentedTabOption[] = useMemo(
    () =>
      activeViews.map((v) => ({
        key: v.id,
        label: v.name,
        icon: VIEW_TYPE_META[v.viewType]?.icon ?? 'list',
      })),
    [activeViews]
  );

  const rawEntries = useMemo(
    () =>
      !repo || revision < 0 || !library
        ? []
        : repo.listHydratedEntries(library.slug, searchText),
    [repo, revision, library, searchText]
  );

  const activeCardConfig = useMemo(
    () =>
      currentView?.viewType === 'card'
        ? (currentView.config as Partial<CardViewConfig>)
        : undefined,
    [currentView]
  );

  const {
    entries,
    primaryFilterField,
    sortOptions: availableSortModes,
    activeSort: activeSortInfo,
  } = useMemo(() => {
    if (!library) {
      return {
        entries: [] as HydratedEntry[],
        primaryFilterField: null,
        sortOptions: [],
        activeSort: {
          id: 'updated_desc' as LibrarySortModeId,
          label: '最新更新',
          direction: 'desc' as const,
          isDefault: true,
        },
      };
    }
    return filterAndSortLibraryEntries({
      entries: rawEntries,
      library,
      cardConfig: activeCardConfig,
      selectedFilterValue: selectedFilterVal,
      sortMode,
    });
  }, [rawEntries, library, activeCardConfig, selectedFilterVal, sortMode]);

  const rootParent = useMemo(
    () =>
      !repo || revision < 0 || !library
        ? null
        : library.parentLibrarySlug
          ? repo.getLibraryBySlug(library.parentLibrarySlug)
          : library,
    [repo, revision, library]
  );

  const childLibraries = useMemo(
    () => (!repo || revision < 0 || !rootParent ? [] : repo.listChildLibraries(rootParent.slug)),
    [repo, revision, rootParent]
  );

  const familyLibraries = useMemo(
    () => (rootParent && childLibraries.length > 0 ? [rootParent, ...childLibraries] : []),
    [rootParent, childLibraries]
  );

  const shouldLoadStats = statsViewIdx >= 0 && Math.abs(safeTabIndex - statsViewIdx) <= 1;

  const handleSwitchFamilyLibrary = useCallback(
    (targetSlug: string) => {
      setSearchText('');
      setSearchOpen(false);
      setSelectedFilterVal('');
      setSortMode('view_default');
      setActiveTabIndex(0);
      jumpToPage(0);
      nav.setParams({ slug: targetSlug });
    },
    [nav, jumpToPage]
  );

  const toggleSearch = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    if (searchOpen && searchText) {
      setSearchText('');
    }
    setSearchOpen((v) => !v);
  };

  const cycleSortMode = () => {
    const idx = availableSortModes.findIndex((m) => m.id === activeSortInfo.id);
    const next = availableSortModes[(idx + 1) % availableSortModes.length];
    if (next) setSortMode(next.id);
  };

  if (!library) {
    return (
      <View style={[styles.safeArea, { paddingTop: insets.top }]}>
        <View style={styles.notFoundBox}>
          <Text style={styles.notFoundTitle}>找不到该数据表</Text>
          <Pressable
            onPress={() => nav.replace('/(tabs)')}
            style={({ pressed }) => [styles.backHomeBtn, pressed && styles.pressedSoft]}
          >
            <Text style={styles.backHomeText}>返回首页</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const tone = ToneMap[library.color] ?? ToneMap.teal;
  const showFilterSortBar =
    Boolean(primaryFilterField?.options?.length) || rawEntries.length > 1;
  const isCurrentStats = currentView?.viewType === 'stats';

  const renderFilterSortBar = () => {
    if (!showFilterSortBar) return null;
    return (
      <View style={styles.filterSortRow}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterChipsScroll}
          style={{ flex: 1 }}
        >
          {primaryFilterField?.options?.length ? (
            <>
              <Pressable
                onPress={() => setSelectedFilterVal('')}
                style={({ pressed }) => [
                  styles.filterChip,
                  !selectedFilterVal && { backgroundColor: tone.soft, borderColor: tone.solid },
                  pressed && styles.pressedSoft,
                ]}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    !selectedFilterVal && { color: tone.ink, fontWeight: '700' },
                  ]}
                >
                  全部 ({rawEntries.length})
                </Text>
              </Pressable>
              {primaryFilterField.options.map((opt) => {
                const active = selectedFilterVal === opt.value;
                return (
                  <Pressable
                    key={opt.value}
                    onPress={() => setSelectedFilterVal(active ? '' : opt.value)}
                    style={({ pressed }) => [
                      styles.filterChip,
                      active && { backgroundColor: tone.soft, borderColor: tone.solid },
                      pressed && styles.pressedSoft,
                    ]}
                  >
                    <Text
                      style={[
                        styles.filterChipText,
                        active && { color: tone.ink, fontWeight: '700' },
                      ]}
                    >
                      {opt.value}
                    </Text>
                  </Pressable>
                );
              })}
            </>
          ) : (
            <Text style={styles.filterCountHint}>共 {entries.length} 条记录</Text>
          )}
        </ScrollView>

        {availableSortModes.length > 1 ? (
          <Pressable
            onPress={cycleSortMode}
            style={({ pressed }) => [
              styles.sortPillBtn,
              !activeSortInfo.isDefault && {
                borderColor: tone.solid,
                backgroundColor: tone.soft,
              },
              pressed && styles.pressedScale,
            ]}
          >
            <Feather
              name={activeSortInfo.direction === 'asc' ? 'arrow-up' : 'arrow-down'}
              size={12}
              color={!activeSortInfo.isDefault ? tone.ink : Palette.inkSecondary}
            />
            <Text
              numberOfLines={1}
              style={[
                styles.sortPillText,
                !activeSortInfo.isDefault && { color: tone.ink },
              ]}
            >
              {activeSortInfo.label}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  };

  const renderViewPage = (view: LibraryViewRecord, viewIndex: number, fullWidth?: number) => {
    const pageStyle = fullWidth ? { width: fullWidth } : styles.singlePage;

    if (view.viewType === 'card') {
      const cardCfg = view.config as Partial<CardViewConfig>;
      return (
        <FlatList<HydratedEntry>
          key={view.id}
          data={entries}
          keyExtractor={(item) => item.id}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          initialNumToRender={12}
          maxToRenderPerBatch={10}
          windowSize={7}
          style={pageStyle}
          contentContainerStyle={[styles.pageContent, { paddingBottom: 88 + insets.bottom }]}
          ItemSeparatorComponent={CardSeparator}
          ListHeaderComponent={renderFilterSortBar}
          ListHeaderComponentStyle={showFilterSortBar ? { marginBottom: 8 } : undefined}
          ListEmptyComponent={DynamicCardEmptyState}
          renderItem={({ item }) => (
            <DynamicEntryCard
              library={library}
              entry={item}
              fieldMap={fieldMap}
              cardConfig={cardCfg}
              onSelectEntry={(id) => nav.push(`/entry/${id}`)}
              onSelectEntryRelations={(id) =>
                nav.push({ pathname: '/entry/[id]', params: { id, tab: 'relations' } })
              }
            />
          )}
        />
      );
    }

    if (view.viewType === 'gallery') {
      const galleryCfg = view.config as Partial<GalleryViewConfig>;
      return (
        <ScrollView
          key={view.id}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          style={pageStyle}
          contentContainerStyle={[styles.pageContent, { paddingBottom: 88 + insets.bottom }]}
        >
          {renderFilterSortBar()}
          <DynamicGalleryView
            library={library}
            entries={entries}
            galleryConfig={galleryCfg}
            onSelectEntry={(id) => nav.push(`/entry/${id}`)}
          />
        </ScrollView>
      );
    }

    if (view.viewType === 'calendar') {
      const calendarCfg = view.config as Partial<CalendarViewConfig>;
      return (
        <ScrollView
          key={view.id}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          style={pageStyle}
          contentContainerStyle={[styles.pageContent, { paddingBottom: 88 + insets.bottom }]}
        >
          <DynamicCalendarView
            library={library}
            entries={entries}
            calendarConfig={calendarCfg}
            onSelectEntry={(id) => nav.push(`/entry/${id}`)}
          />
        </ScrollView>
      );
    }

    return (
      <LibraryStatsTabPage
        key={view.id}
        librarySlug={library.slug}
        tone={tone}
        shouldLoad={shouldLoadStats}
        paused={safeTabIndex !== viewIndex}
        bottomInset={insets.bottom}
        pageStyle={pageStyle}
        onOpenCustomize={() => openOmniCapture(library.slug, 'text', undefined, 'stats')}
      />
    );
  };

  return (
    <View style={styles.safeArea}>
      <View style={[styles.topNavOuter, { paddingTop: insets.top }]}>
        <View style={styles.topNav}>
          <Pressable
            onPress={nav.back}
            hitSlop={6}
            style={({ pressed }) => [styles.iconCircle, pressed && styles.pressedScale]}
            accessibilityLabel="返回"
          >
            <Feather name="arrow-left" size={19} color={Palette.inkPrimary} />
          </Pressable>

          <View style={styles.titleCenter}>
            <Text style={styles.navTitle} numberOfLines={1}>
              {library.icon} {library.name}
            </Text>
            <Text style={styles.navMeta}>
              {library.parentLibrarySlug && rootParent
                ? `${rootParent.name} · 附属记录 (${entries.length} 条)`
                : `${entries.length} 条记录`}
            </Text>
          </View>

          <Pressable
            onPress={toggleSearch}
            hitSlop={6}
            style={({ pressed }) => [
              styles.iconCircle,
              (searchOpen || Boolean(searchText)) && { backgroundColor: tone.soft },
              pressed && styles.pressedScale,
            ]}
            accessibilityLabel="搜索本记录本"
          >
            <Feather
              name="search"
              size={17}
              color={searchOpen || searchText ? tone.solid : Palette.inkPrimary}
            />
            {searchText && !searchOpen ? (
              <View style={[styles.searchActiveDot, { backgroundColor: tone.solid }]} />
            ) : null}
          </Pressable>

          <Pressable
            onPress={() => setSchemaModalOpen(true)}
            hitSlop={6}
            style={({ pressed }) => [styles.iconCircle, pressed && styles.pressedScale]}
            accessibilityLabel="管理记录本"
          >
            <Feather name="sliders" size={17} color={Palette.inkPrimary} />
          </Pressable>

          <Pressable
            onPress={() => setEntryModalOpen(true)}
            style={({ pressed }) => [
              styles.addBtn,
              { backgroundColor: tone.solid },
              pressed && styles.pressedScale,
            ]}
          >
            <Feather name="plus" size={16} color={Palette.inkInverse} />
            <Text style={styles.addBtnText}>记一条</Text>
          </Pressable>
        </View>

        {searchOpen ? (
          <View style={styles.topSearchWrap}>
            <View style={styles.searchBox}>
              <Feather name="search" size={15} color={Palette.inkMuted} />
              <TextInput
                value={searchText}
                onChangeText={setSearchText}
                autoFocus
                placeholder={`在「${library.name}」中搜索...`}
                placeholderTextColor={Palette.inkMuted}
                style={styles.searchInput}
              />
              {searchText ? (
                <Pressable hitSlop={8} onPress={() => setSearchText('')}>
                  <Feather name="x-circle" size={16} color={Palette.inkMuted} />
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : null}
      </View>

      {familyLibraries.length > 1 || hasMultipleViews ? (
        <View style={styles.stickyControls}>
          {familyLibraries.length > 1 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.familyBar}
            >
              {familyLibraries.map((item, idx) => {
                const active = item.slug === library.slug;
                const itemTone = ToneMap[item.color] ?? ToneMap.teal;
                return (
                  <Pressable
                    key={item.id}
                    onPress={() => {
                      if (!active) {
                        handleSwitchFamilyLibrary(item.slug);
                      }
                    }}
                    style={({ pressed }) => [
                      styles.familyChip,
                      active && {
                        backgroundColor: itemTone.soft,
                        borderColor: itemTone.solid,
                      },
                      pressed && !active && styles.pressedSoft,
                    ]}
                  >
                    <Text
                      style={[
                        styles.familyChipText,
                        active && { color: itemTone.ink, fontWeight: '800' },
                      ]}
                    >
                      {idx > 0 ? '↳ ' : ''}
                      {item.icon} {item.name} · {item.entryCount}
                    </Text>
                  </Pressable>
                );
              })}
              {rootParent ? (
                <Pressable
                  onPress={() => setCreateSubForParent(rootParent.slug)}
                  style={({ pressed }) => [styles.familyAddChip, pressed && styles.pressedSoft]}
                >
                  <Feather name="plus" size={13} color={Palette.inkSecondary} />
                  <Text style={styles.familyAddText}>附属表</Text>
                </Pressable>
              ) : null}
            </ScrollView>
          ) : null}

          {hasMultipleViews ? (
            <SlidingSegmentedBar
              items={segmentedItems}
              activeIndex={safeTabIndex}
              onSelect={selectPage}
              activeColor={tone.solid}
              scrollX={pagerScrollX}
              pageWidth={effectiveWidth}
            />
          ) : null}
        </View>
      ) : null}

      <ContentTransitionView transitionKey={library.slug} style={styles.pagerWrap}>
        {hasMultipleViews ? (
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
            style={styles.pager}
          >
            {activeViews.map((view, idx) => renderViewPage(view, idx, effectiveWidth))}
          </Animated.ScrollView>
        ) : currentView ? (
          renderViewPage(currentView, 0)
        ) : null}
      </ContentTransitionView>

      <FloatingAssistantButton
        accessibilityLabel={isCurrentStats ? '针对本库问数据或定制图表' : '本库随手说与智能助手'}
        icon={isCurrentStats ? 'bar-chart-2' : 'message-circle'}
        iconSize={isCurrentStats ? 23 : 24}
        backgroundColor={tone.solid}
        bottomOffset={Math.max(insets.bottom, 16) + 8}
        onPress={() =>
          openOmniCapture(library.slug, 'text', undefined, isCurrentStats ? 'stats' : 'library')
        }
        onLongPress={() =>
          openOmniCapture(library.slug, 'voice', undefined, isCurrentStats ? 'stats' : 'library')
        }
      />

      <DynamicEntryFormModal
        visible={entryModalOpen}
        library={library}
        onClose={() => setEntryModalOpen(false)}
      />

      <SchemaEditorModal
        visible={schemaModalOpen || Boolean(createSubForParent)}
        existingLibrary={createSubForParent ? null : library}
        defaultParentSlug={createSubForParent}
        onCreateSubLibrary={(parentSlug) => {
          setSchemaModalOpen(false);
          setTimeout(() => setCreateSubForParent(parentSlug), 210);
        }}
        onClose={() => {
          setSchemaModalOpen(false);
          setCreateSubForParent(null);
        }}
        onSaved={(savedSlug) => {
          if (createSubForParent) {
            setCreateSubForParent(null);
            handleSwitchFamilyLibrary(savedSlug);
          }
        }}
        onDeleted={() => {
          if (library.parentLibrarySlug) {
            handleSwitchFamilyLibrary(library.parentLibrarySlug);
          } else {
            nav.replace('/(tabs)');
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
  topNavOuter: {
    width: '100%',
    backgroundColor: Palette.bgSurface,
    borderBottomWidth: 1,
    borderBottomColor: Palette.borderHairline,
  },
  topNav: {
    width: '100%',
    maxWidth: 880,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  topSearchWrap: {
    width: '100%',
    maxWidth: 880,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  searchActiveDot: {
    position: 'absolute',
    top: 7,
    right: 7,
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  stickyControls: {
    width: '100%',
    maxWidth: 880,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 6,
    gap: 8,
  },
  pagerWrap: {
    flex: 1,
  },
  pager: {
    flex: 1,
  },
  singlePage: {
    flex: 1,
  },
  pageContent: {
    width: '100%',
    maxWidth: 880,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  filterSortRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  filterChipsScroll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  filterChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  filterCountHint: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkMuted,
  },
  sortPillBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    flexShrink: 0,
  },
  sortPillText: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.inkSecondary,
    maxWidth: 86,
  },
  pressedScale: {
    opacity: 0.78,
    transform: [{ scale: 0.95 }],
  },
  pressedSoft: {
    opacity: 0.72,
  },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Palette.bgSubtle,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  titleCenter: {
    flex: 1,
  },
  navTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: Palette.inkPrimary,
  },
  navMeta: {
    fontSize: 11,
    color: Palette.inkMuted,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 999,
  },
  addBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkInverse,
  },
  familyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 2,
  },
  familyChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  familyChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  familyAddChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: Palette.borderStrong,
  },
  familyAddText: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Palette.bgCanvas,
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: Palette.inkPrimary,
    paddingVertical: 0,
  },
  statsWrap: {
    gap: 12,
  },
  emptyStatsCard: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 18,
    padding: 26,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    alignItems: 'center',
    gap: 10,
  },
  emptyStatsIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyStatsDesc: {
    fontSize: 13,
    color: Palette.inkMuted,
    textAlign: 'center',
    lineHeight: 19,
  },
  emptyStatsBtn: {
    marginTop: 4,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
  },
  emptyStatsBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkInverse,
  },
  kpiRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 10,
  },
  notFoundBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  notFoundTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  backHomeBtn: {
    backgroundColor: Palette.brand,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
  },
  backHomeText: {
    color: Palette.inkInverse,
    fontWeight: '700',
  },
});
