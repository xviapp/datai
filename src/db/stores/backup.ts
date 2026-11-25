import type { LibraryLayoutBundle } from '@/schema/view-dsl';
import type { FullBackupBundle } from '../models';
import { sqlReferencesLibraryView, type SyncSqlDriver } from '../types';
import { dropLibrarySqlView } from '../view-compiler';
import type { EntriesStore } from './entries-store';
import type { LibrariesStore } from './libraries-store';
import type { WidgetsStore } from './widgets-store';

export function exportBackupBundleFromDriver(driver: SyncSqlDriver): FullBackupBundle {
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    libraries: driver.getAllSync('SELECT * FROM libraries ORDER BY sort_order ASC'),
    libraryViews: driver.getAllSync(
      'SELECT * FROM library_views ORDER BY library_id ASC, sort_order ASC'
    ),
    libraryRelations: driver.getAllSync('SELECT * FROM library_relations ORDER BY created_at ASC'),
    entries: driver.getAllSync('SELECT * FROM entries ORDER BY created_at ASC'),
    relations: driver.getAllSync('SELECT * FROM entry_relations'),
    widgets: driver.getAllSync('SELECT * FROM dashboard_widgets ORDER BY sort_order ASC'),
  };
}

export function importBackupBundleInternal(
  driver: SyncSqlDriver,
  libraries: LibrariesStore,
  entries: EntriesStore,
  widgets: WidgetsStore,
  bundle: FullBackupBundle
): void {
  const oldLibs = driver.getAllSync<{ slug: string }>('SELECT slug FROM libraries');
  for (const l of oldLibs) {
    dropLibrarySqlView(driver, l.slug);
  }

  driver.execSync('DELETE FROM entry_relations;');
  driver.execSync('DELETE FROM entries;');
  driver.execSync('DELETE FROM library_views;');
  driver.execSync('DELETE FROM library_relations;');
  driver.execSync('DELETE FROM dashboard_widgets;');
  driver.execSync('DELETE FROM libraries;');

  for (const l of bundle.libraries) {
    libraries.insertRawLibrary(l);
  }

  if (bundle.libraryViews && bundle.libraryViews.length > 0) {
    for (const lv of bundle.libraryViews) {
      libraries.insertRawLibraryView(lv);
    }
  } else {
    // 兼容旧版 v1 备份：自动由 views_json 生成 library_views 行
    for (const l of bundle.libraries) {
      try {
        libraries.syncLibraryViewsFromBlueprint(
          String(l.id),
          JSON.parse(String(l.views_json)) as LibraryLayoutBundle,
          true
        );
      } catch {
        // ignore malformed legacy views_json
      }
    }
  }

  for (const e of bundle.entries) {
    entries.insertRawEntry(e);
  }

  for (const r of bundle.relations) {
    driver.runSync(
      `INSERT INTO entry_relations (id, source_entry_id, target_entry_id, source_library_id, field_key, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        String(r.id),
        String(r.source_entry_id),
        String(r.target_entry_id),
        String(r.source_library_id),
        String(r.field_key),
        Number(r.sort_order ?? 0),
      ]
    );
  }

  for (const w of bundle.widgets) {
    widgets.insertRawWidget(w);
  }

  // 兼容旧版 v1 备份时若没有自带 stats 视图，则根据导入的图表补齐
  if (!bundle.libraryViews || bundle.libraryViews.length === 0) {
    for (const l of bundle.libraries) {
      const slug = String(l.slug);
      const hasWidget = bundle.widgets.some(
        (w) =>
          w.library_slug === slug || sqlReferencesLibraryView(String(w.readonly_sql ?? ''), slug)
      );
      if (hasWidget) {
        libraries.ensureStatsViewForLibrary(slug);
      }
    }
  }

  libraries.syncAllLibraryRelations();
  libraries.ensureViewsCompiled();
}
