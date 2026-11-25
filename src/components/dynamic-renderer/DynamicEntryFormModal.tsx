import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import React, { useMemo, useState } from 'react';
import {
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
import { BottomSheetModal } from '@/components/ui/BottomSheetModal';
import { InlineDatePicker } from '@/components/ui/InlineDatePicker';
import { Palette, ToneMap } from '@/constants/design-tokens';
import { useRepository } from '@/context/omni-context';
import type { LibraryRecord } from '@/db/models';
import { formatLocalDate } from '@/engine/date';
import { evaluateFormula } from '@/engine/formula';
import {
  pickImageAsset,
  resolveImageUri,
  savePickedImageToStorage,
} from '@/engine/image-storage';
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
      defaults[f.key] = formatLocalDate();
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
  const sessionKey = `${library.slug}::${editingEntryId ?? 'new'}::${lockedRelation?.targetEntryId ?? ''}`;

  return (
    <BottomSheetModal
      visible={visible}
      onClose={onClose}
      maxHeight="90%"
      maxWidth={680}
      header={
        <View style={styles.header}>
          <Text style={styles.headerTitle}>
            {editingEntryId ? `编辑 · ${library.name}` : `记一条 · ${library.icon} ${library.name}`}
          </Text>
          <Pressable
            onPress={onClose}
            hitSlop={8}
            style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.6 }]}
          >
            <Feather name="x" size={20} color={Palette.inkSecondary} />
          </Pressable>
        </View>
      }
    >
      {visible ? (
        <DynamicEntryFormBody
          key={sessionKey}
          library={library}
          initialData={initialData}
          editingEntryId={editingEntryId}
          lockedRelation={lockedRelation}
          onClose={onClose}
          onSaved={onSaved}
        />
      ) : null}
    </BottomSheetModal>
  );
}

function DynamicEntryFormBody({
  library,
  initialData,
  editingEntryId,
  lockedRelation,
  onClose,
  onSaved,
}: Omit<DynamicEntryFormModalProps, 'visible'>) {
  const { repo } = useRepository();
  const insets = useSafeAreaInsets();
  const [formValues, setFormValues] = useState<Record<string, unknown>>(() =>
    buildInitialFormValues(library, initialData, lockedRelation)
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const tone = ToneMap[library.color] ?? ToneMap.teal;

  const setFieldVal = (key: string, val: unknown) => {
    setFormValues((prev) => ({ ...prev, [key]: val }));
  };

  const pickImageForField = async (fieldKey: string, fromCamera = false) => {
    try {
      setErrorMsg(null);
      const asset = await pickImageAsset(fromCamera, '需要相机权限才能直接拍照');
      if (asset) {
        const storedPath = await savePickedImageToStorage(asset);
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
    <>
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
              归属记录：
              {lockedRelation.targetLibraryIcon ? `${lockedRelation.targetLibraryIcon} ` : ''}
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
              accentColor={tone.solid}
              accentSoft={tone.soft}
              accentInk={tone.ink}
              onChange={(v) => setFieldVal(field.key, v)}
              onPickImage={(fromCamera) => pickImageForField(field.key, fromCamera)}
            />
          ))}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 14) }]}>
        <Pressable
          onPress={onClose}
          style={({ pressed }) => [styles.cancelBtn, pressed && { opacity: 0.78 }]}
        >
          <Text style={styles.cancelText}>取消</Text>
        </Pressable>
        <Pressable
          onPress={handleSave}
          style={({ pressed }) => [
            styles.saveBtn,
            { backgroundColor: tone.solid },
            pressed && { opacity: 0.85, transform: [{ scale: 0.985 }] },
          ]}
        >
          <Feather name="check" size={16} color={Palette.inkInverse} />
          <Text style={styles.saveText}>{editingEntryId ? '保存修改' : '保存'}</Text>
        </Pressable>
      </View>
    </>
  );
}

function FieldInputBlock({
  field,
  value,
  allValues,
  accentColor,
  accentSoft,
  accentInk,
  onChange,
  onPickImage,
}: {
  field: FieldDef;
  value: unknown;
  allValues: Record<string, unknown>;
  accentColor: string;
  accentSoft: string;
  accentInk: string;
  onChange: (val: unknown) => void;
  onPickImage: (fromCamera: boolean) => void;
}) {
  const { repo } = useRepository();
  const [relSearch, setRelSearch] = useState('');

  const relationCandidates = useMemo(() => {
    if (field.type !== 'relation' || !field.relationConfig || !repo) return [];
    return repo.listRelationCandidates(field.relationConfig.targetLibrarySlug);
  }, [field, repo]);

  const filteredRelationCandidates = useMemo(() => {
    const q = relSearch.trim().toLowerCase();
    if (!q) return relationCandidates;
    return relationCandidates.filter((c) => c.title.toLowerCase().includes(q));
  }, [relationCandidates, relSearch]);

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
        <View style={styles.numInputWrap}>
          {field.type === 'currency' ? <Text style={styles.currencyPrefix}>¥</Text> : null}
          <TextInput
            value={value === undefined || value === null ? '' : String(value)}
            onChangeText={(txt) => onChange(txt)}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor={Palette.inkMuted}
            style={styles.numInputInner}
          />
          {field.unit ? <Text style={styles.unitSuffix}>{field.unit}</Text> : null}
        </View>
      ) : null}

      {field.type === 'date' ? (
        <InlineDatePicker
          value={String(value ?? '')}
          onChange={onChange}
          accentColor={accentColor}
        />
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
            const current = Number(value || 0);
            const active = current >= star;
            return (
              <Pressable
                key={star}
                onPress={() => onChange(current === star ? 0 : star)}
                style={({ pressed }) => [styles.starBtn, pressed && { transform: [{ scale: 1.12 }] }]}
              >
                <Text style={[styles.starIcon, active && styles.starIconActive]}>
                  {active ? '★' : '☆'}
                </Text>
              </Pressable>
            );
          })}
          {Number(value || 0) > 0 ? (
            <Text style={styles.ratingHintText}>{Number(value)} 星（再点可清零）</Text>
          ) : null}
        </View>
      ) : null}

      {field.type === 'checkbox' ? (
        <View style={styles.switchRow}>
          <Switch
            value={Boolean(value)}
            onValueChange={onChange}
            trackColor={{ false: Palette.borderStrong, true: accentColor }}
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
          <Pressable
            onPress={() => onPickImage(false)}
            style={({ pressed }) => [
              styles.pickImgBtn,
              { backgroundColor: accentSoft },
              pressed && { opacity: 0.78 },
            ]}
          >
            <Feather name="image" size={15} color={accentInk} />
            <Text style={[styles.pickImgText, { color: accentInk }]}>
              {value ? '相册更换' : '选照片'}
            </Text>
          </Pressable>
          {Platform.OS !== 'web' ? (
            <Pressable
              onPress={() => onPickImage(true)}
              style={({ pressed }) => [
                styles.pickImgBtn,
                { backgroundColor: Palette.bgSubtle },
                pressed && { opacity: 0.78 },
              ]}
            >
              <Feather name="camera" size={15} color={Palette.inkPrimary} />
              <Text style={[styles.pickImgText, { color: Palette.inkPrimary }]}>拍照</Text>
            </Pressable>
          ) : null}
          {value ? (
            <Pressable onPress={() => onChange('')} style={styles.clearImgBtn}>
              <Text style={styles.clearImgText}>移除</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {field.type === 'relation' ? (
        <View style={styles.relPickerWrap}>
          {relationCandidates.length > 6 ? (
            <View style={styles.relSearchBox}>
              <Feather name="search" size={13} color={Palette.inkMuted} />
              <TextInput
                value={relSearch}
                onChangeText={setRelSearch}
                placeholder="筛选关联记录..."
                placeholderTextColor={Palette.inkMuted}
                style={styles.relSearchInput}
              />
            </View>
          ) : null}
          <View style={styles.optionsWrap}>
            {filteredRelationCandidates.length === 0 ? (
              <Text style={styles.readonlyHint}>
                {relationCandidates.length === 0
                  ? `关联目标库 (${field.relationConfig?.targetLibrarySlug}) 暂无可选记录`
                  : '没有匹配的关联记录'}
              </Text>
            ) : (
              filteredRelationCandidates.map((cand) => {
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
                    style={[
                      styles.relOptionPill,
                      active && { backgroundColor: accentColor, borderColor: accentColor },
                    ]}
                  >
                    <Feather
                      name={active ? 'check-circle' : 'link'}
                      size={13}
                      color={active ? Palette.inkInverse : accentColor}
                    />
                    <Text style={[styles.optText, active && styles.optTextActive]} numberOfLines={1}>
                      {cand.title}
                    </Text>
                  </Pressable>
                );
              })
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 14,
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
  numInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    borderRadius: 12,
    paddingHorizontal: 14,
  },
  currencyPrefix: {
    fontSize: 16,
    fontWeight: '700',
    color: Palette.inkSecondary,
    marginRight: 6,
  },
  numInputInner: {
    flex: 1,
    paddingVertical: 11,
    fontSize: 15,
    color: Palette.inkPrimary,
  },
  unitSuffix: {
    fontSize: 13,
    fontWeight: '600',
    color: Palette.inkMuted,
    marginLeft: 6,
  },
  relPickerWrap: {
    gap: 8,
  },
  relSearchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  relSearchInput: {
    flex: 1,
    fontSize: 13,
    color: Palette.inkPrimary,
    paddingVertical: 0,
  },
  ratingHintText: {
    fontSize: 12,
    color: Palette.inkMuted,
    alignSelf: 'center',
    marginLeft: 4,
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
