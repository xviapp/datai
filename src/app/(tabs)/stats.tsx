import Feather from '@expo/vector-icons/Feather';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SqlWidgetCard } from '@/components/charts/SqlWidgetCard';
import { TabPageHeader } from '@/components/layout/TabPageHeader';
import { FloatingAssistantButton } from '@/components/ui/FloatingAssistantButton';
import { Palette, ToneMap } from '@/constants/design-tokens';
import { useOmniModalActions, useRepository, useWidgetRevision } from '@/context/omni-context';
import type { LibraryRecord, SavedDashboardWidget } from '@/db/models';
import { sqlReferencesLibraryView } from '@/db/types';
import { useSwipeablePager } from '@/hooks/useSwipeablePager';
import { useSafeNavigation } from '@/utils/navigation';

type StatsTabItem =
  | {
      id: 'overview';
      kind: 'overview';
      label: string;
      icon: string;
      widgets: SavedDashboardWidget[];
    }
  | {
      id: string;
      kind: 'library';
      label: string;
      icon: string;
      library: LibraryRecord;
      widgets: SavedDashboardWidget[];
    };

export default function StatsScreen() {
  const nav = useSafeNavigation();
  const { repo, libraries } = useRepository();
  const widgetRevision = useWidgetRevision();
  const { openOmniCapture } = useOmniModalActions();

  const [isFocused, setIsFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [manageMode, setManageMode] = useState(false);

  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => setIsFocused(false);
    }, [])
  );

  const [syncedWidgetRevision, setSyncedWidgetRevision] = useState(widgetRevision);
  if (isFocused && syncedWidgetRevision !== widgetRevision) {
    setSyncedWidgetRevision(widgetRevision);
  }

  const allWidgets = useMemo(
    () => (!repo || syncedWidgetRevision < 0 ? [] : repo.listAllDashboardWidgets()),
    [repo, syncedWidgetRevision]
  );
  const overviewWidgets = useMemo(
    () => allWidgets.filter((w) => w.pinnedOverview),
    [allWidgets]
  );
  const unpinnedWidgets = useMemo(
    () => allWidgets.filter((w) => !w.pinnedOverview),
    [allWidgets]
  );

  const tabs: StatsTabItem[] = useMemo(() => {
    const libraryTabs: StatsTabItem[] = [];
    for (const lib of libraries) {
      const matched = allWidgets.filter(
        (w) => w.librarySlug === lib.slug || sqlReferencesLibraryView(w.readonlySql, lib.slug)
      );
      if (matched.length > 0) {
        libraryTabs.push({
          id: lib.slug,
          kind: 'library',
          label: lib.name,
          icon: lib.icon,
          library: lib,
          widgets: matched,
        });
      }
    }
    return [
      {
        id: 'overview',
        kind: 'overview',
        label: '总览',
        icon: '★',
        widgets: overviewWidgets,
      },
      ...libraryTabs,
    ];
  }, [libraries, allWidgets, overviewWidgets]);

  const safeActiveIndex = Math.min(activeIndex, Math.max(0, tabs.length - 1));
  const currentTab = tabs[safeActiveIndex];
  const activeStatsLibSlug =
    currentTab?.kind === 'library' ? currentTab.library.slug : undefined;
  const activeStatsTone =
    currentTab?.kind === 'library'
      ? (ToneMap[currentTab.library.color] ?? ToneMap.teal)
      : ToneMap.teal;

  const {
    pagerRef,
    chipsScrollRef,
    effectiveWidth,
    selectPage,
    handlePagerLayout,
    handlePagerMomentumEnd,
    handleChipLayout,
    onPagerScroll,
  } = useSwipeablePager({
    pageCount: tabs.length,
    activeIndex: safeActiveIndex,
    onIndexChange: setActiveIndex,
  });

  const handleToggleOverview = (id: string, nextPinned: boolean) => {
    repo?.setWidgetPinnedOverview(id, nextPinned);
  };

  const handleMove = (id: string, dir: 'up' | 'down', scopeList: SavedDashboardWidget[]) => {
    repo?.moveDashboardWidget(
      id,
      dir,
      scopeList.map((w) => w.id)
    );
  };

  return (
    <View style={styles.safeArea}>
      <TabPageHeader
        title="统计"
        subtitle={
          manageMode
            ? '点箭头调顺序，点 ★ 决定是否放进总览'
            : allWidgets.length > 0
              ? `总览已选 ${overviewWidgets.length} 项 · 共 ${allWidgets.length} 项定制统计`
              : '按需定制你关心的统计图表'
        }
        right={
          allWidgets.length > 0 ? (
            <Pressable
              onPress={() => setManageMode((m) => !m)}
              style={({ pressed }) => [
                styles.sortBtn,
                manageMode && styles.sortBtnActive,
                pressed && { opacity: 0.8 },
              ]}
            >
              <Feather
                name={manageMode ? 'check' : 'sliders'}
                size={14}
                color={manageMode ? Palette.inkInverse : Palette.inkPrimary}
              />
              <Text style={[styles.sortBtnText, manageMode && styles.sortBtnTextActive]}>
                {manageMode ? '完成' : '排序'}
              </Text>
            </Pressable>
          ) : undefined
        }
      />

      {tabs.length > 1 ? (
        <View style={styles.chipsBarWrap}>
          <ScrollView
            ref={chipsScrollRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipsRow}
          >
            {tabs.map((tab, idx) => {
              const active = idx === safeActiveIndex;
              const tone =
                tab.kind === 'library'
                  ? (ToneMap[tab.library.color] ?? ToneMap.teal)
                  : ToneMap.teal;

              return (
                <Pressable
                  key={tab.id}
                  onLayout={handleChipLayout(idx)}
                  onPress={() => selectPage(idx)}
                  style={({ pressed }) => [
                    styles.chipPill,
                    active && { backgroundColor: tone.solid, borderColor: tone.solid },
                    pressed && !active && { opacity: 0.75 },
                  ]}
                >
                  <Text
                    style={[
                      styles.chipIcon,
                      tab.kind === 'overview' && !active && { color: '#D97706' },
                      active && { color: Palette.inkInverse },
                    ]}
                  >
                    {tab.icon}
                  </Text>
                  <Text
                    style={[styles.chipLabel, active && styles.chipLabelActive]}
                    numberOfLines={1}
                  >
                    {tab.label}
                  </Text>
                  <Text style={[styles.chipCount, active && styles.chipCountActive]}>
                    {tab.widgets.length}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      <Animated.ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        nestedScrollEnabled
        scrollEnabled={tabs.length > 1}
        showsHorizontalScrollIndicator={false}
        onLayout={handlePagerLayout}
        onScroll={onPagerScroll}
        onMomentumScrollEnd={handlePagerMomentumEnd}
        scrollEventThrottle={16}
        style={styles.pager}
      >
        {tabs.map((tab, tabIdx) => {
          const isNearby = Math.abs(tabIdx - safeActiveIndex) <= 1;
          const isPaused = !isFocused || !isNearby;
          const kpis = tab.widgets.filter((w) => w.chartType === 'kpi_number');
          const charts = tab.widgets.filter((w) => w.chartType !== 'kpi_number');

          return (
            <ScrollView
              key={tab.id}
              nestedScrollEnabled
              style={{ width: effectiveWidth }}
              contentContainerStyle={[
                styles.pageContent,
                tabs.length <= 1 && styles.pageContentNoChips,
              ]}
              showsVerticalScrollIndicator={false}
            >
              {tab.kind === 'library' ? (
                <View style={styles.libBanner}>
                  <View
                    style={[
                      styles.libBannerIcon,
                      { backgroundColor: (ToneMap[tab.library.color] ?? ToneMap.teal).soft },
                    ]}
                  >
                    <Text style={styles.libBannerEmoji}>{tab.library.icon}</Text>
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.libBannerName}>{tab.library.name}</Text>
                    <Text style={styles.libBannerDesc} numberOfLines={1}>
                      点亮图表右上角 ★ 可同步展示在总览
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => nav.push(`/library/${tab.library.slug}`)}
                    style={({ pressed }) => [
                      styles.openLibBtn,
                      { backgroundColor: (ToneMap[tab.library.color] ?? ToneMap.teal).soft },
                      pressed && { opacity: 0.75, transform: [{ scale: 0.96 }] },
                    ]}
                  >
                    <Text
                      style={[
                        styles.openLibText,
                        { color: (ToneMap[tab.library.color] ?? ToneMap.teal).ink },
                      ]}
                    >
                      看记录
                    </Text>
                    <Feather
                      name="chevron-right"
                      size={14}
                      color={(ToneMap[tab.library.color] ?? ToneMap.teal).ink}
                    />
                  </Pressable>
                </View>
              ) : null}

              {tab.widgets.length === 0 ? (
                <View style={styles.emptyCard}>
                  <View style={styles.emptyIconCircle}>
                    <Feather name="star" size={21} color="#D97706" />
                  </View>
                  <Text style={styles.emptyDesc}>
                    {tab.kind === 'overview' && allWidgets.length > 0
                      ? '从下方挑选图表加入总览，或在各记录本分组里点亮 ★'
                      : '点右下角按钮说出想看的图表，满意后固定到统计'}
                  </Text>
                  {allWidgets.length === 0 ? (
                    <Pressable
                      onPress={() => openOmniCapture(activeStatsLibSlug, 'text', undefined, 'stats')}
                      style={styles.emptyCtaBtn}
                    >
                      <Text style={styles.emptyCtaText}>定制第一张统计图</Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : (
                <>
                  {kpis.length > 0 ? (
                    <View style={styles.kpiRow}>
                      {kpis.map((w, idx) => (
                        <SqlWidgetCard
                          key={`${tab.id}_${w.id}`}
                          widget={w}
                          compact
                          paused={isPaused}
                          manageMode={manageMode}
                          pinnedOverview={w.pinnedOverview}
                          onToggleOverview={handleToggleOverview}
                          canMoveUp={idx > 0}
                          canMoveDown={idx < kpis.length - 1}
                          onMoveUp={() => handleMove(w.id, 'up', kpis)}
                          onMoveDown={() => handleMove(w.id, 'down', kpis)}
                          onDelete={(id) => repo?.deleteDashboardWidget(id)}
                        />
                      ))}
                    </View>
                  ) : null}

                  {charts.length > 0 ? (
                    <View style={styles.chartsStack}>
                      {charts.map((w, idx) => (
                        <SqlWidgetCard
                          key={`${tab.id}_${w.id}`}
                          widget={w}
                          paused={isPaused}
                          manageMode={manageMode}
                          pinnedOverview={w.pinnedOverview}
                          onToggleOverview={handleToggleOverview}
                          canMoveUp={idx > 0}
                          canMoveDown={idx < charts.length - 1}
                          onMoveUp={() => handleMove(w.id, 'up', charts)}
                          onMoveDown={() => handleMove(w.id, 'down', charts)}
                          onDelete={(id) => repo?.deleteDashboardWidget(id)}
                        />
                      ))}
                    </View>
                  ) : null}
                </>
              )}

              {tab.kind === 'overview' &&
              unpinnedWidgets.length > 0 &&
              (manageMode || overviewWidgets.length === 0) ? (
                <View style={styles.pickBox}>
                  <Text style={styles.pickHeading}>
                    可加入总览的图表 ({unpinnedWidgets.length})
                  </Text>
                  {unpinnedWidgets.map((w) => (
                    <View key={w.id} style={styles.pickRow}>
                      <View style={{ flex: 1, gap: 1 }}>
                        <Text style={styles.pickTitle} numberOfLines={1}>
                          {w.title}
                        </Text>
                        {w.subtitle ? (
                          <Text style={styles.pickSub} numberOfLines={1}>
                            {w.subtitle}
                          </Text>
                        ) : null}
                      </View>
                      <Pressable
                        onPress={() => handleToggleOverview(w.id, true)}
                        style={styles.pickAddBtn}
                      >
                        <Text style={styles.pickAddText}>★ 加入总览</Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
              ) : null}
            </ScrollView>
          );
        })}
      </Animated.ScrollView>

      <FloatingAssistantButton
        accessibilityLabel="问数据或定制统计"
        icon="bar-chart-2"
        iconSize={23}
        backgroundColor={activeStatsTone.solid}
        onPress={() => openOmniCapture(activeStatsLibSlug, 'text', undefined, 'stats')}
        onLongPress={() => openOmniCapture(activeStatsLibSlug, 'voice', undefined, 'stats')}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Palette.bgCanvas,
  },
  sortBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    height: 36,
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    paddingHorizontal: 13,
    borderRadius: 999,
  },
  sortBtnActive: {
    backgroundColor: Palette.inkPrimary,
    borderColor: Palette.inkPrimary,
  },
  sortBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  sortBtnTextActive: {
    color: Palette.inkInverse,
  },
  chipsBarWrap: {
    borderBottomWidth: 1,
    borderBottomColor: Palette.borderHairline,
    paddingBottom: 10,
  },
  chipsRow: {
    paddingHorizontal: 18,
    gap: 8,
    alignItems: 'center',
  },
  chipPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  chipIcon: {
    fontSize: 13,
    color: Palette.brand,
  },
  chipLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkSecondary,
    maxWidth: 128,
  },
  chipLabelActive: {
    color: Palette.inkInverse,
  },
  chipCount: {
    fontSize: 11,
    fontWeight: '700',
    color: Palette.inkMuted,
    marginLeft: 1,
  },
  chipCountActive: {
    color: 'rgba(255,255,255,0.85)',
  },
  pager: {
    flex: 1,
  },
  pageContent: {
    width: '100%',
    maxWidth: 880,
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 92,
    gap: 12,
  },
  pageContentNoChips: {
    paddingTop: 4,
  },
  kpiRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 10,
  },
  chartsStack: {
    gap: 12,
  },
  libBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: Palette.bgSurface,
    borderRadius: 18,
    padding: 13,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  libBannerIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  libBannerEmoji: {
    fontSize: 20,
  },
  libBannerName: {
    fontSize: 15,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  libBannerDesc: {
    fontSize: 12,
    color: Palette.inkMuted,
  },
  openLibBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 999,
  },
  openLibText: {
    fontSize: 12,
    fontWeight: '700',
  },
  emptyCard: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 20,
    padding: 26,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    alignItems: 'center',
    gap: 10,
    marginTop: 8,
  },
  emptyIconCircle: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#FEF3C7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyDesc: {
    fontSize: 13,
    color: Palette.inkMuted,
    textAlign: 'center',
    lineHeight: 20,
  },
  emptyCtaBtn: {
    marginTop: 4,
    backgroundColor: Palette.brand,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
  },
  emptyCtaText: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkInverse,
  },
  pickBox: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 18,
    padding: 15,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 10,
    marginTop: 4,
  },
  pickHeading: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkSecondary,
  },
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: Palette.borderHairline,
  },
  pickTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: Palette.inkPrimary,
  },
  pickSub: {
    fontSize: 12,
    color: Palette.inkMuted,
  },
  pickAddBtn: {
    backgroundColor: '#FEF3C7',
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
  },
  pickAddText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#B45309',
  },
});
