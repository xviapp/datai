import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { type ComponentRef, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SqlWidgetCard } from '@/components/charts/SqlWidgetCard';
import { Palette, ToneMap } from '@/constants/design-tokens';
import { useOmni } from '@/context/omni-context';
import type { LibraryRecord, SavedDashboardWidget } from '@/db/repository';

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
  const router = useRouter();
  const { width: screenWidth } = useWindowDimensions();
  const { repo, libraries, revision, openOmniCapture } = useOmni();

  const [activeIndex, setActiveIndex] = useState(0);
  const [manageMode, setManageMode] = useState(false);
  const pagerRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const chipsScrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const chipLayoutsRef = useRef<Record<number, { x: number; width: number }>>({});

  const allWidgets = !repo || revision < 0 ? [] : repo.listAllDashboardWidgets();
  const overviewWidgets = allWidgets.filter((w) => w.pinnedOverview);
  const unpinnedWidgets = allWidgets.filter((w) => !w.pinnedOverview);

  // 仅对「已设计统计图表」的记录本生成分组标签
  const libraryTabs: StatsTabItem[] = [];
  for (const lib of libraries) {
    const viewToken = `v_${lib.slug}`;
    const matched = allWidgets.filter(
      (w) => w.librarySlug === lib.slug || w.readonlySql.includes(viewToken)
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

  const tabs: StatsTabItem[] = [
    {
      id: 'overview',
      kind: 'overview',
      label: '总览',
      icon: '★',
      widgets: overviewWidgets,
    },
    ...libraryTabs,
  ];

  const safeActiveIndex = Math.min(activeIndex, Math.max(0, tabs.length - 1));

  const scrollChipIntoView = (idx: number) => {
    const layout = chipLayoutsRef.current[idx];
    if (!layout || !chipsScrollRef.current) return;
    const targetX = Math.max(0, layout.x - screenWidth / 2 + layout.width / 2);
    chipsScrollRef.current.scrollTo({ x: targetX, animated: true });
  };

  const handleSelectTab = (idx: number) => {
    setActiveIndex(idx);
    pagerRef.current?.scrollTo({ x: idx * screenWidth, animated: true });
    scrollChipIntoView(idx);
  };

  const handlePagerMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offsetX = e.nativeEvent.contentOffset.x;
    const nextIdx = Math.round(offsetX / Math.max(1, screenWidth));
    const clamped = Math.max(0, Math.min(tabs.length - 1, nextIdx));
    if (clamped !== safeActiveIndex) {
      setActiveIndex(clamped);
      scrollChipIntoView(clamped);
    }
  };

  const handleChipLayout = (idx: number) => (e: LayoutChangeEvent) => {
    const { x, width } = e.nativeEvent.layout;
    chipLayoutsRef.current[idx] = { x, width };
  };

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
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      {/* 顶部标题栏 */}
      <View style={styles.topHeader}>
        <View style={styles.titleBlock}>
          <Text style={styles.pageTitle}>统计</Text>
          <Text style={styles.pageSubtitle}>
            {manageMode
              ? '点箭头调顺序，点 ★ 决定是否放进总览'
              : allWidgets.length > 0
                ? `总览已选 ${overviewWidgets.length} 项 · 共 ${allWidgets.length} 项定制统计`
                : '按需定制你关心的统计图表'}
          </Text>
        </View>

        {allWidgets.length > 0 ? (
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
        ) : null}
      </View>

      {/* 横向分组胶囊 */}
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
                  onPress={() => handleSelectTab(idx)}
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
                  <Text style={[styles.chipLabel, active && styles.chipLabelActive]} numberOfLines={1}>
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

      {/* 可左右滑动的分组内容页 */}
      <ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        scrollEnabled={tabs.length > 1}
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handlePagerMomentumEnd}
        scrollEventThrottle={16}
        style={styles.pager}
      >
        {tabs.map((tab) => {
          const kpis = tab.widgets.filter((w) => w.chartType === 'kpi_number');
          const charts = tab.widgets.filter((w) => w.chartType !== 'kpi_number');

          return (
            <ScrollView
              key={tab.id}
              style={{ width: screenWidth }}
              contentContainerStyle={styles.pageContent}
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
                    onPress={() => router.push(`/library/${tab.library.slug}`)}
                    style={[
                      styles.openLibBtn,
                      { backgroundColor: (ToneMap[tab.library.color] ?? ToneMap.teal).soft },
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
                  <Text style={styles.emptyTitle}>
                    {tab.kind === 'overview' && allWidgets.length > 0
                      ? '总览里还没有星标图表'
                      : '还没有定制统计'}
                  </Text>
                  <Text style={styles.emptyDesc}>
                    {tab.kind === 'overview' && allWidgets.length > 0
                      ? '从下方直接挑选已有图表加入总览，或在各记录本分组里点亮图表右上角的 ★。'
                      : '这里只展示你主动设计过的图表。点右下角按钮说出想看的内容，满意后点「固定到统计」即可。'}
                  </Text>
                  {allWidgets.length === 0 ? (
                    <Pressable
                      onPress={() => openOmniCapture(undefined, 'text')}
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

              {/* 在总览页（排序模式或空态时）提供一键挑图加入总览 */}
              {tab.kind === 'overview' &&
              unpinnedWidgets.length > 0 &&
              (manageMode || overviewWidgets.length === 0) ? (
                <View style={styles.pickBox}>
                  <Text style={styles.pickHeading}>可加入总览的图表 ({unpinnedWidgets.length})</Text>
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
      </ScrollView>

      {/* 右下角统一悬浮主按钮（可随时提问统计或加图） */}
      <Pressable
        accessibilityLabel="问数据或定制统计"
        onPress={() => openOmniCapture(undefined, 'text')}
        onLongPress={() => openOmniCapture(undefined, 'voice')}
        style={({ pressed }) => [
          styles.statsFab,
          pressed && { opacity: 0.9, transform: [{ scale: 0.94 }] },
        ]}
      >
        <Feather name="message-circle" size={24} color={Palette.inkInverse} />
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Palette.bgCanvas,
  },
  topHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 10,
    gap: 10,
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  pageTitle: {
    fontSize: 25,
    fontWeight: '800',
    color: Palette.inkPrimary,
    letterSpacing: -0.5,
  },
  pageSubtitle: {
    fontSize: 12,
    color: Palette.inkMuted,
  },
  headerBtns: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  sortBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    paddingHorizontal: 12,
    paddingVertical: 8,
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
  askBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Palette.brand,
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 999,
  },
  askBtnText: {
    fontSize: 13,
    fontWeight: '700',
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
  statsFab: {
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
  kpiRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
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
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Palette.inkPrimary,
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
