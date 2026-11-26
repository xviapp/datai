import type { HydratedEntry, LibraryRecord } from '@/db/models';
import type { FieldDef } from '@/schema/field-defs';
import type { CardViewConfig } from '@/schema/view-dsl';

export type LibrarySortModeId =
  | 'view_default'
  | 'updated_desc'
  | 'date_desc'
  | 'metric_desc'
  | 'title_asc';

export interface LibrarySortOption {
  id: LibrarySortModeId;
  label: string;
  direction: 'asc' | 'desc';
  /** 是否为该记录本当前视图的默认排序规则 */
  isDefault: boolean;
}

export interface LibraryFilterSelection {
  fieldKey: string;
  value: string;
}

export interface LibraryFilterAndSortResult {
  entries: HydratedEntry[];
  primaryFilterField: FieldDef | null;
  activeFilterValue: string;
  sortOptions: LibrarySortOption[];
  activeSort: LibrarySortOption;
}

function isEmptySortValue(val: unknown): boolean {
  return val === undefined || val === null || val === '';
}

function toFiniteNumber(val: unknown): number | null {
  if (isEmptySortValue(val)) return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

/**
 * 统一的字段值比较器：空值始终置底，数值按大小比较，其余按字符串比较。
 */
export function compareFieldValuesForSort(
  va: unknown,
  vb: unknown,
  direction: 'asc' | 'desc'
): number {
  const aEmpty = isEmptySortValue(va);
  const bEmpty = isEmptySortValue(vb);
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  if (typeof va === 'number' && typeof vb === 'number') {
    if (va === vb) return 0;
    return direction === 'asc' ? va - vb : vb - va;
  }

  const cmp = String(va).localeCompare(String(vb));
  if (cmp === 0) return 0;
  return direction === 'asc' ? cmp : -cmp;
}

/**
 * 统一的视图默认排序器（被仓储层与页面层共同复用，保证同一份排序语义）。
 */
export function sortEntriesByCardConfigInPlace(
  entries: HydratedEntry[],
  cardConfig: Pick<CardViewConfig, 'sortFieldKey' | 'sortDir'>
): HydratedEntry[] {
  const sortKey = cardConfig.sortFieldKey;
  const sortDir = cardConfig.sortDir === 'asc' ? 'asc' : 'desc';
  if (!sortKey) return entries;

  entries.sort((a, b) => {
    const cmp = compareFieldValuesForSort(
      a.computedData[sortKey],
      b.computedData[sortKey],
      sortDir
    );
    if (cmp !== 0) return cmp;
    return b.createdAt - a.createdAt;
  });
  return entries;
}

export function resolveEffectiveCardConfig(
  library: LibraryRecord,
  override?: Partial<CardViewConfig>
): CardViewConfig {
  const base = library.views.card;
  if (!override) return base;
  return {
    ...base,
    ...override,
    titleFieldKey: override.titleFieldKey || base.titleFieldKey,
    footerMetricKeys: override.footerMetricKeys ?? base.footerMetricKeys,
    highlightRules: override.highlightRules ?? base.highlightRules,
  };
}

export function getPrimaryFilterField(
  library: LibraryRecord,
  cardConfig?: Partial<CardViewConfig>
): FieldDef | null {
  const effectiveCard = resolveEffectiveCardConfig(library, cardConfig);
  const badgeKey = effectiveCard.rightBadgeFieldKey;
  const badgeSelect = badgeKey
    ? library.fields.find((f) => f.key === badgeKey && f.type === 'select' && f.options?.length)
    : undefined;
  return (
    badgeSelect ??
    library.fields.find((f) => f.type === 'select' && f.options && f.options.length > 0) ??
    null
  );
}

export function getPrimaryDateField(library: LibraryRecord): FieldDef | null {
  return library.fields.find((f) => f.type === 'date') ?? null;
}

export function getPrimaryMetricField(library: LibraryRecord): FieldDef | null {
  return (
    library.fields.find(
      (f) =>
        f.type === 'currency' ||
        f.type === 'number' ||
        f.type === 'rating' ||
        f.type === 'formula'
    ) ?? null
  );
}

/**
 * 根据记录本字段与视图配置生成明确的排序选项列表：
 * - 若卡片配置了 sortFieldKey，第一项明确标示视图默认字段与方向，第二项为显式「最新更新」（按 updatedAt 降序）；
 * - 若未配置 sortFieldKey，默认即「最新更新」（按 updatedAt 降序）；
 * - 按「字段 + 方向」去重，避免把同字段但相反方向的排序（如有效期升序 vs 有效期降序）误删。
 */
export function getLibrarySortOptions(
  library: LibraryRecord,
  cardConfig?: Partial<CardViewConfig>
): LibrarySortOption[] {
  const effectiveCard = resolveEffectiveCardConfig(library, cardConfig);
  const defaultSortField = effectiveCard.sortFieldKey
    ? (library.fields.find((f) => f.key === effectiveCard.sortFieldKey) ?? null)
    : null;
  const defaultSortDir: 'asc' | 'desc' = effectiveCard.sortDir === 'asc' ? 'asc' : 'desc';
  const primaryDateField = getPrimaryDateField(library);
  const primaryMetricField = getPrimaryMetricField(library);

  const options: LibrarySortOption[] = [];

  if (defaultSortField) {
    options.push({
      id: 'view_default',
      label: `按${defaultSortField.label}`,
      direction: defaultSortDir,
      isDefault: true,
    });
    options.push({
      id: 'updated_desc',
      label: '最新更新',
      direction: 'desc',
      isDefault: false,
    });
  } else {
    options.push({
      id: 'updated_desc',
      label: '最新更新',
      direction: 'desc',
      isDefault: true,
    });
  }

  const isSameDefaultRule = (fieldKey: string, direction: 'asc' | 'desc') =>
    defaultSortField?.key === fieldKey && defaultSortDir === direction;

  if (primaryDateField && !isSameDefaultRule(primaryDateField.key, 'desc')) {
    options.push({
      id: 'date_desc',
      label: `按${primaryDateField.label}`,
      direction: 'desc',
      isDefault: false,
    });
  }

  if (primaryMetricField && !isSameDefaultRule(primaryMetricField.key, 'desc')) {
    options.push({
      id: 'metric_desc',
      label: `按${primaryMetricField.label}`,
      direction: 'desc',
      isDefault: false,
    });
  }

  if (!isSameDefaultRule(effectiveCard.titleFieldKey, 'asc')) {
    options.push({
      id: 'title_asc',
      label: '按标题',
      direction: 'asc',
      isDefault: false,
    });
  }

  return options;
}

export function resolveActiveSortOption(
  options: readonly LibrarySortOption[],
  sortMode: LibrarySortModeId
): LibrarySortOption {
  return (
    options.find((opt) => opt.id === sortMode) ??
    options[0] ?? {
      id: 'updated_desc',
      label: '最新更新',
      direction: 'desc',
      isDefault: true,
    }
  );
}

/**
 * 统一执行记录本页面的主分类筛选与显式排序：
 * - 筛选值绑定 `fieldKey`，切换视图导致主筛选字段变化时自动失效，不会把旧字段选项误用到新字段；
 * - 按钮标签与实际列表顺序由同一份排序规则派生。
 */
export function filterAndSortLibraryEntries(params: {
  entries: readonly HydratedEntry[];
  library: LibraryRecord;
  cardConfig?: Partial<CardViewConfig>;
  selectedFilter?: LibraryFilterSelection | null;
  sortMode: LibrarySortModeId;
}): LibraryFilterAndSortResult {
  const { entries, library, cardConfig, selectedFilter, sortMode } = params;
  const effectiveCard = resolveEffectiveCardConfig(library, cardConfig);
  const primaryFilterField = getPrimaryFilterField(library, effectiveCard);
  const sortOptions = getLibrarySortOptions(library, effectiveCard);
  const activeSort = resolveActiveSortOption(sortOptions, sortMode);

  const activeFilterValue =
    primaryFilterField &&
    selectedFilter &&
    selectedFilter.fieldKey === primaryFilterField.key &&
    selectedFilter.value &&
    (primaryFilterField.options?.some((opt) => opt.value === selectedFilter.value) ?? true)
      ? selectedFilter.value
      : '';

  const filtered =
    primaryFilterField && activeFilterValue
      ? entries.filter(
          (e) => String(e.computedData[primaryFilterField.key] ?? '') === activeFilterValue
        )
      : [...entries];

  const copy = [...filtered];

  if (activeSort.id === 'view_default') {
    if (effectiveCard.sortFieldKey) {
      sortEntriesByCardConfigInPlace(copy, effectiveCard);
    } else {
      copy.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
    }
  } else if (activeSort.id === 'updated_desc') {
    copy.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  } else if (activeSort.id === 'date_desc') {
    const primaryDateField = getPrimaryDateField(library);
    if (primaryDateField) {
      copy.sort((a, b) => {
        const cmp = compareFieldValuesForSort(
          a.computedData[primaryDateField.key],
          b.computedData[primaryDateField.key],
          'desc'
        );
        return cmp !== 0 ? cmp : b.updatedAt - a.updatedAt;
      });
    }
  } else if (activeSort.id === 'metric_desc') {
    const primaryMetricField = getPrimaryMetricField(library);
    if (primaryMetricField) {
      copy.sort((a, b) => {
        const na = toFiniteNumber(a.computedData[primaryMetricField.key]);
        const nb = toFiniteNumber(b.computedData[primaryMetricField.key]);
        if (na === null && nb === null) return b.updatedAt - a.updatedAt;
        if (na === null) return 1;
        if (nb === null) return -1;
        if (nb !== na) return nb - na;
        return b.updatedAt - a.updatedAt;
      });
    }
  } else if (activeSort.id === 'title_asc') {
    copy.sort((a, b) => {
      const cmp = a.titleSummary.localeCompare(b.titleSummary, 'zh-CN');
      return cmp !== 0 ? cmp : b.updatedAt - a.updatedAt;
    });
  }

  return {
    entries: copy,
    primaryFilterField,
    activeFilterValue,
    sortOptions,
    activeSort,
  };
}
