import { Feather } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect } from 'react-native-svg';
import { ChartSeriesColors, Palette, ToneMap } from '@/constants/design-tokens';
import { useOmni } from '@/context/omni-context';
import type { DashboardWidget } from '@/schema/view-dsl';

interface SqlWidgetCardProps {
  widget: DashboardWidget;
  onDelete?: (id: string) => void;
  onPin?: (widget: DashboardWidget) => void;
  compact?: boolean;
}

function formatMetric(val: unknown, prefix = '', suffix = ''): string {
  const num = Number(val ?? 0);
  if (!Number.isFinite(num)) return `${prefix}${String(val ?? '-')}${suffix}`;
  const formatted =
    Math.abs(num) >= 10000
      ? num.toLocaleString('zh-CN', { maximumFractionDigits: 1 })
      : num.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return `${prefix}${formatted}${suffix}`;
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const rad = (deg: number) => ((deg - 90) * Math.PI) / 180.0;
  const start = { x: cx + r * Math.cos(rad(endAngle)), y: cy + r * Math.sin(rad(endAngle)) };
  const end = { x: cx + r * Math.cos(rad(startAngle)), y: cy + r * Math.sin(rad(startAngle)) };
  const largeArc = endAngle - startAngle <= 180 ? '0' : '1';
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
}

export function SqlWidgetCard({ widget, onDelete, onPin, compact }: SqlWidgetCardProps) {
  const { repo, revision } = useOmni();
  const tone = ToneMap[widget.accentTone ?? 'teal'] ?? ToneMap.teal;

  const queryOutcome = (() => {
    if (!repo || revision < 0) {
      return { rows: [] as Array<Record<string, unknown>>, error: null as string | null };
    }
    try {
      const rows = repo.executeReadOnlyQuery(widget.readonlySql);
      return { rows, error: null };
    } catch (err) {
      return { rows: [], error: err instanceof Error ? err.message : String(err) };
    }
  })();

  const { rows, error } = queryOutcome;

  if (widget.chartType === 'kpi_number') {
    const firstRow = rows[0] ?? {};
    const val = firstRow[widget.yKey] ?? Object.values(firstRow)[0] ?? 0;

    return (
      <View style={[styles.card, compact && styles.cardCompact]}>
        <View style={styles.headerRow}>
          <View style={styles.titleWrap}>
            <Text style={styles.kpiLabel} numberOfLines={1}>
              {widget.title}
            </Text>
            {widget.subtitle ? (
              <Text style={styles.subtitle} numberOfLines={1}>
                {widget.subtitle}
              </Text>
            ) : null}
          </View>
          {onDelete ? (
            <Pressable hitSlop={8} onPress={() => onDelete(widget.id)} style={styles.iconBtn}>
              <Feather name="x" size={15} color={Palette.inkMuted} />
            </Pressable>
          ) : null}
          {onPin ? (
            <Pressable onPress={() => onPin(widget)} style={[styles.pinBtn, { backgroundColor: tone.soft }]}>
              <Feather name="bookmark" size={13} color={tone.ink} />
              <Text style={[styles.pinText, { color: tone.ink }]}>固定到首页</Text>
            </Pressable>
          ) : null}
        </View>
        {error ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : (
          <Text style={[styles.kpiValue, { color: tone.solid }]} numberOfLines={1}>
            {formatMetric(val, widget.unitPrefix, widget.unitSuffix)}
          </Text>
        )}
      </View>
    );
  }

  const points = rows.slice(0, 8).map((r, idx) => {
    const xVal = widget.xKey ? r[widget.xKey] : Object.values(r)[0];
    const yVal = Number(r[widget.yKey] ?? Object.values(r)[1] ?? 0);
    return {
      label: String(xVal ?? `项${idx + 1}`),
      value: Number.isFinite(yVal) ? Math.max(0, yVal) : 0,
      color: ChartSeriesColors[idx % ChartSeriesColors.length],
    };
  });

  const maxVal = Math.max(1, ...points.map((p) => p.value));
  const sumVal = points.reduce((acc, p) => acc + p.value, 0);

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.titleWrap}>
          <Text style={styles.chartTitle}>{widget.title}</Text>
          {widget.subtitle ? <Text style={styles.subtitle}>{widget.subtitle}</Text> : null}
        </View>
        {onDelete ? (
          <Pressable hitSlop={8} onPress={() => onDelete(widget.id)} style={styles.iconBtn}>
            <Feather name="trash-2" size={15} color={Palette.inkMuted} />
          </Pressable>
        ) : null}
        {onPin ? (
          <Pressable onPress={() => onPin(widget)} style={[styles.pinBtn, { backgroundColor: tone.soft }]}>
            <Feather name="bookmark" size={13} color={tone.ink} />
            <Text style={[styles.pinText, { color: tone.ink }]}>固定到首页</Text>
          </Pressable>
        ) : null}
      </View>

      {error ? (
        <Text style={styles.errorText}>统计暂时不可用</Text>
      ) : points.length === 0 ? (
        <Text style={styles.emptyText}>暂无统计数据</Text>
      ) : widget.chartType === 'pie' ? (
        <View style={styles.pieRow}>
          <Svg width={120} height={120} viewBox="0 0 120 120">
            <Circle cx={60} cy={60} r={42} stroke={Palette.bgSubtle} strokeWidth={18} fill="none" />
            {sumVal > 0 &&
              (() => {
                let cursor = 0;
                return points.map((p, i) => {
                  const sweep = (p.value / sumVal) * 359.9;
                  const start = cursor;
                  const end = cursor + sweep;
                  cursor = end;
                  if (sweep < 1) return null;
                  return (
                    <Path
                      key={i}
                      d={describeArc(60, 60, 42, start, end)}
                      stroke={p.color}
                      strokeWidth={18}
                      strokeLinecap="butt"
                      fill="none"
                    />
                  );
                });
              })()}
          </Svg>
          <View style={styles.legendCol}>
            {points.slice(0, 5).map((p, i) => {
              const pct = sumVal > 0 ? Math.round((p.value / sumVal) * 100) : 0;
              return (
                <View key={i} style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: p.color }]} />
                  <Text style={styles.legendLabel} numberOfLines={1}>
                    {p.label}
                  </Text>
                  <Text style={styles.legendVal}>
                    {formatMetric(p.value, widget.unitPrefix, widget.unitSuffix)} ({pct}%)
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
      ) : widget.chartType === 'line' ? (
        <View style={styles.lineWrap}>
          <Svg width="100%" height={136} viewBox="0 0 320 136">
            <Line x1={12} y1={112} x2={308} y2={112} stroke={Palette.borderHairline} strokeWidth={1} />
            <Line x1={12} y1={64} x2={308} y2={64} stroke={Palette.borderHairline} strokeDasharray="3,3" strokeWidth={1} />
            {points.length > 1 &&
              (() => {
                const coords = points.map((p, idx) => ({
                  x: 20 + (idx * 280) / Math.max(1, points.length - 1),
                  y: 108 - (p.value / maxVal) * 84,
                }));
                const d = coords
                  .map((c, idx) => `${idx === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
                  .join(' ');
                return (
                  <G>
                    <Path d={d} stroke={tone.solid} strokeWidth={2.5} fill="none" />
                    {coords.map((c, idx) => (
                      <Circle key={idx} cx={c.x} cy={c.y} r={4} fill={Palette.bgSurface} stroke={tone.solid} strokeWidth={2.5} />
                    ))}
                  </G>
                );
              })()}
          </Svg>
          <View style={styles.axisLabelsRow}>
            {points.map((p, idx) => (
              <Text key={idx} style={styles.axisLabel} numberOfLines={1}>
                {p.label.slice(-5)}
              </Text>
            ))}
          </View>
        </View>
      ) : (
        <View style={styles.barList}>
          {points.map((p, idx) => {
            const widthPct = Math.max(4, Math.round((p.value / maxVal) * 100));
            return (
              <View key={idx} style={styles.barRow}>
                <View style={styles.barTopLine}>
                  <Text style={styles.barLabel} numberOfLines={1}>
                    {p.label}
                  </Text>
                  <Text style={styles.barValue}>
                    {formatMetric(p.value, widget.unitPrefix, widget.unitSuffix)}
                  </Text>
                </View>
                <View style={styles.barTrack}>
                  <Svg width="100%" height={8}>
                    <Rect x="0" y="0" width={`${widthPct}%`} height={8} rx={4} fill={tone.solid} />
                  </Svg>
                </View>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 12,
  },
  cardCompact: {
    flex: 1,
    minWidth: 155,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  titleWrap: {
    flex: 1,
    gap: 2,
  },
  kpiLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  chartTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  subtitle: {
    fontSize: 12,
    color: Palette.inkMuted,
  },
  kpiValue: {
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: -0.5,
    marginTop: 2,
  },
  iconBtn: {
    padding: 4,
  },
  pinBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  pinText: {
    fontSize: 12,
    fontWeight: '600',
  },
  errorText: {
    fontSize: 12,
    color: Palette.danger,
  },
  emptyText: {
    fontSize: 13,
    color: Palette.inkMuted,
    paddingVertical: 12,
  },
  pieRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  legendCol: {
    flex: 1,
    gap: 7,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendLabel: {
    flex: 1,
    fontSize: 12,
    color: Palette.inkSecondary,
  },
  legendVal: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkPrimary,
  },
  lineWrap: {
    gap: 4,
  },
  axisLabelsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
  },
  axisLabel: {
    fontSize: 11,
    color: Palette.inkMuted,
    maxWidth: 52,
  },
  barList: {
    gap: 10,
  },
  barRow: {
    gap: 4,
  },
  barTopLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  barLabel: {
    flex: 1,
    fontSize: 13,
    color: Palette.inkSecondary,
    fontWeight: '500',
  },
  barValue: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  barTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: Palette.bgSubtle,
    overflow: 'hidden',
  },
});
