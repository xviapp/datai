import { createId } from '@/engine/id';
import type { AccentTone, DashboardWidget } from '@/schema/view-dsl';
import type { SavedDashboardWidget } from '../models';
import { sqlReferencesLibraryView, type SyncSqlDriver } from '../types';
import type { LibrariesStore } from './libraries-store';

interface RawWidgetRow {
  id: string;
  library_slug: string | null;
  title: string;
  subtitle: string | null;
  chart_type: DashboardWidget['chartType'];
  readonly_sql: string;
  x_key: string | null;
  y_key: string;
  unit_prefix: string | null;
  unit_suffix: string | null;
  accent_tone: AccentTone;
  pinned_overview: number;
  sort_order: number;
}

export class WidgetsStore {
  constructor(
    private driver: SyncSqlDriver,
    private libraries: LibrariesStore
  ) {}

  listDashboardWidgets(librarySlug?: string | null): DashboardWidget[] {
    const rows = librarySlug
      ? this.driver.getAllSync<RawWidgetRow>(
          'SELECT * FROM dashboard_widgets WHERE library_slug = ? ORDER BY sort_order ASC, created_at ASC',
          [librarySlug]
        )
      : this.driver.getAllSync<RawWidgetRow>(
          'SELECT * FROM dashboard_widgets WHERE library_slug IS NULL ORDER BY sort_order ASC, created_at ASC'
        );

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      subtitle: r.subtitle ?? undefined,
      chartType: r.chart_type,
      readonlySql: r.readonly_sql,
      xKey: r.x_key ?? undefined,
      yKey: r.y_key,
      unitPrefix: r.unit_prefix ?? undefined,
      unitSuffix: r.unit_suffix ?? undefined,
      accentTone: r.accent_tone,
    }));
  }

  listAllDashboardWidgets(): SavedDashboardWidget[] {
    const rows = this.driver.getAllSync<RawWidgetRow>(
      'SELECT * FROM dashboard_widgets ORDER BY sort_order ASC, created_at ASC'
    );

    return rows.map((r) => ({
      id: r.id,
      librarySlug: r.library_slug ?? null,
      title: r.title,
      subtitle: r.subtitle ?? undefined,
      chartType: r.chart_type,
      readonlySql: r.readonly_sql,
      xKey: r.x_key ?? undefined,
      yKey: r.y_key,
      unitPrefix: r.unit_prefix ?? undefined,
      unitSuffix: r.unit_suffix ?? undefined,
      accentTone: r.accent_tone,
      pinnedOverview: r.pinned_overview !== 0,
      sortOrder: Number(r.sort_order ?? 0),
    }));
  }

  listWidgetsForLibrary(slug: string): SavedDashboardWidget[] {
    const all = this.listAllDashboardWidgets();
    return all.filter(
      (w) => w.librarySlug === slug || sqlReferencesLibraryView(w.readonlySql, slug)
    );
  }

  saveDashboardWidgetInternal(
    w: DashboardWidget,
    librarySlug: string | null = null,
    sortOrder?: number,
    pinnedOverview = true
  ): { id: string; viewsChanged: boolean } {
    const id = w.id || createId('wdg');
    let order = sortOrder;
    if (order === undefined) {
      const maxRow = this.driver.getFirstSync<{ max_order: number | null }>(
        'SELECT MAX(sort_order) AS max_order FROM dashboard_widgets'
      );
      order = (maxRow?.max_order ?? -1) + 1;
    }
    this.driver.runSync(
      `INSERT OR REPLACE INTO dashboard_widgets
       (id, library_slug, title, subtitle, chart_type, readonly_sql, x_key, y_key, unit_prefix, unit_suffix, accent_tone, pinned_overview, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        librarySlug,
        w.title,
        w.subtitle ?? null,
        w.chartType,
        w.readonlySql,
        w.xKey ?? null,
        w.yKey,
        w.unitPrefix ?? null,
        w.unitSuffix ?? null,
        w.accentTone ?? 'teal',
        pinnedOverview ? 1 : 0,
        order,
        Date.now(),
      ]
    );
    // 图表落盘后，自动为相关记录本在 library_views 表中按需点亮「统计」视图
    let viewsChanged = false;
    const allLibSlugs = this.driver.getAllSync<{ slug: string }>('SELECT slug FROM libraries');
    for (const row of allLibSlugs) {
      if (row.slug === librarySlug || sqlReferencesLibraryView(w.readonlySql, row.slug)) {
        if (this.libraries.ensureStatsViewForLibrary(row.slug)) {
          viewsChanged = true;
        }
      }
    }
    return { id, viewsChanged };
  }

  setWidgetPinnedOverviewInternal(widgetId: string, pinned: boolean): void {
    this.driver.runSync('UPDATE dashboard_widgets SET pinned_overview = ? WHERE id = ?', [
      pinned ? 1 : 0,
      widgetId,
    ]);
  }

  moveDashboardWidgetInternal(
    widgetId: string,
    direction: 'up' | 'down',
    scopeIds: string[]
  ): boolean {
    const scopeIdx = scopeIds.indexOf(widgetId);
    if (scopeIdx < 0) return false;
    const neighborIdx = direction === 'up' ? scopeIdx - 1 : scopeIdx + 1;
    if (neighborIdx < 0 || neighborIdx >= scopeIds.length) return false;

    const neighborId = scopeIds[neighborIdx];
    const allIds = this.listAllDashboardWidgets().map((w) => w.id);
    const fromGlobal = allIds.indexOf(widgetId);
    const toGlobal = allIds.indexOf(neighborId);
    if (fromGlobal < 0 || toGlobal < 0) return false;

    const nextIds = [...allIds];
    nextIds.splice(fromGlobal, 1);
    const insertAt = nextIds.indexOf(neighborId);
    if (insertAt < 0) return false;
    nextIds.splice(direction === 'up' ? insertAt : insertAt + 1, 0, widgetId);

    this.driver.withTransactionSync(() => {
      nextIds.forEach((id, idx) => {
        this.driver.runSync('UPDATE dashboard_widgets SET sort_order = ? WHERE id = ?', [idx, id]);
      });
    });
    return true;
  }

  deleteDashboardWidgetInternal(widgetId: string): void {
    this.driver.runSync('DELETE FROM dashboard_widgets WHERE id = ?', [widgetId]);
  }

  insertRawWidget(w: Record<string, unknown>): void {
    this.driver.runSync(
      `INSERT OR REPLACE INTO dashboard_widgets (id, library_slug, title, subtitle, chart_type, readonly_sql, x_key, y_key, unit_prefix, unit_suffix, accent_tone, pinned_overview, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(w.id),
        w.library_slug ? String(w.library_slug) : null,
        String(w.title),
        w.subtitle ? String(w.subtitle) : null,
        String(w.chart_type),
        String(w.readonly_sql),
        w.x_key ? String(w.x_key) : null,
        String(w.y_key),
        w.unit_prefix ? String(w.unit_prefix) : null,
        w.unit_suffix ? String(w.unit_suffix) : null,
        String(w.accent_tone ?? 'teal'),
        w.pinned_overview === undefined ? 1 : Number(w.pinned_overview),
        Number(w.sort_order ?? 0),
        Number(w.created_at ?? Date.now()),
      ]
    );
  }
}
