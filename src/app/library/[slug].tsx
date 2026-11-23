import Feather from '@expo/vector-icons/Feather';
import { useLocalSearchParams } from 'expo-router';
import React, { type ComponentRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
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
import { useSafeNavigation } from '@/utils/navigation';

type ViewTab = 'card' | 'gallery' | 'calendar' | 'stats';

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
  const [searchText, setSearchText] = useState('');
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

  const entries = useMemo(
    () =>
      !repo || revision < 0 || !library
        ? []
        : repo.listHydratedEntries(library.slug, searchText),
    [repo, revision, library, searchText]
  );

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

  // 监听滑动偏移，过半即刻更新选中态，避免等惯性刹停才变亮
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
      setActiveTabIndex(0);
      programmaticScrollRef.current = false;
      pagerScrollX.setValue(0);
      pagerRef.current?.scrollTo({ x: 0, animated: false });
      nav.setParams({ slug: targetSlug });
    },
    [nav, pagerScrollX]
  );

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

  const renderSearchBar = () => (
    <View style={styles.searchBox}>
      <Feather name="search" size={15} color={Palette.inkMuted} />
      <TextInput
        value={searchText}
        onChangeText={setSearchText}
        placeholder={`在「${library.name}」中搜索...`}
        placeholderTextColor={Palette.inkMuted}
        style={styles.searchInput}
      />
      {searchText ? (
        <Pressable hitSlop={8} onPress={() => setSearchText('')}>
          <Feather name="x" size={16} color={Palette.inkMuted} />
        </Pressable>
      ) : null}
    </View>
  );

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
          {/* Page 0：列表 */}
          <ScrollView
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            style={{ width: effectiveWidth }}
            contentContainerStyle={[styles.pageContent, { paddingBottom: 88 + insets.bottom }]}
          >
            {renderSearchBar()}
            <DynamicCardListView
              library={library}
              entries={entries}
              onSelectEntry={(id) => nav.push(`/entry/${id}`)}
              onSelectEntryRelations={(id) =>
                nav.push({ pathname: '/entry/[id]', params: { id, tab: 'relations' } })
              }
            />
          </ScrollView>

          {/* Page 1：画廊 */}
          <ScrollView
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            style={{ width: effectiveWidth }}
            contentContainerStyle={[styles.pageContent, { paddingBottom: 88 + insets.bottom }]}
          >
            {renderSearchBar()}
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
            {renderSearchBar()}
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
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  stickyControls: {
    width: '100%',
    maxWidth: 880,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 10,
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
    gap: 14,
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
    paddingHorizontal: 14,
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
    paddingVertical: 7,
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
    paddingVertical: 7,
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
    backgroundColor: Palette.bgSurface,
    paddingHorizontal: 13,
    paddingVertical: 9,
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
    gap: 12,
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
