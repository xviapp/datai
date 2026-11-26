import { evaluateFormula, evaluateHighlightRules } from '@/engine/formula';
import { sortEntriesByCardConfigInPlace } from '@/engine/library-view-rules';
import type { CardViewConfig } from '@/schema/view-dsl';
import type {
  BackRelRow,
  ForwardRelRow,
  HydratedEntry,
  LibraryRecord,
  LinkedEntryRef,
  RawEntryRow,
} from './models';
import type { SyncSqlDriver } from './types';

const RELATION_QUERY_CHUNK_SIZE = 400;

/**
 * 批量查询一组条目的正向关联和反向引用，彻底消除列表页 N+1 SQL 查询
 */
export function loadRelationsBatch(
  driver: SyncSqlDriver,
  entryIds: string[]
): {
  forwardBySourceId: Map<string, ForwardRelRow[]>;
  backByTargetId: Map<string, BackRelRow[]>;
} {
  const forwardBySourceId = new Map<string, ForwardRelRow[]>();
  const backByTargetId = new Map<string, BackRelRow[]>();
  if (entryIds.length === 0) {
    return { forwardBySourceId, backByTargetId };
  }

  for (let i = 0; i < entryIds.length; i += RELATION_QUERY_CHUNK_SIZE) {
    const chunk = entryIds.slice(i, i + RELATION_QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');

    const forwardRows = driver.getAllSync<ForwardRelRow>(
      `SELECT
         r.source_entry_id,
         r.field_key,
         t.id AS target_id,
         t.title_summary AS target_title,
         t.library_id AS target_lib_id,
         t.data_json AS target_data_json
       FROM entry_relations r
       JOIN entries t ON t.id = r.target_entry_id
       WHERE r.source_entry_id IN (${placeholders})
       ORDER BY r.sort_order ASC`,
      chunk
    );

    for (const fr of forwardRows) {
      let list = forwardBySourceId.get(fr.source_entry_id);
      if (!list) {
        list = [];
        forwardBySourceId.set(fr.source_entry_id, list);
      }
      list.push(fr);
    }

    const backRows = driver.getAllSync<BackRelRow>(
      `SELECT
         r.target_entry_id,
         r.field_key,
         s.id AS source_id,
         s.title_summary AS source_title,
         s.library_id AS source_lib_id,
         s.data_json AS source_data_json
       FROM entry_relations r
       JOIN entries s ON s.id = r.source_entry_id
       WHERE r.target_entry_id IN (${placeholders})
       ORDER BY s.created_at DESC`,
      chunk
    );

    for (const br of backRows) {
      let list = backByTargetId.get(br.target_entry_id);
      if (!list) {
        list = [];
        backByTargetId.set(br.target_entry_id, list);
      }
      list.push(br);
    }
  }

  return { forwardBySourceId, backByTargetId };
}

/**
 * 水合单条原始记录：解析正向关联、反向引用、Rollup 跨表汇总、Formula 行内公式与条件高亮
 */
export function hydrateRowWithRelations(
  row: RawEntryRow,
  lib: LibraryRecord,
  allLibsById: Map<string, LibraryRecord>,
  allLibsBySlug: Map<string, LibraryRecord>,
  forwardRows: ForwardRelRow[],
  backRows: BackRelRow[],
  parsedJsonCache: Map<string, Record<string, unknown>>
): HydratedEntry {
  const parsePayload = (entryId: string, jsonStr: string): Record<string, unknown> => {
    const cached = parsedJsonCache.get(entryId);
    if (cached) return cached;
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    parsedJsonCache.set(entryId, parsed);
    return parsed;
  };

  const rawData = parsePayload(row.id, row.data_json);
  const computedData: Record<string, unknown> = { ...rawData };

  const forwardLinks: Record<string, LinkedEntryRef[]> = {};
  const forwardTargetPayloads: Record<string, Array<Record<string, unknown>>> = {};

  for (const fr of forwardRows) {
    const targetLib = allLibsById.get(fr.target_lib_id);
    if (!targetLib) continue;
    if (!forwardLinks[fr.field_key]) forwardLinks[fr.field_key] = [];
    if (!forwardTargetPayloads[fr.field_key]) forwardTargetPayloads[fr.field_key] = [];

    forwardLinks[fr.field_key].push({
      id: fr.target_id,
      title: fr.target_title,
      libraryId: targetLib.id,
      librarySlug: targetLib.slug,
      libraryName: targetLib.name,
      libraryIcon: targetLib.icon,
      fieldKey: fr.field_key,
    });
    forwardTargetPayloads[fr.field_key].push(parsePayload(fr.target_id, fr.target_data_json));
  }

  const backlinks: LinkedEntryRef[] = [];
  const reversePayloadsByKey: Record<string, Array<Record<string, unknown>>> = {};

  for (const br of backRows) {
    const srcLib = allLibsById.get(br.source_lib_id);
    if (!srcLib) continue;
    backlinks.push({
      id: br.source_id,
      title: br.source_title,
      libraryId: srcLib.id,
      librarySlug: srcLib.slug,
      libraryName: srcLib.name,
      libraryIcon: srcLib.icon,
      fieldKey: br.field_key,
    });
    const revKey = `reverse:${srcLib.slug}.${br.field_key}`;
    if (!reversePayloadsByKey[revKey]) reversePayloadsByKey[revKey] = [];
    reversePayloadsByKey[revKey].push(parsePayload(br.source_id, br.source_data_json));
  }

  // 计算 Rollup 汇总字段（支持正向 relationFieldKey 与反向 reverse:<slug>.<fieldKey>）
  for (const field of lib.fields) {
    if (field.type !== 'rollup' || !field.rollupConfig) continue;
    const { relationFieldKey, targetFieldKey, fn } = field.rollupConfig;

    let payloads: Array<Record<string, unknown>> = [];
    if (relationFieldKey.startsWith('reverse:')) {
      payloads = reversePayloadsByKey[relationFieldKey] ?? [];
    } else if (allLibsBySlug.has(relationFieldKey)) {
      const prefix = `reverse:${relationFieldKey}.`;
      for (const [rk, list] of Object.entries(reversePayloadsByKey)) {
        if (rk.startsWith(prefix)) payloads.push(...list);
      }
    } else {
      payloads = forwardTargetPayloads[relationFieldKey] ?? [];
    }

    if (fn === 'COUNT') {
      computedData[field.key] = payloads.length;
      continue;
    }

    const nums = payloads
      .map((p) => Number(p[targetFieldKey]))
      .filter((n) => Number.isFinite(n));

    if (nums.length === 0) {
      computedData[field.key] = 0;
    } else if (fn === 'SUM') {
      computedData[field.key] = Math.round(nums.reduce((a, b) => a + b, 0) * 100) / 100;
    } else if (fn === 'AVG') {
      computedData[field.key] =
        Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
    } else if (fn === 'MIN') {
      computedData[field.key] = Math.min(...nums);
    } else if (fn === 'MAX') {
      computedData[field.key] = Math.max(...nums);
    }
  }

  // 计算行内 Formula 字段（可引用基础字段与刚算出的 Rollup 字段）
  for (const field of lib.fields) {
    if (field.type !== 'formula' || !field.formulaExpr) continue;
    computedData[field.key] = evaluateFormula(field.formulaExpr, computedData);
  }

  // 计算条件高亮规则
  const highlight = evaluateHighlightRules(lib.views.card.highlightRules, computedData);

  return {
    id: row.id,
    libraryId: row.library_id,
    librarySlug: lib.slug,
    titleSummary: row.title_summary,
    rawData,
    computedData,
    forwardLinks,
    backlinks,
    highlight,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 统一的视图排序器：按 cardConfig.sortFieldKey / sortDir 对水合后的条目原地排序
 */
export function sortHydratedEntries(
  entries: HydratedEntry[],
  cardConfig: Pick<CardViewConfig, 'sortFieldKey' | 'sortDir'>
): HydratedEntry[] {
  return sortEntriesByCardConfigInPlace(entries, cardConfig);
}
