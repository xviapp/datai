import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
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
import type { LibraryRecord } from '@/db/repository';

export default function HomeVaultScreen() {
  const router = useRouter();
  const { repo, libraries, revision, hasApiKey, openOmniCapture } = useOmni();
  const [globalSearch, setGlobalSearch] = useState('');
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [managingLibrary, setManagingLibrary] = useState<LibraryRecord | null>(null);

  const widgets = !repo || revision < 0 ? [] : repo.listDashboardWidgets(null);

  const kpiWidgets = widgets.filter((w) => w.chartType === 'kpi_number');
  const chartWidgets = widgets.filter((w) => w.chartType !== 'kpi_number');
  const totalEntryCount = libraries.reduce((sum, l) => sum + l.entryCount, 0);

  const searchHits = (() => {
    if (!repo || revision < 0 || !globalSearch.trim()) return [];
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
  })();

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        {/* 顶部标题栏 */}
        <View style={styles.topHeaderBlock}>
          <View style={styles.topHeader}>
            <View style={styles.brandBlock}>
              <Text style={styles.brandTitle} numberOfLines={1}>
                万象记
              </Text>
              <Text style={styles.brandSubtitle}>
                {libraries.length} 个记录本 · 共 {totalEntryCount} 条记录
              </Text>
            </View>
            <View style={styles.headerActions}>
              {!hasApiKey ? (
                <Pressable
                  onPress={() => router.push('/(tabs)/settings')}
                  style={({ pressed }) => [styles.keyStatusPill, pressed && { opacity: 0.75 }]}
                >
                  <View style={styles.statusDot} />
                  <Text style={styles.keyStatusText}>连接助手</Text>
                </Pressable>
              ) : null}
              <Pressable
                id="btn-new-library"
                onPress={() => setCreateModalOpen(true)}
                style={({ pressed }) => [styles.newLibBtn, pressed && { opacity: 0.85 }]}
              >
                <Feather name="plus" size={16} color={Palette.inkInverse} />
                <Text style={styles.newLibBtnText}>新建</Text>
              </Pressable>
            </View>
          </View>
        </View>

        {/* 全局搜索 */}
        <View style={styles.searchBar}>
          <Feather name="search" size={16} color={Palette.inkMuted} />
          <TextInput
            id="input-global-search"
            value={globalSearch}
            onChangeText={setGlobalSearch}
            placeholder="搜索全部记录..."
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
                  onPress={() => router.push(`/entry/${hit.id}`)}
                  style={[
                    styles.searchHitRow,
                    idx === searchHits.length - 1 && { borderBottomWidth: 0 },
                  ]}
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

        {/* 我的记录本 */}
        <View style={styles.sectionRow}>
          <Text style={styles.sectionHeading}>记录本</Text>
          <Pressable hitSlop={8} onPress={() => router.push('/(tabs)/ai-studio')}>
            <Text style={styles.linkAction}>让助手定制 →</Text>
          </Pressable>
        </View>

        <View style={styles.libGrid}>
          {libraries.map((lib) => {
            const tone = ToneMap[lib.color] ?? ToneMap.teal;

            return (
              <Pressable
                key={lib.id}
                onPress={() => router.push(`/library/${lib.slug}`)}
                onLongPress={() => setManagingLibrary(lib)}
                style={({ pressed }) => [styles.libCard, pressed && styles.libCardPressed]}
              >
                <View style={styles.libCardTop}>
                  <View style={[styles.libIconWrap, { backgroundColor: tone.soft }]}>
                    <Text style={styles.libEmoji}>{lib.icon}</Text>
                  </View>
                  <View style={styles.countPill}>
                    <Text style={styles.countText}>{lib.entryCount} 条</Text>
                  </View>
                </View>

                <Text style={styles.libName} numberOfLines={1}>
                  {lib.name}
                </Text>
                <Text style={styles.libDesc} numberOfLines={2}>
                  {lib.description || '点击查看全部记录'}
                </Text>
              </Pressable>
            );
          })}

          {libraries.length === 0 || libraries.length % 2 === 1 ? (
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

        {/* 统计一览 */}
        <View style={styles.sectionRow}>
          <Text style={styles.sectionHeading}>统计一览</Text>
          <Pressable hitSlop={8} onPress={() => router.push('/(tabs)/ai-studio')}>
            <Text style={styles.linkAction}>提问生成 →</Text>
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

      {/* 底部随手记唤醒条 */}
      <View style={styles.omniDockWrap}>
        <Pressable
          id="btn-open-omni-bar"
          onPress={() => openOmniCapture(undefined)}
          style={({ pressed }) => [styles.omniDockBtn, pressed && { opacity: 0.92, transform: [{ scale: 0.99 }] }]}
        >
          <View style={styles.omniSparkIcon}>
            <Feather name="edit-3" size={15} color={Palette.inkInverse} />
          </View>
          <Text style={styles.omniDockPlaceholder} numberOfLines={1}>
            记一笔... 说句话、拍小票或贴链接
          </Text>
          <View style={styles.omniRightIcons}>
            <Feather name="mic" size={16} color={Palette.inkMuted} />
            <Feather name="camera" size={16} color={Palette.brand} />
          </View>
        </Pressable>
      </View>

      <SchemaEditorModal
        visible={createModalOpen || Boolean(managingLibrary)}
        existingLibrary={managingLibrary}
        onClose={() => {
          setCreateModalOpen(false);
          setManagingLibrary(null);
        }}
        onSaved={(newSlug) => {
          if (!managingLibrary) {
            router.push(`/library/${newSlug}`);
          }
        }}
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
  topHeaderBlock: {
    paddingTop: 4,
  },
  topHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  brandBlock: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  brandTitle: {
    fontSize: 25,
    fontWeight: '800',
    color: Palette.inkPrimary,
    letterSpacing: -0.5,
  },
  brandSubtitle: {
    fontSize: 13,
    color: Palette.inkMuted,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: 8,
  },
  keyStatusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 11,
    paddingVertical: 8,
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
    gap: 4,
    backgroundColor: Palette.brand,
    paddingHorizontal: 14,
    paddingVertical: 8,
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
    bottom: 14,
    alignItems: 'center',
  },
  omniDockBtn: {
    width: '100%',
    maxWidth: 680,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    backgroundColor: Palette.bgSurface,
    paddingLeft: 10,
    paddingRight: 16,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.1,
    shadowRadius: 18,
    elevation: 6,
  },
  omniSparkIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: Palette.brand,
    alignItems: 'center',
    justifyContent: 'center',
  },
  omniDockPlaceholder: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    color: Palette.inkSecondary,
  },
  omniRightIcons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
});
