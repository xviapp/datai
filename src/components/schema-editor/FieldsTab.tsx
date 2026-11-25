import Feather from '@expo/vector-icons/Feather';
import React, { useState } from 'react';
import {
  LayoutAnimation,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Palette } from '@/constants/design-tokens';
import {
  ADVANCED_FIELD_TYPES,
  COMMON_FIELD_TYPES,
  FIELD_TYPE_META,
  ROLLUP_FNS,
} from '@/constants/schema-meta';
import type { LibraryRecord } from '@/db/models';
import type { FieldDef } from '@/schema/field-defs';

export interface FieldsTabProps {
  width: number;
  slug: string;
  fields: FieldDef[];
  libraries: LibraryRecord[];
  onAddField: () => void;
  onUpdateField: (index: number, patch: Partial<FieldDef>) => void;
  onMoveField: (index: number, delta: -1 | 1) => void;
  onRemoveField: (index: number) => void;
}

export function FieldsTab({
  width,
  slug,
  fields,
  libraries,
  onAddField,
  onUpdateField,
  onMoveField,
  onRemoveField,
}: FieldsTabProps) {
  const [openTypePickerKey, setOpenTypePickerKey] = useState<string | null>(null);

  const toggleTypePicker = (rowKey: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpenTypePickerKey((prev) => (prev === rowKey ? null : rowKey));
  };

  return (
    <ScrollView
      nestedScrollEnabled
      keyboardShouldPersistTaps="handled"
      style={{ width }}
      contentContainerStyle={styles.scrollContent}
    >
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>数据结构 · 共 {fields.length} 项</Text>
        <Pressable onPress={onAddField} style={styles.addFieldBtn}>
          <Feather name="plus" size={14} color={Palette.brand} />
          <Text style={styles.addFieldText}>添加一项</Text>
        </Pressable>
      </View>

      {fields.map((field, index) => {
        const rowKey = field.key || String(index);
        const isPickerOpen = openTypePickerKey === rowKey;
        const typeMeta = FIELD_TYPE_META[field.type];
        const typeBadgeIcon =
          field.type === 'text' && field.multiline ? 'align-left' : typeMeta.icon;
        const typeBadgeLabel =
          field.type === 'text' && field.multiline ? '长文本' : typeMeta.label;

        return (
          <View
            key={rowKey}
            style={[styles.fieldCard, isPickerOpen && styles.fieldCardActive]}
          >
            <View style={styles.rowGap}>
              <TextInput
                value={field.label}
                onChangeText={(v) => onUpdateField(index, { label: v })}
                placeholder="填写名称，如：书摘随感、页码"
                placeholderTextColor={Palette.inkMuted}
                style={[styles.smallInput, styles.fieldNameInput]}
              />

              <Pressable
                onPress={() => toggleTypePicker(rowKey)}
                style={({ pressed }) => [
                  styles.typeSelectBtn,
                  isPickerOpen && styles.typeSelectBtnOpen,
                  pressed && { opacity: 0.78, transform: [{ scale: 0.97 }] },
                ]}
                accessibilityLabel={`选择${field.label || '记录项'}类型`}
              >
                <Feather
                  name={typeBadgeIcon}
                  size={13}
                  color={isPickerOpen ? Palette.brand : Palette.inkSecondary}
                />
                <Text
                  numberOfLines={1}
                  style={[styles.typeSelectText, isPickerOpen && styles.typeSelectTextOpen]}
                >
                  {typeBadgeLabel}
                  {field.required ? ' *' : ''}
                </Text>
                <Feather
                  name={isPickerOpen ? 'chevron-up' : 'chevron-down'}
                  size={13}
                  color={isPickerOpen ? Palette.brand : Palette.inkMuted}
                />
              </Pressable>

              {fields.length > 1 ? (
                <Pressable
                  onPress={() => {
                    if (openTypePickerKey === rowKey) setOpenTypePickerKey(null);
                    onRemoveField(index);
                  }}
                  hitSlop={6}
                  style={({ pressed }) => [styles.delIconBtn, pressed && { opacity: 0.65 }]}
                  accessibilityLabel="删除记录项"
                >
                  <Feather name="trash-2" size={15} color={Palette.danger} />
                </Pressable>
              ) : null}
            </View>

            {isPickerOpen ? (
              <View style={styles.typeDropdownPanel}>
                <View style={styles.fieldMetaBar}>
                  <View style={styles.moveBtnsRow}>
                    <Pressable
                      disabled={index === 0}
                      onPress={() => onMoveField(index, -1)}
                      style={[styles.metaChipBtn, index === 0 && styles.metaChipDisabled]}
                    >
                      <Feather name="arrow-up" size={12} color={Palette.inkSecondary} />
                      <Text style={styles.metaChipText}>上移</Text>
                    </Pressable>
                    <Pressable
                      disabled={index === fields.length - 1}
                      onPress={() => onMoveField(index, 1)}
                      style={[
                        styles.metaChipBtn,
                        index === fields.length - 1 && styles.metaChipDisabled,
                      ]}
                    >
                      <Feather name="arrow-down" size={12} color={Palette.inkSecondary} />
                      <Text style={styles.metaChipText}>下移</Text>
                    </Pressable>
                  </View>

                  {field.type !== 'rollup' && field.type !== 'formula' ? (
                    <Pressable
                      onPress={() => onUpdateField(index, { required: !field.required })}
                      style={[styles.metaChipBtn, field.required && styles.metaChipBtnActive]}
                    >
                      <Feather
                        name={field.required ? 'check-square' : 'square'}
                        size={12}
                        color={field.required ? Palette.brand : Palette.inkMuted}
                      />
                      <Text
                        style={[
                          styles.metaChipText,
                          field.required && { color: Palette.brand, fontWeight: '700' },
                        ]}
                      >
                        必填
                      </Text>
                    </Pressable>
                  ) : null}
                </View>

                {field.type === 'number' ||
                field.type === 'formula' ||
                field.type === 'rollup' ? (
                  <View style={styles.unitRow}>
                    <Text style={styles.typeGroupLabel}>显示单位（可选）</Text>
                    <TextInput
                      value={field.unit ?? ''}
                      onChangeText={(u) => onUpdateField(index, { unit: u || undefined })}
                      placeholder="如：页、分钟、km、元/天"
                      placeholderTextColor={Palette.inkMuted}
                      style={[styles.smallInput, styles.unitInput]}
                    />
                  </View>
                ) : null}

                <Text style={styles.typeGroupLabel}>常用类型</Text>
                <View style={styles.typeGrid}>
                  {COMMON_FIELD_TYPES.map((t) => {
                    const active = field.type === t;
                    const meta = FIELD_TYPE_META[t];
                    return (
                      <Pressable
                        key={t}
                        onPress={() => {
                          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                          onUpdateField(
                            index,
                            t === 'text' ? { type: t } : { type: t, multiline: false }
                          );
                          setOpenTypePickerKey(null);
                        }}
                        style={({ pressed }) => [
                          styles.typeGridCell,
                          active && styles.typeGridCellActive,
                          pressed && { opacity: 0.75 },
                        ]}
                      >
                        <Feather
                          name={meta.icon}
                          size={13}
                          color={active ? Palette.brand : Palette.inkSecondary}
                        />
                        <Text
                          numberOfLines={1}
                          style={[
                            styles.typeGridCellText,
                            active && styles.typeGridCellTextActive,
                          ]}
                        >
                          {meta.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                {field.type === 'text' ? (
                  <Pressable
                    onPress={() => onUpdateField(index, { multiline: !field.multiline })}
                    style={({ pressed }) => [
                      styles.multilineToggleRow,
                      field.multiline && styles.multilineToggleRowActive,
                      pressed && { opacity: 0.8 },
                    ]}
                  >
                    <Feather
                      name={field.multiline ? 'check-square' : 'square'}
                      size={14}
                      color={field.multiline ? Palette.brand : Palette.inkMuted}
                    />
                    <Text
                      style={[
                        styles.multilineToggleText,
                        field.multiline && styles.multilineToggleTextActive,
                      ]}
                    >
                      多行长文本（适合书摘、随感或长备注）
                    </Text>
                  </Pressable>
                ) : null}

                <Text style={[styles.typeGroupLabel, { marginTop: 4 }]}>关联与自动计算</Text>
                <View style={styles.typeGrid}>
                  {ADVANCED_FIELD_TYPES.map((t) => {
                    const active = field.type === t;
                    const meta = FIELD_TYPE_META[t];
                    return (
                      <Pressable
                        key={t}
                        onPress={() => {
                          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                          onUpdateField(index, { type: t, multiline: false });
                          setOpenTypePickerKey(null);
                        }}
                        style={({ pressed }) => [
                          styles.typeGridCell,
                          active && styles.typeGridCellActive,
                          pressed && { opacity: 0.75 },
                        ]}
                      >
                        <Feather
                          name={meta.icon}
                          size={13}
                          color={active ? Palette.brand : Palette.inkSecondary}
                        />
                        <Text
                          numberOfLines={1}
                          style={[
                            styles.typeGridCellText,
                            active && styles.typeGridCellTextActive,
                          ]}
                        >
                          {meta.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}

            {(field.type === 'select' || field.type === 'multi_select') && (
              <TextInput
                value={(field.options ?? []).map((o) => o.value).join(', ')}
                onChangeText={(txt) =>
                  onUpdateField(index, {
                    options: txt
                      .split(/[,，]/)
                      .map((s) => s.trim())
                      .filter(Boolean)
                      .map((value) => ({ value })),
                  })
                }
                placeholder="选项列表，用逗号分隔（如：待办, 进行中, 已完成）"
                placeholderTextColor={Palette.inkMuted}
                style={styles.smallInput}
              />
            )}

            {field.type === 'relation' && (
              <View style={styles.typeChipsRow}>
                <Text style={styles.subFieldHint}>指向目标库：</Text>
                {libraries.map((targetLib) => {
                  const active = field.relationConfig?.targetLibrarySlug === targetLib.slug;
                  return (
                    <Pressable
                      key={targetLib.slug}
                      onPress={() =>
                        onUpdateField(index, {
                          relationConfig: {
                            targetLibrarySlug: targetLib.slug,
                            allowMultiple: true,
                          },
                        })
                      }
                      style={[styles.typeChip, active && styles.typeChipActive]}
                    >
                      <Text style={[styles.typeChipText, active && styles.typeChipTextActive]}>
                        {targetLib.icon} {targetLib.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}

            {field.type === 'formula' && (
              <TextInput
                value={field.formulaExpr ?? ''}
                onChangeText={(v) => onUpdateField(index, { formulaExpr: v })}
                placeholder="表达式，如: ROUND(price / MAX(1, DAYS_SINCE(buy_date)), 2)"
                placeholderTextColor={Palette.inkMuted}
                autoCapitalize="none"
                style={styles.smallInput}
              />
            )}

            {field.type === 'rollup' ? (
              <RollupConfigEditor
                slug={slug}
                field={field}
                allFields={fields}
                libraries={libraries}
                onChange={(rollupConfig) => onUpdateField(index, { rollupConfig })}
              />
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

function RollupConfigEditor({
  slug,
  field,
  allFields,
  libraries,
  onChange,
}: {
  slug: string;
  field: FieldDef;
  allFields: FieldDef[];
  libraries: LibraryRecord[];
  onChange: (cfg: NonNullable<FieldDef['rollupConfig']>) => void;
}) {
  const currentRelKey = field.rollupConfig?.relationFieldKey ?? '';
  const currentTargetKey = field.rollupConfig?.targetFieldKey ?? '';
  const currentFn = field.rollupConfig?.fn ?? 'SUM';

  const rollupSources: Array<{
    value: string;
    label: string;
    targetLib: LibraryRecord;
  }> = [];

  for (const rf of allFields) {
    if (rf.type === 'relation' && rf.relationConfig?.targetLibrarySlug) {
      const targetLib = libraries.find((l) => l.slug === rf.relationConfig?.targetLibrarySlug);
      if (targetLib) {
        rollupSources.push({
          value: rf.key,
          label: `${rf.label} (${targetLib.icon}${targetLib.name})`,
          targetLib,
        });
      }
    }
  }

  if (slug) {
    for (const otherLib of libraries) {
      if (otherLib.slug === slug) continue;
      for (const ofield of otherLib.fields) {
        if (ofield.type === 'relation' && ofield.relationConfig?.targetLibrarySlug === slug) {
          rollupSources.push({
            value: `reverse:${otherLib.slug}.${ofield.key}`,
            label: `关联表：${otherLib.icon} ${otherLib.name}`,
            targetLib: otherLib,
          });
        }
      }
    }
  }

  const matchedSource = rollupSources.find((s) => s.value === currentRelKey);
  const targetFields = matchedSource
    ? matchedSource.targetLib.fields.filter(
        (tf) =>
          tf.type === 'number' ||
          tf.type === 'currency' ||
          tf.type === 'rating' ||
          tf.type === 'formula'
      )
    : [];

  return (
    <View style={styles.rollupBox}>
      {rollupSources.length > 0 ? (
        <>
          <Text style={styles.typeGroupLabel}>汇总来源</Text>
          <View style={styles.typeChipsRow}>
            {rollupSources.map((src) => {
              const active = src.value === currentRelKey;
              return (
                <Pressable
                  key={src.value}
                  onPress={() => {
                    const defaultField =
                      src.targetLib.fields.find(
                        (tf) => tf.type === 'currency' || tf.type === 'number'
                      )?.key ??
                      src.targetLib.fields[0]?.key ??
                      'id';
                    onChange({
                      relationFieldKey: src.value,
                      targetFieldKey: defaultField,
                      fn: currentFn,
                    });
                  }}
                  style={[styles.typeChip, active && styles.typeChipActive]}
                >
                  <Text style={[styles.typeChipText, active && styles.typeChipTextActive]}>
                    {src.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.typeGroupLabel}>统计方式</Text>
          <View style={styles.typeChipsRow}>
            {ROLLUP_FNS.map((item) => {
              const active = currentFn === item.fn;
              return (
                <Pressable
                  key={item.fn}
                  onPress={() =>
                    onChange({
                      relationFieldKey: currentRelKey,
                      targetFieldKey: currentTargetKey || 'id',
                      fn: item.fn,
                    })
                  }
                  style={[styles.typeChip, active && styles.typeChipActive]}
                >
                  <Text style={[styles.typeChipText, active && styles.typeChipTextActive]}>
                    {item.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {currentFn !== 'COUNT' && targetFields.length > 0 ? (
            <>
              <Text style={styles.typeGroupLabel}>目标数值字段</Text>
              <View style={styles.typeChipsRow}>
                {targetFields.map((tf) => {
                  const active = currentTargetKey === tf.key;
                  return (
                    <Pressable
                      key={tf.key}
                      onPress={() =>
                        onChange({
                          relationFieldKey: currentRelKey,
                          targetFieldKey: tf.key,
                          fn: currentFn,
                        })
                      }
                      style={[styles.typeChip, active && styles.typeChipActive]}
                    >
                      <Text style={[styles.typeChipText, active && styles.typeChipTextActive]}>
                        {tf.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : null}
        </>
      ) : (
        <View style={styles.rowGap}>
          <TextInput
            value={currentRelKey}
            onChangeText={(v) =>
              onChange({
                relationFieldKey: v,
                targetFieldKey: currentTargetKey || 'amount',
                fn: currentFn,
              })
            }
            placeholder="先添加一个「跨表关联」字段或附属表"
            placeholderTextColor={Palette.inkMuted}
            autoCapitalize="none"
            style={[styles.smallInput, { flex: 1 }]}
          />
          <TextInput
            value={currentTargetKey}
            onChangeText={(v) =>
              onChange({
                relationFieldKey: currentRelKey,
                targetFieldKey: v,
                fn: currentFn,
              })
            }
            placeholder="目标字段"
            placeholderTextColor={Palette.inkMuted}
            autoCapitalize="none"
            style={[styles.smallInput, { width: 96 }]}
          />
        </View>
      )}
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
  addFieldBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Palette.brandSoft,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  addFieldText: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.brand,
  },
  rowGap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
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
  fieldCard: {
    backgroundColor: Palette.bgCanvas,
    borderRadius: 14,
    padding: 10,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 8,
  },
  fieldCardActive: {
    borderColor: Palette.brand,
  },
  fieldNameInput: {
    flex: 1,
    minWidth: 0,
    height: 38,
    paddingVertical: 0,
  },
  typeSelectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 38,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    flexShrink: 0,
  },
  typeSelectBtnOpen: {
    backgroundColor: Palette.brandSoft,
    borderColor: Palette.brand,
  },
  typeSelectText: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.inkSecondary,
    maxWidth: 68,
  },
  typeSelectTextOpen: {
    color: Palette.brand,
  },
  delIconBtn: {
    width: 34,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  typeDropdownPanel: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 8,
  },
  fieldMetaBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: Palette.borderHairline,
  },
  moveBtnsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  metaChipBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  metaChipBtnActive: {
    backgroundColor: Palette.brandSoft,
    borderColor: Palette.brand,
  },
  metaChipDisabled: {
    opacity: 0.35,
  },
  metaChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  unitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  unitInput: {
    flex: 1,
    height: 34,
    paddingVertical: 0,
  },
  typeGroupLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: Palette.inkMuted,
  },
  typeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  typeGridCell: {
    width: '31.5%',
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 9,
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  typeGridCellActive: {
    backgroundColor: Palette.brandSoft,
    borderColor: Palette.brand,
  },
  typeGridCellText: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  typeGridCellTextActive: {
    color: Palette.brand,
    fontWeight: '700',
  },
  multilineToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 9,
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
  },
  multilineToggleRowActive: {
    backgroundColor: Palette.brandSoft,
    borderColor: Palette.brand,
  },
  multilineToggleText: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  multilineToggleTextActive: {
    color: Palette.brand,
    fontWeight: '700',
  },
  rollupBox: {
    backgroundColor: Palette.bgSurface,
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 7,
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
  subFieldHint: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
});
