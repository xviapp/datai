import type { FieldDef } from '@/schema/field-defs';
import type { SyncSqlDriver } from './types';

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
