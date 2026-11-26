import type { DraftEntryItem } from '@/ai/schemas';
import type { LibraryRecord } from '@/db/models';
import { createId } from '@/engine/id';

export const PREV_REF_PREFIX = '@prev:';
export const DRAFT_REF_PREFIX = '@draft:';

export interface CommitDraftEntryItem extends DraftEntryItem {
  draftId?: string;
}

export interface ManagedCaptureDraft extends DraftEntryItem {
  draftId: string;
}

export interface DanglingDraftRelation {
  draftId: string;
  fieldKey: string;
  fieldLabel: string;
  targetLibrarySlug?: string;
  missingDraftIds: string[];
  invalidTokens: string[];
}

export function makeDraftRefToken(draftId: string): string {
  return `${DRAFT_REF_PREFIX}${draftId}`;
}

export function parseDraftRefId(token: string): string | null {
  if (!token.startsWith(DRAFT_REF_PREFIX)) return null;
  const id = token.slice(DRAFT_REF_PREFIX.length).trim();
  return id || null;
}

export function parsePrevRefIndex(token: string): number | null {
  if (!token.startsWith(PREV_REF_PREFIX)) return null;
  const raw = token.slice(PREV_REF_PREFIX.length).trim();
  if (!/^\d+$/.test(raw)) return null;
  const idx = Number(raw);
  return Number.isSafeInteger(idx) ? idx : null;
}

export function isBatchRefToken(token: string): boolean {
  return token.startsWith(DRAFT_REF_PREFIX) || token.startsWith(PREV_REF_PREFIX);
}

export function extractRelationTokens(rawVal: unknown): string[] {
  if (Array.isArray(rawVal)) {
    return rawVal.map((item) => String(item ?? '').trim()).filter(Boolean);
  }
  if (typeof rawVal === 'string' && rawVal.trim()) {
    return [rawVal.trim()];
  }
  return [];
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
 * 接收 AI 快记草稿后立刻分配稳定 draftId，并将所有位置耦合的 `@prev:<idx>` 转为 `@draft:<draftId>`。
 * 这样删除任意前置草稿后，后续草稿的关联绝不会因为数组左移而静默错绑到另一条草稿。
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

    const convertToken = (token: string): string => {
      const prevIdx = parsePrevRefIndex(token);
      if (prevIdx === null) return token;
      if (prevIdx >= 0 && prevIdx < currentIdx && assignedIds[prevIdx]) {
        return makeDraftRefToken(assignedIds[prevIdx]);
      }
      return makeDraftRefToken(`missing_prev_${prevIdx}`);
    };

    for (const [k, v] of Object.entries(nextData)) {
      const fDef = fieldByKey?.get(k);
      if (fDef && fDef.type !== 'relation') {
        continue;
      }

      if (Array.isArray(v)) {
        let changed = false;
        const mapped = v.map((item) => {
          if (typeof item === 'string' && item.startsWith(PREV_REF_PREFIX)) {
            changed = true;
            return convertToken(item);
          }
          return item;
        });
        if (changed) {
          nextData[k] = mapped;
        }
      } else if (typeof v === 'string' && v.startsWith(PREV_REF_PREFIX)) {
        nextData[k] = [convertToken(v)];
      } else if (typeof v === 'string' && v.startsWith(DRAFT_REF_PREFIX) && fDef?.type === 'relation') {
        nextData[k] = [v];
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
 * 扫描当前草稿批次中所有指向已删除或无效草稿的关联字段。
 */
export function findDanglingDraftRelations(
  drafts: readonly ManagedCaptureDraft[],
  libMap: ReadonlyMap<string, LibraryRecord>
): DanglingDraftRelation[] {
  const issues: DanglingDraftRelation[] = [];
  const priorIds = new Set<string>();

  for (let i = 0; i < drafts.length; i += 1) {
    const draft = drafts[i];
    const lib = libMap.get(draft.librarySlug);
    const fieldByKey = lib ? new Map(lib.fields.map((f) => [f.key, f])) : null;

    for (const [fieldKey, rawVal] of Object.entries(draft.data)) {
      const fDef = fieldByKey?.get(fieldKey);
      if (fDef && fDef.type !== 'relation') continue;

      const tokens = extractRelationTokens(rawVal);
      if (tokens.length === 0) continue;

      const missingDraftIds: string[] = [];
      const invalidTokens: string[] = [];

      for (const token of tokens) {
        const refDraftId = parseDraftRefId(token);
        if (refDraftId !== null) {
          if (!priorIds.has(refDraftId)) {
            missingDraftIds.push(refDraftId);
            invalidTokens.push(token);
          }
          continue;
        }
        const prevIdx = parsePrevRefIndex(token);
        if (prevIdx !== null) {
          if (prevIdx < 0 || prevIdx >= i) {
            invalidTokens.push(token);
          }
        }
      }

      if (invalidTokens.length > 0) {
        issues.push({
          draftId: draft.draftId,
          fieldKey,
          fieldLabel: fDef?.label ?? fieldKey,
          targetLibrarySlug: fDef?.relationConfig?.targetLibrarySlug,
          missingDraftIds,
          invalidTokens,
        });
      }
    }

    priorIds.add(draft.draftId);
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
 * 入库前解析单条草稿中的 `@draft:<draftId>`（优先）与兼容 `@prev:<idx>` 引用。
 * 遇到已删除或越界的草稿引用直接抛出明确异常，杜绝静默丢关联或错绑。
 */
export function resolveDraftDataForCommit(
  draft: CommitDraftEntryItem,
  lib: LibraryRecord | null,
  createdIds: readonly string[],
  createdIdByDraftId: ReadonlyMap<string, string>
): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...draft.data };
  const fieldByKey = lib ? new Map(lib.fields.map((f) => [f.key, f])) : null;

  const resolveSingleToken = (token: string, fieldLabel: string): string => {
    const refDraftId = parseDraftRefId(token);
    if (refDraftId !== null) {
      const targetId = createdIdByDraftId.get(refDraftId);
      if (!targetId) {
        throw new Error(`关联字段「${fieldLabel}」指向的草稿已被删除或尚未创建，请重新选择关联后再保存`);
      }
      return targetId;
    }

    const prevIdx = parsePrevRefIndex(token);
    if (prevIdx !== null) {
      const targetId = createdIds[prevIdx];
      if (!targetId) {
        throw new Error(`关联字段「${fieldLabel}」引用的草稿不存在，请重新选择关联后再保存`);
      }
      return targetId;
    }

    return token;
  };

  for (const [k, v] of Object.entries(resolved)) {
    const fDef = fieldByKey?.get(k);
    if (fDef && fDef.type !== 'relation') {
      continue;
    }
    const fieldLabel = fDef?.label ?? k;

    if (Array.isArray(v)) {
      resolved[k] = v
        .map((item) => {
          if (typeof item === 'string' && isBatchRefToken(item)) {
            return resolveSingleToken(item, fieldLabel);
          }
          return String(item);
        })
        .filter(Boolean);
    } else if (typeof v === 'string' && isBatchRefToken(v)) {
      resolved[k] = [resolveSingleToken(v, fieldLabel)];
    }
  }

  return resolved;
}
