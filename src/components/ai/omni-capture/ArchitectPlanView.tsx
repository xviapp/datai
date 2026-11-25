import Feather from '@expo/vector-icons/Feather';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { AssistantIntent } from '@/ai/agents';
import type { ArchitectPlan } from '@/ai/schemas';
import { Palette } from '@/constants/design-tokens';
import { FIELD_TYPE_META } from '@/constants/schema-meta';
import type { ArchitectLibraryDiff, LibraryRecord } from '@/db/models';
import { IntentFallbackBar } from './IntentFallbackBar';

export interface ArchitectPlanViewProps {
  plan: ArchitectPlan;
  diffs: ArchitectLibraryDiff[];
  hasDestructiveChanges: boolean;
  existingSlugs: Set<string>;
  libMap: Map<string, LibraryRecord>;
  loading: boolean;
  onRetryAs: (intent: AssistantIntent) => void;
}

export function ArchitectPlanView({
  plan,
  diffs,
  hasDestructiveChanges,
  existingSlugs,
  libMap,
  loading,
  onRetryAs,
}: ArchitectPlanViewProps) {
  return (
    <View style={styles.resultSection}>
      <Text style={styles.sectionTitle}>方案预览（确认前不会改动数据）</Text>
      <Text style={styles.summaryText}>{plan.summary}</Text>

      {diffs.length > 0 ? (
        <View style={[styles.diffWarnBanner, hasDestructiveChanges && styles.diffDangerBanner]}>
          <Feather
            name="alert-triangle"
            size={15}
            color={hasDestructiveChanges ? Palette.danger : Palette.warning}
          />
          <View style={{ flex: 1, gap: 3 }}>
            <Text
              style={[styles.diffWarnTitle, hasDestructiveChanges && { color: Palette.danger }]}
            >
              {hasDestructiveChanges
                ? '注意：此方案会移除或改动已有字段类型，旧记录中对应值可能无法显示或保存'
                : '存量字段变更提示'}
            </Text>
            {diffs.map((d) => (
              <Text key={d.slug} style={styles.diffWarnLine}>
                • {d.name}（{d.entryCount} 条记录）：
                {[
                  d.removedFields.length > 0
                    ? `移除 ${d.removedFields.map((f) => f.label).join('、')}`
                    : '',
                  d.typeChangedFields.length > 0
                    ? `类型变更 ${d.typeChangedFields
                        .map(
                          (f) =>
                            `${f.label}(${FIELD_TYPE_META[f.fromType].label}→${FIELD_TYPE_META[f.toType].label})`
                        )
                        .join('、')}`
                    : '',
                  d.newlyRequiredFields.length > 0
                    ? `新增必填 ${d.newlyRequiredFields.map((f) => f.label).join('、')}`
                    : '',
                ]
                  .filter(Boolean)
                  .join('；')}
              </Text>
            ))}
          </View>
        </View>
      ) : null}

      {plan.libraries.map((bp) => {
        const isUpdate = existingSlugs.has(bp.slug);
        const parentLibName = bp.parentLibrarySlug
          ? (plan.libraries.find((x) => x.slug === bp.parentLibrarySlug)?.name ??
            libMap.get(bp.parentLibrarySlug)?.name ??
            bp.parentLibrarySlug)
          : null;

        const previewViews =
          bp.viewList && bp.viewList.length > 0
            ? bp.viewList
            : [
                { name: '列表', viewType: 'card' as const },
                ...(bp.views.gallery ? [{ name: '画廊', viewType: 'gallery' as const }] : []),
                ...(bp.views.calendar ? [{ name: '日历', viewType: 'calendar' as const }] : []),
              ];

        return (
          <View key={bp.slug} style={styles.resultCard}>
            <View style={styles.draftHeader}>
              <View style={styles.planLibTitleRow}>
                <Text style={styles.draftLibBadge}>
                  {bp.icon} {bp.name}
                </Text>
                {parentLibName ? (
                  <View style={styles.subLibBadge}>
                    <Text style={styles.subLibBadgeText}>
                      附属 · {parentLibName}
                      {bp.showOnHome === false ? '（收纳）' : ''}
                    </Text>
                  </View>
                ) : null}
              </View>
              <View
                style={[
                  styles.opBadge,
                  { backgroundColor: isUpdate ? Palette.infoSoft : Palette.successSoft },
                ]}
              >
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: '700',
                    color: isUpdate ? Palette.info : Palette.success,
                  }}
                >
                  {isUpdate ? '更新' : '新建'}
                </Text>
              </View>
            </View>

            <View style={styles.planViewsRow}>
              <Feather name="layout" size={12} color={Palette.brand} />
              <Text style={styles.planViewsLabel}>视图：</Text>
              {previewViews.map((v, vi) => (
                <View key={`${v.viewType}_${vi}`} style={styles.planViewBadge}>
                  <Text style={styles.planViewBadgeText}>{v.name}</Text>
                </View>
              ))}
            </View>

            <View style={styles.fieldsWrap}>
              {bp.fields.map((f) => (
                <View key={f.key} style={styles.fieldChip}>
                  <Text style={styles.fieldChipText}>
                    {f.label} · {f.multiline ? '多行文本' : FIELD_TYPE_META[f.type]?.label ?? f.type}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        );
      })}

      {plan.dashboardWidgets.length > 0 ? (
        <Text style={styles.assistantNote}>
          同时会在统计页添加 {plan.dashboardWidgets.length} 张配套图表
        </Text>
      ) : null}

      <IntentFallbackBar currentIntent="architect" disabled={loading} onRetryAs={onRetryAs} />
    </View>
  );
}

const styles = StyleSheet.create({
  resultSection: {
    gap: 10,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: Palette.inkPrimary,
  },
  summaryText: {
    fontSize: 13,
    color: Palette.inkSecondary,
    lineHeight: 20,
  },
  assistantNote: {
    fontSize: 13,
    fontWeight: '600',
    color: Palette.brand,
  },
  diffWarnBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: Palette.warningSoft,
    padding: 12,
    borderRadius: 12,
  },
  diffDangerBanner: {
    backgroundColor: Palette.dangerSoft,
  },
  diffWarnTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.warning,
    lineHeight: 17,
  },
  diffWarnLine: {
    fontSize: 12,
    color: Palette.inkSecondary,
    lineHeight: 17,
  },
  resultCard: {
    backgroundColor: Palette.bgCanvas,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 8,
  },
  draftHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  planLibTitleRow: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  draftLibBadge: {
    fontSize: 14,
    fontWeight: '800',
    color: Palette.inkPrimary,
  },
  subLibBadge: {
    backgroundColor: Palette.brandSoft,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  subLibBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: Palette.brand,
  },
  opBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  planViewsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  planViewsLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: Palette.inkSecondary,
  },
  planViewBadge: {
    backgroundColor: Palette.brandSoft,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  planViewBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: Palette.brand,
  },
  fieldsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  fieldChip: {
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  fieldChipText: {
    fontSize: 11,
    color: Palette.inkSecondary,
    fontWeight: '600',
  },
});
