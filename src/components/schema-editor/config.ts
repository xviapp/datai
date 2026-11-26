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
  /** 保留原有视图配置快照，避免保存时丢失编辑器未暴露的高级项与继承关系 */
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
      titleFieldKey: existingLibrary.views.card.titleFieldKey || existingLibrary.fields[0]?.key || '',
      subtitleFieldKey: existingLibrary.views.card.subtitleFieldKey ?? '',
      rightBadgeFieldKey: existingLibrary.views.card.rightBadgeFieldKey ?? '',
      footerMetricKeys: Array.isArray(existingLibrary.views.card.footerMetricKeys)
        ? [...existingLibrary.views.card.footerMetricKeys]
        : [],
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
 * - 编辑器「列表卡片显示字段」仅作用于主卡片视图且仅写入用户实际改过的字段；
 * - 其余已有视图（次卡片、画廊、日历、统计）原样保留原有配置及省略键的继承关系，仅清理被删除的字段引用；
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

  const initialCard = existingLibrary?.views.card;
  const initialSubtitleKey = initialCard?.subtitleFieldKey ?? '';
  const initialRightBadgeKey = initialCard?.rightBadgeFieldKey ?? '';
  const initialFooterKeys = Array.isArray(initialCard?.footerMetricKeys)
    ? initialCard.footerMetricKeys
    : [];

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

  const mergePrimaryExistingCardConfig = (
    rawBase: Record<string, unknown>,
    fallbackBundle: CardViewConfig
  ): CardViewConfig & Record<string, unknown> => {
    const mergedRaw: Record<string, unknown> = {
      ...(fallbackBundle as unknown as Record<string, unknown>),
      ...rawBase,
    };
    const baseCard = mergedRaw as Partial<CardViewConfig>;

    const baseRules = Array.isArray(baseCard.highlightRules)
      ? baseCard.highlightRules
      : Array.isArray(fallbackBundle.highlightRules)
        ? fallbackBundle.highlightRules
        : [];
    const validRules = baseRules.filter(
      (rule) => Boolean(rule && typeof rule.fieldKey === 'string' && fieldKeySet.has(rule.fieldKey))
    );

    const baseFooters = Array.isArray(baseCard.footerMetricKeys)
      ? baseCard.footerMetricKeys.filter((k) => typeof k === 'string' && fieldKeySet.has(k))
      : Array.isArray(fallbackBundle.footerMetricKeys)
        ? fallbackBundle.footerMetricKeys.filter((k) => typeof k === 'string' && fieldKeySet.has(k))
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

  /**
   * 保留次卡片视图的原配置与省略键（如省略 sortFieldKey / sortDir 以继承库默认排序），
   * 绝不把未显式配置的键实体化成默认值，仅清理已被删除的字段引用。
   */
  const preserveSecondaryExistingCardConfig = (
    rawBase: Record<string, unknown>
  ): Record<string, unknown> => {
    const next: Record<string, unknown> = { ...rawBase };

    if ('titleFieldKey' in next && !keepValidKey(next.titleFieldKey)) {
      delete next.titleFieldKey;
    }
    if ('subtitleFieldKey' in next && !keepValidKey(next.subtitleFieldKey)) {
      delete next.subtitleFieldKey;
    }
    if ('coverImageFieldKey' in next && !keepValidKey(next.coverImageFieldKey)) {
      delete next.coverImageFieldKey;
    }
    if ('rightBadgeFieldKey' in next && !keepValidKey(next.rightBadgeFieldKey)) {
      delete next.rightBadgeFieldKey;
    }
    if ('footerMetricKeys' in next && Array.isArray(next.footerMetricKeys)) {
      next.footerMetricKeys = next.footerMetricKeys.filter(
        (k) => typeof k === 'string' && fieldKeySet.has(k)
      );
    }
    if ('sortFieldKey' in next && !keepValidKey(next.sortFieldKey)) {
      delete next.sortFieldKey;
    }
    if ('highlightRules' in next && Array.isArray(next.highlightRules)) {
      next.highlightRules = next.highlightRules.filter((rule) =>
        Boolean(
          rule &&
            typeof (rule as { fieldKey?: unknown }).fieldKey === 'string' &&
            fieldKeySet.has((rule as { fieldKey: string }).fieldKey)
        )
      );
    }
    return next;
  };

  const buildDefaultGalleryConfig = (): GalleryViewConfig => ({
    titleFieldKey: validTitleKey,
    subtitleFieldKey: validSubtitleKey,
    coverImageFieldKey: firstImageKey,
    badgeFieldKey: validRightBadgeKey,
    ratingFieldKey: firstRatingKey,
  });

  /**
   * 保留已有画廊视图的原配置，不因修改「列表卡片显示字段」而覆盖画廊配置；仅清理失效字段引用。
   */
  const preserveExistingGalleryConfig = (
    rawBase: Record<string, unknown>
  ): Record<string, unknown> => {
    const next: Record<string, unknown> = { ...rawBase };
    if ('titleFieldKey' in next && !keepValidKey(next.titleFieldKey)) {
      next.titleFieldKey = validTitleKey;
    }
    if ('subtitleFieldKey' in next && !keepValidKey(next.subtitleFieldKey)) {
      delete next.subtitleFieldKey;
    }
    if ('coverImageFieldKey' in next && !keepValidKey(next.coverImageFieldKey)) {
      delete next.coverImageFieldKey;
    }
    if ('badgeFieldKey' in next && !keepValidKey(next.badgeFieldKey)) {
      delete next.badgeFieldKey;
    }
    if ('ratingFieldKey' in next && !keepValidKey(next.ratingFieldKey)) {
      delete next.ratingFieldKey;
    }
    return next;
  };

  const buildDefaultCalendarConfig = (): CalendarViewConfig => ({
    dateFieldKey: firstDateKey ?? '',
    titleFieldKey: validTitleKey,
    metricFieldKey: validFooterMetricKeys[0],
    tagFieldKey: validRightBadgeKey,
  });

  /**
   * 保留已有日历视图的原配置，不因修改「列表卡片显示字段」而覆盖日历指标/标签；仅清理失效字段引用。
   */
  const preserveExistingCalendarConfig = (
    rawBase: Record<string, unknown>
  ): Record<string, unknown> => {
    const next: Record<string, unknown> = { ...rawBase };
    if ('dateFieldKey' in next && !keepValidKey(next.dateFieldKey)) {
      next.dateFieldKey = firstDateKey ?? '';
    }
    if ('titleFieldKey' in next && !keepValidKey(next.titleFieldKey)) {
      next.titleFieldKey = validTitleKey;
    }
    if ('metricFieldKey' in next && !keepValidKey(next.metricFieldKey)) {
      delete next.metricFieldKey;
    }
    if ('tagFieldKey' in next && !keepValidKey(next.tagFieldKey)) {
      delete next.tagFieldKey;
    }
    return next;
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
      if (hasExistingConfig) {
        const isPrimaryExistingCard =
          Boolean(existingLibrary) &&
          ((existingView && existingView.id === primaryExistingCardId) ||
            (!primaryExistingCardId && !existingView));
        resolvedConfig =
          isPrimaryExistingCard && existingLibrary
            ? mergePrimaryExistingCardConfig(baseConfig ?? {}, existingLibrary.views.card)
            : preserveSecondaryExistingCardConfig(baseConfig ?? {});
      } else {
        resolvedConfig = buildDefaultCardConfig() as unknown as Record<string, unknown>;
      }
    } else if (v.viewType === 'gallery') {
      resolvedConfig = hasExistingConfig
        ? preserveExistingGalleryConfig(baseConfig ?? {})
        : (buildDefaultGalleryConfig() as unknown as Record<string, unknown>);
    } else if (v.viewType === 'calendar') {
      resolvedConfig = hasExistingConfig
        ? preserveExistingCalendarConfig(baseConfig ?? {})
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

  const primaryCardInput =
    (primaryExistingCardId
      ? viewInputs.find((v) => v.viewType === 'card' && v.id === primaryExistingCardId)
      : undefined) ?? viewInputs.find((v) => v.viewType === 'card');
  const firstGalleryInput = viewInputs.find((v) => v.viewType === 'gallery');
  const firstCalendarInput = viewInputs.find((v) => v.viewType === 'calendar');

  const fallbackBundleCard: CardViewConfig = existingLibrary
    ? mergePrimaryExistingCardConfig(
        existingLibrary.views.card as unknown as Record<string, unknown>,
        existingLibrary.views.card
      )
    : buildDefaultCardConfig();

  const resolvedBundleCard: CardViewConfig = (() => {
    const mergedCardRaw = primaryCardInput
      ? {
          ...fallbackBundleCard,
          ...(primaryCardInput.config as Partial<CardViewConfig>),
        }
      : fallbackBundleCard;
    const pruned = preserveSecondaryExistingCardConfig(
      mergedCardRaw as unknown as Record<string, unknown>
    ) as Partial<CardViewConfig>;
    return {
      ...pruned,
      titleFieldKey: keepValidKey(pruned.titleFieldKey) ?? validTitleKey,
      footerMetricKeys: Array.isArray(pruned.footerMetricKeys) ? pruned.footerMetricKeys : [],
      sortDir: pruned.sortDir === 'asc' ? 'asc' : 'desc',
      highlightRules: Array.isArray(pruned.highlightRules) ? pruned.highlightRules : [],
    };
  })();

  const resolvedBundleGallery: GalleryViewConfig | undefined = firstGalleryInput
    ? (() => {
        const sanitizedExistingGallery = existingLibrary?.views.gallery
          ? preserveExistingGalleryConfig(
              existingLibrary.views.gallery as unknown as Record<string, unknown>
            )
          : {};
        const mergedGallery = preserveExistingGalleryConfig({
          ...sanitizedExistingGallery,
          ...(firstGalleryInput.config ?? {}),
        });
        return {
          ...(mergedGallery as Partial<GalleryViewConfig>),
          titleFieldKey: keepValidKey(mergedGallery.titleFieldKey) ?? validTitleKey,
        };
      })()
    : undefined;

  const resolvedBundleCalendar: CalendarViewConfig | undefined = firstCalendarInput
    ? (() => {
        const sanitizedExistingCalendar = existingLibrary?.views.calendar
          ? preserveExistingCalendarConfig(
              existingLibrary.views.calendar as unknown as Record<string, unknown>
            )
          : {};
        const mergedCalendar = preserveExistingCalendarConfig({
          ...sanitizedExistingCalendar,
          ...(firstCalendarInput.config ?? {}),
        });
        return {
          ...(mergedCalendar as Partial<CalendarViewConfig>),
          dateFieldKey: keepValidKey(mergedCalendar.dateFieldKey) ?? firstDateKey ?? '',
          titleFieldKey: keepValidKey(mergedCalendar.titleFieldKey) ?? validTitleKey,
        };
      })()
    : undefined;

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
      card: resolvedBundleCard,
      gallery: resolvedBundleGallery,
      calendar: resolvedBundleCalendar,
    },
  };

  return {
    slug: cleanSlug,
    blueprint,
    viewInputs,
  };
}
