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
  parseBatchRefToken,
  type DanglingDraftRelation,
  type ManagedCaptureDraft,
} from '@/engine/capture-drafts';
import type { FieldType } from '@/schema/field-defs';
import { IntentFallbackBar } from './IntentFallbackBar';

const RELATION_CANDIDATE_PAGE_SIZE = 20;

export interface CaptureResultViewProps {
  assistantNote?: string;
  drafts: ManagedCaptureDraft[];
  libMap: Map<string, LibraryRecord>;
  existingEntrySummaryMap: Map<string, { title: string; librarySlug: string }>;
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
  existingEntrySummaryMap,
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
  const [relSearch, setRelSearch] = useState('');
  const [relLimit, setRelLimit] = useState(RELATION_CANDIDATE_PAGE_SIZE);

  const danglingByField = useMemo(() => {
    const map = new Map<string, DanglingDraftRelation>();
    for (const issue of danglingRelations) {
      map.set(`${issue.draftId}::${issue.fieldKey}`, issue);
    }
    return map;
  }, [danglingRelations]);

  const activePickerTargetSlug = useMemo(() => {
    if (!pickingRelationKey) return undefined;
    const [draftId, fieldKey] = pickingRelationKey.split('::');
    const draft = drafts.find((d) => d.draftId === draftId);
    const lib = draft ? libMap.get(draft.librarySlug) : undefined;
    const fDef = lib?.fields.find((f) => f.key === fieldKey);
    return fDef?.relationConfig?.targetLibrarySlug;
  }, [pickingRelationKey, drafts, libMap]);

  const candidatePage = useMemo(() => {
    if (!repo || !activePickerTargetSlug) {
      return { items: [] as Array<{ id: string; title: string }>, hasMore: false };
    }
    const fetched = repo.listRelationCandidates(activePickerTargetSlug, relSearch, relLimit + 1);
    return {
      items: fetched.slice(0, relLimit),
      hasMore: fetched.length > relLimit,
    };
  }, [repo, activePickerTargetSlug, relSearch, relLimit]);

  const toggleRelationPicker = (fieldSig: string) => {
    setPickingRelationKey((cur) => (cur === fieldSig ? null : fieldSig));
    setRelSearch('');
    setRelLimit(RELATION_CANDIDATE_PAGE_SIZE);
  };

  return (
    <View style={styles.resultSection}>
      {assistantNote ? <Text style={styles.assistantNote}>{assistantNote}</Text> : null}

      {danglingRelations.length > 0 ? (
        <View style={styles.danglingBanner}>
          <Feather name="alert-triangle" size={14} color={Palette.warning} />
          <Text style={styles.danglingBannerText}>
            有 {danglingRelations.length} 处关联无效或待补充，请先重新选择后再保存
          </Text>
        </View>
      ) : null}

      {drafts.map((d, idx) => {
        const draftLib = libMap.get(d.librarySlug);
        const priorDraftMap = new Map(drafts.slice(0, idx).map((p) => [p.draftId, p]));

        // 确保必填关联字段即便未出现在 draft.data 中也能展示并供用户选择
        const fieldEntries: Array<[string, unknown]> = Object.entries(d.data);
        if (draftLib) {
          const presentKeys = new Set(fieldEntries.map(([k]) => k));
          for (const f of draftLib.fields) {
            if (f.type === 'relation' && f.required && !presentKeys.has(f.key)) {
              fieldEntries.push([f.key, []]);
            }
          }
        }

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
              {fieldEntries.map(([k, v]) => {
                const fDef = draftLib?.fields.find((f) => f.key === k);
                const fieldSig = `${d.draftId}::${k}`;
                const dangling = danglingByField.get(fieldSig);
                const isRelationField = fDef?.type === 'relation' || Boolean(dangling);
                const targetLibSlug = fDef?.relationConfig?.targetLibrarySlug;
                const targetLibName = targetLibSlug ? libMap.get(targetLibSlug)?.name : undefined;

                const formatTokenLabel = (token: string): string => {
                  const parsed = parseBatchRefToken(token);
                  if (parsed?.kind === 'malformed') {
                    return '需重选（无效引用）';
                  }
                  if (parsed?.kind === 'draft') {
                    const targetDraft = priorDraftMap.get(parsed.draftId);
                    if (targetDraft) {
                      if (targetLibSlug && targetDraft.librarySlug !== targetLibSlug) {
                        return targetLibName
                          ? `需重选（需关联「${targetLibName}」）`
                          : '需重选（关联记录本不匹配）';
                      }
                      const targetLib = libMap.get(targetDraft.librarySlug);
                      return `同批新建：${getDraftDisplayTitle(targetDraft, targetLib)}`;
                    }
                    const removedTitle = removedDraftTitles[parsed.draftId];
                    return removedTitle
                      ? `需重选（原「${removedTitle}」已删）`
                      : '需重新选择关联';
                  }
                  if (parsed?.kind === 'prev') {
                    const targetDraft = parsed.index < idx ? drafts[parsed.index] : undefined;
                    if (targetDraft) {
                      if (targetLibSlug && targetDraft.librarySlug !== targetLibSlug) {
                        return targetLibName
                          ? `需重选（需关联「${targetLibName}」）`
                          : '需重选（关联记录本不匹配）';
                      }
                      const targetLib = libMap.get(targetDraft.librarySlug);
                      return `同批新建：${getDraftDisplayTitle(targetDraft, targetLib)}`;
                    }
                    return '需重新选择关联';
                  }
                  if (isRelationField) {
                    const summary = existingEntrySummaryMap.get(token);
                    if (!summary) return '需重选（记录不存在）';
                    if (targetLibSlug && summary.librarySlug !== targetLibSlug) {
                      return targetLibName
                        ? `需重选（需关联「${targetLibName}」）`
                        : '需重选（关联记录本不匹配）';
                    }
                    return summary.title;
                  }
                  return token;
                };

                const formatDraftVal = (rawVal: unknown): string => {
                  if (isRelationField) {
                    const tokens = extractRelationTokens(rawVal);
                    if (tokens.length === 0) {
                      return fDef?.required ? '请选择必填关联' : '未关联';
                    }
                    const joined = tokens.map(formatTokenLabel).join('、');
                    if (dangling?.reasons.includes('too_many_targets')) {
                      return `${joined}（仅支持单选，请重选）`;
                    }
                    return joined;
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
                const searchLower = relSearch.trim().toLowerCase();
                const compatibleDrafts = isPickingThis
                  ? getCompatiblePriorDrafts(drafts, d.draftId, targetLibSlug).filter((candDraft) => {
                      if (!searchLower) return true;
                      const title = getDraftDisplayTitle(candDraft, libMap.get(candDraft.librarySlug));
                      return title.toLowerCase().includes(searchLower);
                    })
                  : [];

                const handleSelectRelationToken = (token: string) => {
                  const allowMultiple = fDef?.relationConfig?.allowMultiple ?? true;
                  const cleanExisting = currentTokens.filter((t) => !invalidTokenSet.has(t));
                  if (!allowMultiple) {
                    onUpdateRelation(d.draftId, k, [token]);
                    setPickingRelationKey(null);
                    return;
                  }
                  if (cleanExisting.includes(token)) {
                    // 必填多选关联不允许取消勾选最后一个有效目标
                    if (fDef?.required && cleanExisting.length <= 1) {
                      return;
                    }
                    onUpdateRelation(
                      d.draftId,
                      k,
                      cleanExisting.filter((t) => t !== token)
                    );
                  } else {
                    onUpdateRelation(d.draftId, k, [...cleanExisting, token]);
                  }
                };

                const showSearchInput =
                  Boolean(activePickerTargetSlug) &&
                  (candidatePage.items.length > 6 || candidatePage.hasMore || Boolean(relSearch));
                const showClearBtn = !fDef?.required && currentTokens.length > 0;
                const hasPickerContent =
                  showSearchInput ||
                  compatibleDrafts.length > 0 ||
                  candidatePage.items.length > 0 ||
                  candidatePage.hasMore ||
                  showClearBtn;

                return (
                  <View key={k} style={styles.draftFieldBlock}>
                    <View style={styles.draftKvRow}>
                      <Text style={styles.draftKey}>{fDef?.label ?? k}:</Text>
                      {isRelationField ? (
                        <Pressable
                          onPress={() => toggleRelationPicker(fieldSig)}
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

                    {isRelationField && isPickingThis && hasPickerContent ? (
                      <View style={styles.relationPickerBox}>
                        {showSearchInput ? (
                          <View style={styles.relationSearchRow}>
                            <Feather name="search" size={13} color={Palette.inkMuted} />
                            <TextInput
                              value={relSearch}
                              onChangeText={(txt) => {
                                setRelSearch(txt);
                                setRelLimit(RELATION_CANDIDATE_PAGE_SIZE);
                              }}
                              placeholder="搜索可关联记录..."
                              placeholderTextColor={Palette.inkMuted}
                              style={styles.relationSearchInput}
                            />
                            {relSearch ? (
                              <Pressable
                                hitSlop={8}
                                onPress={() => {
                                  setRelSearch('');
                                  setRelLimit(RELATION_CANDIDATE_PAGE_SIZE);
                                }}
                              >
                                <Feather name="x-circle" size={14} color={Palette.inkMuted} />
                              </Pressable>
                            ) : null}
                          </View>
                        ) : null}

                        {compatibleDrafts.length > 0 || candidatePage.items.length > 0 ? (
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

                            {candidatePage.items.map((cand) => {
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
                          </View>
                        ) : null}

                        {candidatePage.hasMore || showClearBtn ? (
                          <View style={styles.relationPickerFooter}>
                            {candidatePage.hasMore ? (
                              <Pressable
                                onPress={() =>
                                  setRelLimit((n) => n + RELATION_CANDIDATE_PAGE_SIZE)
                                }
                                style={styles.loadMoreBtn}
                              >
                                <Text style={styles.loadMoreText}>显示更多</Text>
                              </Pressable>
                            ) : null}
                            {showClearBtn ? (
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
  relationSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Palette.bgCanvas,
    borderWidth: 1,
    borderColor: Palette.borderHairline,
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  relationSearchInput: {
    flex: 1,
    fontSize: 12,
    color: Palette.inkPrimary,
    paddingVertical: 0,
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
  relationPickerFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  loadMoreBtn: {
    paddingVertical: 2,
  },
  loadMoreText: {
    fontSize: 12,
    fontWeight: '700',
    color: Palette.brand,
  },
  clearRelBtn: {
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
