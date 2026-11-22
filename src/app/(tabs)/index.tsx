import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
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
import { SchemaEditorModal } from '@/components/dynamic-renderer/SchemaEditorModal';
import { Palette, ToneMap } from '@/constants/design-tokens';
import { useOmni } from '@/context/omni-context';

export default function HomeVaultScreen() {
  const router = useRouter();
  const { repo, libraries, revision, hasApiKey, openOmniCapture } = useOmni();
  const [globalSearch, setGlobalSearch] = useState('');
  const [createModalOpen, setCreateModalOpen] = useState(false);

  const widgets = useMemo(() => {
    void revision;
    if (!repo) return [];
    return repo.listDashboardWidgets(null);
  }, [repo, revision]);

  const kpiWidgets = widgets.filter((w) => w.chartType === 'kpi_number');
  const chartWidgets = widgets.filter((w) => w.chartType !== 'kpi_number');

  const searchHits = useMemo(() => {
    void revision;
    if (!repo || !globalSearch.trim()) return [];
    const results: Array<{
      id: string;
      title: string;
      libName: string;
      libIcon: string;
    }> = [];
    for (const lib of libraries) {
      const matched = repo.listHydratedEntries(lib.slug, globalSearch);
      for (const m of matched.slice(0, 8)) {
        results.push({
          id: m.id,
          title: m.titleSummary,
          libName: lib.name,
          libIcon: lib.icon,
        });
      }
    }
    return results;
  }, [repo, libraries, globalSearch, revision]);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        {/* 顶部标题栏 */}
        <View style={styles.topHeader}>
          <View>
            <Text style={styles.brandTitle}>万象记 OmniVault</Text>
            <Text style={styles.brandSubtitle}>
              本地离线 SQLite · 双向引用 · DeepSeek V4.1 驱动
            </Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable
              onPress={() => router.push('/(tabs)/settings')}
              style={[
                styles.keyStatusPill,
                { backgroundColor: hasApiKey ? Palette.brandSoft : Palette.warningSoft },
              ]}
            >
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: hasApiKey ? Palette.brand : Palette.warning },
                ]}
              />
              <Text
                style={[
                  styles.keyStatusText,
                  { color: hasApiKey ? Palette.brand : Palette.warning },
                ]}
              >
                {hasApiKey ? 'AI 已就绪' : '未配 Key'}
              </Text>
            </Pressable>
            <Pressable
              id="btn-new-library"
              onPress={() => setCreateModalOpen(true)}
              style={styles.newLibBtn}
            >
              <Feather name="plus" size={16} color={Palette.inkInverse} />
              <Text style={styles.newLibBtnText}>新建库</Text>
            </Pressable>
          </View>
        </View>

        {/* 全局跨库秒搜 */}
        <View style={styles.searchBar}>
          <Feather name="search" size={16} color={Palette.inkMuted} />
          <TextInput
            id="input-global-search"
            value={globalSearch}
            onChangeText={setGlobalSearch}
            placeholder="跨所有记录库检索标题、标签、备注..."
            placeholderTextColor={Palette.inkMuted}
            style={styles.searchInput}
          />
          {globalSearch ? (
            <Pressable onPress={() => setGlobalSearch('')}>
              <Feather name="x-circle" size={16} color={Palette.inkMuted} />
            </Pressable>
          ) : null}
        </View>

        {globalSearch.trim() ? (
          <View style={styles.searchResultSection}>
            <Text style={styles.sectionHeading}>跨库搜索结果 ({searchHits.length})</Text>
            {searchHits.length === 0 ? (
              <Text style={styles.mutedTip}>未找到包含 “{globalSearch}” 的记录</Text>
            ) : (
              searchHits.map((hit) => (
                <Pressable
                  key={hit.id}
                  onPress={() => router.push(`/entry/${hit.id}`)}
                  style={styles.searchHitRow}
                >
                  <Text style={styles.searchHitTitle} numberOfLines={1}>
                    {hit.title}
                  </Text>
                  <Text style={styles.searchHitLib}>
                    {hit.libIcon} {hit.libName}
                  </Text>
                </Pressable>
              ))
            )}
          </View>
        ) : null}

        {/* 自定义记录库矩阵 */}
        <View style={styles.sectionRow}>
          <Text style={styles.sectionHeading}>我的数据模型库 ({libraries.length})</Text>
          <Pressable onPress={() => router.push('/(tabs)/ai-studio')}>
            <Text style={styles.linkAction}>AI 一句话建多表 →</Text>
          </Pressable>
        </View>

        <View style={styles.libGrid}>
          {libraries.map((lib) => {
            const tone = ToneMap[lib.color] ?? ToneMap.teal;
            const relCount = lib.fields.filter((f) => f.type === 'relation').length;
            const calcCount = lib.fields.filter(
              (f) => f.type === 'rollup' || f.type === 'formula'
            ).length;

            return (
              <Pressable
                key={lib.id}
                onPress={() => router.push(`/library/${lib.slug}`)}
                style={({ pressed }) => [styles.libCard, pressed && { opacity: 0.85 }]}
              >
                <View style={styles.libCardTop}>
                  <View style={[styles.libIconWrap, { backgroundColor: tone.soft }]}>
                    <Text style={styles.libEmoji}>{lib.icon}</Text>
                  </View>
                  <View style={[styles.countPill, { backgroundColor: Palette.bgSubtle }]}>
                    <Text style={styles.countText}>{lib.entryCount} 条</Text>
                  </View>
                </View>

                <Text style={styles.libName} numberOfLines={1}>
                  {lib.name}
                </Text>
                <Text style={styles.libDesc} numberOfLines={2}>
                  {lib.description || `${lib.fields.length} 个自定义字段`}
                </Text>

                <View style={styles.libMetaTags}>
                  <Text style={styles.libMetaChip}>{lib.fields.length} 字段</Text>
                  {relCount > 0 ? (
                    <Text style={[styles.libMetaChip, { color: tone.ink }]}>
                      {relCount} 关联
                    </Text>
                  ) : null}
                  {calcCount > 0 ? (
                    <Text style={[styles.libMetaChip, { color: tone.ink }]}>
                      {calcCount} 计算列
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </View>

        {/* 离线跨库统计看板 */}
        <View style={styles.sectionRow}>
          <Text style={styles.sectionHeading}>跨库实时统计看板（纯本地 SQL）</Text>
          <Pressable onPress={() => router.push('/(tabs)/ai-studio')}>
            <Text style={styles.linkAction}>AI 新增图表 →</Text>
          </Pressable>
        </View>

        {kpiWidgets.length > 0 ? (
          <View style={styles.kpiRow}>
            {kpiWidgets.map((w) => (
              <SqlWidgetCard
                key={w.id}
                widget={w}
                compact
                onDelete={(id) => repo?.deleteDashboardWidget(id)}
              />
            ))}
          </View>
        ) : null}

        <View style={styles.chartsStack}>
          {chartWidgets.map((w) => (
            <SqlWidgetCard
              key={w.id}
              widget={w}
              onDelete={(id) => repo?.deleteDashboardWidget(id)}
            />
          ))}
        </View>
      </ScrollView>

      {/* 底部常驻全局 AI 万能快记唤醒条 */}
      <View style={styles.omniDockWrap}>
        <Pressable
          id="btn-open-omni-bar"
          onPress={() => openOmniCapture(undefined)}
          style={({ pressed }) => [styles.omniDockBtn, pressed && { opacity: 0.92 }]}
        >
          <View style={styles.omniSparkIcon}>
            <Feather name="zap" size={16} color={Palette.inkInverse} />
          </View>
          <Text style={styles.omniDockPlaceholder} numberOfLines={1}>
            AI 万能快记：说一句话 / 拍小票 / 贴链接自动跨表入库...
          </Text>
          <Feather name="camera" size={17} color={Palette.brand} />
        </Pressable>
      </View>

      <SchemaEditorModal
        visible={createModalOpen}
        existingLibrary={null}
        onClose={() => setCreateModalOpen(false)}
        onSaved={(newSlug) => router.push(`/library/${newSlug}`)}
      />
    </SafeAreaView>
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
    paddingTop: 14,
    paddingBottom: 96,
    gap: 16,
  },
  topHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  brandTitle: {
    fontSize: 23,
    fontWeight: '800',
    color: Palette.inkPrimary,
    letterSpacing: -0.4,
  },
  brandSubtitle: {
    fontSize: 12,
    color: Palette.inkMuted,
    marginTop: 2,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  keyStatusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  keyStatusText: {
    fontSize: 12,
    fontWeight: '700',
  },
  newLibBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Palette.brand,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
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
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: Palette.inkPrimary,
  },
  searchHitLib: {
    fontSize: 12,
    color: Palette.inkSecondary,
    fontWeight: '600',
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
    gap: 12,
  },
  libCard: {
    width: '48%',
    minWidth: 156,
    flexGrow: 1,
    backgroundColor: Palette.bgSurface,
    borderRadius: 18,
    padding: 15,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 8,
  },
  libCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  libIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  libEmoji: {
    fontSize: 20,
  },
  countPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
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
  },
  libDesc: {
    fontSize: 12,
    color: Palette.inkMuted,
    lineHeight: 17,
    minHeight: 34,
  },
  libMetaTags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: Palette.borderHairline,
  },
  libMetaChip: {
    fontSize: 11,
    fontWeight: '600',
    color: Palette.inkMuted,
  },
  kpiRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  chartsStack: {
    gap: 12,
  },
  omniDockWrap: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 12,
    alignItems: 'center',
  },
  omniDockBtn: {
    width: '100%',
    maxWidth: 680,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Palette.bgSurface,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Palette.borderStrong,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 14,
    elevation: 5,
  },
  omniSparkIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: Palette.brand,
    alignItems: 'center',
    justifyContent: 'center',
  },
  omniDockPlaceholder: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
});
