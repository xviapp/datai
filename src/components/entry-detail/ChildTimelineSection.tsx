import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { formatFieldDisplay } from '@/components/dynamic-renderer/DynamicViews';
import { Palette, ToneMap } from '@/constants/design-tokens';
import { useRepository } from '@/context/omni-context';
import type { ChildLibrarySection, LibraryRecord } from '@/db/models';
import { formatLocalDate } from '@/engine/date';
import {
  pickImageAsset,
  resolveImageUri,
  savePickedImageToStorage,
} from '@/engine/image-storage';

export interface ChildTimelineSectionProps {
  parentEntryId: string;
  section: ChildLibrarySection;
  /** 外部完整表单保存成功后自增，触发清空当前原位草稿 */
  clearDraftToken: number;
  onOpenLibrary: (slug: string) => void;
  onOpenEntry: (entryId: string) => void;
  onOpenFullModal: (
    childLibrary: LibraryRecord,
    relationFieldKey: string,
    prefill?: Record<string, unknown>
  ) => void;
  onPreviewImage: (uri: string, caption?: string) => void;
}

export function ChildTimelineSection({
  parentEntryId,
  section,
  clearDraftToken,
  onOpenLibrary,
  onOpenEntry,
  onOpenFullModal,
  onPreviewImage,
}: ChildTimelineSectionProps) {
  const { repo } = useRepository();
  const { childLibrary, relationFieldKey, entries: subEntries } = section;
  const subTone = ToneMap[childLibrary.color] ?? ToneMap.teal;

  const [draftText, setDraftText] = useState('');
  const [draftImg, setDraftImg] = useState('');
  const [quickError, setQuickError] = useState<string | null>(null);
  const [prevClearToken, setPrevClearToken] = useState(clearDraftToken);
  if (prevClearToken !== clearDraftToken) {
    setPrevClearToken(clearDraftToken);
    if (clearDraftToken > 0) {
      setDraftText('');
      setDraftImg('');
      setQuickError(null);
    }
  }

  const fieldMap = useMemo(
    () => new Map(childLibrary.fields.map((f) => [f.key, f])),
    [childLibrary.fields]
  );

  const quickTextField = useMemo(
    () =>
      childLibrary.fields.find((f) => f.type === 'text' && f.multiline) ??
      childLibrary.fields.find(
        (f) => f.type === 'text' && f.key === childLibrary.views.card.titleFieldKey
      ) ??
      childLibrary.fields.find((f) => f.type === 'text'),
    [childLibrary.fields, childLibrary.views.card.titleFieldKey]
  );
  const quickImageField = useMemo(
    () => childLibrary.fields.find((f) => f.type === 'image'),
    [childLibrary.fields]
  );
  const dateField = useMemo(
    () => childLibrary.fields.find((f) => f.type === 'date'),
    [childLibrary.fields]
  );
  const badgeField = childLibrary.views.card.rightBadgeFieldKey
    ? fieldMap.get(childLibrary.views.card.rightBadgeFieldKey)
    : undefined;

  const handlePickQuickImage = async () => {
    try {
      setQuickError(null);
      const asset = await pickImageAsset(false);
      if (asset) {
        const storedPath = await savePickedImageToStorage(asset);
        setDraftImg(storedPath);
      }
    } catch (err) {
      setQuickError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleQuickAdd = () => {
    const textVal = draftText.trim();
    const imgVal = draftImg;

    if (!textVal && !imgVal) {
      onOpenFullModal(childLibrary, relationFieldKey);
      return;
    }

    const payload: Record<string, unknown> = {
      [relationFieldKey]: [parentEntryId],
    };
    if (dateField) {
      payload[dateField.key] = formatLocalDate();
    }
    if (quickTextField && textVal) {
      payload[quickTextField.key] = textVal;
    }
    if (quickImageField && imgVal) {
      payload[quickImageField.key] = imgVal;
    }

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
      onOpenFullModal(childLibrary, relationFieldKey, payload);
      return;
    }

    if (!repo) return;
    try {
      setQuickError(null);
      repo.createEntry(childLibrary.slug, payload);
      setDraftText('');
      setDraftImg('');
    } catch (err) {
      setQuickError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <View style={styles.sectionCard}>
      <View style={styles.subSectionHeader}>
        <Pressable
          onPress={() => onOpenLibrary(childLibrary.slug)}
          style={({ pressed }) => [styles.sectionHeader, pressed && { opacity: 0.72 }]}
        >
          <Text style={styles.sectionTitle}>
            {childLibrary.icon} {childLibrary.name} ({subEntries.length})
          </Text>
          <Feather name="chevron-right" size={15} color={Palette.inkMuted} />
        </Pressable>

        <Pressable
          onPress={() => onOpenFullModal(childLibrary, relationFieldKey)}
          style={[styles.subAddBtn, { backgroundColor: subTone.soft }]}
        >
          <Feather name="plus" size={14} color={subTone.ink} />
          <Text style={[styles.subAddBtnText, { color: subTone.ink }]}>记完整记录</Text>
        </Pressable>
      </View>

      {quickTextField || quickImageField ? (
        <View style={styles.quickComposer}>
          {quickTextField ? (
            <TextInput
              value={draftText}
              onChangeText={setDraftText}
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
              <Pressable onPress={() => setDraftImg('')}>
                <Feather name="x-circle" size={17} color={Palette.danger} />
              </Pressable>
            </View>
          ) : null}

          <View style={styles.quickActionsBar}>
            {quickImageField ? (
              <Pressable onPress={handlePickQuickImage} style={styles.quickToolChip}>
                <Feather name="image" size={14} color={subTone.ink} />
                <Text style={[styles.quickToolText, { color: subTone.ink }]}>
                  {quickImageField.label}
                </Text>
              </Pressable>
            ) : (
              <View />
            )}

            <Pressable
              onPress={handleQuickAdd}
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

      {quickError ? <Text style={styles.quickErrorText}>{quickError}</Text> : null}

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

            const imgKey = childLibrary.views.card.coverImageFieldKey ?? quickImageField?.key;
            const imgUri = imgKey ? resolveImageUri(sub.computedData[imgKey]) : '';

            return (
              <View key={sub.id} style={styles.timelineRow}>
                <View style={styles.timelineRailCol}>
                  <View style={[styles.timelineDot, { backgroundColor: subTone.solid }]} />
                  {!isLastItem ? <View style={styles.timelineLine} /> : null}
                </View>

                <Pressable
                  onPress={() => onOpenEntry(sub.id)}
                  style={({ pressed }) => [
                    styles.timelineCard,
                    pressed && { opacity: 0.82, transform: [{ scale: 0.988 }] },
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
                    <Pressable
                      onPress={(e) => {
                        e.stopPropagation();
                        onPreviewImage(imgUri, bodyText || dateVal);
                      }}
                      style={({ pressed }) => [pressed && { opacity: 0.85 }]}
                    >
                      <Image
                        source={{ uri: imgUri }}
                        style={styles.timelinePhoto}
                        contentFit="cover"
                      />
                    </Pressable>
                  ) : null}
                </Pressable>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionCard: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 12,
  },
  subSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
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
  mutedText: {
    fontSize: 13,
    color: Palette.inkMuted,
    lineHeight: 19,
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
});
