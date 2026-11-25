import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatFieldDisplay } from '@/components/dynamic-renderer/DynamicViews';
import { HighlightTonePalette, Palette, ToneMap } from '@/constants/design-tokens';
import type { HydratedEntry, LibraryRecord } from '@/db/models';
import type { FieldDef } from '@/schema/field-defs';

export interface EntryHeroCardProps {
  entry: HydratedEntry;
  library: LibraryRecord;
  computedFields: FieldDef[];
  compact: boolean;
}

export function EntryHeroCard({
  entry,
  library,
  computedFields,
  compact,
}: EntryHeroCardProps) {
  const tone = ToneMap[library.color] ?? ToneMap.teal;
  const hl = entry.highlight ? HighlightTonePalette[entry.highlight.tone] : null;

  return (
    <View
      style={[
        styles.heroCard,
        compact && styles.heroCardCompact,
        hl && { backgroundColor: hl.bg },
      ]}
    >
      <View style={styles.heroTopRow}>
        <Text
          style={[styles.heroTitle, compact && styles.heroTitleCompact]}
          numberOfLines={compact ? 2 : undefined}
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
        compact ? (
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
                <Text style={[styles.computedVal, { color: tone.ink }]} numberOfLines={1}>
                  {formatFieldDisplay(cf, entry.computedData[cf.key])}
                </Text>
              </View>
            ))}
          </View>
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
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
  heroTitleCompact: {
    fontSize: 18,
    lineHeight: 24,
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
});
