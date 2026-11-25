import type Feather from '@expo/vector-icons/Feather';
import type React from 'react';
import type { FieldType, RollupFn } from '@/schema/field-defs';
import type { AccentTone, LibraryViewType } from '@/schema/view-dsl';

export type FeatherIconName = React.ComponentProps<typeof Feather>['name'];

export interface FieldTypeMeta {
  label: string;
  icon: FeatherIconName;
  category: 'common' | 'advanced';
}

export const FIELD_TYPE_META: Record<FieldType, FieldTypeMeta> = {
  text: { label: '文本', icon: 'type', category: 'common' },
  number: { label: '数字', icon: 'hash', category: 'common' },
  currency: { label: '金额', icon: 'dollar-sign', category: 'common' },
  date: { label: '日期', icon: 'calendar', category: 'common' },
  select: { label: '单选', icon: 'disc', category: 'common' },
  multi_select: { label: '多选', icon: 'check-square', category: 'common' },
  rating: { label: '评分', icon: 'star', category: 'common' },
  checkbox: { label: '开关', icon: 'toggle-right', category: 'common' },
  image: { label: '图片', icon: 'image', category: 'common' },
  relation: { label: '跨表关联', icon: 'link-2', category: 'advanced' },
  rollup: { label: '跨表汇总', icon: 'layers', category: 'advanced' },
  formula: { label: '计算公式', icon: 'sliders', category: 'advanced' },
};

export const COMMON_FIELD_TYPES: FieldType[] = [
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

export const ADVANCED_FIELD_TYPES: FieldType[] = ['relation', 'rollup', 'formula'];

export const ROLLUP_FNS: Array<{ fn: RollupFn; label: string }> = [
  { fn: 'SUM', label: '求和' },
  { fn: 'COUNT', label: '计数' },
  { fn: 'AVG', label: '平均' },
  { fn: 'MAX', label: '最大' },
  { fn: 'MIN', label: '最小' },
];

export const CURATED_EMOJIS = [
  '📒',
  '📚',
  '💰',
  '📷',
  '💊',
  '☕',
  '🏃',
  '🎬',
  '✈️',
  '🍽️',
  '🪴',
  '🎵',
  '🛍️',
  '📝',
  '💡',
  '🎯',
  '🏠',
  '🐾',
];

export const VIEW_TYPE_META: Record<
  LibraryViewType,
  { label: string; icon: FeatherIconName }
> = {
  card: { label: '列表', icon: 'list' },
  gallery: { label: '画廊', icon: 'grid' },
  calendar: { label: '日历', icon: 'calendar' },
  stats: { label: '统计', icon: 'pie-chart' },
};

export const ALL_VIEW_TYPES: LibraryViewType[] = ['card', 'gallery', 'calendar', 'stats'];

export const ACCENT_TONES: AccentTone[] = ['teal', 'amber', 'rose', 'blue', 'emerald', 'slate'];
