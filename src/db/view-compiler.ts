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
      selectCols.push(`CAST(COALESCE(json_extract(e.data_json, '${jsonPath}'), 0) AS REAL) AS ${col}`);
    } else if (field.type === 'checkbox') {
      selectCols.push(
        `CASE WHEN json_extract(e.data_json, '${jsonPath}') IN (1, 'true', true) THEN 1 ELSE 0 END AS ${col}`
      );
    } else {
      selectCols.push(`CAST(COALESCE(json_extract(e.data_json, '${jsonPath}'), '') AS TEXT) AS ${col}`);
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

export interface LibraryCatalogItem {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string;
  fields: FieldDef[];
  recentEntries?: Array<{ id: string; title: string }>;
}

/**
 * 为 deepseek-flash 生成极简、高信息密度的数据库视图与关联字典（利于命中前缀缓存）
 */
export function buildDatabaseCatalogPrompt(libraries: LibraryCatalogItem[]): string {
  if (libraries.length === 0) {
    return '当前本地数据库尚无自定义库。';
  }

  const lines: string[] = [
    '## 本地 SQLite 逻辑视图与表结构目录',
    '跨表引用关系存放在边表 `entry_relations(source_entry_id, target_entry_id, field_key)`，可与各视图的 `_id` 做 JOIN。',
    '',
  ];

  for (const lib of libraries) {
    lines.push(`### 库: ${lib.icon} ${lib.name} (slug: \`${lib.slug}\`, SQL视图: \`v_${lib.slug}\`)`);
    if (lib.description) {
      lines.push(`说明: ${lib.description}`);
    }
    lines.push('- 内置列: `_id` (TEXT 主键), `_title` (TEXT 主标题), `_created_at` (DATETIME)');
    for (const f of lib.fields) {
      let extra = '';
      if (f.unit) extra += ` [单位:${f.unit}]`;
      if (f.options?.length) extra += ` [可选值:${f.options.map((o) => o.value).join('/')}]`;
      if (f.relationConfig) {
        extra += ` [关联目标库:${f.relationConfig.targetLibrarySlug}, 通过 entry_relations.field_key='${f.key}' 连接]`;
      }
      if (f.rollupConfig) {
        extra += ` [Rollup:${f.rollupConfig.fn}(${f.rollupConfig.relationFieldKey}->${f.rollupConfig.targetFieldKey}), 不在SQL视图列中]`;
      }
      if (f.formulaExpr) {
        extra += ` [行内公式:${f.formulaExpr}, 不在SQL视图列中]`;
      }
      if (f.type === 'image') {
        extra += ' [图片字段, 不在SQL视图列中]';
      }
      lines.push(`- \`${f.key}\` (${f.type}, "${f.label}")${extra}`);
    }
    if (lib.recentEntries && lib.recentEntries.length > 0) {
      lines.push(
        `- 已有记录候选(供关联引用匹配 ID): ${lib.recentEntries
          .map((e) => `${e.title}=>${e.id}`)
          .join(' | ')}`
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}
