import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { HighlightTonePalette, Palette, ToneMap } from '@/constants/design-tokens';
import type { HydratedEntry, LibraryRecord } from '@/db/repository';
import type { FieldDef } from '@/schema/field-defs';

export function formatFieldDisplay(field: FieldDef | undefined, val: unknown): string {
  if (val === undefined || val === null || val === '') return '—';
  if (!field) return String(val);

  switch (field.type) {
    case 'currency': {
      const n = Number(val);
      return Number.isFinite(n) ? `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}` : String(val);
    }
    case 'number':
    case 'rollup':
    case 'formula': {
      const n = Number(val);
      const numText = Number.isFinite(n)
        ? n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
        : String(val);
      return field.unit ? `${numText} ${field.unit}` : numText;
    }
    case 'rating': {
      const stars = Math.max(0, Math.min(5, Math.round(Number(val) || 0)));
      return stars > 0 ? `${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}` : '未评分';
    }
    case 'checkbox':
      return val ? '已勾选' : '否';
    case 'multi_select':
      return Array.isArray(val) ? val.join(' · ') : String(val);
    default:
      return field.unit ? `${String(val)} ${field.unit}` : String(val);
  }
}

export function DynamicCardListView({
  library,
  entries,
  onSelectEntry,
}: {
  library: LibraryRecord;
  entries: HydratedEntry[];
  onSelectEntry: (entryId: string) => void;
}) {
  const cardCfg = library.views.card;
  const fieldMap = useMemo(() => new Map(library.fields.map((f) => [f.key, f])), [library.fields]);
  const libTone = ToneMap[library.color] ?? ToneMap.teal;

  if (entries.length === 0) {
    return (
      <View style={styles.emptyBox}>
        <Text style={styles.emptyTitle}>暂无记录</Text>
        <Text style={styles.emptyDesc}>点击右上角「新增」或底部「AI 万能快记」添加第一条记录</Text>
      </View>
    );
  }

  return (
    <View style={styles.listCol}>
      {entries.map((entry) => {
        const hl = entry.highlight ? HighlightTonePalette[entry.highlight.tone] : null;
        const subtitleField = cardCfg.subtitleFieldKey ? fieldMap.get(cardCfg.subtitleFieldKey) : undefined;
        const subtitleRaw = cardCfg.subtitleFieldKey ? entry.computedData[cardCfg.subtitleFieldKey] : undefined;
        const badgeField = cardCfg.rightBadgeFieldKey ? fieldMap.get(cardCfg.rightBadgeFieldKey) : undefined;
        const badgeVal = cardCfg.rightBadgeFieldKey ? entry.computedData[cardCfg.rightBadgeFieldKey] : undefined;
        const coverUri = cardCfg.coverImageFieldKey
          ? String(entry.computedData[cardCfg.coverImageFieldKey] ?? '')
          : '';

        const matchedOptColor = badgeField?.options?.find((o) => o.value === String(badgeVal))?.color;

        const allForwardRefs = Object.values(entry.forwardLinks).flat();

        return (
          <Pressable
            key={entry.id}
            onPress={() => onSelectEntry(entry.id)}
            style={({ pressed }) => [
              styles.card,
              hl && { backgroundColor: hl.bg },
              pressed && styles.cardPressed,
            ]}
          >
            <View style={styles.cardMainRow}>
              {coverUri ? (
                <Image source={{ uri: coverUri }} style={styles.cardThumb} contentFit="cover" />
              ) : null}

              <View style={styles.cardBody}>
                <View style={styles.cardTopRow}>
                  <Text style={styles.cardTitle} numberOfLines={1}>
                    {entry.titleSummary}
                  </Text>

                  <View style={styles.badgesGroup}>
                    {entry.highlight?.badgeText && hl ? (
                      <View style={[styles.badgePill, { backgroundColor: hl.pillBg }]}>
                        <Text style={[styles.badgeText, { color: hl.pillInk }]}>
                          {entry.highlight.badgeText}
                        </Text>
                      </View>
                    ) : null}

                    {badgeVal !== undefined && badgeVal !== '' ? (
                      <View
                        style={[
                          styles.badgePill,
                          {
                            backgroundColor: matchedOptColor ? `${matchedOptColor}18` : libTone.soft,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.badgeText,
                            { color: matchedOptColor || libTone.ink },
                          ]}
                        >
                          {formatFieldDisplay(badgeField, badgeVal)}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </View>

                {subtitleRaw !== undefined && subtitleRaw !== '' ? (
                  <Text style={styles.cardSubtitle} numberOfLines={1}>
                    {formatFieldDisplay(subtitleField, subtitleRaw)}
                  </Text>
                ) : null}

                {(allForwardRefs.length > 0 || entry.backlinks.length > 0) && (
                  <View style={styles.relationsStrip}>
                    {allForwardRefs.slice(0, 2).map((ref) => (
                      <View key={`${ref.fieldKey}-${ref.id}`} style={styles.relChip}>
                        <Feather name="link-2" size={11} color={Palette.brand} />
                        <Text style={styles.relChipText} numberOfLines={1}>
                          {ref.libraryIcon} {ref.title}
                        </Text>
                      </View>
                    ))}
                    {entry.backlinks.length > 0 ? (
                      <View style={styles.backlinkChip}>
                        <Feather name="corner-down-right" size={11} color={Palette.inkSecondary} />
                        <Text style={styles.backlinkChipText}>被引用 {entry.backlinks.length}</Text>
                      </View>
                    ) : null}
                  </View>
                )}

                {cardCfg.footerMetricKeys.length > 0 ? (
                  <View style={styles.metricsFooter}>
                    {cardCfg.footerMetricKeys.map((mKey) => {
                      const mf = fieldMap.get(mKey);
                      if (!mf) return null;
                      return (
                        <View key={mKey} style={styles.metricCell}>
                          <Text style={styles.metricLabel}>{mf.label}</Text>
                          <Text style={styles.metricValue} numberOfLines={1}>
                            {formatFieldDisplay(mf, entry.computedData[mKey])}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                ) : null}
              </View>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

export function DynamicGalleryView({
  library,
  entries,
  onSelectEntry,
}: {
  library: LibraryRecord;
  entries: HydratedEntry[];
  onSelectEntry: (entryId: string) => void;
}) {
  const fieldMap = useMemo(() => new Map(library.fields.map((f) => [f.key, f])), [library.fields]);
  const galleryCfg = library.views.gallery;
  const coverKey =
    galleryCfg?.coverImageFieldKey ||
    library.views.card.coverImageFieldKey ||
    library.fields.find((f) => f.type === 'image')?.key;
  const subKey = galleryCfg?.subtitleFieldKey || library.views.card.subtitleFieldKey;
  const ratingKey =
    galleryCfg?.ratingFieldKey || library.fields.find((f) => f.type === 'rating')?.key;
  const badgeKey = galleryCfg?.badgeFieldKey || library.views.card.rightBadgeFieldKey;

  if (entries.length === 0) {
    return (
      <View style={styles.emptyBox}>
        <Text style={styles.emptyTitle}>画廊暂无内容</Text>
        <Text style={styles.emptyDesc}>新增带有封面图或评分的条目后将在此以海报墙展示</Text>
      </View>
    );
  }

  return (
    <View style={styles.galleryGrid}>
      {entries.map((entry) => {
        const coverUri = coverKey ? String(entry.computedData[coverKey] ?? '') : '';
        const subtitle = subKey ? formatFieldDisplay(fieldMap.get(subKey), entry.computedData[subKey]) : '';
        const rating = ratingKey
          ? formatFieldDisplay(fieldMap.get(ratingKey), entry.computedData[ratingKey])
          : '';
        const badge = badgeKey ? String(entry.computedData[badgeKey] ?? '') : '';

        return (
          <Pressable
            key={entry.id}
            onPress={() => onSelectEntry(entry.id)}
            style={({ pressed }) => [styles.galleryCard, pressed && styles.cardPressed]}
          >
            {coverUri ? (
              <Image source={{ uri: coverUri }} style={styles.galleryPoster} contentFit="cover" />
            ) : (
              <View style={styles.galleryFallbackPoster}>
                <Text style={styles.galleryFallbackEmoji}>{library.icon}</Text>
                <Text style={styles.galleryFallbackTitle} numberOfLines={2}>
                  {entry.titleSummary}
                </Text>
              </View>
            )}
            <View style={styles.galleryMeta}>
              <View style={styles.galleryTopMeta}>
                <Text style={styles.galleryTitle} numberOfLines={1}>
                  {entry.titleSummary}
                </Text>
                {badge ? <Text style={styles.galleryBadge}>{badge}</Text> : null}
              </View>
              {subtitle && subtitle !== '—' ? (
                <Text style={styles.gallerySub} numberOfLines={1}>
                  {subtitle}
                </Text>
              ) : null}
              {rating && rating !== '—' ? <Text style={styles.galleryStars}>{rating}</Text> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

export function DynamicCalendarView({
  library,
  entries,
  onSelectEntry,
}: {
  library: LibraryRecord;
  entries: HydratedEntry[];
  onSelectEntry: (entryId: string) => void;
}) {
  const calCfg = library.views.calendar;
  const dateKey =
    calCfg?.dateFieldKey || library.fields.find((f) => f.type === 'date')?.key || '';
  const metricKey = calCfg?.metricFieldKey || library.views.card.footerMetricKeys[0];
  const fieldMap = useMemo(() => new Map(library.fields.map((f) => [f.key, f])), [library.fields]);

  const [monthOffset, setMonthOffset] = useState(0);
  const [selectedDayStr, setSelectedDayStr] = useState<string | null>(null);

  const monthInfo = useMemo(() => {
    const base = new Date();
    const target = new Date(base.getFullYear(), base.getMonth() + monthOffset, 1);
    const year = target.getFullYear();
    const month = target.getMonth();
    const firstWeekday = target.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
    return { year, month: month + 1, firstWeekday, daysInMonth, prefix };
  }, [monthOffset]);

  const entriesByDate = useMemo(() => {
    const map = new Map<string, HydratedEntry[]>();
    for (const e of entries) {
      const rawDate = dateKey
        ? String(e.computedData[dateKey] ?? '').slice(0, 10)
        : new Date(e.createdAt).toISOString().slice(0, 10);
      if (!rawDate) continue;
      const list = map.get(rawDate) ?? [];
      list.push(e);
      map.set(rawDate, list);
    }
    return map;
  }, [entries, dateKey]);

  const dayCells: Array<string | null> = [];
  for (let i = 0; i < monthInfo.firstWeekday; i++) dayCells.push(null);
  for (let d = 1; d <= monthInfo.daysInMonth; d++) {
    dayCells.push(`${monthInfo.prefix}-${String(d).padStart(2, '0')}`);
  }

  const displayedEntries = useMemo(() => {
    if (selectedDayStr) {
      return entriesByDate.get(selectedDayStr) ?? [];
    }
    return entries.filter((e) => {
      const rawDate = dateKey
        ? String(e.computedData[dateKey] ?? '').slice(0, 10)
        : new Date(e.createdAt).toISOString().slice(0, 10);
      return rawDate.startsWith(monthInfo.prefix);
    });
  }, [selectedDayStr, entriesByDate, entries, dateKey, monthInfo.prefix]);

  return (
    <View style={styles.calWrap}>
      <View style={styles.calCard}>
        <View style={styles.calHeader}>
          <Pressable
            onPress={() => {
              setMonthOffset((m) => m - 1);
              setSelectedDayStr(null);
            }}
            style={styles.calNavBtn}
          >
            <Feather name="chevron-left" size={18} color={Palette.inkPrimary} />
          </Pressable>
          <Text style={styles.calMonthTitle}>
            {monthInfo.year} 年 {monthInfo.month} 月
          </Text>
          <Pressable
            onPress={() => {
              setMonthOffset((m) => m + 1);
              setSelectedDayStr(null);
            }}
            style={styles.calNavBtn}
          >
            <Feather name="chevron-right" size={18} color={Palette.inkPrimary} />
          </Pressable>
        </View>

        <View style={styles.weekRow}>
          {['日', '一', '二', '三', '四', '五', '六'].map((w) => (
            <Text key={w} style={styles.weekLabel}>
              {w}
            </Text>
          ))}
        </View>

        <View style={styles.daysGrid}>
          {dayCells.map((dateStr, idx) => {
            if (!dateStr) {
              return <View key={`pad-${idx}`} style={styles.dayCell} />;
            }
            const count = entriesByDate.get(dateStr)?.length ?? 0;
            const selected = selectedDayStr === dateStr;
            const dayNum = Number(dateStr.slice(-2));

            return (
              <Pressable
                key={dateStr}
                onPress={() => setSelectedDayStr(selected ? null : dateStr)}
                style={[
                  styles.dayCell,
                  count > 0 && styles.dayCellHasData,
                  selected && styles.dayCellSelected,
                ]}
              >
                <Text style={[styles.dayNum, selected && styles.dayNumSelected]}>{dayNum}</Text>
                {count > 0 ? (
                  <View
                    style={[
                      styles.dayDot,
                      selected && { backgroundColor: Palette.inkInverse },
                    ]}
                  />
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </View>

      <Text style={styles.calSubheading}>
        {selectedDayStr ? `${selectedDayStr} 当日记录 (${displayedEntries.length})` : `本月记录 (${displayedEntries.length})`}
      </Text>

      {displayedEntries.map((e) => (
        <Pressable
          key={e.id}
          onPress={() => onSelectEntry(e.id)}
          style={styles.calEntryRow}
        >
          <View style={styles.calEntryLeft}>
            <Text style={styles.calEntryTitle} numberOfLines={1}>
              {e.titleSummary}
            </Text>
            <Text style={styles.calEntryDate}>
              {dateKey ? String(e.computedData[dateKey] ?? '—') : ''}
            </Text>
          </View>
          {metricKey ? (
            <Text style={styles.calEntryMetric}>
              {formatFieldDisplay(fieldMap.get(metricKey), e.computedData[metricKey])}
            </Text>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  listCol: {
    gap: 10,
  },
  card: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  cardPressed: {
    opacity: 0.86,
  },
  cardMainRow: {
    flexDirection: 'row',
    gap: 12,
  },
  cardThumb: {
    width: 60,
    height: 76,
    borderRadius: 10,
    backgroundColor: Palette.bgSubtle,
  },
  cardBody: {
    flex: 1,
    gap: 6,
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  cardTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  badgesGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  badgePill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  cardSubtitle: {
    fontSize: 13,
    color: Palette.inkSecondary,
  },
  relationsStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 2,
  },
  relChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Palette.brandSoft,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    maxWidth: 200,
  },
  relChipText: {
    fontSize: 11,
    color: Palette.brand,
    fontWeight: '600',
  },
  backlinkChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Palette.bgSubtle,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  backlinkChipText: {
    fontSize: 11,
    color: Palette.inkSecondary,
    fontWeight: '600',
  },
  metricsFooter: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
    paddingTop: 8,
    marginTop: 2,
    borderTopWidth: 1,
    borderTopColor: Palette.borderHairline,
  },
  metricCell: {
    gap: 1,
  },
  metricLabel: {
    fontSize: 11,
    color: Palette.inkMuted,
  },
  metricValue: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  emptyBox: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 16,
    padding: 28,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 6,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  emptyDesc: {
    fontSize: 13,
    color: Palette.inkMuted,
    textAlign: 'center',
  },
  galleryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  galleryCard: {
    width: '48%',
    minWidth: 152,
    flexGrow: 1,
    backgroundColor: Palette.bgSurface,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  galleryPoster: {
    width: '100%',
    height: 184,
    backgroundColor: Palette.bgSubtle,
  },
  galleryFallbackPoster: {
    width: '100%',
    height: 150,
    backgroundColor: Palette.bgSubtle,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    gap: 6,
  },
  galleryFallbackEmoji: {
    fontSize: 32,
  },
  galleryFallbackTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Palette.inkPrimary,
    textAlign: 'center',
  },
  galleryMeta: {
    padding: 12,
    gap: 4,
  },
  galleryTopMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  galleryTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  galleryBadge: {
    fontSize: 11,
    color: Palette.brand,
    fontWeight: '600',
  },
  gallerySub: {
    fontSize: 12,
    color: Palette.inkSecondary,
  },
  galleryStars: {
    fontSize: 13,
    color: '#D97706',
    marginTop: 2,
  },
  calWrap: {
    gap: 12,
  },
  calCard: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 10,
  },
  calHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  calNavBtn: {
    padding: 6,
    borderRadius: 8,
    backgroundColor: Palette.bgSubtle,
  },
  calMonthTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  weekRow: {
    flexDirection: 'row',
  },
  weekLabel: {
    flex: 1,
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkMuted,
  },
  daysGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  dayCell: {
    width: '14.285%',
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    gap: 2,
  },
  dayCellHasData: {
    backgroundColor: Palette.brandSoft,
  },
  dayCellSelected: {
    backgroundColor: Palette.brand,
  },
  dayNum: {
    fontSize: 13,
    fontWeight: '600',
    color: Palette.inkPrimary,
  },
  dayNumSelected: {
    color: Palette.inkInverse,
    fontWeight: '700',
  },
  dayDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: Palette.brand,
  },
  calSubheading: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkSecondary,
    marginTop: 4,
  },
  calEntryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Palette.bgSurface,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  calEntryLeft: {
    flex: 1,
    gap: 2,
  },
  calEntryTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  calEntryDate: {
    fontSize: 12,
    color: Palette.inkMuted,
  },
  calEntryMetric: {
    fontSize: 14,
    fontWeight: '700',
    color: Palette.brand,
  },
});
