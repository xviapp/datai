import type { FieldDef } from '@/schema/field-defs';
import type { SyncSqlDriver } from './types';

function assertSafeIdentifier(ident: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(ident)) {
    throw new Error(`非法 SQL 标识符: ${ident}`);
  }
  return ident;
}

/**
 * 将自定义库动态编译为原生 SQLite 逻辑视图 v_<slug>
 * 优势：物理层无需 ALTER TABLE，同时 AI 和统计看板可直接编写干净的 SELECT ... FROM v_<slug>
 */
export function compileLibrarySqlView(
  driver: SyncSqlDriver,
  libraryId: string,
  slug: string,
  fields: FieldDef[]
): void {
  const safeSlug = assertSafeIdentifier(slug);
  const viewName = `v_${safeSlug}`;
  const escapedLibId = libraryId.replace(/'/g, "''");

  const selectCols: string[] = [
    `e.id AS _id`,
    `e.title_summary AS _title`,
    `datetime(e.created_at / 1000, 'unixepoch', 'localtime') AS _created_at`,
  ];

  for (const field of fields) {
    // 跳过运行时内存聚合/公式字段、多值关系数组以及图片字段，避免大体积路径/base64 暴露给 SQL 与 AI
    if (
      field.type === 'rollup' ||
      field.type === 'formula' ||
      field.type === 'relation' ||
      field.type === 'image'
    ) {
      continue;
    }
    const col = assertSafeIdentifier(field.key);
    const jsonPath = `$.${col}`;

    if (field.type === 'number' || field.type === 'currency' || field.type === 'rating') {
      selectCols.push(
        `CAST(COALESCE(json_extract(e.data_json, '${jsonPath}'), 0) AS REAL) AS ${col}`
      );
    } else if (field.type === 'checkbox') {
      selectCols.push(
        `CASE WHEN json_extract(e.data_json, '${jsonPath}') IN (1, 'true', true) THEN 1 ELSE 0 END AS ${col}`
      );
    } else {
      selectCols.push(
        `CAST(COALESCE(json_extract(e.data_json, '${jsonPath}'), '') AS TEXT) AS ${col}`
      );
    }
  }

  driver.execSync(`DROP VIEW IF EXISTS ${viewName};`);
  driver.execSync(
    `CREATE VIEW ${viewName} AS\nSELECT\n  ${selectCols.join(',\n  ')}\nFROM entries e\nWHERE e.library_id = '${escapedLibId}';`
  );
}

export function dropLibrarySqlView(driver: SyncSqlDriver, slug: string): void {
  if (/^[a-z][a-z0-9_]*$/.test(slug)) {
    driver.execSync(`DROP VIEW IF EXISTS v_${slug};`);
  }
}
