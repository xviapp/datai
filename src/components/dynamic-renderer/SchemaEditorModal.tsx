import Feather from '@expo/vector-icons/Feather';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  LayoutAnimation,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { runArchitectAgent } from '@/ai/agents';
import { isAbortError } from '@/ai/deepseek-client';
import { BasicSettingsTab } from '@/components/schema-editor/BasicSettingsTab';
import { FieldsTab } from '@/components/schema-editor/FieldsTab';
import { buildInitialSchemaDraft, type SchemaDraftState } from '@/components/schema-editor/types';
import { ViewsTab } from '@/components/schema-editor/ViewsTab';
import { BottomSheetModal } from '@/components/ui/BottomSheetModal';
import { SlidingSegmentedBar } from '@/components/ui/SlidingSegmentedBar';
import { Palette, ToneMap } from '@/constants/design-tokens';
import { VIEW_TYPE_META } from '@/constants/schema-meta';
import { useRepository } from '@/context/omni-context';
import type { LibraryRecord, LibraryViewInput } from '@/db/models';
import { useSwipeablePager } from '@/hooks/useSwipeablePager';
import type { FieldDef } from '@/schema/field-defs';
import type { LibraryBlueprint, LibraryViewType } from '@/schema/view-dsl';

interface SchemaEditorModalProps {
  visible: boolean;
  existingLibrary?: LibraryRecord | null;
  defaultParentSlug?: string | null;
  onCreateSubLibrary?: (parentSlug: string) => void;
  onClose: () => void;
  onSaved?: (slug: string) => void;
  onDeleted?: (slug: string) => void;
}

export function SchemaEditorModal({
  visible,
  existingLibrary,
  defaultParentSlug,
  onCreateSubLibrary,
  onClose,
  onSaved,
  onDeleted,
}: SchemaEditorModalProps) {
  const [headerTitle, setHeaderTitle] = useState(
    existingLibrary ? `${existingLibrary.icon} 管理 · ${existingLibrary.name}` : '新建记录本'
  );
  const sessionKey = `${existingLibrary?.slug ?? 'new'}::${defaultParentSlug ?? ''}`;

  return (
    <BottomSheetModal
      visible={visible}
      onClose={onClose}
      maxHeight="92%"
      maxWidth={720}
      sheetStyle={styles.tallSheet}
      header={
        <View style={styles.header}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {headerTitle}
          </Text>
          <Pressable
            onPress={onClose}
            hitSlop={8}
            style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.6 }]}
          >
            <Feather name="x" size={20} color={Palette.inkSecondary} />
          </Pressable>
        </View>
      }
    >
      {visible ? (
        <SchemaEditorBody
          key={sessionKey}
          existingLibrary={existingLibrary}
          defaultParentSlug={defaultParentSlug}
          onCreateSubLibrary={onCreateSubLibrary}
          onHeaderTitleChange={setHeaderTitle}
          onClose={onClose}
          onSaved={onSaved}
          onDeleted={onDeleted}
        />
      ) : null}
    </BottomSheetModal>
  );
}

function SchemaEditorBody({
  existingLibrary,
  defaultParentSlug,
  onCreateSubLibrary,
  onHeaderTitleChange,
  onClose,
  onSaved,
  onDeleted,
}: Omit<SchemaEditorModalProps, 'visible'> & {
  onHeaderTitleChange: (title: string) => void;
}) {
  const { repo, libraries } = useRepository();
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();

  const [draft, setDraft] = useState<SchemaDraftState>(() =>
    buildInitialSchemaDraft(libraries, existingLibrary, defaultParentSlug)
  );
  const [activeTabIndex, setActiveTabIndex] = useState(existingLibrary ? 1 : 0);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const title = existingLibrary
      ? `${draft.icon || existingLibrary.icon} 管理 · ${draft.name || existingLibrary.name}`
      : draft.name.trim()
        ? `${draft.icon || '📒'} ${draft.name.trim()}`
        : '新建记录本';
    onHeaderTitleChange(title);
  }, [existingLibrary, draft.icon, draft.name, onHeaderTitleChange]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const initialTabKey = `${existingLibrary?.slug ?? 'new'}::${defaultParentSlug ?? ''}`;
  const {
    pagerRef,
    pagerScrollX,
    effectiveWidth,
    selectPage,
    handlePagerLayout,
    handlePagerMomentumEnd,
    onPagerScroll,
  } = useSwipeablePager({
    pageCount: 3,
    activeIndex: activeTabIndex,
    onIndexChange: setActiveTabIndex,
    initialWidth: Math.min(screenWidth, 720),
    syncKey: initialTabKey,
  });

  const patchDraft = (partial: Partial<SchemaDraftState>) => {
    setDraft((prev) => ({ ...prev, ...partial }));
  };

  const moveField = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= draft.fields.length) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setDraft((prev) => {
      const next = [...prev.fields];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return { ...prev, fields: next };
    });
  };

  const addNewField = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setDraft((prev) => {
      const idx = prev.fields.length + 1;
      const suffix = Math.random().toString(36).slice(2, 6);
      return {
        ...prev,
        fields: [
          ...prev.fields,
          {
            key: `field_${idx}_${suffix}`,
            label: `记录项 ${idx}`,
            type: 'text',
            required: false,
          },
        ],
      };
    });
  };

  const updateFieldAt = (index: number, patch: Partial<FieldDef>) => {
    setDraft((prev) => ({
      ...prev,
      fields: prev.fields.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    }));
  };

  const removeFieldAt = (index: number) => {
    if (draft.fields.length <= 1) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setDraft((prev) => {
      const removedKey = prev.fields[index]?.key;
      return {
        ...prev,
        fields: prev.fields.filter((_, i) => i !== index),
        footerMetricKeys: prev.footerMetricKeys.filter((k) => k !== removedKey),
      };
    });
  };

  const toggleFooterMetric = (key: string) => {
    setDraft((prev) => ({
      ...prev,
      footerMetricKeys: prev.footerMetricKeys.includes(key)
        ? prev.footerMetricKeys.filter((k) => k !== key)
        : prev.footerMetricKeys.length < 4
          ? [...prev.footerMetricKeys, key]
          : prev.footerMetricKeys,
    }));
  };

  const handleSelectParent = (nextParentSlug: string) => {
    setDraft((prev) => {
      if (!nextParentSlug) {
        return { ...prev, parentLibrarySlug: '', showOnHome: true };
      }
      const nextShowOnHome = !prev.parentLibrarySlug ? false : prev.showOnHome;
      const targetLib = libraries.find((l) => l.slug === nextParentSlug);
      let nextFields = prev.fields;
      if (
        targetLib &&
        !prev.fields.some(
          (f) => f.type === 'relation' && f.relationConfig?.targetLibrarySlug === nextParentSlug
        )
      ) {
        const baseKey = `parent_${nextParentSlug}`.slice(0, 28);
        const usedKeys = new Set(prev.fields.map((f) => f.key));
        const relKey = usedKeys.has(baseKey) ? `${baseKey}_ref` : baseKey;
        nextFields = [
          {
            key: relKey,
            label: `所属${targetLib.name}`,
            type: 'relation',
            required: false,
            relationConfig: {
              targetLibrarySlug: nextParentSlug,
              allowMultiple: false,
            },
          },
          ...prev.fields,
        ];
      }
      return {
        ...prev,
        parentLibrarySlug: nextParentSlug,
        showOnHome: nextShowOnHome,
        fields: nextFields,
      };
    });
  };

  const addViewDraft = (viewType: LibraryViewType) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setDraft((prev) => ({
      ...prev,
      viewDrafts: [...prev.viewDrafts, { name: VIEW_TYPE_META[viewType].label, viewType }],
    }));
  };

  const removeViewDraft = (idx: number) => {
    if (draft.viewDrafts.length <= 1) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setDraft((prev) => ({
      ...prev,
      viewDrafts: prev.viewDrafts.filter((_, i) => i !== idx),
    }));
  };

  const moveViewDraft = (idx: number, delta: -1 | 1) => {
    const target = idx + delta;
    if (target < 0 || target >= draft.viewDrafts.length) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setDraft((prev) => {
      const next = [...prev.viewDrafts];
      const [item] = next.splice(idx, 1);
      next.splice(target, 0, item);
      return { ...prev, viewDrafts: next };
    });
  };

  const updateViewDraftName = (idx: number, nextName: string) => {
    setDraft((prev) => ({
      ...prev,
      viewDrafts: prev.viewDrafts.map((v, i) => (i === idx ? { ...v, name: nextName } : v)),
    }));
  };

  const handleAiAssist = async () => {
    if (!repo || !aiPrompt.trim()) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      setAiLoading(true);
      setErrorMsg(null);
      const scopedPrompt = existingLibrary
        ? `针对已有库 slug="${existingLibrary.slug}" (${existingLibrary.name}) 进行数据结构或视图表现调整：${aiPrompt}`
        : defaultParentSlug
          ? `围绕已有主库 slug="${defaultParentSlug}" 新建或调整附属子记录本：${aiPrompt}`
          : aiPrompt;
      const plan = await runArchitectAgent(repo, scopedPrompt, undefined, {
        targetLibrarySlug: existingLibrary?.slug ?? defaultParentSlug ?? undefined,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      repo.applyArchitectPlan(plan);
      const targetSlug = plan.libraries[0]?.slug || draft.slug;
      onSaved?.(targetSlug);
      onClose();
    } catch (err) {
      if (isAbortError(err)) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (abortRef.current === controller) {
        setAiLoading(false);
      }
    }
  };

  const handleManualSave = () => {
    if (!repo) return;
    try {
      setErrorMsg(null);
      const cleanSlug = draft.slug.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
      if (!/^[a-z][a-z0-9_]*$/.test(cleanSlug)) {
        throw new Error('英文标识（slug）必须以小写字母开头，仅含字母、数字与下划线');
      }
      if (!draft.name.trim()) {
        selectPage(0);
        throw new Error('请先在「基础」页填写记录本名称');
      }

      const validTitleKey = draft.fields.some((f) => f.key === draft.titleFieldKey)
        ? draft.titleFieldKey
        : draft.fields[0].key;
      const dateField = draft.fields.find((f) => f.type === 'date');
      const imgField = draft.fields.find((f) => f.type === 'image');
      const ratingField = draft.fields.find((f) => f.type === 'rating');

      const cardConfig = {
        titleFieldKey: validTitleKey,
        subtitleFieldKey: draft.subtitleFieldKey || undefined,
        coverImageFieldKey: imgField?.key,
        rightBadgeFieldKey: draft.rightBadgeFieldKey || undefined,
        footerMetricKeys: draft.footerMetricKeys.filter((k) =>
          draft.fields.some((f) => f.key === k)
        ),
        sortFieldKey: dateField?.key,
        sortDir: 'desc' as const,
        highlightRules: existingLibrary?.views.card.highlightRules ?? [],
      };
      const galleryConfig = {
        titleFieldKey: validTitleKey,
        subtitleFieldKey: draft.subtitleFieldKey || undefined,
        coverImageFieldKey: imgField?.key,
        badgeFieldKey: draft.rightBadgeFieldKey || undefined,
        ratingFieldKey: ratingField?.key,
      };
      const calendarConfig = {
        dateFieldKey: dateField?.key ?? '',
        titleFieldKey: validTitleKey,
        metricFieldKey: draft.footerMetricKeys[0],
      };

      const normalizedViews =
        draft.viewDrafts.length > 0
          ? draft.viewDrafts
          : [{ name: '列表', viewType: 'card' as LibraryViewType }];
      const hasGallery = normalizedViews.some((v) => v.viewType === 'gallery');
      const hasCalendar = normalizedViews.some((v) => v.viewType === 'calendar');

      const blueprint: LibraryBlueprint = {
        slug: cleanSlug,
        name: draft.name.trim(),
        description: draft.description.trim(),
        icon: draft.icon.trim() || '📦',
        color: draft.color,
        parentLibrarySlug:
          draft.parentLibrarySlug && draft.parentLibrarySlug !== cleanSlug
            ? draft.parentLibrarySlug
            : undefined,
        showOnHome: draft.showOnHome,
        fields: draft.fields,
        views: {
          card: cardConfig,
          gallery: hasGallery ? galleryConfig : undefined,
          calendar: hasCalendar ? calendarConfig : undefined,
        },
      };

      const viewInputs: LibraryViewInput[] = normalizedViews.map((v) => ({
        id: v.id,
        name: v.name.trim() || VIEW_TYPE_META[v.viewType].label,
        viewType: v.viewType,
        config:
          v.viewType === 'card'
            ? (cardConfig as unknown as Record<string, unknown>)
            : v.viewType === 'gallery'
              ? (galleryConfig as unknown as Record<string, unknown>)
              : v.viewType === 'calendar'
                ? (calendarConfig as unknown as Record<string, unknown>)
                : {},
      }));

      // 单事务原子落盘结构与视图配置（只触发一次 notify 与一次持久化导出）
      repo.upsertLibrary(blueprint, viewInputs);

      onSaved?.(cleanSlug);
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteLibrary = () => {
    if (!repo || !existingLibrary) return;
    try {
      const targetSlug = existingLibrary.slug;
      repo.deleteLibrary(targetSlug);
      onClose();
      onDeleted?.(targetSlug);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const parentCandidates = useMemo(
    () => libraries.filter((l) => !l.parentLibrarySlug && l.slug !== draft.slug),
    [libraries, draft.slug]
  );
  const tone = ToneMap[draft.color] ?? ToneMap.teal;

  const editorTabs = useMemo(
    () => [
      { key: 'basic', label: '基础', icon: 'sliders' as const },
      { key: 'fields', label: `字段 (${draft.fields.length})`, icon: 'list' as const },
      { key: 'views', label: `视图 (${draft.viewDrafts.length})`, icon: 'layout' as const },
    ],
    [draft.fields.length, draft.viewDrafts.length]
  );

  return (
    <>
      <View style={styles.tabBarWrap}>
        <SlidingSegmentedBar
          compact
          items={editorTabs}
          activeIndex={activeTabIndex}
          onSelect={selectPage}
          activeColor={tone.solid}
          scrollX={pagerScrollX}
          pageWidth={effectiveWidth}
        />
        {errorMsg ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{errorMsg}</Text>
          </View>
        ) : null}
      </View>

      <Animated.ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        nestedScrollEnabled
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onLayout={handlePagerLayout}
        onScroll={onPagerScroll}
        onMomentumScrollEnd={handlePagerMomentumEnd}
        style={styles.pager}
      >
        <BasicSettingsTab
          width={effectiveWidth}
          existingLibrary={existingLibrary}
          name={draft.name}
          icon={draft.icon}
          color={draft.color}
          parentLibrarySlug={draft.parentLibrarySlug}
          showOnHome={draft.showOnHome}
          parentCandidates={parentCandidates}
          aiPrompt={aiPrompt}
          aiLoading={aiLoading}
          onChangeAiPrompt={setAiPrompt}
          onAiAssist={handleAiAssist}
          onChangeName={(name) => patchDraft({ name })}
          onChangeIcon={(icon) => patchDraft({ icon })}
          onChangeColor={(color) => patchDraft({ color })}
          onSelectParent={handleSelectParent}
          onChangeShowOnHome={(showOnHome) => patchDraft({ showOnHome })}
          onCreateSubLibrary={onCreateSubLibrary}
          onDeleteLibrary={handleDeleteLibrary}
        />

        <FieldsTab
          width={effectiveWidth}
          slug={draft.slug}
          fields={draft.fields}
          libraries={libraries}
          onAddField={addNewField}
          onUpdateField={updateFieldAt}
          onMoveField={moveField}
          onRemoveField={removeFieldAt}
        />

        <ViewsTab
          width={effectiveWidth}
          fields={draft.fields}
          viewDrafts={draft.viewDrafts}
          titleFieldKey={draft.titleFieldKey}
          subtitleFieldKey={draft.subtitleFieldKey}
          rightBadgeFieldKey={draft.rightBadgeFieldKey}
          footerMetricKeys={draft.footerMetricKeys}
          onAddView={addViewDraft}
          onRemoveView={removeViewDraft}
          onMoveView={moveViewDraft}
          onUpdateViewName={updateViewDraftName}
          onSelectTitleKey={(titleFieldKey) => patchDraft({ titleFieldKey })}
          onSelectSubtitleKey={(subtitleFieldKey) => patchDraft({ subtitleFieldKey })}
          onSelectRightBadgeKey={(rightBadgeFieldKey) => patchDraft({ rightBadgeFieldKey })}
          onToggleFooterMetric={toggleFooterMetric}
        />
      </Animated.ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 14) }]}>
        <Pressable
          onPress={onClose}
          style={({ pressed }) => [styles.cancelBtn, pressed && { opacity: 0.78 }]}
        >
          <Text style={styles.cancelText}>取消</Text>
        </Pressable>
        <Pressable
          onPress={handleManualSave}
          style={({ pressed }) => [
            styles.saveBtn,
            { backgroundColor: tone.solid },
            pressed && { opacity: 0.85, transform: [{ scale: 0.985 }] },
          ]}
        >
          <Text style={styles.saveText}>保存</Text>
        </Pressable>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: Palette.borderHairline,
  },
  headerTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  closeBtn: {
    padding: 4,
  },
  tallSheet: {
    height: '88%',
  },
  tabBarWrap: {
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 6,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: Palette.borderHairline,
    backgroundColor: Palette.bgSurface,
  },
  pager: {
    flex: 1,
  },
  errorBanner: {
    backgroundColor: Palette.dangerSoft,
    padding: 12,
    borderRadius: 12,
  },
  errorText: {
    color: Palette.danger,
    fontSize: 13,
    fontWeight: '600',
  },
  footer: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: Palette.borderHairline,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: Palette.bgSubtle,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 15,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  saveBtn: {
    flex: 2,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: Palette.brand,
    alignItems: 'center',
  },
  saveText: {
    fontSize: 15,
    fontWeight: '700',
    color: Palette.inkInverse,
  },
});
