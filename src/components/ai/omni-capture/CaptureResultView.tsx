import Feather from '@expo/vector-icons/Feather';
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { AssistantIntent } from '@/ai/agents';
import type { DraftEntryItem } from '@/ai/schemas';
import { Palette } from '@/constants/design-tokens';
import { useRepository } from '@/context/omni-context';
import type { LibraryRecord } from '@/db/models';
import type { FieldType } from '@/schema/field-defs';
import { IntentFallbackBar } from './IntentFallbackBar';

export interface CaptureResultViewProps {
  assistantNote?: string;
  drafts: DraftEntryItem[];
  libMap: Map<string, LibraryRecord>;
  loading: boolean;
  onUpdateField: (draftIdx: number, fieldKey: string, nextRaw: string, fieldType?: FieldType) => void;
  onRemoveDraft: (draftIdx: number) => void;
  onRetryAs: (intent: AssistantIntent) => void;
}

export function CaptureResultView({
  assistantNote,
  drafts,
  libMap,
  loading,
  onUpdateField,
  onRemoveDraft,
  onRetryAs,
}: CaptureResultViewProps) {
  const { repo } = useRepository();
  const [editingDraftKey, setEditingDraftKey] = useState<string | null>(null);

  // 一次性轻量批量查表解析关联目标标题，避免在渲染循环里逐条执行完整水合
  const relationTitleMap = useMemo(() => {
    if (!repo) return new Map<string, string>();
    const ids: string[] = [];
    for (const d of drafts) {
      const lib = libMap.get(d.librarySlug);
      if (!lib) continue;
      for (const [k, v] of Object.entries(d.data)) {
        const fDef = lib.fields.find((f) => f.key === k);
        if (fDef?.type !== 'relation' || !Array.isArray(v)) continue;
        for (const item of v) {
          const token = String(item);
          if (token && !token.startsWith('@prev:')) {
            ids.push(token);
          }
        }
      }
    }
    return repo.getEntryTitleMap(ids);
  }, [repo, drafts, libMap]);

  return (
    <View style={styles.resultSection}>
      {assistantNote ? <Text style={styles.assistantNote}>{assistantNote}</Text> : null}

      {drafts.map((d, idx) => {
        const draftLib = libMap.get(d.librarySlug);
        return (
          <View key={idx} style={styles.resultCard}>
            <View style={styles.draftHeader}>
              <Text style={styles.draftLibBadge}>
                {draftLib ? `${draftLib.icon} ${draftLib.name}` : d.librarySlug}
              </Text>
              <Pressable onPress={() => onRemoveDraft(idx)}>
                <Feather name="x" size={16} color={Palette.inkMuted} />
              </Pressable>
            </View>
            {d.reason ? <Text style={styles.draftReason}>{d.reason}</Text> : null}
            <View style={styles.draftFieldsGrid}>
              {Object.entries(d.data).map(([k, v]) => {
                const fDef = draftLib?.fields.find((f) => f.key === k);
                const formatDraftVal = (rawVal: unknown): string => {
                  if (Array.isArray(rawVal)) {
                    return rawVal
                      .map((item) => {
                        const token = String(item);
                        if (token.startsWith('@prev:')) {
                          const pIdx = Number(token.slice(6));
                          return `同批新建记录 #${pIdx + 1}`;
                        }
                        if (fDef?.type === 'relation') {
                          return relationTitleMap.get(token) ?? token;
                        }
                        return token;
                      })
                      .join('、');
                  }
                  return String(rawVal ?? '');
                };

                const fieldSig = `${idx}::${k}`;
                const isScalarEditable =
                  !Array.isArray(v) && typeof v !== 'boolean' && fDef?.type !== 'relation';
                const isEditingThis = editingDraftKey === fieldSig;

                return (
                  <View key={k} style={styles.draftKvRow}>
                    <Text style={styles.draftKey}>{fDef?.label ?? k}:</Text>
                    {isEditingThis ? (
                      <TextInput
                        value={String(v ?? '')}
                        autoFocus
                        onChangeText={(txt) => onUpdateField(idx, k, txt, fDef?.type)}
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
    gap: 4,
    marginTop: 2,
  },
  draftKvRow: {
    flexDirection: 'row',
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
  draftValEditable: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
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
