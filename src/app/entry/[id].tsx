import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  DynamicEntryFormModal,
  type LockedRelationContext,
} from '@/components/dynamic-renderer/DynamicEntryFormModal';
import { formatFieldDisplay } from '@/components/dynamic-renderer/DynamicViews';
import { HighlightTonePalette, Palette, ToneMap } from '@/constants/design-tokens';
import { useOmni } from '@/context/omni-context';
import type { ChildLibrarySection, LibraryRecord } from '@/db/repository';
import { formatLocalDate } from '@/engine/date';
import { resolveImageUri, savePickedImageToStorage } from '@/engine/image-storage';

export default function EntryDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { repo, revision, openOmniCapture } = useOmni();

  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [subModalTarget, setSubModalTarget] = useState<{
    childLibrary: LibraryRecord;
    lockedRelation: LockedRelationContext;
    initialData?: Record<string, unknown>;
  } | null>(null);

  const [quickTexts, setQuickTexts] = useState<Record<string, string>>({});
  const [quickImages, setQuickImages] = useState<Record<string, string>>({});
  const [quickError, setQuickError] = useState<string | null>(null);

  const entryIdStr = id ? String(id) : '';
  const hydratedBundle =
    !repo || revision < 0 || !entryIdStr ? null : repo.getHydratedEntryById(entryIdStr);

  if (!hydratedBundle || !repo) {
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
  const childSections: ChildLibrarySection[] = repo.listChildSectionsForEntry(
    entry.id,
    library.slug
  );
  const childSlugSet = new Set(childSections.map((s) => s.childLibrary.slug));
  const otherBacklinks = entry.backlinks.filter((bl) => !childSlugSet.has(bl.librarySlug));

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
    repo.deleteEntry(entry.id);
    router.back();
  };

  const handleOpenSubModal = (
    section: ChildLibrarySection,
    prefill?: Record<string, unknown>
  ) => {
    setSubModalTarget({
      childLibrary: section.childLibrary,
      lockedRelation: {
        fieldKey: section.relationFieldKey,
        targetEntryId: entry.id,
        targetTitle: entry.titleSummary,
        targetLibraryIcon: library.icon,
      },
      initialData: prefill,
    });
  };

  const handlePickQuickImage = async (childSlug: string) => {
    try {
      setQuickError(null);
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.85,
        base64: Platform.OS === 'web',
      });
      if (!res.canceled && res.assets[0]) {
        const storedPath = await savePickedImageToStorage(res.assets[0]);
        setQuickImages((prev) => ({ ...prev, [childSlug]: storedPath }));
      }
    } catch (err) {
      setQuickError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleQuickAddSubEntry = (section: ChildLibrarySection) => {
    const { childLibrary, relationFieldKey } = section;
    const textVal = (quickTexts[childLibrary.slug] ?? '').trim();
    const imgVal = quickImages[childLibrary.slug] ?? '';

    const quickTextField =
      childLibrary.fields.find((f) => f.type === 'text' && f.multiline) ??
      childLibrary.fields.find(
        (f) => f.type === 'text' && f.key === childLibrary.views.card.titleFieldKey
      ) ??
      childLibrary.fields.find((f) => f.type === 'text');
    const quickDateField = childLibrary.fields.find((f) => f.type === 'date');
    const quickImageField = childLibrary.fields.find((f) => f.type === 'image');

    if (!textVal && !imgVal) {
      handleOpenSubModal(section);
      return;
    }

    const payload: Record<string, unknown> = {
      [relationFieldKey]: [entry.id],
    };
    if (quickDateField) {
      payload[quickDateField.key] = formatLocalDate();
    }
    if (quickTextField && textVal) {
      payload[quickTextField.key] = textVal;
    }
    if (quickImageField && imgVal) {
      payload[quickImageField.key] = imgVal;
    }

    // 自动补齐必填单选默认值；若有未填的必填数值等字段，平滑打开完整弹窗继续补充
    let hasMissingRequired = false;
    for (const f of childLibrary.fields) {
      if (f.type === 'rollup' || f.type === 'formula' || !f.required) continue;
      if (payload[f.key] !== undefined && payload[f.key] !== '') continue;
      if (f.type === 'select' && f.options?.length) {
        payload[f.key] = f.options[0].value;
      } else {
        hasMissingRequired = true;
      }
    }

    if (hasMissingRequired) {
      handleOpenSubModal(section, payload);
      return;
    }

    try {
      setQuickError(null);
      repo.createEntry(childLibrary.slug, payload);
      setQuickTexts((prev) => ({ ...prev, [childLibrary.slug]: '' }));
      setQuickImages((prev) => ({ ...prev, [childLibrary.slug]: '' }));
    } catch (err) {
      setQuickError(err instanceof Error ? err.message : String(err));
    }
  };

  const entryAiContext = {
    entryId: entry.id,
    title: entry.titleSummary,
    librarySlug: library.slug,
    libraryName: library.name,
    libraryIcon: library.icon,
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
            <Text style={styles.confirmDelText}>
              {entry.backlinks.length > 0
                ? `确认删除（保留${entry.backlinks.length}条关联）`
                : '确认删除'}
            </Text>
          </Pressable>
        ) : (
          <Pressable onPress={() => setConfirmDelete(true)} style={styles.iconBtn}>
            <Feather name="trash-2" size={17} color={Palette.danger} />
          </Pressable>
        )}
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.container, { paddingBottom: 92 + insets.bottom }]}
        keyboardShouldPersistTaps="handled"
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
            const isLast = idx === baseFields.length - 1;
            if (f.type === 'image' && val) {
              return (
                <View
                  key={f.key}
                  style={[styles.imageFieldBlock, !isLast && styles.blockDivider]}
                >
                  <Text style={styles.fieldKeyLabel}>{f.label}</Text>
                  <Image
                    source={{ uri: resolveImageUri(val) }}
                    style={styles.detailImage}
                    contentFit="cover"
                  />
                </View>
              );
            }
            if (f.type === 'text' && f.multiline) {
              return (
                <View
                  key={f.key}
                  style={[styles.multilineFieldBlock, !isLast && styles.blockDivider]}
                >
                  <Text style={styles.fieldKeyLabel}>{f.label}</Text>
                  <Text style={styles.multilineValText}>
                    {val ? String(val) : '—'}
                  </Text>
                </View>
              );
            }
            return (
              <View
                key={f.key}
                style={[styles.kvRow, isLast && { borderBottomWidth: 0 }]}
              >
                <Text style={styles.fieldKeyLabel}>{f.label}</Text>
                <Text style={styles.fieldValText}>{formatFieldDisplay(f, val)}</Text>
              </View>
            );
          })}
        </View>

        {/* 附属子记录本：原位快记 + 阅读/跟进时间轴 */}
        {childSections.map((section) => {
          const { childLibrary, entries: subEntries } = section;
          const subTone = ToneMap[childLibrary.color] ?? ToneMap.teal;
          const fieldMap = new Map(childLibrary.fields.map((f) => [f.key, f]));
          const quickTextField =
            childLibrary.fields.find((f) => f.type === 'text' && f.multiline) ??
            childLibrary.fields.find(
              (f) => f.type === 'text' && f.key === childLibrary.views.card.titleFieldKey
            ) ??
            childLibrary.fields.find((f) => f.type === 'text');
          const quickImageField = childLibrary.fields.find((f) => f.type === 'image');
          const dateField = childLibrary.fields.find((f) => f.type === 'date');
          const badgeField = childLibrary.views.card.rightBadgeFieldKey
            ? fieldMap.get(childLibrary.views.card.rightBadgeFieldKey)
            : undefined;

          const draftText = quickTexts[childLibrary.slug] ?? '';
          const draftImg = quickImages[childLibrary.slug] ?? '';

          return (
            <View key={childLibrary.id} style={styles.sectionCard}>
              <View style={styles.subSectionHeader}>
                <Pressable
                  onPress={() => router.push(`/library/${childLibrary.slug}`)}
                  style={styles.sectionHeader}
                >
                  <Text style={styles.sectionTitle}>
                    {childLibrary.icon} {childLibrary.name} ({subEntries.length})
                  </Text>
                  <Feather name="chevron-right" size={15} color={Palette.inkMuted} />
                </Pressable>

                <Pressable
                  onPress={() => handleOpenSubModal(section)}
                  style={[styles.subAddBtn, { backgroundColor: subTone.soft }]}
                >
                  <Feather name="plus" size={14} color={subTone.ink} />
                  <Text style={[styles.subAddBtnText, { color: subTone.ink }]}>记完整记录</Text>
                </Pressable>
              </View>

              {/* 原位极速图文随手记（免弹窗） */}
              {quickTextField || quickImageField ? (
                <View style={styles.quickComposer}>
                  {quickTextField ? (
                    <TextInput
                      value={draftText}
                      onChangeText={(txt) =>
                        setQuickTexts((prev) => ({ ...prev, [childLibrary.slug]: txt }))
                      }
                      multiline
                      placeholder={
                        quickTextField.placeholder ||
                        `随手记一段${childLibrary.name}、书摘或想法...`
                      }
                      placeholderTextColor={Palette.inkMuted}
                      style={styles.quickInput}
                    />
                  ) : null}

                  {draftImg ? (
                    <View style={styles.quickImgPreviewRow}>
                      <Image
                        source={{ uri: resolveImageUri(draftImg) }}
                        style={styles.quickImgThumb}
                        contentFit="cover"
                      />
                      <Pressable
                        onPress={() =>
                          setQuickImages((prev) => ({ ...prev, [childLibrary.slug]: '' }))
                        }
                      >
                        <Feather name="x-circle" size={17} color={Palette.danger} />
                      </Pressable>
                    </View>
                  ) : null}

                  <View style={styles.quickActionsBar}>
                    {quickImageField ? (
                      <Pressable
                        onPress={() => handlePickQuickImage(childLibrary.slug)}
                        style={styles.quickToolChip}
                      >
                        <Feather name="image" size={14} color={subTone.ink} />
                        <Text style={[styles.quickToolText, { color: subTone.ink }]}>
                          {quickImageField.label}
                        </Text>
                      </Pressable>
                    ) : (
                      <View />
                    )}

                    <Pressable
                      onPress={() => handleQuickAddSubEntry(section)}
                      style={[
                        styles.quickSubmitBtn,
                        { backgroundColor: subTone.solid },
                        !draftText.trim() && !draftImg && { opacity: 0.72 },
                      ]}
                    >
                      <Feather name="check" size={13} color={Palette.inkInverse} />
                      <Text style={styles.quickSubmitText}>
                        {draftText.trim() || draftImg ? '极速记一笔' : '填写进度'}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}

              {quickError ? (
                <Text style={styles.quickErrorText}>{quickError}</Text>
              ) : null}

              {/* 时间轴明细流 */}
              {subEntries.length === 0 ? (
                <Text style={styles.mutedText}>
                  还没有{childLibrary.name}，可在上方随手摘抄一句，或点右上角记录进度指标
                </Text>
              ) : (
                <View style={styles.timelineList}>
                  {subEntries.map((sub, idx) => {
                    const isLastItem = idx === subEntries.length - 1;
                    const dateVal = dateField
                      ? String(sub.computedData[dateField.key] ?? '')
                      : new Date(sub.createdAt).toLocaleDateString('zh-CN');
                    const badgeVal = badgeField ? sub.computedData[badgeField.key] : undefined;
                    const matchedBadgeColor = badgeField?.options?.find(
                      (o) => o.value === String(badgeVal)
                    )?.color;

                    // 提取非空的结构化数值/评分指标（若未填页码/时长则不渲染空胶囊，保持纯书摘卡片清爽）
                    const metricKeys =
                      childLibrary.views.card.footerMetricKeys.length > 0
                        ? childLibrary.views.card.footerMetricKeys
                        : childLibrary.fields
                            .filter(
                              (f) =>
                                f.type === 'number' ||
                                f.type === 'currency' ||
                                f.type === 'rating' ||
                                f.type === 'formula'
                            )
                            .map((f) => f.key)
                            .slice(0, 3);

                    const activeMetrics = metricKeys
                      .map((mk) => {
                        const mf = fieldMap.get(mk);
                        if (!mf || mf.type === 'date') return null;
                        const raw = sub.computedData[mk];
                        if (raw === undefined || raw === null || raw === '' || raw === 0) {
                          return null;
                        }
                        return {
                          key: mk,
                          label: mf.label,
                          display: formatFieldDisplay(mf, raw),
                        };
                      })
                      .filter(Boolean) as Array<{ key: string; label: string; display: string }>;

                    const primaryNoteText = quickTextField
                      ? String(sub.computedData[quickTextField.key] ?? '').trim()
                      : '';
                    const bodyText = primaryNoteText || sub.titleSummary;

                    const imgKey =
                      childLibrary.views.card.coverImageFieldKey ?? quickImageField?.key;
                    const imgUri = imgKey ? resolveImageUri(sub.computedData[imgKey]) : '';

                    return (
                      <View key={sub.id} style={styles.timelineRow}>
                        <View style={styles.timelineRailCol}>
                          <View
                            style={[styles.timelineDot, { backgroundColor: subTone.solid }]}
                          />
                          {!isLastItem ? <View style={styles.timelineLine} /> : null}
                        </View>

                        <Pressable
                          onPress={() => router.push(`/entry/${sub.id}`)}
                          style={({ pressed }) => [
                            styles.timelineCard,
                            pressed && { opacity: 0.82 },
                          ]}
                        >
                          <View style={styles.timelineMetaRow}>
                            <Text style={styles.timelineDateText}>{dateVal || '记录'}</Text>
                            {badgeVal !== undefined && badgeVal !== '' ? (
                              <View
                                style={[
                                  styles.timelineBadge,
                                  {
                                    backgroundColor: matchedBadgeColor
                                      ? `${matchedBadgeColor}18`
                                      : subTone.soft,
                                  },
                                ]}
                              >
                                <Text
                                  style={[
                                    styles.timelineBadgeText,
                                    { color: matchedBadgeColor || subTone.ink },
                                  ]}
                                >
                                  {formatFieldDisplay(badgeField, badgeVal)}
                                </Text>
                              </View>
                            ) : null}
                          </View>

                          {activeMetrics.length > 0 ? (
                            <View style={styles.timelineMetricsRow}>
                              {activeMetrics.map((m) => (
                                <View key={m.key} style={styles.timelineMetricChip}>
                                  <Text style={styles.timelineMetricText}>
                                    {m.label} {m.display}
                                  </Text>
                                </View>
                              ))}
                            </View>
                          ) : null}

                          {bodyText ? (
                            <Text style={styles.timelineBodyText} numberOfLines={8}>
                              {bodyText}
                            </Text>
                          ) : null}

                          {imgUri ? (
                            <Image
                              source={{ uri: imgUri }}
                              style={styles.timelinePhoto}
                              contentFit="cover"
                            />
                          ) : null}
                        </Pressable>
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          );
        })}

        {/* 正向关联内容 */}
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

        {/* 其他跨表弱关联引用 */}
        {otherBacklinks.length > 0 ? (
          <View style={styles.sectionCard}>
            <View style={styles.sectionHeader}>
              <Feather name="corner-down-right" size={15} color={Palette.inkSecondary} />
              <Text style={styles.sectionTitle}>相关引用 ({otherBacklinks.length})</Text>
            </View>
            {otherBacklinks.map((bl) => (
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

      {/* 右下角悬浮随手说：自动携带当前主记录上下文（点击打字/拍书页，长按语音） */}
      <Pressable
        accessibilityLabel="针对当前记录随手说"
        onPress={() => openOmniCapture(library.slug, 'text', entryAiContext)}
        onLongPress={() => openOmniCapture(library.slug, 'voice', entryAiContext)}
        style={({ pressed }) => [
          styles.fabBtn,
          { bottom: Math.max(insets.bottom, 16) + 8, backgroundColor: tone.solid },
          pressed && { opacity: 0.9, transform: [{ scale: 0.94 }] },
        ]}
      >
        <Feather name="message-circle" size={24} color={Palette.inkInverse} />
      </Pressable>

      <DynamicEntryFormModal
        visible={editOpen}
        library={library}
        initialData={entry.rawData}
        editingEntryId={entry.id}
        onClose={() => setEditOpen(false)}
      />

      {subModalTarget ? (
        <DynamicEntryFormModal
          visible={Boolean(subModalTarget)}
          library={subModalTarget.childLibrary}
          initialData={subModalTarget.initialData}
          lockedRelation={subModalTarget.lockedRelation}
          onClose={() => setSubModalTarget(null)}
          onSaved={() => {
            const targetSlug = subModalTarget.childLibrary.slug;
            setQuickTexts((prev) => ({ ...prev, [targetSlug]: '' }));
            setQuickImages((prev) => ({ ...prev, [targetSlug]: '' }));
          }}
        />
      ) : null}
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
    paddingHorizontal: 11,
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
    lineHeight: 28,
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
  subSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: Palette.inkPrimary,
  },
  subAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
  },
  subAddBtnText: {
    fontSize: 12,
    fontWeight: '700',
  },
  computedGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  computedTile: {
    flex: 1,
    minWidth: 140,
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
  kvRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: Palette.borderHairline,
    gap: 12,
  },
  blockDivider: {
    borderBottomWidth: 1,
    borderBottomColor: Palette.borderHairline,
    paddingBottom: 12,
  },
  multilineFieldBlock: {
    gap: 6,
    paddingVertical: 4,
  },
  multilineValText: {
    fontSize: 14,
    lineHeight: 22,
    color: Palette.inkPrimary,
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
  quickComposer: {
    backgroundColor: Palette.bgCanvas,
    borderRadius: 14,
    padding: 11,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 9,
  },
  quickInput: {
    minHeight: 54,
    fontSize: 14,
    lineHeight: 20,
    color: Palette.inkPrimary,
    textAlignVertical: 'top',
    padding: 0,
  },
  quickImgPreviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  quickImgThumb: {
    width: 48,
    height: 48,
    borderRadius: 8,
  },
  quickActionsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  quickToolChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  quickToolText: {
    fontSize: 12,
    fontWeight: '600',
  },
  quickSubmitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
  },
  quickSubmitText: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.inkInverse,
  },
  quickErrorText: {
    fontSize: 12,
    color: Palette.danger,
    fontWeight: '600',
  },
  timelineList: {
    marginTop: 2,
  },
  timelineRow: {
    flexDirection: 'row',
    gap: 11,
  },
  timelineRailCol: {
    width: 14,
    alignItems: 'center',
  },
  timelineDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    marginTop: 14,
  },
  timelineLine: {
    flex: 1,
    width: 2,
    backgroundColor: Palette.borderHairline,
    marginVertical: 3,
  },
  timelineCard: {
    flex: 1,
    backgroundColor: Palette.bgCanvas,
    borderRadius: 14,
    padding: 13,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    marginBottom: 10,
    gap: 7,
  },
  timelineMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  timelineDateText: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.inkSecondary,
  },
  timelineBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  timelineBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  timelineMetricsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  timelineMetricChip: {
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 7,
  },
  timelineMetricText: {
    fontSize: 11,
    fontWeight: '700',
    color: Palette.inkSecondary,
  },
  timelineBodyText: {
    fontSize: 14,
    lineHeight: 21,
    color: Palette.inkPrimary,
  },
  timelinePhoto: {
    width: '100%',
    height: 150,
    borderRadius: 10,
    backgroundColor: Palette.bgSubtle,
    marginTop: 2,
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
});
