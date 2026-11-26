import type { DraftEntryItem } from '@/ai/schemas';
import type { LibraryRecord } from '@/db/models';
import { createId } from '@/engine/id';
import { normalizeRelationValueList } from '@/schema/field-defs';

export const PREV_REF_PREFIX = '@prev:';
export const DRAFT_REF_PREFIX = '@draft:';

export interface CommitDraftEntryItem extends DraftEntryItem {
  draftId?: string;
}

export interface ManagedCaptureDraft extends DraftEntryItem {
  draftId: string;
}

export type RelationIssueReason =
  | 'malformed'
  | 'missing_draft'
  | 'library_mismatch'
  | 'missing_entry'
  | 'missing_required'
  | 'too_many_targets';

export interface DanglingDraftRelation {
  draftId: string;
  fieldKey: string;
  fieldLabel: string;
  targetLibrarySlug?: string;
  missingDraftIds: string[];
  invalidTokens: string[];
  reasons: RelationIssueReason[];
}

export type ParsedBatchRef =
  | { kind: 'draft'; draftId: string; raw: string }
  | { kind: 'prev'; index: number; raw: string }
  | { kind: 'malformed'; raw: string };

export interface PriorDraftTarget {
  draftId?: string;
  librarySlug: string;
  createdEntryId?: string;
}

export type RelationTokenResolution =
  | { ok: true; kind: 'entry'; entryId: string }
  | { ok: true; kind: 'batch'; target: PriorDraftTarget }
  | {
      ok: false;
      reason: Exclude<RelationIssueReason, 'missing_required' | 'too_many_targets'>;
      raw: string;
      missingDraftId?: string;
      actualLibrarySlug?: string;
      expectedLibrarySlug?: string;
    };

export function makeDraftRefToken(draftId: string): string {
  return `${DRAFT_REF_PREFIX}${draftId}`;
}

export function parseBatchRefToken(token: string): ParsedBatchRef | null {
  const trimmed = token.trim();
  if (trimmed.startsWith(DRAFT_REF_PREFIX)) {
    const id = trimmed.slice(DRAFT_REF_PREFIX.length).trim();
    if (!id) return { kind: 'malformed', raw: trimmed };
    return { kind: 'draft', draftId: id, raw: trimmed };
  }
  if (trimmed.startsWith(PREV_REF_PREFIX)) {
    const rawIdx = trimmed.slice(PREV_REF_PREFIX.length).trim();
    if (!/^\d+$/.test(rawIdx)) {
      return { kind: 'malformed', raw: trimmed };
    }
    const index = Number(rawIdx);
    if (!Number.isSafeInteger(index)) {
      return { kind: 'malformed', raw: trimmed };
    }
    return { kind: 'prev', index, raw: trimmed };
  }
  return null;
}

export function parseDraftRefId(token: string): string | null {
  const parsed = parseBatchRefToken(token);
  return parsed?.kind === 'draft' ? parsed.draftId : null;
}

export function parsePrevRefIndex(token: string): number | null {
  const parsed = parseBatchRefToken(token);
  return parsed?.kind === 'prev' ? parsed.index : null;
}

export function isBatchRefToken(token: string): boolean {
  const trimmed = token.trim();
  return trimmed.startsWith(DRAFT_REF_PREFIX) || trimmed.startsWith(PREV_REF_PREFIX);
}

/**
 * 与入库校验（`normalizeRelationValueList`）共用同一套拆分与裁剪规则。
 */
export function extractRelationTokens(rawVal: unknown): string[] {
  return normalizeRelationValueList(rawVal);
}

/**
 * 预览校验与入库解析共用的单条关联引用解析规则：
 * - 识别并拦截格式非法的 `@prev:x` / `@draft:` 引用；
 * - 校验同批草稿引用存在且位于当前草稿之前；
 * - 校验同批草稿与已有条目所属库与字段 `targetLibrarySlug` 一致。
 */
export function resolveRelationToken(
  token: string,
  context: {
    priorDrafts: readonly PriorDraftTarget[];
    expectedLibrarySlug?: string;
    existingEntryLibraryById?: ReadonlyMap<string, string>;
  }
): RelationTokenResolution {
  const { priorDrafts, expectedLibrarySlug, existingEntryLibraryById } = context;
  const trimmed = token.trim();
  const parsed = parseBatchRefToken(trimmed);

  if (!parsed) {
    if (existingEntryLibraryById) {
      const actualSlug = existingEntryLibraryById.get(trimmed);
      if (!actualSlug) {
        return {
          ok: false,
          reason: 'missing_entry',
          raw: trimmed,
          expectedLibrarySlug,
        };
      }
      if (expectedLibrarySlug && actualSlug !== expectedLibrarySlug) {
        return {
          ok: false,
          reason: 'library_mismatch',
          raw: trimmed,
          actualLibrarySlug: actualSlug,
          expectedLibrarySlug,
        };
      }
    }
    return { ok: true, kind: 'entry', entryId: trimmed };
  }

  if (parsed.kind === 'malformed') {
    return {
      ok: false,
      reason: 'malformed',
      raw: trimmed,
      expectedLibrarySlug,
    };
  }

  const target =
    parsed.kind === 'draft'
      ? priorDrafts.find((p) => p.draftId === parsed.draftId)
      : priorDrafts[parsed.index];

  if (!target) {
    return {
      ok: false,
      reason: 'missing_draft',
      raw: trimmed,
      missingDraftId: parsed.kind === 'draft' ? parsed.draftId : undefined,
      expectedLibrarySlug,
    };
  }

  if (expectedLibrarySlug && target.librarySlug !== expectedLibrarySlug) {
    return {
      ok: false,
      reason: 'library_mismatch',
      raw: trimmed,
      actualLibrarySlug: target.librarySlug,
      expectedLibrarySlug,
    };
  }

  return { ok: true, kind: 'batch', target };
}

/**
 * 计算单条快记草稿的人类可读标题，用于在跨草稿关联展示与删除提示中替代无意义的 #1 下标。
 */
export function getDraftDisplayTitle(draft: DraftEntryItem, lib?: LibraryRecord): string {
  const data = draft.data;
  const titleKey = lib?.views.card.titleFieldKey || lib?.fields[0]?.key || '';
  let rawTitle = titleKey ? data[titleKey] : undefined;

  if (rawTitle === undefined || rawTitle === null || String(rawTitle).trim() === '') {
    if (lib) {
      const fallbackField = lib.fields.find(
        (f) =>
          (f.type === 'text' || f.type === 'select' || f.type === 'date') &&
          data[f.key] !== undefined &&
          data[f.key] !== null &&
          String(data[f.key]).trim() !== ''
      );
      if (fallbackField) {
        rawTitle = data[fallbackField.key];
      }
    } else {
      for (const v of Object.values(data)) {
        if (typeof v === 'string' && v.trim() && !isBatchRefToken(v.trim())) {
          rawTitle = v;
          break;
        }
      }
    }
  }

  const firstLine =
    rawTitle !== undefined && rawTitle !== null
      ? String(rawTitle)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find(Boolean) ?? ''
      : '';
  if (firstLine) {
    return firstLine.length > 36 ? `${firstLine.slice(0, 36)}…` : firstLine;
  }
  return lib ? `${lib.name}草稿` : `${draft.librarySlug}草稿`;
}

/**
 * 接收 AI 快记草稿后：
 * 1. 先按统一规则规范化关联值（去空白、拆分逗号分隔字符串）；
 * 2. 为每条草稿分配稳定 draftId，并将位置耦合的 `@prev:<idx>`（含带空白的 `" @prev:0"`）按原始下标转为 `@draft:<draftId>`。
 */
export function normalizeCaptureDrafts(
  rawDrafts: readonly CommitDraftEntryItem[],
  libMap?: ReadonlyMap<string, LibraryRecord>
): ManagedCaptureDraft[] {
  const assignedIds = rawDrafts.map((d) => d.draftId?.trim() || createId('dft'));

  return rawDrafts.map((draft, currentIdx) => {
    const lib = libMap?.get(draft.librarySlug);
    const fieldByKey = lib ? new Map(lib.fields.map((f) => [f.key, f])) : null;
    const nextData: Record<string, unknown> = { ...draft.data };

    const convertToken = (rawToken: string): string => {
      const token = rawToken.trim();
      const parsed = parseBatchRefToken(token);
      if (!parsed || parsed.kind !== 'prev') return token;
      if (parsed.index >= 0 && parsed.index < currentIdx && assignedIds[parsed.index]) {
        return makeDraftRefToken(assignedIds[parsed.index]);
      }
      return makeDraftRefToken(`missing_prev_${parsed.index}`);
    };

    for (const [k, v] of Object.entries(nextData)) {
      const fDef = fieldByKey?.get(k);
      if (fDef && fDef.type !== 'relation') {
        continue;
      }

      if (fDef?.type === 'relation') {
        const tokens = extractRelationTokens(v);
        nextData[k] = tokens.map(convertToken);
        continue;
      }

      // 未匹配到库定义时，只要值里包含批次引用（如 " @prev:0"），也同样规范化转换
      const candidateTokens = extractRelationTokens(v);
      if (candidateTokens.some(isBatchRefToken)) {
        nextData[k] = candidateTokens.map(convertToken);
      }
    }

    return {
      ...draft,
      draftId: assignedIds[currentIdx],
      data: nextData,
    };
  });
}

/**
 * 按稳定 draftId 移除草稿，不改写其他草稿的关联引用，以便明确暴露出失效关联供用户重选。
 */
export function removeCaptureDraftById(
  drafts: readonly ManagedCaptureDraft[],
  targetDraftId: string,
  libMap?: ReadonlyMap<string, LibraryRecord>
): {
  nextDrafts: ManagedCaptureDraft[];
  removedDraft?: ManagedCaptureDraft;
  removedLabel?: string;
} {
  const removedDraft = drafts.find((d) => d.draftId === targetDraftId);
  if (!removedDraft) {
    return { nextDrafts: [...drafts] };
  }
  const removedLabel = getDraftDisplayTitle(removedDraft, libMap?.get(removedDraft.librarySlug));
  return {
    nextDrafts: drafts.filter((d) => d.draftId !== targetDraftId),
    removedDraft,
    removedLabel,
  };
}

/**
 * 收集草稿中全部非批次引用的已有记录 ID，供预览一次性批量查询标题与所属库。
 */
export function collectReferencedExistingEntryIds(
  drafts: readonly DraftEntryItem[],
  libMap: ReadonlyMap<string, LibraryRecord>
): string[] {
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
  return ids;
}

/**
 * 扫描当前草稿批次中所有失效、跨库、格式错误、超限（单选多值）或必填为空的关联字段（与入库共用同一解析规则）。
 */
export function findDanglingDraftRelations(
  drafts: readonly ManagedCaptureDraft[],
  libMap: ReadonlyMap<string, LibraryRecord>,
  options?: {
    existingEntryLibraryById?: ReadonlyMap<string, string>;
  }
): DanglingDraftRelation[] {
  const issues: DanglingDraftRelation[] = [];
  const priorDrafts: PriorDraftTarget[] = [];

  for (let i = 0; i < drafts.length; i += 1) {
    const draft = drafts[i];
    const lib = libMap.get(draft.librarySlug);
    const fieldByKey = lib ? new Map(lib.fields.map((f) => [f.key, f])) : null;
    const checkedKeys = new Set<string>();

    const inspectField = (fieldKey: string, rawVal: unknown) => {
      if (checkedKeys.has(fieldKey)) return;
      checkedKeys.add(fieldKey);

      const fDef = fieldByKey?.get(fieldKey);
      if (fDef && fDef.type !== 'relation') return;

      const tokens = Array.from(new Set(extractRelationTokens(rawVal)));
      const expectedLibrarySlug = fDef?.relationConfig?.targetLibrarySlug;

      const missingDraftIds: string[] = [];
      const invalidTokens: string[] = [];
      const reasonSet = new Set<RelationIssueReason>();
      let validCount = 0;

      for (const token of tokens) {
        const res = resolveRelationToken(token, {
          priorDrafts,
          expectedLibrarySlug,
          existingEntryLibraryById:
            fDef?.type === 'relation' ? options?.existingEntryLibraryById : undefined,
        });
        if (!res.ok) {
          invalidTokens.push(token);
          reasonSet.add(res.reason);
          if (res.missingDraftId) {
            missingDraftIds.push(res.missingDraftId);
          }
        } else {
          validCount += 1;
        }
      }

      if (fDef?.type === 'relation' && fDef.required && validCount === 0) {
        reasonSet.add('missing_required');
      }

      if (
        fDef?.type === 'relation' &&
        fDef.relationConfig?.allowMultiple === false &&
        tokens.length > 1
      ) {
        reasonSet.add('too_many_targets');
      }

      if (
        invalidTokens.length > 0 ||
        reasonSet.has('missing_required') ||
        reasonSet.has('too_many_targets')
      ) {
        issues.push({
          draftId: draft.draftId,
          fieldKey,
          fieldLabel: fDef?.label ?? fieldKey,
          targetLibrarySlug: expectedLibrarySlug,
          missingDraftIds,
          invalidTokens,
          reasons: Array.from(reasonSet),
        });
      }
    };

    for (const [fieldKey, rawVal] of Object.entries(draft.data)) {
      inspectField(fieldKey, rawVal);
    }

    if (lib) {
      for (const f of lib.fields) {
        if (f.type === 'relation' && f.required) {
          inspectField(f.key, draft.data[f.key]);
        }
      }
    }

    priorDrafts.push({
      draftId: draft.draftId,
      librarySlug: draft.librarySlug,
    });
  }

  return issues;
}

/**
 * 列出当前草稿之前仍存活、且属于目标关联库的同批草稿，供用户重选关联。
 */
export function getCompatiblePriorDrafts(
  drafts: readonly ManagedCaptureDraft[],
  currentDraftId: string,
  targetLibrarySlug?: string
): ManagedCaptureDraft[] {
  const currentIdx = drafts.findIndex((d) => d.draftId === currentDraftId);
  if (currentIdx <= 0) return [];
  const prior = drafts.slice(0, currentIdx);
  if (!targetLibrarySlug) return prior;
  return prior.filter((d) => d.librarySlug === targetLibrarySlug);
}

export function updateDraftRelationTokens(
  drafts: readonly ManagedCaptureDraft[],
  draftId: string,
  fieldKey: string,
  nextTokens: string[]
): ManagedCaptureDraft[] {
  return drafts.map((d) =>
    d.draftId === draftId
      ? {
          ...d,
          data: {
            ...d.data,
            [fieldKey]: nextTokens,
          },
        }
      : d
  );
}

/**
 * 入库前解析单条草稿中的关联引用（与预览校验共用 `extractRelationTokens` + `resolveRelationToken`）。
 * 遇到非法格式、已删除草稿、跨库引用或单选多值时直接抛出明确异常，由外层事务原子回滚。
 */
export function resolveDraftDataForCommit(
  draft: CommitDraftEntryItem,
  lib: LibraryRecord | null,
  priorTargets: readonly PriorDraftTarget[]
): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...draft.data };
  const fieldByKey = lib ? new Map(lib.fields.map((f) => [f.key, f])) : null;

  const resolveSingleToken = (
    token: string,
    fieldLabel: string,
    expectedLibrarySlug?: string
  ): string => {
    const res = resolveRelationToken(token, {
      priorDrafts: priorTargets,
      expectedLibrarySlug,
    });
    if (!res.ok) {
      if (res.reason === 'malformed') {
        throw new Error(`关联字段「${fieldLabel}」包含无效的草稿引用（${res.raw}），请重新选择后再保存`);
      }
      if (res.reason === 'library_mismatch') {
        throw new Error(
          `关联字段「${fieldLabel}」引用了不匹配的记录本草稿（${res.actualLibrarySlug}），请重新选择后再保存`
        );
      }
      throw new Error(`关联字段「${fieldLabel}」指向的草稿已被删除或尚未创建，请重新选择关联后再保存`);
    }
    if (res.kind === 'batch') {
      if (!res.target.createdEntryId) {
        throw new Error(`关联字段「${fieldLabel}」指向的草稿尚未创建，请重新选择关联后再保存`);
      }
      return res.target.createdEntryId;
    }
    return res.entryId;
  };

  for (const [k, v] of Object.entries(resolved)) {
    const fDef = fieldByKey?.get(k);
    if (fDef && fDef.type !== 'relation') {
      continue;
    }
    const fieldLabel = fDef?.label ?? k;
    const expectedSlug = fDef?.relationConfig?.targetLibrarySlug;

    const tokens = extractRelationTokens(v);
    if (fDef?.type === 'relation') {
      const nextIds = Array.from(
        new Set(
          tokens
            .map((tok) =>
              isBatchRefToken(tok) ? resolveSingleToken(tok, fieldLabel, expectedSlug) : tok
            )
            .filter(Boolean)
        )
      );
      if (fDef.relationConfig?.allowMultiple === false && nextIds.length > 1) {
        throw new Error(`关联字段「${fieldLabel}」仅支持关联 1 条记录`);
      }
      resolved[k] = nextIds;
    } else if (tokens.some(isBatchRefToken)) {
      resolved[k] = Array.from(
        new Set(
          tokens
            .map((tok) =>
              isBatchRefToken(tok) ? resolveSingleToken(tok, fieldLabel, expectedSlug) : tok
            )
            .filter(Boolean)
        )
      );
    }
  }

  return resolved;
}
