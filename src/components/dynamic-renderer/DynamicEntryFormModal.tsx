import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import React, { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Palette } from '@/constants/design-tokens';
import { useOmni } from '@/context/omni-context';
import type { LibraryRecord } from '@/db/repository';
import { formatLocalDateOffset } from '@/engine/date';
import { evaluateFormula } from '@/engine/formula';
import { resolveImageUri, savePickedImageToStorage } from '@/engine/image-storage';
import type { FieldDef } from '@/schema/field-defs';

export interface LockedRelationContext {
  fieldKey: string;
  targetEntryId: string;
  targetTitle: string;
  targetLibraryIcon?: string;
}

interface DynamicEntryFormModalProps {
  visible: boolean;
  library: LibraryRecord;
  initialData?: Record<string, unknown>;
  editingEntryId?: string;
  lockedRelation?: LockedRelationContext;
  onClose: () => void;
  onSaved?: (entryId: string) => void;
}

function quickDateStr(offsetDays: number): string {
  return formatLocalDateOffset(offsetDays);
}

function buildInitialFormValues(
  library: LibraryRecord,
  initialData?: Record<string, unknown>,
  lockedRelation?: LockedRelationContext
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const f of library.fields) {
    if (lockedRelation && f.key === lockedRelation.fieldKey && !initialData?.[f.key]) {
      defaults[f.key] = [lockedRelation.targetEntryId];
    } else if (initialData && initialData[f.key] !== undefined) {
      defaults[f.key] = initialData[f.key];
    } else if (f.type === 'date') {
      defaults[f.key] = quickDateStr(0);
    } else if (f.type === 'checkbox') {
      defaults[f.key] = false;
    } else if (f.type === 'multi_select' || f.type === 'relation') {
      defaults[f.key] = [];
    } else if (f.type === 'select' && f.options?.length && f.required) {
      defaults[f.key] = f.options[0].value;
    } else {
      defaults[f.key] = '';
    }
  }
  return defaults;
}

export function DynamicEntryFormModal({
  visible,
  library,
  initialData,
  editingEntryId,
  lockedRelation,
  onClose,
  onSaved,
}: DynamicEntryFormModalProps) {
  const { repo } = useOmni();
  const insets = useSafeAreaInsets();
  const [formValues, setFormValues] = useState<Record<string, unknown>>(() =>
    buildInitialFormValues(library, initialData, lockedRelation)
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [prevSession, setPrevSession] = useState({
    visible: false,
    librarySlug: library.slug,
    editingEntryId,
    initialData,
    lockedTargetId: lockedRelation?.targetEntryId,
  });

  if (
    visible &&
    (!prevSession.visible ||
      prevSession.librarySlug !== library.slug ||
      prevSession.editingEntryId !== editingEntryId ||
      prevSession.initialData !== initialData ||
      prevSession.lockedTargetId !== lockedRelation?.targetEntryId)
  ) {
    setPrevSession({
      visible: true,
      librarySlug: library.slug,
      editingEntryId,
      initialData,
      lockedTargetId: lockedRelation?.targetEntryId,
    });
    setFormValues(buildInitialFormValues(library, initialData, lockedRelation));
    setErrorMsg(null);
  } else if (!visible && prevSession.visible) {
    setPrevSession((s) => ({ ...s, visible: false }));
  }

  const setFieldVal = (key: string, val: unknown) => {
    setFormValues((prev) => ({ ...prev, [key]: val }));
  };

  const pickImageForField = async (fieldKey: string) => {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.85,
        base64: Platform.OS === 'web',
      });
      if (!res.canceled && res.assets[0]) {
        const storedPath = await savePickedImageToStorage(res.assets[0]);
        setFieldVal(fieldKey, storedPath);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSave = () => {
    if (!repo) return;
    try {
      setErrorMsg(null);
      if (editingEntryId) {
        repo.updateEntry(editingEntryId, formValues);
        onSaved?.(editingEntryId);
      } else {
        const id = repo.createEntry(library.slug, formValues);
        onSaved?.(id);
      }
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.backdrop}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>
              {editingEntryId ? `编辑 · ${library.name}` : `记一条 · ${library.icon} ${library.name}`}
            </Text>
            <Pressable onPress={onClose} style={styles.closeBtn}>
              <Feather name="x" size={20} color={Palette.inkSecondary} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.scrollArea}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            {errorMsg ? (
              <View style={styles.errorBanner}>
                <Text style={styles.errorText}>{errorMsg}</Text>
              </View>
            ) : null}

            {lockedRelation ? (
              <View style={styles.lockedRelBanner}>
                <Feather name="link-2" size={14} color={Palette.brand} />
                <Text style={styles.lockedRelText} numberOfLines={1}>
                  归属记录：{lockedRelation.targetLibraryIcon ? `${lockedRelation.targetLibraryIcon} ` : ''}
                  {lockedRelation.targetTitle}
                </Text>
              </View>
            ) : null}

            {library.fields
              .filter((field) => !lockedRelation || field.key !== lockedRelation.fieldKey)
              .map((field) => (
                <FieldInputBlock
                  key={field.key}
                  field={field}
                  value={formValues[field.key]}
                  allValues={formValues}
                  onChange={(v) => setFieldVal(field.key, v)}
                  onPickImage={() => pickImageForField(field.key)}
                />
              ))}
          </ScrollView>

          <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 14) }]}>
            <Pressable onPress={onClose} style={styles.cancelBtn}>
              <Text style={styles.cancelText}>取消</Text>
            </Pressable>
            <Pressable onPress={handleSave} style={styles.saveBtn}>
              <Feather name="check" size={16} color={Palette.inkInverse} />
              <Text style={styles.saveText}>{editingEntryId ? '保存修改' : '保存'}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function FieldInputBlock({
  field,
  value,
  allValues,
  onChange,
  onPickImage,
}: {
  field: FieldDef;
  value: unknown;
  allValues: Record<string, unknown>;
  onChange: (val: unknown) => void;
  onPickImage: () => void;
}) {
  const { repo } = useOmni();

  const relationCandidates = useMemo(() => {
    if (field.type !== 'relation' || !field.relationConfig || !repo) return [];
    return repo.listRelationCandidates(field.relationConfig.targetLibrarySlug);
  }, [field, repo]);

  if (field.type === 'rollup') {
    return (
      <View style={styles.readonlyBox}>
        <Text style={styles.fieldLabel}>{field.label}（自动统计）</Text>
        <Text style={styles.readonlyHint}>保存后会自动根据相关记录汇总</Text>
      </View>
    );
  }

  if (field.type === 'formula') {
    const previewVal = field.formulaExpr ? evaluateFormula(field.formulaExpr, allValues) : '';
    return (
      <View style={styles.readonlyBox}>
        <Text style={styles.fieldLabel}>{field.label}（自动计算）</Text>
        <Text style={styles.formulaPreviewVal}>
          {String(previewVal)} {field.unit ?? ''}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>
        {field.label}
        {field.unit ? ` (${field.unit})` : ''}
        {field.required ? <Text style={styles.reqStar}> *</Text> : null}
      </Text>

      {field.type === 'text' ? (
        <TextInput
          value={String(value ?? '')}
          onChangeText={onChange}
          multiline={Boolean(field.multiline)}
          numberOfLines={field.multiline ? 4 : 1}
          textAlignVertical={field.multiline ? 'top' : 'center'}
          placeholder={field.placeholder || `请输入${field.label}`}
          placeholderTextColor={Palette.inkMuted}
          style={[styles.textInput, field.multiline && styles.multilineInput]}
        />
      ) : null}

      {field.type === 'number' || field.type === 'currency' ? (
        <TextInput
          value={value === undefined || value === null ? '' : String(value)}
          onChangeText={(txt) => onChange(txt)}
          keyboardType="decimal-pad"
          placeholder="0.00"
          placeholderTextColor={Palette.inkMuted}
          style={styles.textInput}
        />
      ) : null}

      {field.type === 'date' ? (
        <View style={styles.dateBlock}>
          <TextInput
            value={String(value ?? '')}
            onChangeText={onChange}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={Palette.inkMuted}
            style={styles.textInput}
          />
          <View style={styles.quickChipsRow}>
            {[
              { label: '今天', offset: 0 },
              { label: '昨天', offset: -1 },
              { label: '+30天', offset: 30 },
              { label: '+1年', offset: 365 },
            ].map((q) => (
              <Pressable
                key={q.label}
                onPress={() => onChange(quickDateStr(q.offset))}
                style={styles.quickChip}
              >
                <Text style={styles.quickChipText}>{q.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      {field.type === 'select' ? (
        <View style={styles.optionsWrap}>
          {(field.options ?? []).map((opt) => {
            const active = String(value ?? '') === opt.value;
            return (
              <Pressable
                key={opt.value}
                onPress={() => onChange(active && !field.required ? '' : opt.value)}
                style={[
                  styles.optPill,
                  active && {
                    backgroundColor: opt.color || Palette.brand,
                    borderColor: opt.color || Palette.brand,
                  },
                ]}
              >
                <Text style={[styles.optText, active && styles.optTextActive]}>{opt.value}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {field.type === 'multi_select' ? (
        <View style={styles.optionsWrap}>
          {(field.options ?? []).map((opt) => {
            const list = Array.isArray(value) ? value.map(String) : [];
            const active = list.includes(opt.value);
            return (
              <Pressable
                key={opt.value}
                onPress={() =>
                  onChange(active ? list.filter((x) => x !== opt.value) : [...list, opt.value])
                }
                style={[
                  styles.optPill,
                  active && {
                    backgroundColor: opt.color || Palette.brand,
                    borderColor: opt.color || Palette.brand,
                  },
                ]}
              >
                <Text style={[styles.optText, active && styles.optTextActive]}>{opt.value}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {field.type === 'rating' ? (
        <View style={styles.starsRow}>
          {[1, 2, 3, 4, 5].map((star) => {
            const active = Number(value || 0) >= star;
            return (
              <Pressable key={star} onPress={() => onChange(star)} style={styles.starBtn}>
                <Text style={[styles.starIcon, active && styles.starIconActive]}>
                  {active ? '★' : '☆'}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {field.type === 'checkbox' ? (
        <View style={styles.switchRow}>
          <Switch
            value={Boolean(value)}
            onValueChange={onChange}
            trackColor={{ false: Palette.borderStrong, true: Palette.brand }}
          />
          <Text style={styles.switchHint}>{value ? '已开启' : '未开启'}</Text>
        </View>
      ) : null}

      {field.type === 'image' ? (
        <View style={styles.imagePickerRow}>
          {value ? (
            <Image
              source={{ uri: resolveImageUri(value) }}
              style={styles.previewImg}
              contentFit="cover"
            />
          ) : null}
          <Pressable onPress={onPickImage} style={styles.pickImgBtn}>
            <Feather name="image" size={16} color={Palette.brand} />
            <Text style={styles.pickImgText}>{value ? '更换图片' : '从相册选择图片'}</Text>
          </Pressable>
          {value ? (
            <Pressable onPress={() => onChange('')} style={styles.clearImgBtn}>
              <Text style={styles.clearImgText}>移除</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {field.type === 'relation' ? (
        <View style={styles.optionsWrap}>
          {relationCandidates.length === 0 ? (
            <Text style={styles.readonlyHint}>
              关联目标库 ({field.relationConfig?.targetLibrarySlug}) 暂无可选记录
            </Text>
          ) : (
            relationCandidates.map((cand) => {
              const selectedIds = Array.isArray(value) ? value.map(String) : [];
              const active = selectedIds.includes(cand.id);
              const allowMulti = field.relationConfig?.allowMultiple ?? true;

              return (
                <Pressable
                  key={cand.id}
                  onPress={() => {
                    if (active) {
                      onChange(selectedIds.filter((x) => x !== cand.id));
                    } else {
                      onChange(allowMulti ? [...selectedIds, cand.id] : [cand.id]);
                    }
                  }}
                  style={[styles.relOptionPill, active && styles.relOptionPillActive]}
                >
                  <Feather
                    name={active ? 'check-circle' : 'link'}
                    size={13}
                    color={active ? Palette.inkInverse : Palette.brand}
                  />
                  <Text style={[styles.optText, active && styles.optTextActive]} numberOfLines={1}>
                    {cand.title}
                  </Text>
                </Pressable>
              );
            })
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(20, 26, 25, 0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Palette.bgSurface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '90%',
    width: '100%',
    maxWidth: 680,
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
    gap: 16,
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
  lockedRelBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Palette.brandSoft,
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderRadius: 12,
  },
  lockedRelText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    color: Palette.brand,
  },
  fieldGroup: {
    gap: 8,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkSecondary,
  },
  reqStar: {
    color: Palette.danger,
  },
  textInput: {
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 15,
    color: Palette.inkPrimary,
  },
  multilineInput: {
    minHeight: 104,
    lineHeight: 22,
    paddingTop: 12,
  },
  dateBlock: {
    gap: 8,
  },
  quickChipsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  quickChip: {
    backgroundColor: Palette.bgSubtle,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  quickChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  optionsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  optPill: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Palette.borderStrong,
    backgroundColor: Palette.bgSurface,
  },
  relOptionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Palette.borderStrong,
    backgroundColor: Palette.bgCanvas,
    maxWidth: '100%',
  },
  relOptionPillActive: {
    backgroundColor: Palette.brand,
    borderColor: Palette.brand,
  },
  optText: {
    fontSize: 13,
    fontWeight: '600',
    color: Palette.inkPrimary,
  },
  optTextActive: {
    color: Palette.inkInverse,
  },
  starsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  starBtn: {
    padding: 4,
  },
  starIcon: {
    fontSize: 28,
    color: Palette.borderStrong,
  },
  starIconActive: {
    color: '#D97706',
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  switchHint: {
    fontSize: 13,
    color: Palette.inkSecondary,
  },
  imagePickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  previewImg: {
    width: 56,
    height: 56,
    borderRadius: 10,
  },
  pickImgBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Palette.brandSoft,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },
  pickImgText: {
    fontSize: 13,
    fontWeight: '700',
    color: Palette.brand,
  },
  clearImgBtn: {
    padding: 8,
  },
  clearImgText: {
    fontSize: 13,
    color: Palette.danger,
  },
  readonlyBox: {
    backgroundColor: Palette.bgSubtle,
    padding: 12,
    borderRadius: 12,
    gap: 4,
  },
  readonlyHint: {
    fontSize: 12,
    color: Palette.inkMuted,
  },
  formulaPreviewVal: {
    fontSize: 16,
    fontWeight: '700',
    color: Palette.brand,
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: Palette.brand,
  },
  saveText: {
    fontSize: 15,
    fontWeight: '700',
    color: Palette.inkInverse,
  },
});
