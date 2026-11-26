import { normalizeRelationValueList, type FieldDef } from '@/schema/field-defs';
import type { SyncSqlDriver } from './types';

/**
 * 线性时间 O(N + M) 合并按 sort_order 排序的关系行与现有 data_json 列表：
 * - 严格保持 existingTokens 相对顺序不变；
 * - 计算无前驱锚点时的目标桶位时扣除已在前面插入的缺失项数 insertedBefore，
 *   确保例如 [C, D] 合并 [(A, 0), (B, 1)] 准确得到 [A, B, C, D]。
 */
export function mergeOrderedRelationItems(
  existingTokens: readonly string[],
  relItems: ReadonlyArray<{ targetId: string; sortOrder: number }>
): string[] {
  const existing = Array.from(new Set(existingTokens));
  if (existing.length === 0) {
    return relItems.map((item) => item.targetId);
  }

  const existingPos = new Map<string, number>();
  existing.forEach((id, idx) => existingPos.set(id, idx));

  const missingCount = relItems.reduce(
    (acc, item) => (existingPos.has(item.targetId) ? acc : acc + 1),
    0
  );
  if (missingCount === 0) {
    return existing;
  }

  const len = relItems.length;
  const prefixMaxPos = new Array<number>(len).fill(-1);
  let runningMax = -1;
  for (let i = 0; i < len; i++) {
    prefixMaxPos[i] = runningMax;
    const pos = existingPos.get(relItems[i].targetId);
    if (pos !== undefined && pos > runningMax) {
      runningMax = pos;
    }
  }

  const suffixMinPos = new Array<number>(len).fill(Infinity);
  let runningMin = Infinity;
  for (let i = len - 1; i >= 0; i--) {
    suffixMinPos[i] = runningMin;
    const pos = existingPos.get(relItems[i].targetId);
    if (pos !== undefined && pos < runningMin) {
      runningMin = pos;
    }
  }

  const buckets: string[][] = Array.from({ length: existing.length + 1 }, () => []);
  let insertedBefore = 0;
  for (let i = 0; i < len; i++) {
    const { targetId, sortOrder } = relItems[i];
    if (existingPos.has(targetId)) continue;

    const adjustedOrder = Math.max(
      0,
      Math.min(Math.trunc(sortOrder) - insertedBefore, existing.length)
    );
    const hasPred = prefixMaxPos[i] !== -1;
    const hasSucc = suffixMinPos[i] !== Infinity;

    let bucket = adjustedOrder;
    if (hasPred && !hasSucc) {
      bucket = prefixMaxPos[i] + 1;
    } else if (!hasPred && hasSucc) {
      bucket = Math.min(adjustedOrder, suffixMinPos[i]);
    } else if (hasPred && hasSucc) {
      bucket = prefixMaxPos[i] < suffixMinPos[i] ? prefixMaxPos[i] + 1 : adjustedOrder;
    }
    buckets[bucket].push(targetId);
    insertedBefore++;
  }

  const out: string[] = [];
  for (let slot = 0; slot < existing.length; slot++) {
    for (const id of buckets[slot]) out.push(id);
    out.push(existing[slot]);
  }
  for (const id of buckets[existing.length]) out.push(id);
  return out;
}

/**
 * v4 -> v5 一次性迁移：将旧版本（如 9080eb3）中仍有效但缺失于 entries.data_json 的 entry_relations 行补回 data_json，
 * 消除升级后新增无关字段时重建索引清空旧关联的风险，且迁移后启动零开销。
 */
export function reconcileLegacyEntryRelationsV5(driver: SyncSqlDriver): void {
  const relRows = driver.getAllSync<{
    source_entry_id: string;
    target_entry_id: string;
    field_key: string;
    sort_order: number;
  }>(
    `SELECT source_entry_id, target_entry_id, field_key, sort_order
     FROM entry_relations
     ORDER BY source_entry_id ASC, field_key ASC, sort_order ASC`
  );
  if (relRows.length === 0) return;

  const libRows = driver.getAllSync<{ id: string; slug: string; fields_json: string }>(
    'SELECT id, slug, fields_json FROM libraries'
  );
  const libFieldsById = new Map<string, Map<string, FieldDef>>();
  const libIdBySlug = new Map<string, string>();
  for (const l of libRows) {
    libIdBySlug.set(l.slug, l.id);
    let fields: FieldDef[] = [];
    try {
      fields = JSON.parse(l.fields_json) as FieldDef[];
    } catch {
      fields = [];
    }
    libFieldsById.set(l.id, new Map(fields.map((f) => [f.key, f])));
  }

  const relsBySource = new Map<
    string,
    Map<string, Array<{ targetId: string; sortOrder: number }>>
  >();
  const targetIdSet = new Set<string>();
  for (const r of relRows) {
    if (!r.source_entry_id || !r.target_entry_id || !r.field_key) continue;
    let byField = relsBySource.get(r.source_entry_id);
    if (!byField) {
      byField = new Map();
      relsBySource.set(r.source_entry_id, byField);
    }
    let items = byField.get(r.field_key);
    if (!items) {
      items = [];
      byField.set(r.field_key, items);
    }
    if (!items.some((it) => it.targetId === r.target_entry_id)) {
      items.push({ targetId: r.target_entry_id, sortOrder: Number(r.sort_order ?? items.length) });
      targetIdSet.add(r.target_entry_id);
    }
  }

  const targetLibIdByEntryId = new Map<string, string>();
  const uniqueTargetIds = Array.from(targetIdSet);
  for (let i = 0; i < uniqueTargetIds.length; i += 400) {
    const chunk = uniqueTargetIds.slice(i, i + 400);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = driver.getAllSync<{ id: string; library_id: string }>(
      `SELECT id, library_id FROM entries WHERE id IN (${placeholders})`,
      chunk
    );
    for (const r of rows) {
      targetLibIdByEntryId.set(r.id, r.library_id);
    }
  }

  for (const [sourceEntryId, byField] of relsBySource.entries()) {
    const srcRow = driver.getFirstSync<{ id: string; library_id: string; data_json: string }>(
      'SELECT id, library_id, data_json FROM entries WHERE id = ?',
      [sourceEntryId]
    );
    if (!srcRow) continue;
    const fieldByKey = libFieldsById.get(srcRow.library_id);
    if (!fieldByKey) continue;

    let parsed: Record<string, unknown> | null = null;
    try {
      const raw = JSON.parse(srcRow.data_json);
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        parsed = raw as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }
    if (!parsed) continue;

    let dataChanged = false;
    for (const [fieldKey, relItems] of byField.entries()) {
      const fDef = fieldByKey.get(fieldKey);
      if (!fDef || fDef.type !== 'relation') continue;

      const targetSlug = fDef.relationConfig?.targetLibrarySlug;
      const expectedTargetLibId = targetSlug ? (libIdBySlug.get(targetSlug) ?? null) : null;
      if (targetSlug && !expectedTargetLibId) continue;

      const existingTokens = Array.from(new Set(normalizeRelationValueList(parsed[fieldKey])));
      const validRelItems = relItems.filter((it) => {
        const libId = targetLibIdByEntryId.get(it.targetId);
        if (!libId) return false;
        if (expectedTargetLibId && libId !== expectedTargetLibId) return false;
        return true;
      });
      if (validRelItems.length === 0) continue;

      if (fDef.relationConfig?.allowMultiple === false) {
        const hasValidExisting = existingTokens.some((id) => {
          const libId =
            targetLibIdByEntryId.get(id) ??
            driver.getFirstSync<{ library_id: string }>(
              'SELECT library_id FROM entries WHERE id = ?',
              [id]
            )?.library_id;
          if (!libId) return false;
          if (expectedTargetLibId && libId !== expectedTargetLibId) return false;
          return true;
        });
        if (!hasValidExisting) {
          parsed[fieldKey] = [validRelItems[0].targetId];
          dataChanged = true;
        }
        continue;
      }

      const merged = mergeOrderedRelationItems(existingTokens, validRelItems);
      if (
        merged.length !== existingTokens.length ||
        merged.some((id, idx) => id !== existingTokens[idx])
      ) {
        parsed[fieldKey] = merged;
        dataChanged = true;
      }
    }

    if (dataChanged) {
      driver.runSync('UPDATE entries SET data_json = ? WHERE id = ?', [
        JSON.stringify(parsed),
        srcRow.id,
      ]);
    }
  }
}

/**
 * 根据 libraries.fields_json 与 parent_slug 重建/回填表间关系表 library_relations
 */
export function rebuildLibraryRelationsTable(
  driver: SyncSqlDriver,
  options: { clearFirst: boolean } = { clearFirst: true }
): void {
  const now = Date.now();
  const libs = driver.getAllSync<{
    id: string;
    slug: string;
    parent_slug: string | null;
    fields_json: string;
  }>('SELECT id, slug, parent_slug, fields_json FROM libraries');

  const slugToId = new Map<string, string>();
  for (const lib of libs) {
    slugToId.set(lib.slug, lib.id);
  }

  if (options.clearFirst) {
    driver.execSync('DELETE FROM library_relations;');
  }

  for (const lib of libs) {
    let fields: FieldDef[] = [];
    try {
      fields = JSON.parse(lib.fields_json) as FieldDef[];
    } catch {
      fields = [];
    }

    for (const f of fields) {
      if (f.type !== 'relation' || !f.key || !f.relationConfig?.targetLibrarySlug) continue;
      const targetId = slugToId.get(f.relationConfig.targetLibrarySlug);
      if (!targetId) continue;
      const relationKind =
        lib.parent_slug && f.relationConfig.targetLibrarySlug === lib.parent_slug
          ? 'parent_child'
          : 'reference';
      const allowMultiple = f.relationConfig.allowMultiple === false ? 0 : 1;
      driver.runSync(
        `INSERT OR IGNORE INTO library_relations (id, source_library_id, target_library_id, field_key, relation_kind, allow_multiple, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          `lrel_${lib.id}_${f.key}`,
          lib.id,
          targetId,
          f.key,
          relationKind,
          allowMultiple,
          now,
        ]
      );
    }
  }
}
