import { Feather } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { runArchitectAgent } from '@/ai/agents';
import { Palette, ToneMap } from '@/constants/design-tokens';
import { useOmni } from '@/context/omni-context';
import type { LibraryRecord } from '@/db/repository';
import { FieldTypeEnum, type FieldDef, type FieldType } from '@/schema/field-defs';
import type { AccentTone, LibraryBlueprint } from '@/schema/view-dsl';

interface SchemaEditorModalProps {
  visible: boolean;
  existingLibrary?: LibraryRecord | null;
  onClose: () => void;
  onSaved?: (slug: string) => void;
}

const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: '文本',
  number: '数字',
  currency: '金额',
  date: '日期',
  select: '单选',
  multi_select: '多选',
  rating: '星级',
  checkbox: '勾选',
  image: '图片',
  relation: '跨表关联',
  rollup: '跨表汇总',
  formula: '计算公式',
};

const TONES: AccentTone[] = ['teal', 'amber', 'rose', 'blue', 'emerald', 'slate'];

export function SchemaEditorModal({
  visible,
  existingLibrary,
  onClose,
  onSaved,
}: SchemaEditorModalProps) {
  const { repo, libraries } = useOmni();

  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('🗂️');
  const [color, setColor] = useState<AccentTone>('teal');
  const [description, setDescription] = useState('');
  const [fields, setFields] = useState<FieldDef[]>([]);

  // Card View Slots
  const [titleFieldKey, setTitleFieldKey] = useState('');
  const [subtitleFieldKey, setSubtitleFieldKey] = useState('');
  const [rightBadgeFieldKey, setRightBadgeFieldKey] = useState('');
  const [footerMetricKeys, setFooterMetricKeys] = useState<string[]>([]);

  // Inline AI evolution
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setErrorMsg(null);
    setAiPrompt('');
    if (existingLibrary) {
      setSlug(existingLibrary.slug);
      setName(existingLibrary.name);
      setIcon(existingLibrary.icon);
      setColor(existingLibrary.color);
      setDescription(existingLibrary.description);
      setFields(existingLibrary.fields);
      setTitleFieldKey(existingLibrary.views.card.titleFieldKey);
      setSubtitleFieldKey(existingLibrary.views.card.subtitleFieldKey ?? '');
      setRightBadgeFieldKey(existingLibrary.views.card.rightBadgeFieldKey ?? '');
      setFooterMetricKeys(existingLibrary.views.card.footerMetricKeys);
    } else {
      setSlug(`custom_${Math.floor(100 + Math.random() * 899)}`);
      setName('');
      setIcon('📒');
      setColor('teal');
      setDescription('');
      setFields([
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
      ]);
      setTitleFieldKey('title');
      setSubtitleFieldKey('record_date');
      setRightBadgeFieldKey('tag');
      setFooterMetricKeys(['record_date']);
    }
  }, [visible, existingLibrary]);

  const addNewField = () => {
    const idx = fields.length + 1;
    setFields((prev) => [
      ...prev,
      {
        key: `field_${idx}`,
        label: `自定义字段${idx}`,
        type: 'text',
        required: false,
      },
    ]);
  };

  const updateFieldAt = (index: number, patch: Partial<FieldDef>) => {
    setFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  };

  const removeFieldAt = (index: number) => {
    if (fields.length <= 1) return;
    const removedKey = fields[index].key;
    setFields((prev) => prev.filter((_, i) => i !== index));
    setFooterMetricKeys((prev) => prev.filter((k) => k !== removedKey));
  };

  const toggleFooterMetric = (key: string) => {
    setFooterMetricKeys((prev) =>
      prev.includes(key)
        ? prev.filter((k) => k !== key)
        : prev.length < 4
          ? [...prev, key]
          : prev
    );
  };

  const handleAiAssist = async () => {
    if (!repo || !aiPrompt.trim()) return;
    try {
      setAiLoading(true);
      setErrorMsg(null);
      const scopedPrompt = existingLibrary
        ? `针对已有库 slug="${existingLibrary.slug}" (${existingLibrary.name}) 进行模型/样式调整：${aiPrompt}`
        : aiPrompt;
      const plan = await runArchitectAgent(repo, scopedPrompt);
      repo.applyArchitectPlan(plan);
      const targetSlug = plan.libraries[0]?.slug || slug;
      onSaved?.(targetSlug);
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setAiLoading(false);
    }
  };

  const handleManualSave = () => {
    if (!repo) return;
    try {
      setErrorMsg(null);
      const cleanSlug = slug.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
      if (!/^[a-z][a-z0-9_]*$/.test(cleanSlug)) {
        throw new Error('英文标识（slug）必须以小写字母开头，仅含字母、数字与下划线');
      }
      if (!name.trim()) {
        throw new Error('请填写数据表名称');
      }

      const validTitleKey = fields.some((f) => f.key === titleFieldKey)
        ? titleFieldKey
        : fields[0].key;
      const dateField = fields.find((f) => f.type === 'date');
      const imgField = fields.find((f) => f.type === 'image');
      const ratingField = fields.find((f) => f.type === 'rating');

      const blueprint: LibraryBlueprint = {
        slug: cleanSlug,
        name: name.trim(),
        description: description.trim(),
        icon: icon.trim() || '📦',
        color,
        fields,
        views: {
          card: {
            titleFieldKey: validTitleKey,
            subtitleFieldKey: subtitleFieldKey || undefined,
            coverImageFieldKey: imgField?.key,
            rightBadgeFieldKey: rightBadgeFieldKey || undefined,
            footerMetricKeys: footerMetricKeys.filter((k) => fields.some((f) => f.key === k)),
            sortFieldKey: dateField?.key,
            sortDir: 'desc',
            highlightRules: existingLibrary?.views.card.highlightRules ?? [],
          },
          gallery: {
            titleFieldKey: validTitleKey,
            subtitleFieldKey: subtitleFieldKey || undefined,
            coverImageFieldKey: imgField?.key,
            badgeFieldKey: rightBadgeFieldKey || undefined,
            ratingFieldKey: ratingField?.key,
          },
          calendar: dateField
            ? {
                dateFieldKey: dateField.key,
                titleFieldKey: validTitleKey,
                metricFieldKey: footerMetricKeys[0],
              }
            : undefined,
        },
      };

      repo.upsertLibrary(blueprint);
      onSaved?.(cleanSlug);
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>
              {existingLibrary ? `模型与显示样式 · ${existingLibrary.name}` : '新建自定义数据模型'}
            </Text>
            <Pressable onPress={onClose} style={styles.closeBtn}>
              <Feather name="x" size={20} color={Palette.inkSecondary} />
            </Pressable>
          </View>

          <ScrollView style={styles.scrollArea} contentContainerStyle={styles.scrollContent}>
            {errorMsg ? (
              <View style={styles.errorBanner}>
                <Text style={styles.errorText}>{errorMsg}</Text>
              </View>
            ) : null}

            {/* AI 一句话建模/改样式入口 */}
            <View style={styles.aiBox}>
              <View style={styles.aiTitleRow}>
                <Feather name="zap" size={14} color={Palette.brand} />
                <Text style={styles.aiBoxTitle}>DeepSeek V4.1 一句话生成/改样式</Text>
              </View>
              <View style={styles.aiInputRow}>
                <TextInput
                  value={aiPrompt}
                  onChangeText={setAiPrompt}
                  placeholder={
                    existingLibrary
                      ? '如：增加一个报销状态单选字段，未报销标黄提醒'
                      : '如：做一个咖啡豆品鉴库，带烘焙度、评分与日均克价公式'
                  }
                  placeholderTextColor={Palette.inkMuted}
                  style={styles.aiInput}
                />
                <Pressable
                  disabled={aiLoading || !aiPrompt.trim()}
                  onPress={handleAiAssist}
                  style={[
                    styles.aiGoBtn,
                    (aiLoading || !aiPrompt.trim()) && styles.btnDisabled,
                  ]}
                >
                  {aiLoading ? (
                    <ActivityIndicator size="small" color={Palette.inkInverse} />
                  ) : (
                    <Text style={styles.aiGoText}>AI 执行</Text>
                  )}
                </Pressable>
              </View>
            </View>

            {/* 基础信息 */}
            <Text style={styles.sectionTitle}>1. 库标识与主题色</Text>
            <View style={styles.rowGap}>
              <TextInput
                value={icon}
                onChangeText={setIcon}
                style={[styles.input, { width: 58, textAlign: 'center', fontSize: 20 }]}
                maxLength={2}
              />
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="数据库名称（如 宠物档案）"
                placeholderTextColor={Palette.inkMuted}
                style={[styles.input, { flex: 1 }]}
              />
            </View>
            {!existingLibrary ? (
              <TextInput
                value={slug}
                onChangeText={setSlug}
                placeholder="英文表标识 slug（如 pet_logs）"
                placeholderTextColor={Palette.inkMuted}
                autoCapitalize="none"
                style={styles.input}
              />
            ) : null}

            <View style={styles.tonesRow}>
              {TONES.map((t) => {
                const active = color === t;
                return (
                  <Pressable
                    key={t}
                    onPress={() => setColor(t)}
                    style={[
                      styles.toneCircle,
                      { backgroundColor: ToneMap[t].solid },
                      active && styles.toneCircleActive,
                    ]}
                  />
                );
              })}
            </View>

            {/* 字段模型列表 */}
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>2. 自定义字段结构 ({fields.length})</Text>
              <Pressable onPress={addNewField} style={styles.addFieldBtn}>
                <Feather name="plus" size={14} color={Palette.brand} />
                <Text style={styles.addFieldText}>添加字段</Text>
              </Pressable>
            </View>

            {fields.map((field, index) => (
              <View key={index} style={styles.fieldCard}>
                <View style={styles.rowGap}>
                  <TextInput
                    value={field.label}
                    onChangeText={(v) => updateFieldAt(index, { label: v })}
                    placeholder="字段中文名"
                    style={[styles.smallInput, { flex: 1 }]}
                  />
                  <TextInput
                    value={field.key}
                    onChangeText={(v) =>
                      updateFieldAt(index, {
                        key: v.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
                      })
                    }
                    placeholder="key"
                    autoCapitalize="none"
                    style={[styles.smallInput, { width: 112 }]}
                  />
                  {fields.length > 1 ? (
                    <Pressable onPress={() => removeFieldAt(index)} style={styles.delIconBtn}>
                      <Feather name="trash-2" size={15} color={Palette.danger} />
                    </Pressable>
                  ) : null}
                </View>

                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={styles.typeChipsRow}>
                    {FieldTypeEnum.options.map((t) => {
                      const active = field.type === t;
                      return (
                        <Pressable
                          key={t}
                          onPress={() => updateFieldAt(index, { type: t })}
                          style={[styles.typeChip, active && styles.typeChipActive]}
                        >
                          <Text style={[styles.typeChipText, active && styles.typeChipTextActive]}>
                            {FIELD_TYPE_LABELS[t]}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </ScrollView>

                {(field.type === 'select' || field.type === 'multi_select') && (
                  <TextInput
                    value={(field.options ?? []).map((o) => o.value).join(', ')}
                    onChangeText={(txt) =>
                      updateFieldAt(index, {
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
                            updateFieldAt(index, {
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
                    onChangeText={(v) => updateFieldAt(index, { formulaExpr: v })}
                    placeholder="表达式，如: ROUND(price / MAX(1, DAYS_SINCE(buy_date)), 2)"
                    placeholderTextColor={Palette.inkMuted}
                    autoCapitalize="none"
                    style={styles.smallInput}
                  />
                )}

                {field.type === 'rollup' && (
                  <View style={styles.rowGap}>
                    <TextInput
                      value={field.rollupConfig?.relationFieldKey ?? ''}
                      onChangeText={(v) =>
                        updateFieldAt(index, {
                          rollupConfig: {
                            relationFieldKey: v,
                            targetFieldKey: field.rollupConfig?.targetFieldKey ?? 'amount',
                            fn: field.rollupConfig?.fn ?? 'SUM',
                          },
                        })
                      }
                      placeholder="关联key 或 reverse:库.字段"
                      autoCapitalize="none"
                      style={[styles.smallInput, { flex: 1 }]}
                    />
                    <TextInput
                      value={field.rollupConfig?.targetFieldKey ?? ''}
                      onChangeText={(v) =>
                        updateFieldAt(index, {
                          rollupConfig: {
                            relationFieldKey: field.rollupConfig?.relationFieldKey ?? '',
                            targetFieldKey: v,
                            fn: field.rollupConfig?.fn ?? 'SUM',
                          },
                        })
                      }
                      placeholder="聚合目标字段"
                      autoCapitalize="none"
                      style={[styles.smallInput, { width: 105 }]}
                    />
                  </View>
                )}
              </View>
            ))}

            {/* 3. 显示样式卡片槽位映射 */}
            <Text style={styles.sectionTitle}>3. 卡片显示样式映射（View DSL）</Text>
            <SlotPickerRow
              label="主标题字段"
              fields={fields}
              selectedKey={titleFieldKey}
              onSelect={setTitleFieldKey}
            />
            <SlotPickerRow
              label="副标题字段"
              fields={fields}
              selectedKey={subtitleFieldKey}
              allowEmpty
              onSelect={setSubtitleFieldKey}
            />
            <SlotPickerRow
              label="右上角胶囊"
              fields={fields}
              selectedKey={rightBadgeFieldKey}
              allowEmpty
              onSelect={setRightBadgeFieldKey}
            />

            <View style={styles.slotBlock}>
              <Text style={styles.subFieldHint}>卡片底部指标栏（最多选 4 项）：</Text>
              <View style={styles.typeChipsRow}>
                {fields.map((f) => {
                  const active = footerMetricKeys.includes(f.key);
                  return (
                    <Pressable
                      key={f.key}
                      onPress={() => toggleFooterMetric(f.key)}
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
          </ScrollView>

          <View style={styles.footer}>
            <Pressable onPress={onClose} style={styles.cancelBtn}>
              <Text style={styles.cancelText}>取消</Text>
            </Pressable>
            <Pressable onPress={handleManualSave} style={styles.saveBtn}>
              <Text style={styles.saveText}>保存模型与样式</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
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
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(20, 26, 25, 0.48)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Palette.bgSurface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '92%',
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Palette.borderHairline,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  closeBtn: {
    padding: 4,
  },
  scrollArea: {
    paddingHorizontal: 20,
  },
  scrollContent: {
    paddingVertical: 16,
    gap: 14,
  },
  errorBanner: {
    backgroundColor: Palette.dangerSoft,
    padding: 12,
    borderRadius: 12,
  },
  errorText: {
    color: Palette.danger,
    fontSize: 13,
    fontWeight: '600',
  },
  aiBox: {
    backgroundColor: Palette.brandSoft,
    padding: 14,
    borderRadius: 14,
    gap: 8,
  },
  aiTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  aiBoxTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.brand,
  },
  aiInputRow: {
    flexDirection: 'row',
    gap: 8,
  },
  aiInput: {
    flex: 1,
    backgroundColor: Palette.bgSurface,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 13,
    color: Palette.inkPrimary,
  },
  aiGoBtn: {
    backgroundColor: Palette.brand,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiGoText: {
    color: Palette.inkInverse,
    fontSize: 13,
    fontWeight: '700',
  },
  btnDisabled: {
    opacity: 0.45,
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
  rowGap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  input: {
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: Palette.inkPrimary,
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
  tonesRow: {
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 4,
  },
  toneCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  toneCircleActive: {
    borderWidth: 3,
    borderColor: Palette.inkPrimary,
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
  fieldCard: {
    backgroundColor: Palette.bgCanvas,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    gap: 8,
  },
  delIconBtn: {
    padding: 6,
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
  slotBlock: {
    gap: 6,
  },
  footer: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: Palette.borderHairline,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: Palette.bgSubtle,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 15,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  saveBtn: {
    flex: 2,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: Palette.brand,
    alignItems: 'center',
  },
  saveText: {
    fontSize: 15,
    fontWeight: '700',
    color: Palette.inkInverse,
  },
});
