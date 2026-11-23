import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams } from 'expo-router';
import React, { type ComponentRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  type LayoutChangeEvent,
  LayoutAnimation,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  DynamicEntryFormModal,
  type LockedRelationContext,
} from '@/components/dynamic-renderer/DynamicEntryFormModal';
import { formatFieldDisplay } from '@/components/dynamic-renderer/DynamicViews';
import { ImagePreviewModal } from '@/components/ui/ImagePreviewModal';
import { SlidingSegmentedBar } from '@/components/ui/SlidingSegmentedBar';
import { HighlightTonePalette, Palette, ToneMap } from '@/constants/design-tokens';
import { useOmni } from '@/context/omni-context';
import type {
  BacklinkGroupSection,
  ChildLibrarySection,
  LibraryRecord,
} from '@/db/repository';
import { formatLocalDate } from '@/engine/date';
import { resolveImageUri, savePickedImageToStorage } from '@/engine/image-storage';
import { useSafeNavigation } from '@/utils/navigation';

type DetailTabItem =
  | { key: 'detail'; label: string; icon: 'file-text' }
  | {
      key: `child:${string}`;
      label: string;
      count: number;
      emoji: string;
      section: ChildLibrarySection;
    }
  | { key: 'backlinks'; label: string; count: number; icon: 'link-2' };

export default function EntryDetailScreen() {
  const { id, tab } = useLocalSearchParams<{ id: string; tab?: string }>();
  const nav = useSafeNavigation();
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const { repo, revision, openOmniCapture } = useOmni();

  const entryIdStr = id ? String(id) : '';
  const requestedTab = tab ? String(tab) : '';
  const routeSignature = `${entryIdStr}::${requestedTab}`;

  const [selectedTabKey, setSelectedTabKey] = useState<string>(() =>
    requestedTab ? requestedTab : 'detail'
  );
  const [prevRouteSignature, setPrevRouteSignature] = useState(routeSignature);
  if (prevRouteSignature !== routeSignature) {
    setPrevRouteSignature(routeSignature);
    setSelectedTabKey(requestedTab ? requestedTab : 'detail');
  }

  const [pagerWidth, setPagerWidth] = useState(screenWidth);
  const [pagerScrollX] = useState(() => new Animated.Value(0));
  const pagerRef = useRef<ComponentRef<typeof Animated.ScrollView>>(null);
  const chipsScrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const chipLayoutsRef = useRef<Record<number, { x: number; width: number }>>({});
  const programmaticScrollRef = useRef(false);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showEmptyFields, setShowEmptyFields] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ uri: string; caption?: string } | null>(null);
  const [subModalOpen, setSubModalOpen] = useState(false);
  const [subModalTarget, setSubModalTarget] = useState<{
    childLibrary: LibraryRecord;
    lockedRelation: LockedRelationContext;
    initialData?: Record<string, unknown>;
  } | null>(null);

  const [quickTexts, setQuickTexts] = useState<Record<string, string>>({});
  const [quickImages, setQuickImages] = useState<Record<string, string>>({});
  const [quickError, setQuickError] = useState<string | null>(null);

  const hydratedBundle = useMemo(
    () =>
      !repo || revision < 0 || !entryIdStr ? null : repo.getHydratedEntryById(entryIdStr),
    [repo, revision, entryIdStr]
  );

  const childSections: ChildLibrarySection[] = useMemo(() => {
    if (!repo || revision < 0 || !hydratedBundle) return [];
    return repo.listChildSectionsForEntry(
      hydratedBundle.entry.id,
      hydratedBundle.library.slug
    );
  }, [repo, revision, hydratedBundle]);

  const backlinkGroups: BacklinkGroupSection[] = useMemo(() => {
    if (!repo || revision < 0 || !hydratedBundle) return [];
    const childSlugSet = new Set(childSections.map((s) => s.childLibrary.slug));
    return repo.listBacklinkGroupsForEntry(hydratedBundle.entry.id, childSlugSet);
  }, [repo, revision, hydratedBundle, childSections]);

  const totalBacklinkCount = useMemo(
    () => backlinkGroups.reduce((sum, g) => sum + g.entries.length, 0),
    [backlinkGroups]
  );

  const detailTabs: DetailTabItem[] = useMemo(
    () => [
      { key: 'detail', label: '详情', icon: 'file-text' },
      ...childSections.map(
        (section): DetailTabItem => ({
          key: `child:${section.childLibrary.slug}`,
          label: section.childLibrary.name,
          count: section.entries.length,
          emoji: section.childLibrary.icon,
          section,
        })
      ),
      ...(totalBacklinkCount > 0
        ? ([
            {
              key: 'backlinks',
              label: childSections.length > 0 ? '关联引用' : '关联记录',
              count: totalBacklinkCount,
              icon: 'link-2',
            },
          ] as DetailTabItem[])
        : []),
    ],
    [childSections, totalBacklinkCount]
  );

  const hasMultipleTabs = detailTabs.length > 1;
  const activeTabKey = (() => {
    if (!hasMultipleTabs) return 'detail';
    if (selectedTabKey === 'relations') {
      return detailTabs[1]?.key ?? 'detail';
    }
    if (detailTabs.some((t) => t.key === selectedTabKey)) {
      return selectedTabKey;
    }
    return 'detail';
  })();

  const activeTabIndex = Math.max(
    0,
    detailTabs.findIndex((t) => t.key === activeTabKey)
  );
  const effectiveWidth = pagerWidth > 0 ? pagerWidth : screenWidth;

  const scrollChipIntoView = useCallback(
    (idx: number) => {
      const layout = chipLayoutsRef.current[idx];
      if (!layout || !chipsScrollRef.current) return;
      const targetX = Math.max(0, layout.x - effectiveWidth / 2 + layout.width / 2);
      chipsScrollRef.current.scrollTo({ x: targetX, animated: true });
    },
    [effectiveWidth]
  );

  // 路由切换或携带 ?tab=relations 进入时，立即对齐到对应分页
  useEffect(() => {
    if (!hasMultipleTabs) return;
    const targetX = activeTabIndex * effectiveWidth;
    pagerScrollX.setValue(targetX);
    const frame = requestAnimationFrame(() => {
      pagerRef.current?.scrollTo({ x: targetX, animated: false });
      scrollChipIntoView(activeTabIndex);
    });
    return () => cancelAnimationFrame(frame);
    // 仅在路由签名或分页宽度初始化变化时同步初始页
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeSignature, effectiveWidth, hasMultipleTabs]);

  // 手势左右滑动过半即时同步选中 Tab 与胶囊居中
  useEffect(() => {
    if (!hasMultipleTabs) return;
    const listenerId = pagerScrollX.addListener(({ value }) => {
      if (programmaticScrollRef.current) return;
      const nextIdx = Math.max(
        0,
        Math.min(detailTabs.length - 1, Math.round(value / Math.max(1, effectiveWidth)))
      );
      const nextTab = detailTabs[nextIdx];
      if (!nextTab) return;
      setSelectedTabKey((prev) => {
        if (prev === nextTab.key) return prev;
        scrollChipIntoView(nextIdx);
        return nextTab.key;
      });
    });
    return () => {
      pagerScrollX.removeListener(listenerId);
    };
  }, [hasMultipleTabs, pagerScrollX, detailTabs, effectiveWidth, scrollChipIntoView]);

  useEffect(() => {
    return () => {
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    };
  }, []);

  const handleSelectDetailTab = useCallback(
    (idx: number) => {
      const targetTab = detailTabs[idx];
      if (!targetTab) return;
      programmaticScrollRef.current = true;
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = setTimeout(() => {
        programmaticScrollRef.current = false;
      }, 380);
      setSelectedTabKey(targetTab.key);
      pagerRef.current?.scrollTo({ x: idx * effectiveWidth, animated: true });
      scrollChipIntoView(idx);
    },
    [detailTabs, effectiveWidth, scrollChipIntoView]
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
        Math.min(detailTabs.length - 1, Math.round(offsetX / Math.max(1, effectiveWidth)))
      );
      const nextTab = detailTabs[nextIdx];
      if (nextTab) {
        setSelectedTabKey(nextTab.key);
        scrollChipIntoView(nextIdx);
      }
    },
    [detailTabs, effectiveWidth, scrollChipIntoView]
  );

  const handleChipLayout = useCallback(
    (idx: number) => (e: LayoutChangeEvent) => {
      const { x, width } = e.nativeEvent.layout;
      chipLayoutsRef.current[idx] = { x, width };
    },
    []
  );

  const onPagerScroll = useMemo(
    () =>
      Animated.event([{ nativeEvent: { contentOffset: { x: pagerScrollX } } }], {
        useNativeDriver: true,
      }),
    [pagerScrollX]
  );

  if (!hydratedBundle || !repo) {
    return (
      <View style={[styles.safeArea, { paddingTop: insets.top }]}>
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>该记录不存在或已被删除</Text>
          <Pressable
            onPress={nav.back}
            style={({ pressed }) => [styles.primaryPill, pressed && styles.pressedSoft]}
          >
            <Text style={styles.primaryPillText}>返回上一页</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const { entry, library } = hydratedBundle;

  const activeChildTab = detailTabs.find(
    (t): t is Extract<DetailTabItem, { key: `child:${string}` }> =>
      'section' in t && t.key === activeTabKey
  );

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
    nav.back();
  };

  const handleOpenLockedModal = (
    targetLibrary: LibraryRecord,
    relationFieldKey: string,
    prefill?: Record<string, unknown>
  ) => {
    setSubModalTarget({
      childLibrary: targetLibrary,
      lockedRelation: {
        fieldKey: relationFieldKey,
        targetEntryId: entry.id,
        targetTitle: entry.titleSummary,
        targetLibraryIcon: library.icon,
      },
      initialData: prefill,
    });
    setSubModalOpen(true);
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
      handleOpenLockedModal(childLibrary, relationFieldKey);
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
      handleOpenLockedModal(childLibrary, relationFieldKey, payload);
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
    activeTab: activeTabKey,
    activeChildSlug: activeChildTab?.section.childLibrary.slug,
    activeChildName: activeChildTab?.section.childLibrary.name,
  };

  const renderChildSection = (section: ChildLibrarySection) => {
    const { childLibrary, relationFieldKey, entries: subEntries } = section;
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
            onPress={() => nav.openLibrary(childLibrary.slug)}
            style={({ pressed }) => [styles.sectionHeader, pressed && styles.pressedSoft]}
          >
            <Text style={styles.sectionTitle}>
              {childLibrary.icon} {childLibrary.name} ({subEntries.length})
            </Text>
            <Feather name="chevron-right" size={15} color={Palette.inkMuted} />
          </Pressable>

          <Pressable
            onPress={() => handleOpenLockedModal(childLibrary, relationFieldKey)}
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

        {quickError ? <Text style={styles.quickErrorText}>{quickError}</Text> : null}

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
                    <View style={[styles.timelineDot, { backgroundColor: subTone.solid }]} />
                    {!isLastItem ? <View style={styles.timelineLine} /> : null}
                  </View>

                  <Pressable
                    onPress={() => nav.push(`/entry/${sub.id}`)}
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
                          setPreviewImage({ uri: imgUri, caption: bodyText || dateVal });
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
  };

  const renderBacklinkGroup = (group: BacklinkGroupSection) => {
    const { sourceLibrary, relationFieldKey, relationFieldLabel, entries: relEntries } = group;
    const srcTone = ToneMap[sourceLibrary.color] ?? ToneMap.teal;
    const cardCfg = sourceLibrary.views.card;
    const fieldMap = new Map(sourceLibrary.fields.map((f) => [f.key, f]));
    const subtitleField = cardCfg.subtitleFieldKey
      ? fieldMap.get(cardCfg.subtitleFieldKey)
      : undefined;
    const badgeField = cardCfg.rightBadgeFieldKey
      ? fieldMap.get(cardCfg.rightBadgeFieldKey)
      : undefined;

    return (
      <View key={`${sourceLibrary.slug}::${relationFieldKey}`} style={styles.sectionCard}>
        <View style={styles.subSectionHeader}>
          <Pressable
            onPress={() => nav.openLibrary(sourceLibrary.slug)}
            style={({ pressed }) => [styles.backlinkHeaderLeft, pressed && styles.pressedSoft]}
          >
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>
                {sourceLibrary.icon} {sourceLibrary.name} ({relEntries.length})
              </Text>
              <Feather name="chevron-right" size={15} color={Palette.inkMuted} />
            </View>
            <Text style={styles.backlinkFieldHint}>关联字段：{relationFieldLabel}</Text>
          </Pressable>

          <Pressable
            onPress={() => handleOpenLockedModal(sourceLibrary, relationFieldKey)}
            style={[styles.subAddBtn, { backgroundColor: srcTone.soft }]}
          >
            <Feather name="plus" size={14} color={srcTone.ink} />
            <Text style={[styles.subAddBtnText, { color: srcTone.ink }]}>记关联记录</Text>
          </Pressable>
        </View>

        <View style={styles.backlinkList}>
          {relEntries.map((relEntry) => {
            const relHl = relEntry.highlight
              ? HighlightTonePalette[relEntry.highlight.tone]
              : null;
            const subtitleVal = cardCfg.subtitleFieldKey
              ? relEntry.computedData[cardCfg.subtitleFieldKey]
              : undefined;
            const badgeVal = cardCfg.rightBadgeFieldKey
              ? relEntry.computedData[cardCfg.rightBadgeFieldKey]
              : undefined;
            const matchedOptColor = badgeField?.options?.find(
              (o) => o.value === String(badgeVal)
            )?.color;
            const coverUri = cardCfg.coverImageFieldKey
              ? resolveImageUri(relEntry.computedData[cardCfg.coverImageFieldKey])
              : '';

            const activeMetrics = cardCfg.footerMetricKeys
              .map((mKey) => {
                const mf = fieldMap.get(mKey);
                if (!mf) return null;
                const raw = relEntry.computedData[mKey];
                if (raw === undefined || raw === null || raw === '') return null;
                return {
                  key: mKey,
                  label: mf.label,
                  display: formatFieldDisplay(mf, raw),
                };
              })
              .filter(Boolean) as Array<{ key: string; label: string; display: string }>;

            return (
              <Pressable
                key={relEntry.id}
                onPress={() => nav.push(`/entry/${relEntry.id}`)}
                style={({ pressed }) => [
                  styles.backlinkEntryCard,
                  relHl && { backgroundColor: relHl.bg },
                  pressed && { opacity: 0.82, transform: [{ scale: 0.988 }] },
                ]}
              >
                {coverUri ? (
                  <Image
                    source={{ uri: coverUri }}
                    style={styles.backlinkThumb}
                    contentFit="cover"
                  />
                ) : null}

                <View style={styles.backlinkCardBody}>
                  <View style={styles.timelineMetaRow}>
                    <Text style={styles.backlinkEntryTitle} numberOfLines={2}>
                      {relEntry.titleSummary}
                    </Text>

                    <View style={styles.backlinkBadgesRow}>
                      {relEntry.highlight?.badgeText && relHl ? (
                        <View
                          style={[styles.timelineBadge, { backgroundColor: relHl.pillBg }]}
                        >
                          <Text
                            style={[styles.timelineBadgeText, { color: relHl.pillInk }]}
                          >
                            {relEntry.highlight.badgeText}
                          </Text>
                        </View>
                      ) : null}

                      {badgeVal !== undefined && badgeVal !== '' ? (
                        <View
                          style={[
                            styles.timelineBadge,
                            {
                              backgroundColor: matchedOptColor
                                ? `${matchedOptColor}18`
                                : srcTone.soft,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.timelineBadgeText,
                              { color: matchedOptColor || srcTone.ink },
                            ]}
                          >
                            {formatFieldDisplay(badgeField, badgeVal)}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  </View>

                  {subtitleVal !== undefined && subtitleVal !== '' ? (
                    <Text style={styles.backlinkSubtitle} numberOfLines={1}>
                      {formatFieldDisplay(subtitleField, subtitleVal)}
                    </Text>
                  ) : null}

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
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  };

  return (
    <View style={styles.safeArea}>
      {/* 顶部栏（静态 insets.top，消除 Android 进栈顶栏跳动） */}
      <View style={[styles.topNavOuter, { paddingTop: insets.top }]}>
        <View style={styles.topNav}>
          <Pressable
            onPress={nav.back}
            hitSlop={6}
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pressedScale]}
            accessibilityLabel="返回"
          >
            <Feather name="arrow-left" size={19} color={Palette.inkPrimary} />
          </Pressable>

          <Pressable
            onPress={() => nav.openLibrary(library.slug)}
            style={({ pressed }) => [
              styles.libTagBtn,
              { backgroundColor: tone.soft },
              pressed && styles.pressedScale,
            ]}
          >
            <Text style={[styles.libTagText, { color: tone.ink }]}>
              {library.icon} {library.name}
            </Text>
          </Pressable>

          <View style={{ flex: 1 }} />

          <Pressable
            onPress={() => setEditOpen(true)}
            style={({ pressed }) => [styles.editBtn, pressed && styles.pressedScale]}
          >
            <Feather name="edit-2" size={14} color={Palette.inkPrimary} />
            <Text style={styles.editBtnText}>编辑</Text>
          </Pressable>

          <Pressable
            onPress={() => setConfirmDelete(true)}
            hitSlop={6}
            style={({ pressed }) => [styles.iconBtn, pressed && styles.pressedScale]}
            accessibilityLabel="删除记录"
          >
            <Feather name="trash-2" size={17} color={Palette.danger} />
          </Pressable>
        </View>
      </View>

      {/* 主标题与核心汇总指标卡 */}
      {(() => {
        const heroCardNode = (
          <View
            style={[
              styles.heroCard,
              hasMultipleTabs && styles.heroCardCompact,
              hl && { backgroundColor: hl.bg },
            ]}
          >
            <View style={styles.heroTopRow}>
              <Text
                style={[styles.heroTitle, hasMultipleTabs && styles.heroTitleCompact]}
                numberOfLines={hasMultipleTabs ? 2 : undefined}
              >
                {entry.titleSummary}
              </Text>
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

            {computedFields.length > 0 ? (
              hasMultipleTabs ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.heroStatsStrip}
                >
                  {computedFields.map((cf) => (
                    <View
                      key={cf.key}
                      style={[
                        styles.compactMetricPill,
                        hl
                          ? {
                              backgroundColor: Palette.bgSurface,
                              borderWidth: 1,
                              borderColor: Palette.borderHairline,
                            }
                          : { backgroundColor: tone.soft },
                      ]}
                    >
                      <Text style={styles.compactMetricLabel}>{cf.label}</Text>
                      <Text style={[styles.compactMetricVal, { color: tone.ink }]}>
                        {formatFieldDisplay(cf, entry.computedData[cf.key])}
                      </Text>
                    </View>
                  ))}
                </ScrollView>
              ) : (
                <View style={styles.heroStatsWrap}>
                  {computedFields.map((cf) => (
                    <View
                      key={cf.key}
                      style={[
                        styles.computedTile,
                        computedFields.length === 4 && styles.computedTileHalf,
                        hl
                          ? {
                              backgroundColor: Palette.bgSurface,
                              borderWidth: 1,
                              borderColor: Palette.borderHairline,
                            }
                          : { backgroundColor: tone.soft },
                      ]}
                    >
                      <Text style={styles.computedLabel} numberOfLines={1}>
                        {cf.label}
                      </Text>
                      <Text
                        style={[styles.computedVal, { color: tone.ink }]}
                        numberOfLines={1}
                      >
                        {formatFieldDisplay(cf, entry.computedData[cf.key])}
                      </Text>
                    </View>
                  ))}
                </View>
              )
            ) : null}
          </View>
        );

        const isFieldFilled = (key: string) => {
          const v = entry.computedData[key];
          if (v === undefined || v === null || v === '') return false;
          if (Array.isArray(v) && v.length === 0) return false;
          return true;
        };
        const filledBaseFields = baseFields.filter((f) => isFieldFilled(f.key));
        const emptyBaseFields = baseFields.filter((f) => !isFieldFilled(f.key));
        const visibleBaseFields =
          filledBaseFields.length === 0 || showEmptyFields ? baseFields : filledBaseFields;

        const detailInfoNodes = (
          <>
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>详细信息</Text>
              {visibleBaseFields.map((f, idx) => {
                const val = entry.computedData[f.key];
                const isLast = idx === visibleBaseFields.length - 1;
                if (f.type === 'image' && val) {
                  const fullUri = resolveImageUri(val);
                  return (
                    <View
                      key={f.key}
                      style={[styles.imageFieldBlock, !isLast && styles.blockDivider]}
                    >
                      <Text style={styles.fieldKeyLabel}>{f.label}</Text>
                      <Pressable
                        onPress={() => setPreviewImage({ uri: fullUri, caption: f.label })}
                        style={({ pressed }) => [styles.detailImgPressable, pressed && { opacity: 0.88 }]}
                      >
                        <Image
                          source={{ uri: fullUri }}
                          style={styles.detailImage}
                          contentFit="cover"
                        />
                        <View style={styles.imgZoomBadge}>
                          <Feather name="maximize-2" size={12} color={Palette.inkInverse} />
                        </View>
                      </Pressable>
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

              {filledBaseFields.length > 0 && emptyBaseFields.length > 0 ? (
                <Pressable
                  onPress={() => {
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    setShowEmptyFields((v) => !v);
                  }}
                  style={({ pressed }) => [styles.emptyFieldsToggle, pressed && { opacity: 0.7 }]}
                >
                  <Text style={styles.emptyFieldsToggleText}>
                    {showEmptyFields
                      ? '收起未填字段'
                      : `显示 ${emptyBaseFields.length} 项未填字段`}
                  </Text>
                  <Feather
                    name={showEmptyFields ? 'chevron-up' : 'chevron-down'}
                    size={13}
                    color={Palette.inkMuted}
                  />
                </Pressable>
              ) : null}
            </View>

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
                            onPress={() => nav.push(`/entry/${ref.id}`)}
                            style={({ pressed }) => [
                              styles.linkCard,
                              pressed && { opacity: 0.78, transform: [{ scale: 0.988 }] },
                            ]}
                          >
                            <Text style={styles.linkTitle}>
                              {ref.libraryIcon} {ref.title}
                            </Text>
                            <View style={styles.linkRight}>
                              <Text style={styles.linkLibName}>{ref.libraryName}</Text>
                              <Feather
                                name="chevron-right"
                                size={15}
                                color={Palette.inkMuted}
                              />
                            </View>
                          </Pressable>
                        ))
                      )}
                    </View>
                  );
                })}
              </View>
            ) : null}
          </>
        );

        if (!hasMultipleTabs) {
          return (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={[styles.container, { paddingBottom: 92 + insets.bottom }]}
              keyboardShouldPersistTaps="handled"
            >
              {heroCardNode}
              {detailInfoNodes}
            </ScrollView>
          );
        }

        return (
          <>
            {/* 多 Tab 时顶部吸顶：核心摘要卡 + 跟手滑块 / 横向胶囊条 */}
            <View style={styles.multiTabHeader}>
              {heroCardNode}

              {detailTabs.length <= 3 ? (
                <SlidingSegmentedBar
                  items={detailTabs.map((t) => ({
                    key: t.key,
                    label: `${t.label}${'count' in t ? ` (${t.count})` : ''}`,
                    emoji: 'emoji' in t ? t.emoji : undefined,
                    icon: 'icon' in t ? t.icon : undefined,
                  }))}
                  activeIndex={activeTabIndex}
                  onSelect={handleSelectDetailTab}
                  activeColor={tone.solid}
                  scrollX={pagerScrollX}
                  pageWidth={effectiveWidth}
                />
              ) : (
                <ScrollView
                  ref={chipsScrollRef}
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={styles.detailTabsScroll}
                  contentContainerStyle={styles.detailTabsScrollContent}
                >
                  {detailTabs.map((t, idx) => {
                    const active = idx === activeTabIndex;
                    return (
                      <Pressable
                        key={t.key}
                        onLayout={handleChipLayout(idx)}
                        onPress={() => handleSelectDetailTab(idx)}
                        style={({ pressed }) => [
                          styles.detailTabScrollPill,
                          active && { backgroundColor: tone.solid },
                          pressed && !active && styles.pressedSoft,
                        ]}
                      >
                        {'emoji' in t ? (
                          <Text style={styles.detailTabEmoji}>{t.emoji}</Text>
                        ) : (
                          <Feather
                            name={t.icon}
                            size={13}
                            color={active ? Palette.inkInverse : Palette.inkSecondary}
                          />
                        )}
                        <Text
                          style={[
                            styles.detailTabText,
                            active && { color: Palette.inkInverse },
                          ]}
                        >
                          {t.label}
                          {'count' in t ? ` (${t.count})` : ''}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              )}
            </View>

            {/* 可左右手势滑动的多 Tab 内容分页 */}
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
              style={styles.scroll}
            >
              {detailTabs.map((t) => (
                <ScrollView
                  key={t.key}
                  nestedScrollEnabled
                  keyboardShouldPersistTaps="handled"
                  style={{ width: effectiveWidth }}
                  contentContainerStyle={[
                    styles.pagerPageContent,
                    { paddingBottom: 92 + insets.bottom },
                  ]}
                >
                  {t.key === 'detail' ? detailInfoNodes : null}
                  {'section' in t ? renderChildSection(t.section) : null}
                  {t.key === 'backlinks'
                    ? backlinkGroups.map((group) => renderBacklinkGroup(group))
                    : null}
                </ScrollView>
              ))}
            </Animated.ScrollView>
          </>
        );
      })()}

      {/* 右下角随行助理：自动携带当前主记录与所在 Tab 上下文 */}
      <Pressable
        accessibilityLabel="针对当前记录使用随行助理"
        onPress={() => openOmniCapture(library.slug, 'text', entryAiContext, 'entry')}
        onLongPress={() => openOmniCapture(library.slug, 'voice', entryAiContext, 'entry')}
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
          visible={subModalOpen}
          library={subModalTarget.childLibrary}
          initialData={subModalTarget.initialData}
          lockedRelation={subModalTarget.lockedRelation}
          onClose={() => setSubModalOpen(false)}
          onSaved={() => {
            const targetSlug = subModalTarget.childLibrary.slug;
            setQuickTexts((prev) => ({ ...prev, [targetSlug]: '' }));
            setQuickImages((prev) => ({ ...prev, [targetSlug]: '' }));
          }}
        />
      ) : null}

      <Modal
        visible={confirmDelete}
        transparent
        statusBarTranslucent
        navigationBarTranslucent
        animationType="fade"
        onRequestClose={() => setConfirmDelete(false)}
      >
        <View style={styles.confirmBackdrop}>
          <View style={styles.confirmDialog}>
            <Text style={styles.confirmTitle}>删除这条记录？</Text>
            <Text style={styles.confirmSummary} numberOfLines={2}>
              「{entry.titleSummary}」
            </Text>
            <Text style={styles.confirmHint}>
              {entry.backlinks.length > 0
                ? `删除后将保留 ${entry.backlinks.length} 条关联记录，并可从设置页操作记录中撤销。`
                : '删除后仍可从设置页「最近操作记录」中撤销恢复。'}
            </Text>
            <View style={styles.confirmBtns}>
              <Pressable
                onPress={() => setConfirmDelete(false)}
                style={({ pressed }) => [styles.confirmCancelBtn, pressed && { opacity: 0.78 }]}
              >
                <Text style={styles.confirmCancelText}>取消</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setConfirmDelete(false);
                  handleDelete();
                }}
                style={({ pressed }) => [styles.confirmOkBtn, pressed && { opacity: 0.85 }]}
              >
                <Text style={styles.confirmOkText}>确认删除</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <ImagePreviewModal
        uri={previewImage?.uri ?? null}
        caption={previewImage?.caption}
        onClose={() => setPreviewImage(null)}
      />
    </View>
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
  topNavOuter: {
    width: '100%',
    backgroundColor: Palette.bgSurface,
    borderBottomWidth: 1,
    borderBottomColor: Palette.borderHairline,
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
  },
  pressedScale: {
    opacity: 0.78,
    transform: [{ scale: 0.95 }],
  },
  pressedSoft: {
    opacity: 0.72,
  },
  tabBodyStack: {
    gap: 14,
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
  multiTabHeader: {
    width: '100%',
    maxWidth: 820,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 10,
  },
  pagerPageContent: {
    width: '100%',
    maxWidth: 820,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingTop: 6,
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
  heroCardCompact: {
    padding: 13,
    gap: 5,
  },
  heroTitleCompact: {
    fontSize: 18,
    lineHeight: 24,
  },
  heroStatsStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 8,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: Palette.borderHairline,
  },
  compactMetricPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
  },
  compactMetricLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  compactMetricVal: {
    fontSize: 13,
    fontWeight: '800',
  },
  detailImgPressable: {
    position: 'relative',
    borderRadius: 12,
    overflow: 'hidden',
  },
  imgZoomBadge: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(18, 24, 23, 0.56)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyFieldsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingTop: 10,
    marginTop: 2,
    borderTopWidth: 1,
    borderTopColor: Palette.borderHairline,
  },
  emptyFieldsToggleText: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkMuted,
  },
  confirmBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(18, 24, 23, 0.46)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  confirmDialog: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: Palette.bgSurface,
    borderRadius: 20,
    padding: 20,
    gap: 10,
  },
  confirmTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: Palette.inkPrimary,
  },
  confirmSummary: {
    fontSize: 14,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  confirmHint: {
    fontSize: 13,
    color: Palette.inkSecondary,
    lineHeight: 19,
  },
  confirmBtns: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 6,
  },
  confirmCancelBtn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 12,
    backgroundColor: Palette.bgSubtle,
    alignItems: 'center',
  },
  confirmCancelText: {
    fontSize: 14,
    fontWeight: '700',
    color: Palette.inkSecondary,
  },
  confirmOkBtn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 12,
    backgroundColor: Palette.danger,
    alignItems: 'center',
  },
  confirmOkText: {
    fontSize: 14,
    fontWeight: '700',
    color: Palette.inkInverse,
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
  heroStatsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: Palette.borderHairline,
  },
  computedTile: {
    flex: 1,
    minWidth: 92,
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderRadius: 12,
    gap: 3,
  },
  computedTileHalf: {
    minWidth: '46%',
  },
  computedLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  computedVal: {
    fontSize: 16,
    fontWeight: '800',
  },
  detailTabsBar: {
    flexDirection: 'row',
    backgroundColor: Palette.bgSurface,
    borderRadius: 14,
    padding: 4,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 4,
  },
  detailTabPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 9,
    paddingHorizontal: 8,
    borderRadius: 10,
  },
  detailTabsScroll: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  detailTabsScrollContent: {
    flexDirection: 'row',
    padding: 4,
    gap: 4,
  },
  detailTabScrollPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  detailTabEmoji: {
    fontSize: 13,
  },
  detailTabText: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkSecondary,
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
  backlinkHeaderLeft: {
    flex: 1,
    gap: 2,
  },
  backlinkFieldHint: {
    fontSize: 11,
    color: Palette.inkMuted,
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
  backlinkList: {
    gap: 10,
  },
  backlinkEntryCard: {
    flexDirection: 'row',
    gap: 11,
    backgroundColor: Palette.bgCanvas,
    borderRadius: 14,
    padding: 13,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  backlinkThumb: {
    width: 52,
    height: 66,
    borderRadius: 9,
    backgroundColor: Palette.bgSubtle,
  },
  backlinkCardBody: {
    flex: 1,
    gap: 6,
  },
  backlinkEntryTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    color: Palette.inkPrimary,
    lineHeight: 20,
  },
  backlinkBadgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  backlinkSubtitle: {
    fontSize: 12,
    color: Palette.inkSecondary,
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
