import type { FullBackupBundle } from '../models';
import type { SyncSqlDriver } from '../types';
import { dropLibrarySqlView } from '../view-compiler';
import type { EntriesStore } from './entries-store';
import type { LibrariesStore } from './libraries-store';
import type { WidgetsStore } from './widgets-store';

export function exportBackupBundleFromDriver(driver: SyncSqlDriver): FullBackupBundle {
  return {
    version: 1,
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
  // 全量导入新备份时清空导入前的撤销历史，避免跨备份误操作
  driver.execSync('DELETE FROM ai_snapshots;');

  for (const l of bundle.libraries) {
    libraries.insertRawLibrary(l);
  }

  for (const lv of bundle.libraryViews) {
    libraries.insertRawLibraryView(lv);
  }

  for (const e of bundle.entries) {
    entries.insertRawEntry(e);
  }

  for (const w of bundle.widgets) {
    widgets.insertRawWidget(w);
  }

  libraries.syncAllLibraryRelations();
  libraries.ensureViewsCompiled();
  libraries.invalidateCache();

  // 按库字段定义由 entries.data_json 统一重建 entry_relations 索引，确保字段值与索引严格一致
  for (const lib of libraries.listLibraries()) {
    entries.syncLibraryEntryRelationsInternal(lib.id);
  }
}
