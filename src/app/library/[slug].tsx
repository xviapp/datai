import Feather from '@expo/vector-icons/Feather';
import { useLocalSearchParams } from 'expo-router';
import React, { type ComponentRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  LayoutAnimation,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SqlWidgetCard } from '@/components/charts/SqlWidgetCard';
import { DynamicEntryFormModal } from '@/components/dynamic-renderer/DynamicEntryFormModal';
import {
  DynamicCalendarView,
  DynamicCardListView,
  DynamicGalleryView,
} from '@/components/dynamic-renderer/DynamicViews';
import { SchemaEditorModal } from '@/components/dynamic-renderer/SchemaEditorModal';
import { ContentTransitionView } from '@/components/ui/ContentTransitionView';
import {
  type SegmentedTabOption,
  SlidingSegmentedBar,
} from '@/components/ui/SlidingSegmentedBar';
import { Palette, ToneMap } from '@/constants/design-tokens';
import { useOmni } from '@/context/omni-context';
import type { HydratedEntry } from '@/db/repository';
import { useSafeNavigation } from '@/utils/navigation';

type ViewTab = 'card' | 'gallery' | 'calendar' | 'stats';
type SortMode = 'updated' | 'date_desc' | 'metric_desc' | 'title_asc';

const VIEW_TABS: Array<SegmentedTabOption & { key: ViewTab }> = [
  { key: 'card', label: '列表', icon: 'list' },
  { key: 'gallery', label: '画廊', icon: 'grid' },
  { key: 'calendar', label: '日历', icon: 'calendar' },
  { key: 'stats', label: '统计', icon: 'pie-chart' },
];

export default function LibraryWorkspaceScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const nav = useSafeNavigation();
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const { repo, revision, openOmniCapture } = useOmni();

  const slugStr = slug ? String(slug) : '';
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [pagerWidth, setPagerWidth] = useState(screenWidth);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [selectedFilterVal, setSelectedFilterVal] = useState<string>('');
  const [sortMode, setSortMode] = useState<SortMode>('updated');
  const [entryModalOpen, setEntryModalOpen] = useState(false);
  const [schemaModalOpen, setSchemaModalOpen] = useState(false);
  const [createSubForParent, setCreateSubForParent] = useState<string | null>(null);

  const [pagerScrollX] = useState(() => new Animated.Value(0));
  const pagerRef = useRef<ComponentRef<typeof Animated.ScrollView>>(null);
  const programmaticScrollRef = useRef(false);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeTab: ViewTab = VIEW_TABS[activeTabIndex]?.key ?? 'card';
  const effectiveWidth = pagerWidth > 0 ? pagerWidth : screenWidth;

  const library = useMemo(
    () => (!repo || revision < 0 || !slugStr ? null : repo.getLibraryBySlug(slugStr)),
    [repo, revision, slugStr]
  );

  const rawEntries = useMemo(
    () =>
      !repo || revision < 0 || !library
        ? []
        : repo.listHydratedEntries(library.slug, searchText),
    [repo, revision, library, searchText]
  );

  // 自动提取该库主筛选单选字段与默认排序依据字段
  const primaryFilterField = useMemo(() => {
    if (!library) return null;
    const badgeKey = library.views.card.rightBadgeFieldKey;
    const badgeSelect = badgeKey
      ? library.fields.find((f) => f.key === badgeKey && f.type === 'select' && f.options?.length)
      : undefined;
    return (
      badgeSelect ??
      library.fields.find((f) => f.type === 'select' && f.options && f.options.length > 0) ??
      null
    );
  }, [library]);

  const primaryDateField = useMemo(
    () => library?.fields.find((f) => f.type === 'date') ?? null,
    [library]
  );

  const primaryMetricField = useMemo(
    () =>
      library?.fields.find(
        (f) => f.type === 'currency' || f.type === 'number' || f.type === 'rating' || f.type === 'formula'
      ) ?? null,
    [library]
  );

  const availableSortModes = useMemo(() => {
    const list: Array<{ id: SortMode; label: string }> = [{ id: 'updated', label: '最新更新' }];
    if (primaryDateField) list.push({ id: 'date_desc', label: `按${primaryDateField.label}` });
    if (primaryMetricField) list.push({ id: 'metric_desc', label: `按${primaryMetricField.label}` });
    list.push({ id: 'title_asc', label: '按标题' });
    return list;
  }, [primaryDateField, primaryMetricField]);

  const activeSortInfo =
    availableSortModes.find((m) => m.id === sortMode) ?? availableSortModes[0];

  const entries = useMemo(() => {
    let list = rawEntries;
    if (primaryFilterField && selectedFilterVal) {
      list = list.filter(
        (e) => String(e.computedData[primaryFilterField.key] ?? '') === selectedFilterVal
      );
    }
    if (activeSortInfo.id === 'updated') return list;

    const copy = [...list];
    if (activeSortInfo.id === 'date_desc' && primaryDateField) {
      copy.sort((a, b) =>
        String(b.computedData[primaryDateField.key] ?? '').localeCompare(
          String(a.computedData[primaryDateField.key] ?? '')
        )
      );
    } else if (activeSortInfo.id === 'metric_desc' && primaryMetricField) {
      copy.sort(
        (a, b) =>
          (Number(b.computedData[primaryMetricField.key]) || 0) -
          (Number(a.computedData[primaryMetricField.key]) || 0)
      );
    } else if (activeSortInfo.id === 'title_asc') {
      copy.sort((a, b) => a.titleSummary.localeCompare(b.titleSummary, 'zh-CN'));
    }
    return copy;
  }, [rawEntries, primaryFilterField, selectedFilterVal, activeSortInfo.id, primaryDateField, primaryMetricField]);

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

  // 滑到日历或统计页时再按需查询该库统计图表，保证进入列表页首帧丝滑
  const designedStatsWidgets = useMemo(
    () =>
      !repo || revision < 0 || !library || activeTabIndex < 2
        ? []
        : repo.listWidgetsForLibrary(library.slug),
    [repo, revision, library, activeTabIndex]
  );

  useEffect(() => {
    const listenerId = pagerScrollX.addListener(({ value }) => {
      if (programmaticScrollRef.current) return;
      const nextIdx = Math.max(
        0,
        Math.min(VIEW_TABS.length - 1, Math.round(value / Math.max(1, effectiveWidth)))
      );
      setActiveTabIndex((prev) => (prev === nextIdx ? prev : nextIdx));
    });
    return () => {
      pagerScrollX.removeListener(listenerId);
    };
  }, [pagerScrollX, effectiveWidth]);

  useEffect(() => {
    return () => {
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    };
  }, []);

  const handleSelectViewTab = useCallback(
    (idx: number) => {
      programmaticScrollRef.current = true;
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = setTimeout(() => {
        programmaticScrollRef.current = false;
      }, 380);
      setActiveTabIndex(idx);
      pagerRef.current?.scrollTo({ x: idx * effectiveWidth, animated: true });
    },
    [effectiveWidth]
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
        Math.min(VIEW_TABS.length - 1, Math.round(offsetX / Math.max(1, effectiveWidth)))
      );
      setActiveTabIndex(nextIdx);
    },
    [effectiveWidth]
  );

  const handleSwitchFamilyLibrary = useCallback(
    (targetSlug: string) => {
      setSearchText('');
      setSearchOpen(false);
      setSelectedFilterVal('');
      setSortMode('updated');
      setActiveTabIndex(0);
      programmaticScrollRef.current = false;
      pagerScrollX.setValue(0);
      pagerRef.current?.scrollTo({ x: 0, animated: false });
      nav.setParams({ slug: targetSlug });
    },
    [nav, pagerScrollX]
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

  const onPagerScroll = useMemo(
    () =>
      Animated.event([{ nativeEvent: { contentOffset: { x: pagerScrollX } } }], {
        useNativeDriver: true,
      }),
    [pagerScrollX]
  );

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
              activeSortInfo.id !== 'updated' && { borderColor: tone.solid, backgroundColor: tone.soft },
              pressed && styles.pressedScale,
            ]}
          >
            <Feather
              name="arrow-down"
              size={12}
              color={activeSortInfo.id !== 'updated' ? tone.ink : Palette.inkSecondary}
            />
            <Text
              numberOfLines={1}
              style={[
                styles.sortPillText,
                activeSortInfo.id !== 'updated' && { color: tone.ink },
              ]}
            >
              {activeSortInfo.label}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  };

  return (
    <View style={styles.safeArea}>
      {/* 顶部导航与操作栏（静态 insets.top，消除 Android 进栈顶栏跳动） */}
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

        {/* 按需展开的搜索栏，平时隐藏释放列表空间 */}
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

      {/* 常驻吸顶：主从库胶囊 + 跟手滑动分段条 */}
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

        <SlidingSegmentedBar
          items={VIEW_TABS}
          activeIndex={activeTabIndex}
          onSelect={handleSelectViewTab}
          activeColor={tone.solid}
          scrollX={pagerScrollX}
          pageWidth={effectiveWidth}
        />
      </View>

      {/* 左右滑动切换 4 个视图页（每页独立垂直滚动与滚动位置记忆） */}
      <ContentTransitionView transitionKey={library.slug} style={styles.pagerWrap}>
        <Animated.ScrollView
          ref={pagerRef}
          horizontal
          pagingEnabled
          nestedScrollEnabled
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          onLayout={(e) => {
            const w = e.nativeEvent.layout.width;
            if (w > 0 && Math.abs(w - pagerWidth) > 0.5) {
              setPagerWidth(w);
            }
          }}
          onScroll={onPagerScroll}
          onMomentumScrollEnd={handlePagerMomentumEnd}
          style={styles.pager}
        >
          {/* Page 0：列表（FlatList 虚拟化渲染，长列表流畅不卡顿） */}
          <FlatList<HydratedEntry>
            data={entries}
            keyExtractor={(item) => item.id}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            initialNumToRender={12}
            maxToRenderPerBatch={10}
            windowSize={7}
            style={{ width: effectiveWidth }}
            contentContainerStyle={[styles.pageContent, { paddingBottom: 88 + insets.bottom }]}
            ListHeaderComponent={renderFilterSortBar}
            ListEmptyComponent={
              <DynamicCardListView
                library={library}
                entries={[]}
                onSelectEntry={(id) => nav.push(`/entry/${id}`)}
              />
            }
            renderItem={({ item }) => (
              <DynamicCardListView
                library={library}
                entries={[item]}
                onSelectEntry={(id) => nav.push(`/entry/${id}`)}
                onSelectEntryRelations={(id) =>
                  nav.push({ pathname: '/entry/[id]', params: { id, tab: 'relations' } })
                }
              />
            )}
          />

          {/* Page 1：画廊 */}
          <ScrollView
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            style={{ width: effectiveWidth }}
            contentContainerStyle={[styles.pageContent, { paddingBottom: 88 + insets.bottom }]}
          >
            {renderFilterSortBar()}
            <DynamicGalleryView
              library={library}
              entries={entries}
              onSelectEntry={(id) => nav.push(`/entry/${id}`)}
            />
          </ScrollView>

          {/* Page 2：日历 */}
          <ScrollView
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            style={{ width: effectiveWidth }}
            contentContainerStyle={[styles.pageContent, { paddingBottom: 88 + insets.bottom }]}
          >
            <DynamicCalendarView
              library={library}
              entries={entries}
              onSelectEntry={(id) => nav.push(`/entry/${id}`)}
            />
          </ScrollView>

          {/* Page 3：统计 */}
          <ScrollView
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            style={{ width: effectiveWidth }}
            contentContainerStyle={[styles.pageContent, { paddingBottom: 88 + insets.bottom }]}
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
                  onPress={() => openOmniCapture(library.slug, 'text', undefined, 'stats')}
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
                          paused={activeTabIndex !== 3}
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
                      paused={activeTabIndex !== 3}
                      pinnedOverview={w.pinnedOverview}
                      onToggleOverview={(id, next) => repo?.setWidgetPinnedOverview(id, next)}
                      onDelete={(id) => repo?.deleteDashboardWidget(id)}
                    />
                  ))}
              </View>
            )}
          </ScrollView>
        </Animated.ScrollView>
      </ContentTransitionView>

      {/* 右下角场景化助手按钮（统计 Tab 直达数据分析师，其余视图进入本库助理） */}
      <Pressable
        accessibilityLabel={activeTab === 'stats' ? '针对本库问数据或定制图表' : '本库随手说与智能助手'}
        onPress={() =>
          openOmniCapture(library.slug, 'text', undefined, activeTab === 'stats' ? 'stats' : 'library')
        }
        onLongPress={() =>
          openOmniCapture(library.slug, 'voice', undefined, activeTab === 'stats' ? 'stats' : 'library')
        }
        style={({ pressed }) => [
          styles.fabBtn,
          { bottom: Math.max(insets.bottom, 16) + 8, backgroundColor: tone.solid },
          pressed && { opacity: 0.9, transform: [{ scale: 0.94 }] },
        ]}
      >
        <Feather
          name={activeTab === 'stats' ? 'bar-chart-2' : 'message-circle'}
          size={activeTab === 'stats' ? 23 : 24}
          color={Palette.inkInverse}
        />
      </Pressable>

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
  pageContent: {
    width: '100%',
    maxWidth: 880,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingTop: 6,
    gap: 10,
  },
  filterSortRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 2,
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
  fabBtn: {
    position: 'absolute',
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.22,
    shadowRadius: 14,
    elevation: 8,
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
