import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { SqlWidgetCard } from '@/components/charts/SqlWidgetCard';
import { DynamicEntryFormModal } from '@/components/dynamic-renderer/DynamicEntryFormModal';
import {
  DynamicCalendarView,
  DynamicCardListView,
  DynamicGalleryView,
} from '@/components/dynamic-renderer/DynamicViews';
import { SchemaEditorModal } from '@/components/dynamic-renderer/SchemaEditorModal';
import { Palette, ToneMap } from '@/constants/design-tokens';
import { useOmni } from '@/context/omni-context';

type ViewTab = 'card' | 'gallery' | 'calendar' | 'stats';

export default function LibraryWorkspaceScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { repo, revision, openOmniCapture } = useOmni();

  const [activeTab, setActiveTab] = useState<ViewTab>('card');
  const [searchText, setSearchText] = useState('');
  const [entryModalOpen, setEntryModalOpen] = useState(false);
  const [schemaModalOpen, setSchemaModalOpen] = useState(false);

  const library = !repo || revision < 0 || !slug ? null : repo.getLibraryBySlug(String(slug));
  const entries = !repo || revision < 0 || !library ? [] : repo.listHydratedEntries(library.slug, searchText);

  // 仅展示该记录本已设计过的统计图表
  const designedStatsWidgets =
    !repo || revision < 0 || !library ? [] : repo.listWidgetsForLibrary(library.slug);

  if (!library) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.notFoundBox}>
          <Text style={styles.notFoundTitle}>找不到该数据表</Text>
          <Pressable onPress={() => router.replace('/(tabs)')} style={styles.backHomeBtn}>
            <Text style={styles.backHomeText}>返回首页</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const tone = ToneMap[library.color] ?? ToneMap.teal;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      {/* 顶部导航与操作栏 */}
      <View style={styles.topNav}>
        <Pressable onPress={() => router.back()} style={styles.iconCircle}>
          <Feather name="arrow-left" size={19} color={Palette.inkPrimary} />
        </Pressable>

        <View style={styles.titleCenter}>
          <Text style={styles.navTitle} numberOfLines={1}>
            {library.icon} {library.name}
          </Text>
          <Text style={styles.navMeta}>{entries.length} 条记录</Text>
        </View>

        <Pressable
          onPress={() => setSchemaModalOpen(true)}
          style={styles.iconCircle}
          accessibilityLabel="管理记录本"
        >
          <Feather name="sliders" size={17} color={Palette.inkPrimary} />
        </Pressable>

        <Pressable
          onPress={() => setEntryModalOpen(true)}
          style={[styles.addBtn, { backgroundColor: tone.solid }]}
        >
          <Feather name="plus" size={16} color={Palette.inkInverse} />
          <Text style={styles.addBtnText}>记一条</Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.container, { paddingBottom: 88 + insets.bottom }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* 视图切换器 */}
        <View style={styles.viewTabsBar}>
          {(
            [
              { id: 'card', label: '列表', icon: 'list' },
              { id: 'gallery', label: '画廊', icon: 'grid' },
              { id: 'calendar', label: '日历', icon: 'calendar' },
              { id: 'stats', label: '统计', icon: 'pie-chart' },
            ] as const
          ).map((t) => {
            const active = activeTab === t.id;
            return (
              <Pressable
                key={t.id}
                onPress={() => setActiveTab(t.id)}
                style={[
                  styles.viewTabPill,
                  active && { backgroundColor: tone.solid },
                ]}
              >
                <Feather
                  name={t.icon}
                  size={13}
                  color={active ? Palette.inkInverse : Palette.inkSecondary}
                />
                <Text style={[styles.viewTabText, active && { color: Palette.inkInverse }]}>
                  {t.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {activeTab !== 'stats' ? (
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
        ) : null}

        {activeTab === 'card' ? (
          <DynamicCardListView
            library={library}
            entries={entries}
            onSelectEntry={(id) => router.push(`/entry/${id}`)}
          />
        ) : null}

        {activeTab === 'gallery' ? (
          <DynamicGalleryView
            library={library}
            entries={entries}
            onSelectEntry={(id) => router.push(`/entry/${id}`)}
          />
        ) : null}

        {activeTab === 'calendar' ? (
          <DynamicCalendarView
            library={library}
            entries={entries}
            onSelectEntry={(id) => router.push(`/entry/${id}`)}
          />
        ) : null}

        {activeTab === 'stats' ? (
          designedStatsWidgets.length === 0 ? (
            <View style={styles.emptyStatsCard}>
              <View style={[styles.emptyStatsIcon, { backgroundColor: tone.soft }]}>
                <Feather name="bar-chart-2" size={20} color={tone.solid} />
              </View>
              <Text style={styles.emptyStatsTitle}>还没有为「{library.name}」定制统计</Text>
              <Text style={styles.emptyStatsDesc}>
                有需要统计的指标时，告诉助手你想看什么图表，生成后就会展示在这里。
              </Text>
              <Pressable
                onPress={() => openOmniCapture(library.slug, 'text')}
                style={[styles.emptyStatsBtn, { backgroundColor: tone.solid }]}
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
                    pinnedOverview={w.pinnedOverview}
                    onToggleOverview={(id, next) => repo?.setWidgetPinnedOverview(id, next)}
                    onDelete={(id) => repo?.deleteDashboardWidget(id)}
                  />
                ))}
            </View>
          )
        ) : null}
      </ScrollView>

      {/* 右下角统一圆形悬浮按钮（点击打开随手说，长按直接录音） */}
      <Pressable
        accessibilityLabel="随手说与智能助手"
        onPress={() => openOmniCapture(library.slug, 'text')}
        onLongPress={() => openOmniCapture(library.slug, 'voice')}
        style={({ pressed }) => [
          styles.fabBtn,
          { bottom: Math.max(insets.bottom, 16) + 8, backgroundColor: tone.solid },
          pressed && { opacity: 0.9, transform: [{ scale: 0.94 }] },
        ]}
      >
        <Feather name="message-circle" size={24} color={Palette.inkInverse} />
      </Pressable>

      <DynamicEntryFormModal
        visible={entryModalOpen}
        library={library}
        onClose={() => setEntryModalOpen(false)}
      />

      <SchemaEditorModal
        visible={schemaModalOpen}
        existingLibrary={library}
        onClose={() => setSchemaModalOpen(false)}
        onDeleted={() => router.replace('/(tabs)')}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Palette.bgCanvas,
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
    borderBottomWidth: 1,
    borderBottomColor: Palette.borderHairline,
    backgroundColor: Palette.bgSurface,
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
  schemaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: Palette.bgSubtle,
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderRadius: 10,
  },
  schemaBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.inkPrimary,
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
  scroll: {
    flex: 1,
  },
  container: {
    width: '100%',
    maxWidth: 880,
    alignSelf: 'center',
    padding: 16,
    gap: 14,
  },
  viewTabsBar: {
    flexDirection: 'row',
    backgroundColor: Palette.bgSurface,
    borderRadius: 14,
    padding: 4,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 4,
  },
  viewTabPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 8,
    borderRadius: 10,
  },
  viewTabText: {
    fontSize: 13,
    fontWeight: '700',
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
  emptyStatsTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: Palette.inkPrimary,
    textAlign: 'center',
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
