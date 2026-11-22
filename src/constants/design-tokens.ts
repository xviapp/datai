import type { AccentTone, HighlightTone } from '@/schema/view-dsl';

export const Palette = {
  bgCanvas: '#F7F7F4',
  bgSurface: '#FFFFFF',
  bgSubtle: '#F0F0EC',
  bgMuted: '#E6E7E2',

  inkPrimary: '#181A19',
  inkSecondary: '#575E5B',
  inkMuted: '#8B918E',
  inkInverse: '#FFFFFF',

  borderHairline: '#E8E9E4',
  borderStrong: '#D2D6D1',

  brand: '#0F766E',
  brandHover: '#115E59',
  brandSoft: '#E8F4F1',

  danger: '#BE123C',
  dangerSoft: '#FFE4E6',
  warning: '#B45309',
  warningSoft: '#FEF3C7',
  success: '#047857',
  successSoft: '#D1FAE5',
  info: '#1D4ED8',
  infoSoft: '#DBEAFE',
} as const;

export const ToneMap: Record<
  AccentTone,
  { solid: string; soft: string; ink: string }
> = {
  teal: { solid: '#0F766E', soft: '#E6F4F1', ink: '#0F5C56' },
  amber: { solid: '#C26A1B', soft: '#FDF2E4', ink: '#9A4E12' },
  rose: { solid: '#BE123C', soft: '#FCE8EC', ink: '#9F1239' },
  blue: { solid: '#1D4ED8', soft: '#E8F0FE', ink: '#1E40AF' },
  emerald: { solid: '#047857', soft: '#E3F7EF', ink: '#065F46' },
  slate: { solid: '#334155', soft: '#ECEFF3', ink: '#1E293B' },
};

export const HighlightTonePalette: Record<
  HighlightTone,
  { bg: string; pillBg: string; pillInk: string }
> = {
  danger: { bg: '#FFF8F9', pillBg: '#FFE4E6', pillInk: '#BE123C' },
  warning: { bg: '#FFFDF7', pillBg: '#FEF3C7', pillInk: '#B45309' },
  success: { bg: '#F7FDF9', pillBg: '#D1FAE5', pillInk: '#047857' },
  info: { bg: '#F8FAFF', pillBg: '#DBEAFE', pillInk: '#1D4ED8' },
};

export const ChartSeriesColors = [
  '#0F766E',
  '#C26A1B',
  '#2563EB',
  '#059669',
  '#BE123C',
  '#475569',
];
