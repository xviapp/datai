import type { LibraryRecord, LibraryViewInput, LibraryViewRecord } from '@/db/models';
import type { FieldDef } from '@/schema/field-defs';
import {
  getDefaultViewLabel,
  type AccentTone,
  type CalendarViewConfig,
  type CardViewConfig,
  type GalleryViewConfig,
  type LibraryBlueprint,
  type LibraryViewType,
} from '@/schema/view-dsl';

export interface ViewDraftItem {
  id?: string;
  name: string;
  viewType: LibraryViewType;
  /** 保留原有视图配置快照，避免保存时丢失编辑器未暴露的高级项（如 sortFieldKey / sortDir / tagFieldKey） */
  config?: Record<string, unknown>;
}

export interface SchemaDraftState {
  slug: string;
  name: string;
  icon: string;
  color: AccentTone;
  description: string;
  parentLibrarySlug: string;
  showOnHome: boolean;
  fields: FieldDef[];
  titleFieldKey: string;
  subtitleFieldKey: string;
  rightBadgeFieldKey: string;
  footerMetricKeys: string[];
  viewDrafts: ViewDraftItem[];
}

export interface SchemaSavePayload {
  slug: string;
  blueprint: LibraryBlueprint;
  viewInputs: LibraryViewInput[];
}

function cloneRecord(obj?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!obj) return undefined;
  return { ...obj };
}

/**
 * 从已有记录本或默认预设构造编辑器草稿，完整保留各视图的 ID 与既有配置。
 */
export function buildInitialSchemaDraft(
  libraries: readonly LibraryRecord[],
  existingLibrary?: LibraryRecord | null,
  defaultParentSlug?: string | null
): SchemaDraftState {
  if (existingLibrary) {
    return {
      slug: existingLibrary.slug,
      name: existingLibrary.name,
      icon: existingLibrary.icon,
      color: existingLibrary.color,
      description: existingLibrary.description,
      parentLibrarySlug: existingLibrary.parentLibrarySlug ?? '',
      showOnHome: existingLibrary.showOnHome,
      fields: existingLibrary.fields.map((f) => ({ ...f })),
      titleFieldKey: existingLibrary.views.card.titleFieldKey,
      subtitleFieldKey: existingLibrary.views.card.subtitleFieldKey ?? '',
      rightBadgeFieldKey: existingLibrary.views.card.rightBadgeFieldKey ?? '',
      footerMetricKeys: [...existingLibrary.views.card.footerMetricKeys],
      viewDrafts:
        existingLibrary.viewList.length > 0
          ? existingLibrary.viewList.map((v) => ({
              id: v.id,
              name: v.name,
              viewType: v.viewType,
              config: cloneRecord(v.config),
            }))
          : [
              {
                name: getDefaultViewLabel('card'),
                viewType: 'card',
                config: cloneRecord(existingLibrary.views.card as unknown as Record<string, unknown>),
              },
            ],
    };
  }

  const usedSlugs = new Set(libraries.map((l) => l.slug));
  let nextIdx = libraries.length + 1;
  while (usedSlugs.has(`custom_${nextIdx}`)) {
    nextIdx += 1;
  }
  const slug = `custom_${nextIdx}`;

  const presetParent = defaultParentSlug
    ? libraries.find((l) => l.slug === defaultParentSlug)
    : undefined;

  if (presetParent) {
    return {
      slug,
      name: '',
      description: '',
      icon: '📝',
      color: presetParent.color,
      parentLibrarySlug: presetParent.slug,
      showOnHome: false,
      fields: [
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
      ],
      titleFieldKey: 'note',
      subtitleFieldKey: 'record_date',
      rightBadgeFieldKey: '',
      footerMetricKeys: ['record_date'],
      viewDrafts: [{ name: getDefaultViewLabel('card'), viewType: 'card' }],
    };
  }

  return {
    slug,
    name: '',
    description: '',
    icon: '📒',
    color: 'teal',
    parentLibrarySlug: '',
    showOnHome: true,
    fields: [
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
    ],
    titleFieldKey: 'title',
    subtitleFieldKey: 'record_date',
    rightBadgeFieldKey: 'tag',
    footerMetricKeys: ['record_date'],
    viewDrafts: [{ name: getDefaultViewLabel('card'), viewType: 'card' }],
  };
}

/**
 * 将编辑器草稿组装为可落盘的 blueprint 与 viewInputs：
 * - 已有视图按视图 ID 保留原有配置（含 sortFieldKey / sortDir / highlightRules / tagFieldKey 等），
 *   仅合并用户在编辑器中改动的槽位，并清理已被删除的字段引用；
 * - 新增视图才按当前字段结构套用默认配置。
 */
export function buildSchemaSavePayload(
  draft: SchemaDraftState,
  existingLibrary?: LibraryRecord | null
): SchemaSavePayload {
  const cleanSlug = draft.slug.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!/^[a-z][a-z0-9_]*$/.test(cleanSlug)) {
    throw new Error('英文标识（slug）必须以小写字母开头，仅含字母、数字与下划线');
  }
  if (!draft.name.trim()) {
    throw new Error('请先在「基础」页填写记录本名称');
  }
  if (draft.fields.length === 0) {
    throw new Error('至少需要保留 1 个字段');
  }

  const fieldKeySet = new Set(draft.fields.map((f) => f.key));
  const keepValidKey = (val: unknown): string | undefined =>
    typeof val === 'string' && val.length > 0 && fieldKeySet.has(val) ? val : undefined;

  const validTitleKey = keepValidKey(draft.titleFieldKey) ?? draft.fields[0].key;
  const validSubtitleKey = keepValidKey(draft.subtitleFieldKey);
  const validRightBadgeKey = keepValidKey(draft.rightBadgeFieldKey);
  const validFooterMetricKeys = draft.footerMetricKeys.filter((k) => fieldKeySet.has(k));

  const firstDateKey = draft.fields.find((f) => f.type === 'date')?.key;
  const firstImageKey = draft.fields.find((f) => f.type === 'image')?.key;
  const firstRatingKey = draft.fields.find((f) => f.type === 'rating')?.key;

  const hadImageField = Boolean(existingLibrary?.fields.some((f) => f.type === 'image'));
  const hadRatingField = Boolean(existingLibrary?.fields.some((f) => f.type === 'rating'));

  const initialCard = existingLibrary?.views.card;
  const initialSubtitleKey = initialCard?.subtitleFieldKey ?? '';
  const initialRightBadgeKey = initialCard?.rightBadgeFieldKey ?? '';
  const initialFooterKeys = initialCard?.footerMetricKeys ?? [];

  const titleChanged = !existingLibrary || draft.titleFieldKey !== (initialCard?.titleFieldKey ?? '');
  const subtitleChanged = !existingLibrary || draft.subtitleFieldKey !== initialSubtitleKey;
  const rightBadgeChanged = !existingLibrary || draft.rightBadgeFieldKey !== initialRightBadgeKey;
  const footerMetricsChanged =
    !existingLibrary ||
    draft.footerMetricKeys.length !== initialFooterKeys.length ||
    draft.footerMetricKeys.some((k, idx) => k !== initialFooterKeys[idx]);

  const existingViewById = new Map<string, LibraryViewRecord>(
    (existingLibrary?.viewList ?? []).map((v) => [v.id, v])
  );
  const primaryExistingCardId = existingLibrary?.viewList.find((v) => v.viewType === 'card')?.id;

  const buildDefaultCardConfig = (): CardViewConfig => ({
    titleFieldKey: validTitleKey,
    subtitleFieldKey: validSubtitleKey,
    coverImageFieldKey: firstImageKey,
    rightBadgeFieldKey: validRightBadgeKey,
    footerMetricKeys: validFooterMetricKeys,
    sortFieldKey: firstDateKey,
    sortDir: 'desc',
    highlightRules: [],
  });

  const mergeExistingCardConfig = (
    rawBase: Record<string, unknown>,
    fallbackFromBundle?: CardViewConfig
  ): CardViewConfig & Record<string, unknown> => {
    const mergedRaw: Record<string, unknown> = fallbackFromBundle
      ? { ...(fallbackFromBundle as unknown as Record<string, unknown>), ...rawBase }
      : { ...rawBase };
    const baseCard = mergedRaw as Partial<CardViewConfig>;

    const baseRules = Array.isArray(baseCard.highlightRules)
      ? baseCard.highlightRules
      : (fallbackFromBundle?.highlightRules ?? []);
    const validRules = baseRules.filter(
      (rule) => Boolean(rule && typeof rule.fieldKey === 'string' && fieldKeySet.has(rule.fieldKey))
    );

    const baseFooters = Array.isArray(baseCard.footerMetricKeys)
      ? baseCard.footerMetricKeys.filter((k) => typeof k === 'string' && fieldKeySet.has(k))
      : validFooterMetricKeys;

    const sortDir: 'asc' | 'desc' = baseCard.sortDir === 'asc' ? 'asc' : 'desc';

    return {
      ...mergedRaw,
      titleFieldKey: titleChanged
        ? validTitleKey
        : (keepValidKey(baseCard.titleFieldKey) ?? validTitleKey),
      subtitleFieldKey: subtitleChanged
        ? validSubtitleKey
        : keepValidKey(baseCard.subtitleFieldKey),
      coverImageFieldKey:
        keepValidKey(baseCard.coverImageFieldKey) ?? (!hadImageField ? firstImageKey : undefined),
      rightBadgeFieldKey: rightBadgeChanged
        ? validRightBadgeKey
        : keepValidKey(baseCard.rightBadgeFieldKey),
      footerMetricKeys: footerMetricsChanged ? validFooterMetricKeys : baseFooters,
      sortFieldKey: keepValidKey(baseCard.sortFieldKey),
      sortDir,
      highlightRules: validRules,
    };
  };

  const buildDefaultGalleryConfig = (): GalleryViewConfig => ({
    titleFieldKey: validTitleKey,
    subtitleFieldKey: validSubtitleKey,
    coverImageFieldKey: firstImageKey,
    badgeFieldKey: validRightBadgeKey,
    ratingFieldKey: firstRatingKey,
  });

  const mergeExistingGalleryConfig = (
    rawBase: Record<string, unknown>
  ): GalleryViewConfig & Record<string, unknown> => {
    const baseGallery = rawBase as Partial<GalleryViewConfig>;
    return {
      ...rawBase,
      titleFieldKey: titleChanged
        ? validTitleKey
        : (keepValidKey(baseGallery.titleFieldKey) ?? validTitleKey),
      subtitleFieldKey: subtitleChanged
        ? validSubtitleKey
        : keepValidKey(baseGallery.subtitleFieldKey),
      coverImageFieldKey:
        keepValidKey(baseGallery.coverImageFieldKey) ?? (!hadImageField ? firstImageKey : undefined),
      badgeFieldKey: rightBadgeChanged
        ? validRightBadgeKey
        : keepValidKey(baseGallery.badgeFieldKey),
      ratingFieldKey:
        keepValidKey(baseGallery.ratingFieldKey) ?? (!hadRatingField ? firstRatingKey : undefined),
    };
  };

  const buildDefaultCalendarConfig = (): CalendarViewConfig => ({
    dateFieldKey: firstDateKey ?? '',
    titleFieldKey: validTitleKey,
    metricFieldKey: validFooterMetricKeys[0],
    tagFieldKey: validRightBadgeKey,
  });

  const mergeExistingCalendarConfig = (
    rawBase: Record<string, unknown>
  ): CalendarViewConfig & Record<string, unknown> => {
    const baseCalendar = rawBase as Partial<CalendarViewConfig>;
    return {
      ...rawBase,
      dateFieldKey: keepValidKey(baseCalendar.dateFieldKey) ?? firstDateKey ?? '',
      titleFieldKey: titleChanged
        ? validTitleKey
        : (keepValidKey(baseCalendar.titleFieldKey) ?? validTitleKey),
      metricFieldKey: footerMetricsChanged
        ? validFooterMetricKeys[0]
        : keepValidKey(baseCalendar.metricFieldKey),
      tagFieldKey: rightBadgeChanged
        ? validRightBadgeKey
        : keepValidKey(baseCalendar.tagFieldKey),
    };
  };

  const normalizedViews: ViewDraftItem[] =
    draft.viewDrafts.length > 0
      ? draft.viewDrafts
      : [{ name: getDefaultViewLabel('card'), viewType: 'card' }];

  const viewInputs: LibraryViewInput[] = normalizedViews.map((v) => {
    const existingView = v.id ? existingViewById.get(v.id) : undefined;
    const baseConfig = existingView?.config ?? v.config;
    const hasExistingConfig = Boolean(existingView || v.config);

    let resolvedConfig: Record<string, unknown>;
    if (v.viewType === 'card') {
      resolvedConfig = hasExistingConfig
        ? mergeExistingCardConfig(
            baseConfig ?? {},
            existingView && existingView.id === primaryExistingCardId
              ? existingLibrary?.views.card
              : undefined
          )
        : (buildDefaultCardConfig() as unknown as Record<string, unknown>);
    } else if (v.viewType === 'gallery') {
      resolvedConfig = hasExistingConfig
        ? mergeExistingGalleryConfig(baseConfig ?? {})
        : (buildDefaultGalleryConfig() as unknown as Record<string, unknown>);
    } else if (v.viewType === 'calendar') {
      resolvedConfig = hasExistingConfig
        ? mergeExistingCalendarConfig(baseConfig ?? {})
        : (buildDefaultCalendarConfig() as unknown as Record<string, unknown>);
    } else {
      resolvedConfig = hasExistingConfig ? { ...(baseConfig ?? {}) } : {};
    }

    return {
      id: v.id,
      name: v.name.trim() || getDefaultViewLabel(v.viewType),
      viewType: v.viewType,
      config: resolvedConfig,
    };
  });

  const firstCardInput = viewInputs.find((v) => v.viewType === 'card');
  const firstGalleryInput = viewInputs.find((v) => v.viewType === 'gallery');
  const firstCalendarInput = viewInputs.find((v) => v.viewType === 'calendar');

  const fallbackBundleCard: CardViewConfig = existingLibrary
    ? mergeExistingCardConfig(
        existingLibrary.views.card as unknown as Record<string, unknown>,
        existingLibrary.views.card
      )
    : buildDefaultCardConfig();

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
      card: (firstCardInput?.config as unknown as CardViewConfig) ?? fallbackBundleCard,
      gallery: firstGalleryInput
        ? (firstGalleryInput.config as unknown as GalleryViewConfig)
        : undefined,
      calendar: firstCalendarInput
        ? (firstCalendarInput.config as unknown as CalendarViewConfig)
        : undefined,
    },
  };

  return {
    slug: cleanSlug,
    blueprint,
    viewInputs,
  };
}
