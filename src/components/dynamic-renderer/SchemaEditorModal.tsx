import Feather from '@expo/vector-icons/Feather';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  LayoutAnimation,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { runArchitectAgent } from '@/ai/agents';
import { BottomSheetModal } from '@/components/ui/BottomSheetModal';
import { Palette, ToneMap } from '@/constants/design-tokens';
import { useOmni } from '@/context/omni-context';
import type { LibraryRecord, LibraryViewInput } from '@/db/repository';
import type { FieldDef, FieldType } from '@/schema/field-defs';
import type { AccentTone, LibraryBlueprint, LibraryViewType } from '@/schema/view-dsl';

interface SchemaEditorModalProps {
  visible: boolean;
  existingLibrary?: LibraryRecord | null;
  defaultParentSlug?: string | null;
  onCreateSubLibrary?: (parentSlug: string) => void;
  onClose: () => void;
  onSaved?: (slug: string) => void;
  onDeleted?: (slug: string) => void;
}

const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: '文本',
  number: '数字',
  currency: '金额',
  date: '日期',
  select: '单选',
  multi_select: '多选',
  rating: '星级',
  checkbox: '勾选',
  image: '图片',
  relation: '跨表关联',
  rollup: '跨表汇总',
  formula: '计算公式',
};

const FIELD_TYPE_ICONS: Record<FieldType, React.ComponentProps<typeof Feather>['name']> = {
  text: 'type',
  number: 'hash',
  currency: 'dollar-sign',
  date: 'calendar',
  select: 'disc',
  multi_select: 'check-square',
  rating: 'star',
  checkbox: 'toggle-right',
  image: 'image',
  relation: 'link-2',
  rollup: 'layers',
  formula: 'sliders',
};

const COMMON_FIELD_TYPES: FieldType[] = [
  'text',
  'number',
  'currency',
  'date',
  'select',
  'multi_select',
  'rating',
  'checkbox',
  'image',
];

const ADVANCED_FIELD_TYPES: FieldType[] = ['relation', 'rollup', 'formula'];

const ROLLUP_FNS: Array<{ fn: 'SUM' | 'COUNT' | 'AVG' | 'MAX' | 'MIN'; label: string }> = [
  { fn: 'SUM', label: '求和' },
  { fn: 'COUNT', label: '计数' },
  { fn: 'AVG', label: '平均' },
  { fn: 'MAX', label: '最大' },
  { fn: 'MIN', label: '最小' },
];

const CURATED_EMOJIS = [
  '📒', '📚', '💰', '📷', '💊', '☕',
  '🏃', '🎬', '✈️', '🍽️', '🪴', '🎵',
  '🛍️', '📝', '💡', '🎯', '🏠', '🐾',
];

const VIEW_TYPE_META: Record<
  LibraryViewType,
  { label: string; icon: React.ComponentProps<typeof Feather>['name'] }
> = {
  card: { label: '列表', icon: 'list' },
  gallery: { label: '画廊', icon: 'grid' },
  calendar: { label: '日历', icon: 'calendar' },
  stats: { label: '统计', icon: 'pie-chart' },
};

const ALL_VIEW_TYPES: LibraryViewType[] = ['card', 'gallery', 'calendar', 'stats'];

const TONES: AccentTone[] = ['teal', 'amber', 'rose', 'blue', 'emerald', 'slate'];

export function SchemaEditorModal({
  visible,
  existingLibrary,
  defaultParentSlug,
  onCreateSubLibrary,
  onClose,
  onSaved,
  onDeleted,
}: SchemaEditorModalProps) {
  const { repo, libraries } = useOmni();
  const insets = useSafeAreaInsets();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [openTypePickerKey, setOpenTypePickerKey] = useState<string | null>(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [hierarchyExpanded, setHierarchyExpanded] = useState(Boolean(defaultParentSlug));
  const [cardDisplayExpanded, setCardDisplayExpanded] = useState(false);

  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('🗂️');
  const [color, setColor] = useState<AccentTone>('teal');
  const [description, setDescription] = useState('');
  const [parentLibrarySlug, setParentLibrarySlug] = useState('');
  const [showOnHome, setShowOnHome] = useState(true);
  const [fields, setFields] = useState<FieldDef[]>([]);

  // Card View Slots
  const [titleFieldKey, setTitleFieldKey] = useState('');
  const [subtitleFieldKey, setSubtitleFieldKey] = useState('');
  const [rightBadgeFieldKey, setRightBadgeFieldKey] = useState('');
  const [footerMetricKeys, setFooterMetricKeys] = useState<string[]>([]);
  const [viewDrafts, setViewDrafts] = useState<Array<{ id?: string; name: string; viewType: LibraryViewType }>>([
    { name: '列表', viewType: 'card' },
  ]);

  // Inline AI evolution
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [prevSession, setPrevSession] = useState<{
    visible: boolean;
    existingLibrary: LibraryRecord | null | undefined;
    defaultParentSlug: string | null | undefined;
  }>({ visible: false, existingLibrary: undefined, defaultParentSlug: undefined });

  if (
    visible &&
    (!prevSession.visible ||
      prevSession.existingLibrary !== existingLibrary ||
      prevSession.defaultParentSlug !== defaultParentSlug)
  ) {
    setPrevSession({ visible: true, existingLibrary, defaultParentSlug });
    setErrorMsg(null);
    setAiPrompt('');
    setConfirmDelete(false);
    if (existingLibrary) {
      setSlug(existingLibrary.slug);
      setName(existingLibrary.name);
      setIcon(existingLibrary.icon);
      setColor(existingLibrary.color);
      setDescription(existingLibrary.description);
      setParentLibrarySlug(existingLibrary.parentLibrarySlug ?? '');
      setShowOnHome(existingLibrary.showOnHome);
      setFields(existingLibrary.fields);
      setTitleFieldKey(existingLibrary.views.card.titleFieldKey);
      setSubtitleFieldKey(existingLibrary.views.card.subtitleFieldKey ?? '');
      setRightBadgeFieldKey(existingLibrary.views.card.rightBadgeFieldKey ?? '');
      setFooterMetricKeys(existingLibrary.views.card.footerMetricKeys);
      setViewDrafts(
        existingLibrary.viewList.length > 0
          ? existingLibrary.viewList.map((v) => ({
              id: v.id,
              name: v.name,
              viewType: v.viewType,
            }))
          : [{ name: '列表', viewType: 'card' }]
      );
    } else {
      const usedSlugs = new Set(libraries.map((l) => l.slug));
      let nextIdx = libraries.length + 1;
      while (usedSlugs.has(`custom_${nextIdx}`)) {
        nextIdx += 1;
      }
      setSlug(`custom_${nextIdx}`);
      setName('');
      setDescription('');

      const presetParent = defaultParentSlug
        ? libraries.find((l) => l.slug === defaultParentSlug)
        : undefined;

      if (presetParent) {
        setIcon('📝');
        setColor(presetParent.color);
        setParentLibrarySlug(presetParent.slug);
        setShowOnHome(false);
        setFields([
          {
            key: `parent_${presetParent.slug}`.slice(0, 28),
            label: `所属${presetParent.name}`,
            type: 'relation',
            required: false,
            relationConfig: {
              targetLibrarySlug: presetParent.slug,
              allowMultiple: false,
            },
          },
          {
            key: 'note',
            label: '内容与随感',
            type: 'text',
            required: false,
            multiline: true,
          },
          { key: 'record_date', label: '记录日期', type: 'date', required: true },
        ]);
        setTitleFieldKey('note');
        setSubtitleFieldKey('record_date');
        setRightBadgeFieldKey('');
        setFooterMetricKeys(['record_date']);
        setViewDrafts([{ name: '列表', viewType: 'card' }]);
      } else {
        setIcon('📒');
        setColor('teal');
        setParentLibrarySlug('');
        setShowOnHome(true);
        setFields([
          { key: 'title', label: '名称标题', type: 'text', required: true },
          {
            key: 'tag',
            label: '分类标签',
            type: 'select',
            required: false,
            options: [
              { value: '默认', color: '#0F766E' },
              { value: '重点', color: '#C26A1B' },
            ],
          },
          { key: 'record_date', label: '记录日期', type: 'date', required: true },
        ]);
        setTitleFieldKey('title');
        setSubtitleFieldKey('record_date');
        setRightBadgeFieldKey('tag');
        setFooterMetricKeys(['record_date']);
        setViewDrafts([{ name: '列表', viewType: 'card' }]);
      }
    }
  } else if (!visible && prevSession.visible) {
    setPrevSession((s) => ({ ...s, visible: false }));
    setOpenTypePickerKey(null);
    setEmojiPickerOpen(false);
    setHierarchyExpanded(false);
    setCardDisplayExpanded(false);
  }

  const toggleTypePicker = (rowKey: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpenTypePickerKey((prev) => (prev === rowKey ? null : rowKey));
  };

  const moveField = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= fields.length) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setFields((prev) => {
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
  };

  const addNewField = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    const idx = fields.length + 1;
    const suffix = Math.random().toString(36).slice(2, 6);
    setFields((prev) => [
      ...prev,
      {
        key: `field_${idx}_${suffix}`,
        label: `记录项 ${idx}`,
        type: 'text',
        required: false,
      },
    ]);
  };

  const updateFieldAt = (index: number, patch: Partial<FieldDef>) => {
    setFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  };

  const removeFieldAt = (index: number) => {
    if (fields.length <= 1) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    const removedKey = fields[index].key;
    setOpenTypePickerKey((prev) => (prev === removedKey ? null : prev));
    setFields((prev) => prev.filter((_, i) => i !== index));
    setFooterMetricKeys((prev) => prev.filter((k) => k !== removedKey));
  };

  const toggleFooterMetric = (key: string) => {
    setFooterMetricKeys((prev) =>
      prev.includes(key)
        ? prev.filter((k) => k !== key)
        : prev.length < 4
          ? [...prev, key]
          : prev
    );
  };

  const handleSelectParent = (nextParentSlug: string) => {
    setParentLibrarySlug(nextParentSlug);
    if (!nextParentSlug) {
      setShowOnHome(true);
      return;
    }
    if (!parentLibrarySlug) {
      setShowOnHome(false);
    }
    const targetLib = libraries.find((l) => l.slug === nextParentSlug);
    if (
      targetLib &&
      !fields.some(
        (f) => f.type === 'relation' && f.relationConfig?.targetLibrarySlug === nextParentSlug
      )
    ) {
      const baseKey = `parent_${nextParentSlug}`.slice(0, 28);
      const usedKeys = new Set(fields.map((f) => f.key));
      const relKey = usedKeys.has(baseKey) ? `${baseKey}_ref` : baseKey;
      setFields((prev) => [
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
        ...prev,
      ]);
    }
  };

  const handleAiAssist = async () => {
    if (!repo || !aiPrompt.trim()) return;
    try {
      setAiLoading(true);
      setErrorMsg(null);
      const scopedPrompt = existingLibrary
        ? `针对已有库 slug="${existingLibrary.slug}" (${existingLibrary.name}) 进行模型/样式调整：${aiPrompt}`
        : defaultParentSlug
          ? `围绕已有主库 slug="${defaultParentSlug}" 新建或调整附属子记录本：${aiPrompt}`
          : aiPrompt;
      const plan = await runArchitectAgent(repo, scopedPrompt);
      repo.applyArchitectPlan(plan);
      const targetSlug = plan.libraries[0]?.slug || slug;
      onSaved?.(targetSlug);
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setAiLoading(false);
    }
  };

  const addViewDraft = (viewType: LibraryViewType) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setViewDrafts((prev) => [...prev, { name: VIEW_TYPE_META[viewType].label, viewType }]);
  };

  const removeViewDraft = (idx: number) => {
    if (viewDrafts.length <= 1) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setViewDrafts((prev) => prev.filter((_, i) => i !== idx));
  };

  const moveViewDraft = (idx: number, delta: -1 | 1) => {
    const target = idx + delta;
    if (target < 0 || target >= viewDrafts.length) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setViewDrafts((prev) => {
      const next = [...prev];
      const [item] = next.splice(idx, 1);
      next.splice(target, 0, item);
      return next;
    });
  };

  const updateViewDraftName = (idx: number, nextName: string) => {
    setViewDrafts((prev) => prev.map((v, i) => (i === idx ? { ...v, name: nextName } : v)));
  };

  const handleManualSave = () => {
    if (!repo) return;
    try {
      setErrorMsg(null);
      const cleanSlug = slug.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
      if (!/^[a-z][a-z0-9_]*$/.test(cleanSlug)) {
        throw new Error('英文标识（slug）必须以小写字母开头，仅含字母、数字与下划线');
      }
      if (!name.trim()) {
        throw new Error('请填写数据表名称');
      }

      const validTitleKey = fields.some((f) => f.key === titleFieldKey)
        ? titleFieldKey
        : fields[0].key;
      const dateField = fields.find((f) => f.type === 'date');
      const imgField = fields.find((f) => f.type === 'image');
      const ratingField = fields.find((f) => f.type === 'rating');

      const cardConfig = {
        titleFieldKey: validTitleKey,
        subtitleFieldKey: subtitleFieldKey || undefined,
        coverImageFieldKey: imgField?.key,
        rightBadgeFieldKey: rightBadgeFieldKey || undefined,
        footerMetricKeys: footerMetricKeys.filter((k) => fields.some((f) => f.key === k)),
        sortFieldKey: dateField?.key,
        sortDir: 'desc' as const,
        highlightRules: existingLibrary?.views.card.highlightRules ?? [],
      };
      const galleryConfig = {
        titleFieldKey: validTitleKey,
        subtitleFieldKey: subtitleFieldKey || undefined,
        coverImageFieldKey: imgField?.key,
        badgeFieldKey: rightBadgeFieldKey || undefined,
        ratingFieldKey: ratingField?.key,
      };
      const calendarConfig = {
        dateFieldKey: dateField?.key ?? '',
        titleFieldKey: validTitleKey,
        metricFieldKey: footerMetricKeys[0],
      };

      const normalizedViews =
        viewDrafts.length > 0 ? viewDrafts : [{ name: '列表', viewType: 'card' as LibraryViewType }];
      const hasGallery = normalizedViews.some((v) => v.viewType === 'gallery');
      const hasCalendar = normalizedViews.some((v) => v.viewType === 'calendar');

      const blueprint: LibraryBlueprint = {
        slug: cleanSlug,
        name: name.trim(),
        description: description.trim(),
        icon: icon.trim() || '📦',
        color,
        parentLibrarySlug:
          parentLibrarySlug && parentLibrarySlug !== cleanSlug ? parentLibrarySlug : undefined,
        showOnHome,
        fields,
        views: {
          card: cardConfig,
          gallery: hasGallery ? galleryConfig : undefined,
          calendar: hasCalendar ? calendarConfig : undefined,
        },
      };

      repo.upsertLibrary(blueprint);

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
      repo.saveLibraryViews(cleanSlug, viewInputs);

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

  const parentCandidates = libraries.filter(
    (l) => !l.parentLibrarySlug && l.slug !== slug
  );

  return (
    <BottomSheetModal
      visible={visible}
      onClose={onClose}
      maxHeight="92%"
      maxWidth={720}
      header={
        <View style={styles.header}>
          <Text style={styles.headerTitle}>
            {existingLibrary ? `管理记录本 · ${existingLibrary.name}` : '新建记录本'}
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
      <ScrollView
        style={styles.scrollArea}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
            {errorMsg ? (
              <View style={styles.errorBanner}>
                <Text style={styles.errorText}>{errorMsg}</Text>
              </View>
            ) : null}

            {/* 一句话智能调整 */}
            <View style={styles.aiBox}>
              <View style={styles.aiTitleRow}>
                <Feather name="message-circle" size={14} color={Palette.brand} />
                <Text style={styles.aiBoxTitle}>一句话帮你调整</Text>
              </View>
              <View style={styles.aiInputRow}>
                <TextInput
                  value={aiPrompt}
                  onChangeText={setAiPrompt}
                  placeholder={
                    existingLibrary
                      ? '如：加一个报销状态选项，未报销时标黄提醒'
                      : '如：做一个咖啡豆记录本，并配一个冲煮记录附属表'
                  }
                  placeholderTextColor={Palette.inkMuted}
                  style={styles.aiInput}
                />
                <Pressable
                  disabled={aiLoading || !aiPrompt.trim()}
                  onPress={handleAiAssist}
                  style={[
                    styles.aiGoBtn,
                    (aiLoading || !aiPrompt.trim()) && styles.btnDisabled,
                  ]}
                >
                  {aiLoading ? (
                    <ActivityIndicator size="small" color={Palette.inkInverse} />
                  ) : (
                    <Text style={styles.aiGoText}>生成</Text>
                  )}
                </Pressable>
              </View>
            </View>

            {/* 基础信息 */}
            <Text style={styles.sectionTitle}>1. 名称与样式</Text>
            <View style={styles.rowGap}>
              <Pressable
                onPress={() => {
                  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                  setEmojiPickerOpen((v) => !v);
                }}
                style={({ pressed }) => [
                  styles.emojiTriggerBtn,
                  emojiPickerOpen && styles.emojiTriggerBtnOpen,
                  pressed && { opacity: 0.78 },
                ]}
                accessibilityLabel="选择记录本图标"
              >
                <Text style={styles.emojiTriggerText}>{icon || '📒'}</Text>
              </Pressable>
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="记录本名称（如 阅读记录）"
                placeholderTextColor={Palette.inkMuted}
                style={[styles.input, { flex: 1 }]}
              />
            </View>

            {emojiPickerOpen ? (
              <View style={styles.emojiPanel}>
                <View style={styles.emojiGrid}>
                  {CURATED_EMOJIS.map((em) => {
                    const active = icon === em;
                    return (
                      <Pressable
                        key={em}
                        onPress={() => {
                          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                          setIcon(em);
                          setEmojiPickerOpen(false);
                        }}
                        style={({ pressed }) => [
                          styles.emojiCell,
                          active && styles.emojiCellActive,
                          pressed && { opacity: 0.7 },
                        ]}
                      >
                        <Text style={styles.emojiCellText}>{em}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                <View style={styles.customEmojiRow}>
                  <Text style={styles.subFieldHint}>自定义图标：</Text>
                  <TextInput
                    value={icon}
                    onChangeText={setIcon}
                    maxLength={2}
                    placeholder="输入 Emoji"
                    placeholderTextColor={Palette.inkMuted}
                    style={[styles.smallInput, { width: 96, textAlign: 'center' }]}
                  />
                </View>
              </View>
            ) : null}

            <View style={styles.tonesRow}>
              {TONES.map((t) => {
                const active = color === t;
                return (
                  <Pressable
                    key={t}
                    onPress={() => setColor(t)}
                    style={[
                      styles.toneCircle,
                      { backgroundColor: ToneMap[t].solid },
                      active && styles.toneCircleActive,
                    ]}
                  />
                );
              })}
            </View>

            {parentCandidates.length > 0 ? (
              <View style={styles.collapsibleCard}>
                <Pressable
                  onPress={() => {
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    setHierarchyExpanded((v) => !v);
                  }}
                  style={({ pressed }) => [styles.collapsibleHeader, pressed && { opacity: 0.75 }]}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.collapsibleTitle}>归属与首页显示</Text>
                    <Text style={styles.collapsibleSub} numberOfLines={1}>
                      {parentLibrarySlug
                        ? `附属记录本（${parentCandidates.find((c) => c.slug === parentLibrarySlug)?.name ?? parentLibrarySlug}）`
                        : '独立主记录本'}
                      {showOnHome ? ' · 首页显示' : ' · 已收纳'}
                    </Text>
                  </View>
                  <Feather
                    name={hierarchyExpanded ? 'chevron-up' : 'chevron-down'}
                    size={16}
                    color={Palette.inkMuted}
                  />
                </Pressable>

                {hierarchyExpanded ? (
                  <View style={styles.collapsibleBody}>
                    <Text style={styles.subFieldHint}>层级归属（可选）：</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                      <View style={styles.typeChipsRow}>
                        <Pressable
                          onPress={() => handleSelectParent('')}
                          style={[styles.typeChip, !parentLibrarySlug && styles.typeChipActive]}
                        >
                          <Text
                            style={[
                              styles.typeChipText,
                              !parentLibrarySlug && styles.typeChipTextActive,
                            ]}
                          >
                            独立主记录本
                          </Text>
                        </Pressable>
                        {parentCandidates.map((cand) => {
                          const active = parentLibrarySlug === cand.slug;
                          return (
                            <Pressable
                              key={cand.slug}
                              onPress={() => handleSelectParent(cand.slug)}
                              style={[styles.typeChip, active && styles.typeChipActive]}
                            >
                              <Text style={[styles.typeChipText, active && styles.typeChipTextActive]}>
                                附属：{cand.icon} {cand.name}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    </ScrollView>

                    <View style={styles.homeSwitchRow}>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={styles.homeSwitchTitle}>在首页独立显示卡片</Text>
                        <Text style={styles.homeSwitchDesc}>
                          {parentLibrarySlug
                            ? '关闭后将收纳进主记录本内部切换栏与记录详情时间轴中'
                            : '关闭后可从全局搜索查看，不在首页网格展示'}
                        </Text>
                      </View>
                      <Switch
                        value={showOnHome}
                        onValueChange={setShowOnHome}
                        trackColor={{ false: Palette.borderStrong, true: Palette.brand }}
                      />
                    </View>

                    {existingLibrary && !parentLibrarySlug && onCreateSubLibrary ? (
                      <Pressable
                        onPress={() => onCreateSubLibrary(existingLibrary.slug)}
                        style={styles.spawnSubBtn}
                      >
                        <Feather name="corner-down-right" size={14} color={Palette.brand} />
                        <Text style={styles.spawnSubText}>
                          为「{existingLibrary.name}」新建附属子记录本（如阅读记录 / 跟进流水）
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
              </View>
            ) : null}

            {/* 记录项列表 */}
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>2. 记录项 ({fields.length})</Text>
              <Pressable onPress={addNewField} style={styles.addFieldBtn}>
                <Feather name="plus" size={14} color={Palette.brand} />
                <Text style={styles.addFieldText}>添加一项</Text>
              </Pressable>
            </View>

            {fields.map((field, index) => {
              const rowKey = field.key || String(index);
              const isPickerOpen = openTypePickerKey === rowKey;
              const typeBadgeIcon =
                field.type === 'text' && field.multiline
                  ? 'align-left'
                  : FIELD_TYPE_ICONS[field.type];
              const typeBadgeLabel =
                field.type === 'text' && field.multiline
                  ? '长文本'
                  : FIELD_TYPE_LABELS[field.type];

              return (
                <View
                  key={rowKey}
                  style={[styles.fieldCard, isPickerOpen && styles.fieldCardActive]}
                >
                  <View style={styles.rowGap}>
                    <TextInput
                      value={field.label}
                      onChangeText={(v) => updateFieldAt(index, { label: v })}
                      placeholder="填写名称，如：书摘随感、页码"
                      placeholderTextColor={Palette.inkMuted}
                      style={[styles.smallInput, styles.fieldNameInput]}
                    />

                    <Pressable
                      onPress={() => toggleTypePicker(rowKey)}
                      style={({ pressed }) => [
                        styles.typeSelectBtn,
                        isPickerOpen && styles.typeSelectBtnOpen,
                        pressed && { opacity: 0.78, transform: [{ scale: 0.97 }] },
                      ]}
                      accessibilityLabel={`选择${field.label || '记录项'}类型`}
                    >
                      <Feather
                        name={typeBadgeIcon}
                        size={13}
                        color={isPickerOpen ? Palette.brand : Palette.inkSecondary}
                      />
                      <Text
                        numberOfLines={1}
                        style={[
                          styles.typeSelectText,
                          isPickerOpen && styles.typeSelectTextOpen,
                        ]}
                      >
                        {typeBadgeLabel}
                        {field.required ? ' *' : ''}
                      </Text>
                      <Feather
                        name={isPickerOpen ? 'chevron-up' : 'chevron-down'}
                        size={13}
                        color={isPickerOpen ? Palette.brand : Palette.inkMuted}
                      />
                    </Pressable>

                    {fields.length > 1 ? (
                      <Pressable
                        onPress={() => removeFieldAt(index)}
                        hitSlop={6}
                        style={({ pressed }) => [
                          styles.delIconBtn,
                          pressed && { opacity: 0.65 },
                        ]}
                        accessibilityLabel="删除记录项"
                      >
                        <Feather name="trash-2" size={15} color={Palette.danger} />
                      </Pressable>
                    ) : null}
                  </View>

                  {isPickerOpen ? (
                    <View style={styles.typeDropdownPanel}>
                      {/* 排序、必填与单位快捷设置 */}
                      <View style={styles.fieldMetaBar}>
                        <View style={styles.moveBtnsRow}>
                          <Pressable
                            disabled={index === 0}
                            onPress={() => moveField(index, -1)}
                            style={[styles.metaChipBtn, index === 0 && styles.metaChipDisabled]}
                          >
                            <Feather name="arrow-up" size={12} color={Palette.inkSecondary} />
                            <Text style={styles.metaChipText}>上移</Text>
                          </Pressable>
                          <Pressable
                            disabled={index === fields.length - 1}
                            onPress={() => moveField(index, 1)}
                            style={[
                              styles.metaChipBtn,
                              index === fields.length - 1 && styles.metaChipDisabled,
                            ]}
                          >
                            <Feather name="arrow-down" size={12} color={Palette.inkSecondary} />
                            <Text style={styles.metaChipText}>下移</Text>
                          </Pressable>
                        </View>

                        {field.type !== 'rollup' && field.type !== 'formula' ? (
                          <Pressable
                            onPress={() => updateFieldAt(index, { required: !field.required })}
                            style={[
                              styles.metaChipBtn,
                              field.required && styles.metaChipBtnActive,
                            ]}
                          >
                            <Feather
                              name={field.required ? 'check-square' : 'square'}
                              size={12}
                              color={field.required ? Palette.brand : Palette.inkMuted}
                            />
                            <Text
                              style={[
                                styles.metaChipText,
                                field.required && { color: Palette.brand, fontWeight: '700' },
                              ]}
                            >
                              必填
                            </Text>
                          </Pressable>
                        ) : null}
                      </View>

                      {field.type === 'number' ||
                      field.type === 'formula' ||
                      field.type === 'rollup' ? (
                        <View style={styles.unitRow}>
                          <Text style={styles.typeGroupLabel}>显示单位（可选）</Text>
                          <TextInput
                            value={field.unit ?? ''}
                            onChangeText={(u) => updateFieldAt(index, { unit: u || undefined })}
                            placeholder="如：页、分钟、km、元/天"
                            placeholderTextColor={Palette.inkMuted}
                            style={[styles.smallInput, styles.unitInput]}
                          />
                        </View>
                      ) : null}

                      <Text style={styles.typeGroupLabel}>常用类型</Text>
                      <View style={styles.typeGrid}>
                        {COMMON_FIELD_TYPES.map((t) => {
                          const active = field.type === t;
                          return (
                            <Pressable
                              key={t}
                              onPress={() => {
                                LayoutAnimation.configureNext(
                                  LayoutAnimation.Presets.easeInEaseOut
                                );
                                updateFieldAt(
                                  index,
                                  t === 'text' ? { type: t } : { type: t, multiline: false }
                                );
                                setOpenTypePickerKey(null);
                              }}
                              style={({ pressed }) => [
                                styles.typeGridCell,
                                active && styles.typeGridCellActive,
                                pressed && { opacity: 0.75 },
                              ]}
                            >
                              <Feather
                                name={FIELD_TYPE_ICONS[t]}
                                size={13}
                                color={active ? Palette.brand : Palette.inkSecondary}
                              />
                              <Text
                                numberOfLines={1}
                                style={[
                                  styles.typeGridCellText,
                                  active && styles.typeGridCellTextActive,
                                ]}
                              >
                                {FIELD_TYPE_LABELS[t]}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>

                      {field.type === 'text' ? (
                        <Pressable
                          onPress={() => {
                            updateFieldAt(index, { multiline: !field.multiline });
                          }}
                          style={({ pressed }) => [
                            styles.multilineToggleRow,
                            field.multiline && styles.multilineToggleRowActive,
                            pressed && { opacity: 0.8 },
                          ]}
                        >
                          <Feather
                            name={field.multiline ? 'check-square' : 'square'}
                            size={14}
                            color={field.multiline ? Palette.brand : Palette.inkMuted}
                          />
                          <Text
                            style={[
                              styles.multilineToggleText,
                              field.multiline && styles.multilineToggleTextActive,
                            ]}
                          >
                            多行长文本（适合书摘、随感或长备注）
                          </Text>
                        </Pressable>
                      ) : null}

                      <Text style={[styles.typeGroupLabel, { marginTop: 4 }]}>
                        关联与自动计算
                      </Text>
                      <View style={styles.typeGrid}>
                        {ADVANCED_FIELD_TYPES.map((t) => {
                          const active = field.type === t;
                          return (
                            <Pressable
                              key={t}
                              onPress={() => {
                                LayoutAnimation.configureNext(
                                  LayoutAnimation.Presets.easeInEaseOut
                                );
                                updateFieldAt(index, { type: t, multiline: false });
                                setOpenTypePickerKey(null);
                              }}
                              style={({ pressed }) => [
                                styles.typeGridCell,
                                active && styles.typeGridCellActive,
                                pressed && { opacity: 0.75 },
                              ]}
                            >
                              <Feather
                                name={FIELD_TYPE_ICONS[t]}
                                size={13}
                                color={active ? Palette.brand : Palette.inkSecondary}
                              />
                              <Text
                                numberOfLines={1}
                                style={[
                                  styles.typeGridCellText,
                                  active && styles.typeGridCellTextActive,
                                ]}
                              >
                                {FIELD_TYPE_LABELS[t]}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    </View>
                  ) : null}

                  {(field.type === 'select' || field.type === 'multi_select') && (
                    <TextInput
                      value={(field.options ?? []).map((o) => o.value).join(', ')}
                      onChangeText={(txt) =>
                        updateFieldAt(index, {
                          options: txt
                            .split(/[,，]/)
                            .map((s) => s.trim())
                            .filter(Boolean)
                            .map((value) => ({ value })),
                        })
                      }
                      placeholder="选项列表，用逗号分隔（如：待办, 进行中, 已完成）"
                      placeholderTextColor={Palette.inkMuted}
                      style={styles.smallInput}
                    />
                  )}

                  {field.type === 'relation' && (
                    <View style={styles.typeChipsRow}>
                      <Text style={styles.subFieldHint}>指向目标库：</Text>
                      {libraries.map((targetLib) => {
                        const active = field.relationConfig?.targetLibrarySlug === targetLib.slug;
                        return (
                          <Pressable
                            key={targetLib.slug}
                            onPress={() =>
                              updateFieldAt(index, {
                                relationConfig: {
                                  targetLibrarySlug: targetLib.slug,
                                  allowMultiple: true,
                                },
                              })
                            }
                            style={[styles.typeChip, active && styles.typeChipActive]}
                          >
                            <Text style={[styles.typeChipText, active && styles.typeChipTextActive]}>
                              {targetLib.icon} {targetLib.name}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  )}

                  {field.type === 'formula' && (
                    <TextInput
                      value={field.formulaExpr ?? ''}
                      onChangeText={(v) => updateFieldAt(index, { formulaExpr: v })}
                      placeholder="表达式，如: ROUND(price / MAX(1, DAYS_SINCE(buy_date)), 2)"
                      placeholderTextColor={Palette.inkMuted}
                      autoCapitalize="none"
                      style={styles.smallInput}
                    />
                  )}

                  {field.type === 'rollup' && (() => {
                    const currentRelKey = field.rollupConfig?.relationFieldKey ?? '';
                    const currentTargetKey = field.rollupConfig?.targetFieldKey ?? '';
                    const currentFn = field.rollupConfig?.fn ?? 'SUM';

                    const rollupSources: Array<{
                      value: string;
                      label: string;
                      targetLib: LibraryRecord;
                    }> = [];

                    for (const rf of fields) {
                      if (rf.type === 'relation' && rf.relationConfig?.targetLibrarySlug) {
                        const targetLib = libraries.find(
                          (l) => l.slug === rf.relationConfig?.targetLibrarySlug
                        );
                        if (targetLib) {
                          rollupSources.push({
                            value: rf.key,
                            label: `${rf.label} (${targetLib.icon}${targetLib.name})`,
                            targetLib,
                          });
                        }
                      }
                    }

                    if (slug) {
                      for (const otherLib of libraries) {
                        if (otherLib.slug === slug) continue;
                        for (const ofield of otherLib.fields) {
                          if (
                            ofield.type === 'relation' &&
                            ofield.relationConfig?.targetLibrarySlug === slug
                          ) {
                            rollupSources.push({
                              value: `reverse:${otherLib.slug}.${ofield.key}`,
                              label: `关联表：${otherLib.icon} ${otherLib.name}`,
                              targetLib: otherLib,
                            });
                          }
                        }
                      }
                    }

                    const matchedSource = rollupSources.find((s) => s.value === currentRelKey);
                    const targetFields = matchedSource
                      ? matchedSource.targetLib.fields.filter(
                          (tf) =>
                            tf.type === 'number' ||
                            tf.type === 'currency' ||
                            tf.type === 'rating' ||
                            tf.type === 'formula'
                        )
                      : [];

                    return (
                      <View style={styles.rollupBox}>
                        {rollupSources.length > 0 ? (
                          <>
                            <Text style={styles.typeGroupLabel}>汇总来源</Text>
                            <View style={styles.typeChipsRow}>
                              {rollupSources.map((src) => {
                                const active = src.value === currentRelKey;
                                return (
                                  <Pressable
                                    key={src.value}
                                    onPress={() => {
                                      const defaultField =
                                        src.targetLib.fields.find(
                                          (tf) => tf.type === 'currency' || tf.type === 'number'
                                        )?.key ?? src.targetLib.fields[0]?.key ?? 'id';
                                      updateFieldAt(index, {
                                        rollupConfig: {
                                          relationFieldKey: src.value,
                                          targetFieldKey: defaultField,
                                          fn: currentFn,
                                        },
                                      });
                                    }}
                                    style={[styles.typeChip, active && styles.typeChipActive]}
                                  >
                                    <Text
                                      style={[
                                        styles.typeChipText,
                                        active && styles.typeChipTextActive,
                                      ]}
                                    >
                                      {src.label}
                                    </Text>
                                  </Pressable>
                                );
                              })}
                            </View>

                            <Text style={styles.typeGroupLabel}>统计方式</Text>
                            <View style={styles.typeChipsRow}>
                              {ROLLUP_FNS.map((item) => {
                                const active = currentFn === item.fn;
                                return (
                                  <Pressable
                                    key={item.fn}
                                    onPress={() =>
                                      updateFieldAt(index, {
                                        rollupConfig: {
                                          relationFieldKey: currentRelKey,
                                          targetFieldKey: currentTargetKey || 'id',
                                          fn: item.fn,
                                        },
                                      })
                                    }
                                    style={[styles.typeChip, active && styles.typeChipActive]}
                                  >
                                    <Text
                                      style={[
                                        styles.typeChipText,
                                        active && styles.typeChipTextActive,
                                      ]}
                                    >
                                      {item.label}
                                    </Text>
                                  </Pressable>
                                );
                              })}
                            </View>

                            {currentFn !== 'COUNT' && targetFields.length > 0 ? (
                              <>
                                <Text style={styles.typeGroupLabel}>目标数值字段</Text>
                                <View style={styles.typeChipsRow}>
                                  {targetFields.map((tf) => {
                                    const active = currentTargetKey === tf.key;
                                    return (
                                      <Pressable
                                        key={tf.key}
                                        onPress={() =>
                                          updateFieldAt(index, {
                                            rollupConfig: {
                                              relationFieldKey: currentRelKey,
                                              targetFieldKey: tf.key,
                                              fn: currentFn,
                                            },
                                          })
                                        }
                                        style={[styles.typeChip, active && styles.typeChipActive]}
                                      >
                                        <Text
                                          style={[
                                            styles.typeChipText,
                                            active && styles.typeChipTextActive,
                                          ]}
                                        >
                                          {tf.label}
                                        </Text>
                                      </Pressable>
                                    );
                                  })}
                                </View>
                              </>
                            ) : null}
                          </>
                        ) : (
                          <View style={styles.rowGap}>
                            <TextInput
                              value={currentRelKey}
                              onChangeText={(v) =>
                                updateFieldAt(index, {
                                  rollupConfig: {
                                    relationFieldKey: v,
                                    targetFieldKey: currentTargetKey || 'amount',
                                    fn: currentFn,
                                  },
                                })
                              }
                              placeholder="先添加一个「跨表关联」字段或附属表"
                              placeholderTextColor={Palette.inkMuted}
                              autoCapitalize="none"
                              style={[styles.smallInput, { flex: 1 }]}
                            />
                            <TextInput
                              value={currentTargetKey}
                              onChangeText={(v) =>
                                updateFieldAt(index, {
                                  rollupConfig: {
                                    relationFieldKey: currentRelKey,
                                    targetFieldKey: v,
                                    fn: currentFn,
                                  },
                                })
                              }
                              placeholder="目标字段"
                              placeholderTextColor={Palette.inkMuted}
                              autoCapitalize="none"
                              style={[styles.smallInput, { width: 96 }]}
                            />
                          </View>
                        )}
                      </View>
                    );
                  })()}
                </View>
              );
            })}

            {/* 3. 视图管理（独立 View 表：按需开启画廊 / 日历 / 统计，支持改名与排序） */}
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>3. 视图表现 ({viewDrafts.length})</Text>
              <Text style={styles.viewSectionHint}>仅 1 个视图时自动隐藏切换栏</Text>
            </View>
            <View style={styles.viewsManagerCard}>
              {viewDrafts.map((v, idx) => {
                const meta = VIEW_TYPE_META[v.viewType];
                return (
                  <View key={v.id ?? `${v.viewType}_${idx}`} style={styles.viewManageRow}>
                    <View style={styles.viewTypeTag}>
                      <Feather name={meta.icon} size={13} color={Palette.brand} />
                      <Text style={styles.viewTypeTagText}>{meta.label}</Text>
                    </View>
                    <TextInput
                      value={v.name}
                      onChangeText={(txt) => updateViewDraftName(idx, txt)}
                      placeholder={meta.label}
                      placeholderTextColor={Palette.inkMuted}
                      style={[styles.smallInput, styles.viewNameInput]}
                    />
                    <Pressable
                      disabled={idx === 0}
                      onPress={() => moveViewDraft(idx, -1)}
                      hitSlop={4}
                      style={[styles.viewMiniBtn, idx === 0 && styles.metaChipDisabled]}
                    >
                      <Feather name="arrow-up" size={13} color={Palette.inkSecondary} />
                    </Pressable>
                    <Pressable
                      disabled={idx === viewDrafts.length - 1}
                      onPress={() => moveViewDraft(idx, 1)}
                      hitSlop={4}
                      style={[
                        styles.viewMiniBtn,
                        idx === viewDrafts.length - 1 && styles.metaChipDisabled,
                      ]}
                    >
                      <Feather name="arrow-down" size={13} color={Palette.inkSecondary} />
                    </Pressable>
                    {viewDrafts.length > 1 ? (
                      <Pressable
                        onPress={() => removeViewDraft(idx)}
                        hitSlop={4}
                        style={styles.viewMiniBtn}
                        accessibilityLabel="移除该视图"
                      >
                        <Feather name="x" size={14} color={Palette.danger} />
                      </Pressable>
                    ) : null}
                  </View>
                );
              })}

              {ALL_VIEW_TYPES.some((vt) => !viewDrafts.some((d) => d.viewType === vt)) ? (
                <View style={styles.addViewRow}>
                  <Text style={styles.subFieldHint}>按需添加：</Text>
                  {ALL_VIEW_TYPES.filter((vt) => !viewDrafts.some((d) => d.viewType === vt)).map(
                    (vt) => (
                      <Pressable
                        key={vt}
                        onPress={() => addViewDraft(vt)}
                        style={({ pressed }) => [
                          styles.addViewChip,
                          pressed && { opacity: 0.72 },
                        ]}
                      >
                        <Feather name="plus" size={12} color={Palette.brand} />
                        <Feather name={VIEW_TYPE_META[vt].icon} size={12} color={Palette.brand} />
                        <Text style={styles.addViewChipText}>{VIEW_TYPE_META[vt].label}</Text>
                      </Pressable>
                    )
                  )}
                </View>
              ) : null}
            </View>

            {/* 4. 列表卡片显示（默认折叠，按需微调） */}
            <View style={styles.collapsibleCard}>
              <Pressable
                onPress={() => {
                  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                  setCardDisplayExpanded((v) => !v);
                }}
                style={({ pressed }) => [styles.collapsibleHeader, pressed && { opacity: 0.75 }]}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.collapsibleTitle}>列表卡片显示字段</Text>
                  <Text style={styles.collapsibleSub} numberOfLines={1}>
                    主标题：{fields.find((f) => f.key === titleFieldKey)?.label ?? '自动'}
                    {footerMetricKeys.length > 0 ? ` · ${footerMetricKeys.length} 项重点数值` : ''}
                  </Text>
                </View>
                <Feather
                  name={cardDisplayExpanded ? 'chevron-up' : 'chevron-down'}
                  size={16}
                  color={Palette.inkMuted}
                />
              </Pressable>

              {cardDisplayExpanded ? (
                <View style={styles.collapsibleBody}>
                  <SlotPickerRow
                    label="主标题"
                    fields={fields}
                    selectedKey={titleFieldKey}
                    onSelect={setTitleFieldKey}
                  />
                  <SlotPickerRow
                    label="副标题"
                    fields={fields}
                    selectedKey={subtitleFieldKey}
                    allowEmpty
                    onSelect={setSubtitleFieldKey}
                  />
                  <SlotPickerRow
                    label="右上角标签"
                    fields={fields}
                    selectedKey={rightBadgeFieldKey}
                    allowEmpty
                    onSelect={setRightBadgeFieldKey}
                  />

                  <View style={styles.slotBlock}>
                    <Text style={styles.subFieldHint}>底部重点数值（最多选 4 项）：</Text>
                    <View style={styles.typeChipsRow}>
                      {fields.map((f) => {
                        const active = footerMetricKeys.includes(f.key);
                        return (
                          <Pressable
                            key={f.key}
                            onPress={() => toggleFooterMetric(f.key)}
                            style={[styles.typeChip, active && styles.typeChipActive]}
                          >
                            <Text style={[styles.typeChipText, active && styles.typeChipTextActive]}>
                              {f.label}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                </View>
              ) : null}
            </View>

            {/* 4. 删除整个记录本 */}
            {existingLibrary ? (
              <View style={styles.dangerBox}>
                <Text style={styles.dangerTitle}>删除记录本</Text>
                <Text style={styles.dangerHint}>
                  将删除「{existingLibrary.name}」及里面的全部 {existingLibrary.entryCount} 条记录。删除前会自动留存一份备份，可在「设置 → 最近操作记录」里随时撤销。
                </Text>
                {confirmDelete ? (
                  <View style={styles.dangerActionsRow}>
                    <Pressable
                      onPress={() => setConfirmDelete(false)}
                      style={styles.dangerCancelBtn}
                    >
                      <Text style={styles.dangerCancelText}>先不删</Text>
                    </Pressable>
                    <Pressable onPress={handleDeleteLibrary} style={styles.dangerConfirmBtn}>
                      <Feather name="trash-2" size={14} color={Palette.inkInverse} />
                      <Text style={styles.dangerConfirmText}>确认删除</Text>
                    </Pressable>
                  </View>
                ) : (
                  <Pressable
                    onPress={() => setConfirmDelete(true)}
                    style={styles.dangerTriggerBtn}
                  >
                    <Feather name="trash-2" size={14} color={Palette.danger} />
                    <Text style={styles.dangerTriggerText}>删除整个记录本</Text>
                  </Pressable>
                )}
              </View>
            ) : null}
          </ScrollView>

          <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 14) }]}>
            <Pressable onPress={onClose} style={styles.cancelBtn}>
              <Text style={styles.cancelText}>取消</Text>
            </Pressable>
            <Pressable onPress={handleManualSave} style={styles.saveBtn}>
              <Text style={styles.saveText}>保存</Text>
            </Pressable>
          </View>
    </BottomSheetModal>
  );
}

function SlotPickerRow({
  label,
  fields,
  selectedKey,
  allowEmpty,
  onSelect,
}: {
  label: string;
  fields: FieldDef[];
  selectedKey: string;
  allowEmpty?: boolean;
  onSelect: (key: string) => void;
}) {
  return (
    <View style={styles.slotBlock}>
      <Text style={styles.subFieldHint}>{label}：</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.typeChipsRow}>
          {allowEmpty ? (
            <Pressable
              onPress={() => onSelect('')}
              style={[styles.typeChip, !selectedKey && styles.typeChipActive]}
            >
              <Text style={[styles.typeChipText, !selectedKey && styles.typeChipTextActive]}>
                不显示
              </Text>
            </Pressable>
          ) : null}
          {fields.map((f) => {
            const active = selectedKey === f.key;
            return (
              <Pressable
                key={f.key}
                onPress={() => onSelect(f.key)}
                style={[styles.typeChip, active && styles.typeChipActive]}
              >
                <Text style={[styles.typeChipText, active && styles.typeChipTextActive]}>
                  {f.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
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
    fontSize: 17,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  closeBtn: {
    padding: 4,
  },
  scrollArea: {
    paddingHorizontal: 20,
  },
  scrollContent: {
    paddingVertical: 16,
    gap: 14,
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
  aiBox: {
    backgroundColor: Palette.brandSoft,
    padding: 14,
    borderRadius: 14,
    gap: 8,
  },
  aiTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  aiBoxTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.brand,
  },
  aiInputRow: {
    flexDirection: 'row',
    gap: 8,
  },
  aiInput: {
    flex: 1,
    backgroundColor: Palette.bgSurface,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 13,
    color: Palette.inkPrimary,
  },
  aiGoBtn: {
    backgroundColor: Palette.brand,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiGoText: {
    color: Palette.inkInverse,
    fontSize: 13,
    fontWeight: '700',
  },
  btnDisabled: {
    opacity: 0.45,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: Palette.inkPrimary,
    marginTop: 4,
  },
  rowGap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  input: {
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: Palette.inkPrimary,
  },
  smallInput: {
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: Palette.inkPrimary,
  },
  tonesRow: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 4,
  },
  toneCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  toneCircleActive: {
    borderWidth: 3,
    borderColor: Palette.inkPrimary,
  },
  hierarchyBox: {
    backgroundColor: Palette.bgCanvas,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 10,
  },
  homeSwitchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: Palette.borderHairline,
  },
  homeSwitchTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  homeSwitchDesc: {
    fontSize: 11,
    color: Palette.inkMuted,
    lineHeight: 16,
  },
  spawnSubBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Palette.brandSoft,
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderRadius: 10,
  },
  spawnSubText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    color: Palette.brand,
  },
  addFieldBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Palette.brandSoft,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  addFieldText: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.brand,
  },
  fieldCard: {
    backgroundColor: Palette.bgCanvas,
    borderRadius: 14,
    padding: 10,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 8,
  },
  fieldCardActive: {
    borderColor: Palette.brand,
  },
  fieldNameInput: {
    flex: 1,
    minWidth: 0,
    height: 38,
    paddingVertical: 0,
  },
  typeSelectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 38,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    flexShrink: 0,
  },
  typeSelectBtnOpen: {
    backgroundColor: Palette.brandSoft,
    borderColor: Palette.brand,
  },
  typeSelectText: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.inkSecondary,
    maxWidth: 68,
  },
  typeSelectTextOpen: {
    color: Palette.brand,
  },
  typeDropdownPanel: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 8,
  },
  typeGroupLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: Palette.inkMuted,
  },
  typeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  typeGridCell: {
    width: '31.5%',
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 9,
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  typeGridCellActive: {
    backgroundColor: Palette.brandSoft,
    borderColor: Palette.brand,
  },
  typeGridCellText: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  typeGridCellTextActive: {
    color: Palette.brand,
    fontWeight: '700',
  },
  multilineToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 9,
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  multilineToggleRowActive: {
    backgroundColor: Palette.brandSoft,
    borderColor: Palette.brand,
  },
  multilineToggleText: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  multilineToggleTextActive: {
    color: Palette.brand,
    fontWeight: '700',
  },
  delIconBtn: {
    width: 34,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emojiTriggerBtn: {
    width: 52,
    height: 44,
    borderRadius: 12,
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emojiTriggerBtnOpen: {
    backgroundColor: Palette.brandSoft,
    borderColor: Palette.brand,
  },
  emojiTriggerText: {
    fontSize: 22,
  },
  emojiPanel: {
    backgroundColor: Palette.bgCanvas,
    borderRadius: 14,
    padding: 10,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 10,
  },
  emojiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  emojiCell: {
    width: '15%',
    flexGrow: 1,
    height: 38,
    borderRadius: 10,
    backgroundColor: Palette.bgSurface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  emojiCellActive: {
    backgroundColor: Palette.brandSoft,
    borderColor: Palette.brand,
  },
  emojiCellText: {
    fontSize: 19,
  },
  customEmojiRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: Palette.borderHairline,
  },
  collapsibleCard: {
    backgroundColor: Palette.bgCanvas,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    overflow: 'hidden',
  },
  collapsibleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 13,
    paddingVertical: 11,
  },
  collapsibleTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  collapsibleSub: {
    fontSize: 11,
    color: Palette.inkMuted,
  },
  collapsibleBody: {
    paddingHorizontal: 13,
    paddingBottom: 13,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: Palette.borderHairline,
    gap: 10,
  },
  fieldMetaBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: Palette.borderHairline,
  },
  moveBtnsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  metaChipBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  metaChipBtnActive: {
    backgroundColor: Palette.brandSoft,
    borderColor: Palette.brand,
  },
  metaChipDisabled: {
    opacity: 0.35,
  },
  metaChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  unitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  unitInput: {
    flex: 1,
    height: 34,
    paddingVertical: 0,
  },
  rollupBox: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 7,
  },
  viewSectionHint: {
    fontSize: 11,
    color: Palette.inkMuted,
  },
  viewsManagerCard: {
    backgroundColor: Palette.bgCanvas,
    borderRadius: 14,
    padding: 10,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 8,
  },
  viewManageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  viewTypeTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Palette.brandSoft,
    paddingHorizontal: 9,
    height: 36,
    borderRadius: 9,
  },
  viewTypeTagText: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.brand,
  },
  viewNameInput: {
    flex: 1,
    height: 36,
    paddingVertical: 0,
  },
  viewMiniBtn: {
    width: 28,
    height: 32,
    borderRadius: 8,
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addViewRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: Palette.borderHairline,
  },
  addViewChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Palette.brandSoft,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  addViewChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.brand,
  },
  typeChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  typeChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  typeChipActive: {
    backgroundColor: Palette.brand,
    borderColor: Palette.brand,
  },
  typeChipText: {
    fontSize: 12,
    color: Palette.inkSecondary,
    fontWeight: '600',
  },
  typeChipTextActive: {
    color: Palette.inkInverse,
  },
  subFieldHint: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  slotBlock: {
    gap: 6,
  },
  dangerBox: {
    marginTop: 8,
    backgroundColor: Palette.dangerSoft,
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  dangerTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Palette.danger,
  },
  dangerHint: {
    fontSize: 12,
    color: Palette.inkSecondary,
    lineHeight: 18,
  },
  dangerTriggerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.danger,
    paddingVertical: 10,
    borderRadius: 10,
    marginTop: 2,
  },
  dangerTriggerText: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.danger,
  },
  dangerActionsRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 2,
  },
  dangerCancelBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: Palette.bgSurface,
  },
  dangerCancelText: {
    fontSize: 13,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  dangerConfirmBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: Palette.danger,
  },
  dangerConfirmText: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkInverse,
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
