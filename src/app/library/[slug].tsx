import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
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
import type { DashboardWidget } from '@/schema/view-dsl';

type ViewTab = 'card' | 'gallery' | 'calendar' | 'stats';

export default function LibraryWorkspaceScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const { repo, revision, openOmniCapture } = useOmni();

  const [activeTab, setActiveTab] = useState<ViewTab>('card');
  const [searchText, setSearchText] = useState('');
  const [entryModalOpen, setEntryModalOpen] = useState(false);
  const [schemaModalOpen, setSchemaModalOpen] = useState(false);

  const library = useMemo(() => {
    void revision;
    if (!repo || !slug) return null;
    return repo.getLibraryBySlug(String(slug));
  }, [repo, slug, revision]);

  const entries = useMemo(() => {
    void revision;
    if (!repo || !library) return [];
    return repo.listHydratedEntries(library.slug, searchText);
  }, [repo, library, searchText, revision]);

  // 自动为任意自定义库生成实时统计卡片（数值/金额求和均值 + 分类分组柱图）
  const autoStatsWidgets = useMemo<DashboardWidget[]>(() => {
    if (!library) return [];
    const list: DashboardWidget[] = [
      {
        id: `auto_cnt_${library.slug}`,
        title: `${library.name}总记录数`,
        subtitle: `逻辑视图 v_${library.slug}`,
        chartType: 'kpi_number',
        readonlySql: `SELECT COUNT(*) AS cnt FROM v_${library.slug}`,
        yKey: 'cnt',
        unitSuffix: ' 条',
        accentTone: library.color,
      },
    ];

    const numField = library.fields.find(
      (f) => f.type === 'currency' || f.type === 'number'
    );
    if (numField) {
      list.push({
        id: `auto_sum_${library.slug}`,
        title: `${numField.label}累计`,
        subtitle: `SUM(${numField.key})`,
        chartType: 'kpi_number',
        readonlySql: `SELECT ROUND(COALESCE(SUM(${numField.key}), 0), 2) AS s FROM v_${library.slug}`,
        yKey: 's',
        unitPrefix: numField.type === 'currency' ? '¥' : undefined,
        unitSuffix: numField.type !== 'currency' && numField.unit ? ` ${numField.unit}` : undefined,
        accentTone: library.color,
      });
    }

    const selectField = library.fields.find((f) => f.type === 'select');
    if (selectField && numField) {
      list.push({
        id: `auto_grp_${library.slug}`,
        title: `按「${selectField.label}」汇总${numField.label}`,
        chartType: 'bar',
        readonlySql: `SELECT COALESCE(NULLIF(${selectField.key}, ''), '未分类') AS grp, ROUND(SUM(${numField.key}), 2) AS val FROM v_${library.slug} GROUP BY grp ORDER BY val DESC`,
        xKey: 'grp',
        yKey: 'val',
        unitPrefix: numField.type === 'currency' ? '¥' : undefined,
        accentTone: library.color,
      });
    } else if (selectField) {
      list.push({
        id: `auto_grp_cnt_${library.slug}`,
        title: `按「${selectField.label}」统计条数占比`,
        chartType: 'pie',
        readonlySql: `SELECT COALESCE(NULLIF(${selectField.key}, ''), '未分类') AS grp, COUNT(*) AS val FROM v_${library.slug} GROUP BY grp ORDER BY val DESC`,
        xKey: 'grp',
        yKey: 'val',
        unitSuffix: ' 条',
        accentTone: library.color,
      });
    }

    return list;
  }, [library]);

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
          <Text style={styles.navMeta}>
            v_{library.slug} · {entries.length} 条记录
          </Text>
        </View>

        <Pressable
          onPress={() => setSchemaModalOpen(true)}
          style={styles.schemaBtn}
        >
          <Feather name="sliders" size={14} color={Palette.inkPrimary} />
          <Text style={styles.schemaBtnText}>模型/样式</Text>
        </Pressable>

        <Pressable
          onPress={() => setEntryModalOpen(true)}
          style={[styles.addBtn, { backgroundColor: tone.solid }]}
        >
          <Feather name="plus" size={16} color={Palette.inkInverse} />
          <Text style={styles.addBtnText}>新增</Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        {/* 视图切换器 + 搜索 */}
        <View style={styles.controlsRow}>
          <View style={styles.viewTabsBar}>
            {(
              [
                { id: 'card', label: '卡片流', icon: 'list' },
                { id: 'gallery', label: '海报墙', icon: 'grid' },
                { id: 'calendar', label: '日历', icon: 'calendar' },
                { id: 'stats', label: '库统计', icon: 'pie-chart' },
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

          <Pressable
            onPress={() => openOmniCapture(library.slug)}
            style={[styles.aiQuickBtn, { backgroundColor: tone.soft }]}
          >
            <Feather name="zap" size={13} color={tone.ink} />
            <Text style={[styles.aiQuickText, { color: tone.ink }]}>AI 快记</Text>
          </Pressable>
        </View>

        {activeTab !== 'stats' ? (
          <View style={styles.searchBox}>
            <Feather name="search" size={15} color={Palette.inkMuted} />
            <TextInput
              value={searchText}
              onChangeText={setSearchText}
              placeholder={`在「${library.name}」内筛选关键字...`}
              placeholderTextColor={Palette.inkMuted}
              style={styles.searchInput}
            />
            {searchText ? (
              <Pressable onPress={() => setSearchText('')}>
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
          <View style={styles.statsWrap}>
            <View style={styles.kpiRow}>
              {autoStatsWidgets
                .filter((w) => w.chartType === 'kpi_number')
                .map((w) => (
                  <SqlWidgetCard key={w.id} widget={w} compact />
                ))}
            </View>
            {autoStatsWidgets
              .filter((w) => w.chartType !== 'kpi_number')
              .map((w) => (
                <SqlWidgetCard key={w.id} widget={w} />
              ))}
          </View>
        ) : null}
      </ScrollView>

      <DynamicEntryFormModal
        visible={entryModalOpen}
        library={library}
        onClose={() => setEntryModalOpen(false)}
      />

      <SchemaEditorModal
        visible={schemaModalOpen}
        existingLibrary={library}
        onClose={() => setSchemaModalOpen(false)}
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
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  addBtnText: {
    fontSize: 12,
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
    paddingBottom: 48,
    gap: 14,
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
  },
  viewTabsBar: {
    flexDirection: 'row',
    backgroundColor: Palette.bgSurface,
    borderRadius: 12,
    padding: 3,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 2,
  },
  viewTabPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 9,
  },
  viewTabText: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.inkSecondary,
  },
  aiQuickBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },
  aiQuickText: {
    fontSize: 12,
    fontWeight: '700',
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
