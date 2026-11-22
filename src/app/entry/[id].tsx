import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { DynamicEntryFormModal } from '@/components/dynamic-renderer/DynamicEntryFormModal';
import { formatFieldDisplay } from '@/components/dynamic-renderer/DynamicViews';
import { HighlightTonePalette, Palette, ToneMap } from '@/constants/design-tokens';
import { useOmni } from '@/context/omni-context';
import { resolveImageUri } from '@/engine/image-storage';

export default function EntryDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { repo, revision } = useOmni();
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const hydratedBundle =
    !repo || revision < 0 || !id ? null : repo.getHydratedEntryById(String(id));

  if (!hydratedBundle) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>该记录不存在或已被删除</Text>
          <Pressable onPress={() => router.back()} style={styles.primaryPill}>
            <Text style={styles.primaryPillText}>返回上一页</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const { entry, library } = hydratedBundle;
  const tone = ToneMap[library.color] ?? ToneMap.teal;
  const hl = entry.highlight ? HighlightTonePalette[entry.highlight.tone] : null;

  const baseFields = library.fields.filter(
    (f) => f.type !== 'relation' && f.type !== 'rollup' && f.type !== 'formula'
  );
  const computedFields = library.fields.filter(
    (f) => f.type === 'rollup' || f.type === 'formula'
  );
  const relationFields = library.fields.filter((f) => f.type === 'relation');

  const handleDelete = () => {
    if (!repo) return;
    repo.deleteEntry(entry.id);
    router.back();
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      {/* 顶部栏 */}
      <View style={styles.topNav}>
        <Pressable onPress={() => router.back()} style={styles.iconBtn}>
          <Feather name="arrow-left" size={19} color={Palette.inkPrimary} />
        </Pressable>

        <Pressable
          onPress={() => router.push(`/library/${library.slug}`)}
          style={[styles.libTagBtn, { backgroundColor: tone.soft }]}
        >
          <Text style={[styles.libTagText, { color: tone.ink }]}>
            {library.icon} {library.name}
          </Text>
        </Pressable>

        <View style={{ flex: 1 }} />

        <Pressable onPress={() => setEditOpen(true)} style={styles.editBtn}>
          <Feather name="edit-2" size={14} color={Palette.inkPrimary} />
          <Text style={styles.editBtnText}>编辑</Text>
        </Pressable>

        {confirmDelete ? (
          <Pressable onPress={handleDelete} style={styles.confirmDelBtn}>
            <Text style={styles.confirmDelText}>确认删除</Text>
          </Pressable>
        ) : (
          <Pressable onPress={() => setConfirmDelete(true)} style={styles.iconBtn}>
            <Feather name="trash-2" size={17} color={Palette.danger} />
          </Pressable>
        )}
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.container, { paddingBottom: 32 + insets.bottom }]}
      >
        {/* 主标题卡 */}
        <View style={[styles.heroCard, hl && { backgroundColor: hl.bg }]}>
          <View style={styles.heroTopRow}>
            <Text style={styles.heroTitle}>{entry.titleSummary}</Text>
            {entry.highlight?.badgeText && hl ? (
              <View style={[styles.alertPill, { backgroundColor: hl.pillBg }]}>
                <Text style={[styles.alertText, { color: hl.pillInk }]}>
                  {entry.highlight.badgeText}
                </Text>
              </View>
            ) : null}
          </View>
          <Text style={styles.timestampText}>
            更新于 {new Date(entry.updatedAt).toLocaleString('zh-CN')}
          </Text>
        </View>

        {/* 自动统计指标 */}
        {computedFields.length > 0 ? (
          <View style={styles.sectionCard}>
            <View style={styles.sectionHeader}>
              <Feather name="activity" size={15} color={tone.solid} />
              <Text style={styles.sectionTitle}>自动统计</Text>
            </View>
            <View style={styles.computedGrid}>
              {computedFields.map((cf) => (
                <View key={cf.key} style={[styles.computedTile, { backgroundColor: tone.soft }]}>
                  <Text style={styles.computedLabel}>{cf.label}</Text>
                  <Text style={[styles.computedVal, { color: tone.ink }]}>
                    {formatFieldDisplay(cf, entry.computedData[cf.key])}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* 详细信息 */}
        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>详细信息</Text>
          {baseFields.map((f, idx) => {
            const val = entry.computedData[f.key];
            if (f.type === 'image' && val) {
              return (
                <View key={f.key} style={styles.imageFieldBlock}>
                  <Text style={styles.fieldKeyLabel}>{f.label}</Text>
                  <Image
                    source={{ uri: resolveImageUri(val) }}
                    style={styles.detailImage}
                    contentFit="cover"
                  />
                </View>
              );
            }
            return (
              <View
                key={f.key}
                style={[styles.kvRow, idx === baseFields.length - 1 && { borderBottomWidth: 0 }]}
              >
                <Text style={styles.fieldKeyLabel}>{f.label}</Text>
                <Text style={styles.fieldValText}>{formatFieldDisplay(f, val)}</Text>
              </View>
            );
          })}
        </View>

        {/* 关联内容 */}
        {relationFields.length > 0 ? (
          <View style={styles.sectionCard}>
            <View style={styles.sectionHeader}>
              <Feather name="link-2" size={15} color={Palette.brand} />
              <Text style={styles.sectionTitle}>关联内容</Text>
            </View>
            {relationFields.map((rf) => {
              const refs = entry.forwardLinks[rf.key] ?? [];
              return (
                <View key={rf.key} style={styles.relGroup}>
                  <Text style={styles.fieldKeyLabel}>{rf.label}</Text>
                  {refs.length === 0 ? (
                    <Text style={styles.mutedText}>暂未关联</Text>
                  ) : (
                    refs.map((ref) => (
                      <Pressable
                        key={ref.id}
                        onPress={() => router.push(`/entry/${ref.id}`)}
                        style={({ pressed }) => [styles.linkCard, pressed && { opacity: 0.78 }]}
                      >
                        <Text style={styles.linkTitle}>
                          {ref.libraryIcon} {ref.title}
                        </Text>
                        <View style={styles.linkRight}>
                          <Text style={styles.linkLibName}>{ref.libraryName}</Text>
                          <Feather name="chevron-right" size={15} color={Palette.inkMuted} />
                        </View>
                      </Pressable>
                    ))
                  )}
                </View>
              );
            })}
          </View>
        ) : null}

        {/* 相关引用 */}
        {entry.backlinks.length > 0 ? (
          <View style={styles.sectionCard}>
            <View style={styles.sectionHeader}>
              <Feather name="corner-down-right" size={15} color={Palette.inkSecondary} />
              <Text style={styles.sectionTitle}>相关引用 ({entry.backlinks.length})</Text>
            </View>
            {entry.backlinks.map((bl) => (
              <Pressable
                key={`${bl.fieldKey}-${bl.id}`}
                onPress={() => router.push(`/entry/${bl.id}`)}
                style={({ pressed }) => [styles.linkCard, pressed && { opacity: 0.78 }]}
              >
                <Text style={styles.linkTitle}>
                  {bl.libraryIcon} {bl.title}
                </Text>
                <View style={styles.linkRight}>
                  <Text style={styles.linkLibName}>{bl.libraryName}</Text>
                  <Feather name="chevron-right" size={15} color={Palette.inkMuted} />
                </View>
              </Pressable>
            ))}
          </View>
        ) : null}
      </ScrollView>

      <DynamicEntryFormModal
        visible={editOpen}
        library={library}
        initialData={entry.rawData}
        editingEntryId={entry.id}
        onClose={() => setEditOpen(false)}
      />
    </SafeAreaView>
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
  topNav: {
    width: '100%',
    maxWidth: 820,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: Palette.bgSurface,
    borderBottomWidth: 1,
    borderBottomColor: Palette.borderHairline,
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
  confirmDelBtn: {
    backgroundColor: Palette.danger,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
  },
  confirmDelText: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.inkInverse,
  },
  scroll: {
    flex: 1,
  },
  container: {
    width: '100%',
    maxWidth: 820,
    alignSelf: 'center',
    padding: 16,
    paddingBottom: 48,
    gap: 14,
  },
  heroCard: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 18,
    padding: 18,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 6,
  },
  heroTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  heroTitle: {
    flex: 1,
    fontSize: 21,
    fontWeight: '800',
    color: Palette.inkPrimary,
  },
  alertPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  alertText: {
    fontSize: 12,
    fontWeight: '700',
  },
  timestampText: {
    fontSize: 12,
    color: Palette.inkMuted,
  },
  sectionCard: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 12,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: Palette.inkPrimary,
  },
  computedGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  computedTile: {
    flex: 1,
    minWidth: 150,
    padding: 13,
    borderRadius: 14,
    gap: 4,
  },
  computedLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.inkSecondary,
  },
  computedVal: {
    fontSize: 20,
    fontWeight: '800',
  },
  computedRule: {
    fontSize: 11,
    color: Palette.inkMuted,
  },
  kvRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: Palette.borderHairline,
    gap: 12,
  },
  fieldKeyLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  fieldValText: {
    flex: 1,
    textAlign: 'right',
    fontSize: 14,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  imageFieldBlock: {
    gap: 8,
    paddingVertical: 6,
  },
  detailImage: {
    width: '100%',
    height: 220,
    borderRadius: 14,
    backgroundColor: Palette.bgSubtle,
  },
  relGroup: {
    gap: 8,
  },
  mutedText: {
    fontSize: 13,
    color: Palette.inkMuted,
    lineHeight: 19,
  },
  linkCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Palette.bgCanvas,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  linkTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  linkRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  linkLibName: {
    fontSize: 12,
    color: Palette.inkSecondary,
    fontWeight: '600',
  },
});
