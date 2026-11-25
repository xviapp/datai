import Feather from '@expo/vector-icons/Feather';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Palette } from '@/constants/design-tokens';
import { ALL_VIEW_TYPES, VIEW_TYPE_META } from '@/constants/schema-meta';
import type { FieldDef } from '@/schema/field-defs';
import type { LibraryViewType } from '@/schema/view-dsl';
import type { ViewDraftItem } from './types';

export interface ViewsTabProps {
  width: number;
  fields: FieldDef[];
  viewDrafts: ViewDraftItem[];
  titleFieldKey: string;
  subtitleFieldKey: string;
  rightBadgeFieldKey: string;
  footerMetricKeys: string[];
  onAddView: (viewType: LibraryViewType) => void;
  onRemoveView: (index: number) => void;
  onMoveView: (index: number, delta: -1 | 1) => void;
  onUpdateViewName: (index: number, nextName: string) => void;
  onSelectTitleKey: (key: string) => void;
  onSelectSubtitleKey: (key: string) => void;
  onSelectRightBadgeKey: (key: string) => void;
  onToggleFooterMetric: (key: string) => void;
}

export function ViewsTab({
  width,
  fields,
  viewDrafts,
  titleFieldKey,
  subtitleFieldKey,
  rightBadgeFieldKey,
  footerMetricKeys,
  onAddView,
  onRemoveView,
  onMoveView,
  onUpdateViewName,
  onSelectTitleKey,
  onSelectSubtitleKey,
  onSelectRightBadgeKey,
  onToggleFooterMetric,
}: ViewsTabProps) {
  return (
    <ScrollView
      nestedScrollEnabled
      keyboardShouldPersistTaps="handled"
      style={{ width }}
      contentContainerStyle={styles.scrollContent}
    >
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>已启用视图 ({viewDrafts.length})</Text>
        <Text style={styles.viewSectionHint}>仅 1 个视图时自动隐藏切换栏</Text>
      </View>

      <View style={styles.viewsManagerCard}>
        {viewDrafts.map((v, idx) => {
          const meta = VIEW_TYPE_META[v.viewType];
          return (
            <View key={v.id ?? `${v.viewType}_${idx}`} style={styles.viewManageRow}>
              <View style={styles.viewTypeTag}>
                <Feather name={meta.icon} size={13} color={Palette.brand} />
                <Text style={styles.viewTypeTagText}>{meta.label}</Text>
              </View>
              <TextInput
                value={v.name}
                onChangeText={(txt) => onUpdateViewName(idx, txt)}
                placeholder={meta.label}
                placeholderTextColor={Palette.inkMuted}
                style={[styles.smallInput, styles.viewNameInput]}
              />
              <Pressable
                disabled={idx === 0}
                onPress={() => onMoveView(idx, -1)}
                hitSlop={4}
                style={[styles.viewMiniBtn, idx === 0 && styles.metaChipDisabled]}
              >
                <Feather name="arrow-up" size={13} color={Palette.inkSecondary} />
              </Pressable>
              <Pressable
                disabled={idx === viewDrafts.length - 1}
                onPress={() => onMoveView(idx, 1)}
                hitSlop={4}
                style={[
                  styles.viewMiniBtn,
                  idx === viewDrafts.length - 1 && styles.metaChipDisabled,
                ]}
              >
                <Feather name="arrow-down" size={13} color={Palette.inkSecondary} />
              </Pressable>
              {viewDrafts.length > 1 ? (
                <Pressable
                  onPress={() => onRemoveView(idx)}
                  hitSlop={4}
                  style={styles.viewMiniBtn}
                  accessibilityLabel="移除该视图"
                >
                  <Feather name="x" size={14} color={Palette.danger} />
                </Pressable>
              ) : null}
            </View>
          );
        })}

        {ALL_VIEW_TYPES.some((vt) => !viewDrafts.some((d) => d.viewType === vt)) ? (
          <View style={styles.addViewRow}>
            <Text style={styles.subFieldHint}>按需添加：</Text>
            {ALL_VIEW_TYPES.filter((vt) => !viewDrafts.some((d) => d.viewType === vt)).map(
              (vt) => (
                <Pressable
                  key={vt}
                  onPress={() => onAddView(vt)}
                  style={({ pressed }) => [styles.addViewChip, pressed && { opacity: 0.72 }]}
                >
                  <Feather name="plus" size={12} color={Palette.brand} />
                  <Feather name={VIEW_TYPE_META[vt].icon} size={12} color={Palette.brand} />
                  <Text style={styles.addViewChipText}>{VIEW_TYPE_META[vt].label}</Text>
                </Pressable>
              )
            )}
          </View>
        ) : null}
      </View>

      <Text style={styles.sectionTitle}>列表卡片显示字段</Text>
      <View style={styles.cardDisplayBox}>
        <SlotPickerRow
          label="主标题"
          fields={fields}
          selectedKey={titleFieldKey}
          onSelect={onSelectTitleKey}
        />
        <SlotPickerRow
          label="副标题"
          fields={fields}
          selectedKey={subtitleFieldKey}
          allowEmpty
          onSelect={onSelectSubtitleKey}
        />
        <SlotPickerRow
          label="右上角标签"
          fields={fields}
          selectedKey={rightBadgeFieldKey}
          allowEmpty
          onSelect={onSelectRightBadgeKey}
        />

        <View style={styles.slotBlock}>
          <Text style={styles.subFieldHint}>底部重点数值（最多选 4 项）：</Text>
          <View style={styles.typeChipsRow}>
            {fields.map((f) => {
              const active = footerMetricKeys.includes(f.key);
              return (
                <Pressable
                  key={f.key}
                  onPress={() => onToggleFooterMetric(f.key)}
                  style={[styles.typeChip, active && styles.typeChipActive]}
                >
                  <Text style={[styles.typeChipText, active && styles.typeChipTextActive]}>
                    {f.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

function SlotPickerRow({
  label,
  fields,
  selectedKey,
  allowEmpty,
  onSelect,
}: {
  label: string;
  fields: FieldDef[];
  selectedKey: string;
  allowEmpty?: boolean;
  onSelect: (key: string) => void;
}) {
  return (
    <View style={styles.slotBlock}>
      <Text style={styles.subFieldHint}>{label}：</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.typeChipsRow}>
          {allowEmpty ? (
            <Pressable
              onPress={() => onSelect('')}
              style={[styles.typeChip, !selectedKey && styles.typeChipActive]}
            >
              <Text style={[styles.typeChipText, !selectedKey && styles.typeChipTextActive]}>
                不显示
              </Text>
            </Pressable>
          ) : null}
          {fields.map((f) => {
            const active = selectedKey === f.key;
            return (
              <Pressable
                key={f.key}
                onPress={() => onSelect(f.key)}
                style={[styles.typeChip, active && styles.typeChipActive]}
              >
                <Text style={[styles.typeChipText, active && styles.typeChipTextActive]}>
                  {f.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: 18,
    paddingVertical: 14,
    gap: 12,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: Palette.inkPrimary,
    marginTop: 4,
  },
  viewSectionHint: {
    fontSize: 11,
    color: Palette.inkMuted,
  },
  viewsManagerCard: {
    backgroundColor: Palette.bgCanvas,
    borderRadius: 14,
    padding: 10,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 8,
  },
  viewManageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  viewTypeTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Palette.brandSoft,
    paddingHorizontal: 9,
    height: 36,
    borderRadius: 9,
  },
  viewTypeTagText: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.brand,
  },
  smallInput: {
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: Palette.inkPrimary,
  },
  viewNameInput: {
    flex: 1,
    height: 36,
    paddingVertical: 0,
  },
  viewMiniBtn: {
    width: 28,
    height: 32,
    borderRadius: 8,
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  metaChipDisabled: {
    opacity: 0.35,
  },
  addViewRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: Palette.borderHairline,
  },
  addViewChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Palette.brandSoft,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  addViewChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.brand,
  },
  cardDisplayBox: {
    backgroundColor: Palette.bgCanvas,
    borderRadius: 14,
    padding: 13,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 12,
  },
  slotBlock: {
    gap: 6,
  },
  subFieldHint: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  typeChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  typeChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  typeChipActive: {
    backgroundColor: Palette.brand,
    borderColor: Palette.brand,
  },
  typeChipText: {
    fontSize: 12,
    color: Palette.inkSecondary,
    fontWeight: '600',
  },
  typeChipTextActive: {
    color: Palette.inkInverse,
  },
});
