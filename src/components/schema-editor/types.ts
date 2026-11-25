import type { LibraryRecord } from '@/db/models';
import type { FieldDef } from '@/schema/field-defs';
import type { AccentTone, LibraryViewType } from '@/schema/view-dsl';

export interface ViewDraftItem {
  id?: string;
  name: string;
  viewType: LibraryViewType;
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

export function buildInitialSchemaDraft(
  libraries: LibraryRecord[],
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
      fields: existingLibrary.fields,
      titleFieldKey: existingLibrary.views.card.titleFieldKey,
      subtitleFieldKey: existingLibrary.views.card.subtitleFieldKey ?? '',
      rightBadgeFieldKey: existingLibrary.views.card.rightBadgeFieldKey ?? '',
      footerMetricKeys: existingLibrary.views.card.footerMetricKeys,
      viewDrafts:
        existingLibrary.viewList.length > 0
          ? existingLibrary.viewList.map((v) => ({
              id: v.id,
              name: v.name,
              viewType: v.viewType,
            }))
          : [{ name: '列表', viewType: 'card' }],
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
      viewDrafts: [{ name: '列表', viewType: 'card' }],
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
    viewDrafts: [{ name: '列表', viewType: 'card' }],
  };
}
