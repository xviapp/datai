import Feather from '@expo/vector-icons/Feather';
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { AssistantIntent } from '@/ai/agents';
import { Palette } from '@/constants/design-tokens';
import { useRepository } from '@/context/omni-context';
import type { LibraryRecord } from '@/db/models';
import {
  extractRelationTokens,
  getCompatiblePriorDrafts,
  getDraftDisplayTitle,
  isBatchRefToken,
  makeDraftRefToken,
  parseDraftRefId,
  parsePrevRefIndex,
  type DanglingDraftRelation,
  type ManagedCaptureDraft,
} from '@/engine/capture-drafts';
import type { FieldType } from '@/schema/field-defs';
import { IntentFallbackBar } from './IntentFallbackBar';

export interface CaptureResultViewProps {
  assistantNote?: string;
  drafts: ManagedCaptureDraft[];
  libMap: Map<string, LibraryRecord>;
  danglingRelations: DanglingDraftRelation[];
  removedDraftTitles: Record<string, string>;
  loading: boolean;
  onUpdateField: (draftId: string, fieldKey: string, nextRaw: string, fieldType?: FieldType) => void;
  onUpdateRelation: (draftId: string, fieldKey: string, nextTokens: string[]) => void;
  onRemoveDraft: (draftId: string) => void;
  onRetryAs: (intent: AssistantIntent) => void;
}

export function CaptureResultView({
  assistantNote,
  drafts,
  libMap,
  danglingRelations,
  removedDraftTitles,
  loading,
  onUpdateField,
  onUpdateRelation,
  onRemoveDraft,
  onRetryAs,
}: CaptureResultViewProps) {
  const { repo } = useRepository();
  const [editingDraftKey, setEditingDraftKey] = useState<string | null>(null);
  const [pickingRelationKey, setPickingRelationKey] = useState<string | null>(null);

  const danglingByField = useMemo(() => {
    const map = new Map<string, DanglingDraftRelation>();
    for (const issue of danglingRelations) {
      map.set(`${issue.draftId}::${issue.fieldKey}`, issue);
    }
    return map;
  }, [danglingRelations]);

  // 一次性轻量批量查表解析关联目标标题，避免在渲染循环里逐条执行完整水合
  const relationTitleMap = useMemo(() => {
    if (!repo) return new Map<string, string>();
    const ids: string[] = [];
    for (const d of drafts) {
      const lib = libMap.get(d.librarySlug);
      if (!lib) continue;
      for (const [k, v] of Object.entries(d.data)) {
        const fDef = lib.fields.find((f) => f.key === k);
        if (fDef?.type !== 'relation') continue;
        for (const token of extractRelationTokens(v)) {
          if (token && !isBatchRefToken(token)) {
            ids.push(token);
          }
        }
      }
    }
    return repo.getEntryTitleMap(ids);
  }, [repo, drafts, libMap]);

  const activePickerTargetSlug = useMemo(() => {
    if (!pickingRelationKey) return undefined;
    const [draftId, fieldKey] = pickingRelationKey.split('::');
    const draft = drafts.find((d) => d.draftId === draftId);
    const lib = draft ? libMap.get(draft.librarySlug) : undefined;
    const fDef = lib?.fields.find((f) => f.key === fieldKey);
    return fDef?.relationConfig?.targetLibrarySlug;
  }, [pickingRelationKey, drafts, libMap]);

  const relationCandidates = useMemo(() => {
    if (!repo || !activePickerTargetSlug) return [];
    return repo.listRelationCandidates(activePickerTargetSlug);
  }, [repo, activePickerTargetSlug]);

  return (
    <View style={styles.resultSection}>
      {assistantNote ? <Text style={styles.assistantNote}>{assistantNote}</Text> : null}

      {danglingRelations.length > 0 ? (
        <View style={styles.danglingBanner}>
          <Feather name="alert-triangle" size={14} color={Palette.warning} />
          <Text style={styles.danglingBannerText}>
            有 {danglingRelations.length} 处关联指向已移除的草稿，请重新选择关联或清除后再保存
          </Text>
        </View>
      ) : null}

      {drafts.map((d, idx) => {
        const draftLib = libMap.get(d.librarySlug);
        const priorDraftMap = new Map(drafts.slice(0, idx).map((p) => [p.draftId, p]));

        return (
          <View key={d.draftId} style={styles.resultCard}>
            <View style={styles.draftHeader}>
              <Text style={styles.draftLibBadge}>
                {draftLib ? `${draftLib.icon} ${draftLib.name}` : d.librarySlug}
              </Text>
              <Pressable
                onPress={() => {
                  setEditingDraftKey((cur) => (cur?.startsWith(`${d.draftId}::`) ? null : cur));
                  setPickingRelationKey((cur) => (cur?.startsWith(`${d.draftId}::`) ? null : cur));
                  onRemoveDraft(d.draftId);
                }}
                hitSlop={6}
              >
                <Feather name="x" size={16} color={Palette.inkMuted} />
              </Pressable>
            </View>
            {d.reason ? <Text style={styles.draftReason}>{d.reason}</Text> : null}
            <View style={styles.draftFieldsGrid}>
              {Object.entries(d.data).map(([k, v]) => {
                const fDef = draftLib?.fields.find((f) => f.key === k);
                const fieldSig = `${d.draftId}::${k}`;
                const dangling = danglingByField.get(fieldSig);
                const isRelationField = fDef?.type === 'relation' || Boolean(dangling);

                const formatTokenLabel = (token: string): string => {
                  const refDraftId = parseDraftRefId(token);
                  if (refDraftId !== null) {
                    const targetDraft = priorDraftMap.get(refDraftId);
                    if (targetDraft) {
                      const targetLib = libMap.get(targetDraft.librarySlug);
                      return `同批新建：${getDraftDisplayTitle(targetDraft, targetLib)}`;
                    }
                    const removedTitle = removedDraftTitles[refDraftId];
                    return removedTitle
                      ? `需重选（原「${removedTitle}」已删）`
                      : '需重新选择关联';
                  }
                  const prevIdx = parsePrevRefIndex(token);
                  if (prevIdx !== null) {
                    const targetDraft = prevIdx < idx ? drafts[prevIdx] : undefined;
                    if (targetDraft) {
                      const targetLib = libMap.get(targetDraft.librarySlug);
                      return `同批新建：${getDraftDisplayTitle(targetDraft, targetLib)}`;
                    }
                    return '需重新选择关联';
                  }
                  if (isRelationField) {
                    return relationTitleMap.get(token) ?? token;
                  }
                  return token;
                };

                const formatDraftVal = (rawVal: unknown): string => {
                  if (isRelationField) {
                    const tokens = extractRelationTokens(rawVal);
                    if (tokens.length === 0) return '未关联';
                    return tokens.map(formatTokenLabel).join('、');
                  }
                  if (Array.isArray(rawVal)) {
                    return rawVal.map((item) => formatTokenLabel(String(item))).join('、');
                  }
                  if (typeof rawVal === 'string' && isBatchRefToken(rawVal)) {
                    return formatTokenLabel(rawVal);
                  }
                  return String(rawVal ?? '');
                };

                const isScalarEditable =
                  !Array.isArray(v) && typeof v !== 'boolean' && !isRelationField;
                const isEditingThis = editingDraftKey === fieldSig;
                const isPickingThis = pickingRelationKey === fieldSig;

                const currentTokens = isRelationField ? extractRelationTokens(v) : [];
                const invalidTokenSet = new Set(dangling?.invalidTokens ?? []);
                const compatibleDrafts = isPickingThis
                  ? getCompatiblePriorDrafts(
                      drafts,
                      d.draftId,
                      fDef?.relationConfig?.targetLibrarySlug
                    )
                  : [];

                const handleSelectRelationToken = (token: string) => {
                  const allowMultiple = fDef?.relationConfig?.allowMultiple ?? true;
                  const cleanExisting = currentTokens.filter((t) => !invalidTokenSet.has(t));
                  if (!allowMultiple) {
                    onUpdateRelation(d.draftId, k, [token]);
                    setPickingRelationKey(null);
                    return;
                  }
                  const next = cleanExisting.includes(token)
                    ? cleanExisting.filter((t) => t !== token)
                    : [...cleanExisting, token];
                  onUpdateRelation(d.draftId, k, next);
                };

                return (
                  <View key={k} style={styles.draftFieldBlock}>
                    <View style={styles.draftKvRow}>
                      <Text style={styles.draftKey}>{fDef?.label ?? k}:</Text>
                      {isRelationField ? (
                        <Pressable
                          onPress={() =>
                            setPickingRelationKey((cur) => (cur === fieldSig ? null : fieldSig))
                          }
                          style={({ pressed }) => [
                            styles.relationValBtn,
                            dangling && styles.relationValBtnDangling,
                            pressed && { opacity: 0.72 },
                          ]}
                        >
                          <Text
                            style={[styles.draftVal, dangling && styles.draftValDangling]}
                            numberOfLines={3}
                          >
                            {formatDraftVal(v)}
                          </Text>
                          <View
                            style={[
                              styles.relationActionPill,
                              dangling && styles.relationActionPillDangling,
                            ]}
                          >
                            <Text
                              style={[
                                styles.relationActionText,
                                dangling && styles.relationActionTextDangling,
                              ]}
                            >
                              {isPickingThis ? '收起' : dangling ? '重选' : '修改'}
                            </Text>
                          </View>
                        </Pressable>
                      ) : isEditingThis ? (
                        <TextInput
                          value={String(v ?? '')}
                          autoFocus
                          onChangeText={(txt) => onUpdateField(d.draftId, k, txt, fDef?.type)}
                          onBlur={() => setEditingDraftKey(null)}
                          onSubmitEditing={() => setEditingDraftKey(null)}
                          keyboardType={
                            fDef?.type === 'number' || fDef?.type === 'currency'
                              ? 'decimal-pad'
                              : 'default'
                          }
                          style={styles.draftInlineInput}
                        />
                      ) : isScalarEditable ? (
                        <Pressable
                          onPress={() => setEditingDraftKey(fieldSig)}
                          style={({ pressed }) => [
                            styles.draftValEditable,
                            pressed && { opacity: 0.7 },
                          ]}
                        >
                          <Text style={styles.draftVal} numberOfLines={3}>
                            {formatDraftVal(v) || '点击填写'}
                          </Text>
                          <Feather name="edit-3" size={11} color={Palette.inkMuted} />
                        </Pressable>
                      ) : (
                        <Text style={styles.draftVal} numberOfLines={3}>
                          {formatDraftVal(v)}
                        </Text>
                      )}
                    </View>

                    {isRelationField && isPickingThis ? (
                      <View style={styles.relationPickerBox}>
                        <View style={styles.relationPickerChips}>
                          {compatibleDrafts.map((candDraft) => {
                            const token = makeDraftRefToken(candDraft.draftId);
                            const selected = currentTokens.includes(token);
                            const targetLib = libMap.get(candDraft.librarySlug);
                            return (
                              <Pressable
                                key={token}
                                onPress={() => handleSelectRelationToken(token)}
                                style={[
                                  styles.relationChip,
                                  selected && styles.relationChipSelected,
                                ]}
                              >
                                <Text
                                  style={[
                                    styles.relationChipText,
                                    selected && styles.relationChipTextSelected,
                                  ]}
                                  numberOfLines={1}
                                >
                                  同批新建 · {getDraftDisplayTitle(candDraft, targetLib)}
                                </Text>
                              </Pressable>
                            );
                          })}

                          {relationCandidates.slice(0, 20).map((cand) => {
                            const selected = currentTokens.includes(cand.id);
                            return (
                              <Pressable
                                key={cand.id}
                                onPress={() => handleSelectRelationToken(cand.id)}
                                style={[
                                  styles.relationChip,
                                  selected && styles.relationChipSelected,
                                ]}
                              >
                                <Text
                                  style={[
                                    styles.relationChipText,
                                    selected && styles.relationChipTextSelected,
                                  ]}
                                  numberOfLines={1}
                                >
                                  {cand.title}
                                </Text>
                              </Pressable>
                            );
                          })}

                          {compatibleDrafts.length === 0 && relationCandidates.length === 0 ? (
                            <Text style={styles.relationEmptyHint}>
                              目标记录本暂无可关联记录
                            </Text>
                          ) : null}
                        </View>

                        {!fDef?.required && currentTokens.length > 0 ? (
                          <Pressable
                            onPress={() => {
                              onUpdateRelation(d.draftId, k, []);
                              setPickingRelationKey(null);
                            }}
                            style={styles.clearRelBtn}
                          >
                            <Text style={styles.clearRelText}>暂不关联（清除）</Text>
                          </Pressable>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>
          </View>
        );
      })}

      <IntentFallbackBar currentIntent="capture" disabled={loading} onRetryAs={onRetryAs} />
    </View>
  );
}

const styles = StyleSheet.create({
  resultSection: {
    gap: 10,
  },
  assistantNote: {
    fontSize: 13,
    fontWeight: '600',
    color: Palette.brand,
  },
  danglingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Palette.warningSoft,
    borderWidth: 1,
    borderColor: Palette.warning,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  danglingBannerText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    color: Palette.warning,
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
  draftLibBadge: {
    fontSize: 14,
    fontWeight: '800',
    color: Palette.inkPrimary,
  },
  draftReason: {
    fontSize: 12,
    color: Palette.inkMuted,
  },
  draftFieldsGrid: {
    gap: 6,
    marginTop: 2,
  },
  draftFieldBlock: {
    gap: 6,
  },
  draftKvRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  draftKey: {
    fontSize: 13,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  draftVal: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    color: Palette.inkPrimary,
  },
  draftValDangling: {
    color: Palette.danger,
  },
  draftValEditable: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  relationValBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  relationValBtnDangling: {
    backgroundColor: Palette.dangerSoft,
    borderWidth: 1,
    borderColor: Palette.danger,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  relationActionPill: {
    backgroundColor: Palette.bgSubtle,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  relationActionPillDangling: {
    backgroundColor: Palette.danger,
  },
  relationActionText: {
    fontSize: 11,
    fontWeight: '700',
    color: Palette.inkSecondary,
  },
  relationActionTextDangling: {
    color: Palette.inkInverse,
  },
  relationPickerBox: {
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    borderRadius: 10,
    padding: 10,
    gap: 8,
  },
  relationPickerChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  relationChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    maxWidth: '100%',
  },
  relationChipSelected: {
    backgroundColor: Palette.brand,
    borderColor: Palette.brand,
  },
  relationChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkSecondary,
  },
  relationChipTextSelected: {
    color: Palette.inkInverse,
  },
  relationEmptyHint: {
    fontSize: 12,
    color: Palette.inkMuted,
  },
  clearRelBtn: {
    alignSelf: 'flex-start',
    paddingVertical: 2,
  },
  clearRelText: {
    fontSize: 12,
    fontWeight: '600',
    color: Palette.inkMuted,
  },
  draftInlineInput: {
    flex: 1,
    backgroundColor: Palette.bgSurface,
    borderWidth: 1,
    borderColor: Palette.brand,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 13,
    color: Palette.inkPrimary,
  },
});
