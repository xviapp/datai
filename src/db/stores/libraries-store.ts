import { createId } from '@/engine/id';
import type { FieldDef } from '@/schema/field-defs';
import {
  DEFAULT_VIEW_LABELS,
  getDefaultViewLabel,
  type AccentTone,
  type CalendarViewConfig,
  type CardViewConfig,
  type GalleryViewConfig,
  type LibraryBlueprint,
  type LibraryLayoutBundle,
  type LibraryViewType,
} from '@/schema/view-dsl';
import type {
  LibraryRecord,
  LibraryRelationRecord,
  LibraryViewInput,
  LibraryViewRecord,
} from '../models';
import { rebuildLibraryRelationsTable } from '../relations-sync';
import type { SyncSqlDriver } from '../types';
import { compileLibrarySqlView } from '../view-compiler';

export interface LibrariesCacheSnapshot {
  list: LibraryRecord[];
  byId: Map<string, LibraryRecord>;
  bySlug: Map<string, LibraryRecord>;
}

export class LibrariesStore {
  private librariesCache: LibraryRecord[] | null = null;
  private librariesByIdCache: Map<string, LibraryRecord> | null = null;
  private librariesBySlugCache: Map<string, LibraryRecord> | null = null;

  constructor(private driver: SyncSqlDriver) {}

  invalidateCache(): void {
    this.librariesCache = null;
    this.librariesByIdCache = null;
    this.librariesBySlugCache = null;
  }

  ensureCache(): LibrariesCacheSnapshot {
    if (this.librariesCache && this.librariesByIdCache && this.librariesBySlugCache) {
      return {
        list: this.librariesCache,
        byId: this.librariesByIdCache,
        bySlug: this.librariesBySlugCache,
      };
    }

    const rows = this.driver.getAllSync<{
      id: string;
      slug: string;
      name: string;
      description: string;
      icon: string;
      color: AccentTone;
      parent_slug: string | null;
      show_on_home: number;
      fields_json: string;
      views_json: string;
      updated_at: number;
      entry_count: number;
    }>(`
      SELECT
        l.*,
        (SELECT COUNT(*) FROM entries e WHERE e.library_id = l.id) AS entry_count
      FROM libraries l
      ORDER BY l.sort_order ASC, l.created_at ASC
    `);

    const viewRows = this.driver.getAllSync<{
      id: string;
      library_id: string;
      name: string;
      view_type: LibraryViewType;
      config_json: string;
      sort_order: number;
      is_default: number;
      created_at: number;
      updated_at: number;
    }>(`
      SELECT id, library_id, name, view_type, config_json, sort_order, is_default, created_at, updated_at
      FROM library_views
      ORDER BY sort_order ASC, created_at ASC
    `);

    const viewsByLibId = new Map<string, LibraryViewRecord[]>();
    for (const vr of viewRows) {
      let cfg: Record<string, unknown> = {};
      try {
        cfg = JSON.parse(vr.config_json) as Record<string, unknown>;
      } catch {
        cfg = {};
      }
      const listForLib = viewsByLibId.get(vr.library_id) ?? [];
      listForLib.push({
        id: vr.id,
        libraryId: vr.library_id,
        name: vr.name,
        viewType: vr.view_type,
        config: cfg,
        sortOrder: vr.sort_order,
        isDefault: vr.is_default !== 0,
        createdAt: vr.created_at,
        updatedAt: vr.updated_at,
      });
      viewsByLibId.set(vr.library_id, listForLib);
    }

    const list: LibraryRecord[] = rows.map((r) => {
      const fields = JSON.parse(r.fields_json) as FieldDef[];
      const legacyBundle = JSON.parse(r.views_json) as LibraryLayoutBundle;
      const rawViewList = viewsByLibId.get(r.id) ?? [];
      const viewList: LibraryViewRecord[] =
        rawViewList.length > 0
          ? rawViewList
          : [
              {
                id: `vw_${r.id}_card`,
                libraryId: r.id,
                name: DEFAULT_VIEW_LABELS.card,
                viewType: 'card',
                config: (legacyBundle.card ?? {}) as unknown as Record<string, unknown>,
                sortOrder: 0,
                isDefault: true,
                createdAt: r.updated_at,
                updatedAt: r.updated_at,
              },
            ];

      const cardRow = viewList.find((v) => v.viewType === 'card');
      const galleryRow = viewList.find((v) => v.viewType === 'gallery');
      const calendarRow = viewList.find((v) => v.viewType === 'calendar');

      const mergedViews: LibraryLayoutBundle = {
        card: {
          ...legacyBundle.card,
          ...(cardRow?.config as Partial<CardViewConfig> | undefined),
        },
        gallery: galleryRow
          ? ({
              ...(legacyBundle.gallery ?? {
                titleFieldKey: legacyBundle.card.titleFieldKey || fields[0]?.key || '',
              }),
              ...(galleryRow.config as Partial<GalleryViewConfig>),
            } as GalleryViewConfig)
          : undefined,
        calendar: calendarRow
          ? ({
              ...(legacyBundle.calendar ?? {
                dateFieldKey: fields.find((f) => f.type === 'date')?.key || '',
                titleFieldKey: legacyBundle.card.titleFieldKey || fields[0]?.key || '',
              }),
              ...(calendarRow.config as Partial<CalendarViewConfig>),
            } as CalendarViewConfig)
          : undefined,
      };

      return {
        id: r.id,
        slug: r.slug,
        name: r.name,
        description: r.description,
        icon: r.icon,
        color: r.color,
        parentLibrarySlug: r.parent_slug || null,
        showOnHome: r.show_on_home !== 0,
        fields,
        viewList,
        views: mergedViews,
        entryCount: Number(r.entry_count ?? 0),
        updatedAt: r.updated_at,
      };
    });

    const byId = new Map<string, LibraryRecord>();
    const bySlug = new Map<string, LibraryRecord>();
    for (const lib of list) {
      byId.set(lib.id, lib);
      bySlug.set(lib.slug, lib);
    }

    this.librariesCache = list;
    this.librariesByIdCache = byId;
    this.librariesBySlugCache = bySlug;

    return { list, byId, bySlug };
  }

  ensureViewsCompiled(): void {
    const rows = this.driver.getAllSync<{
      id: string;
      slug: string;
      fields_json: string;
    }>('SELECT id, slug, fields_json FROM libraries');
    for (const r of rows) {
      try {
        const fields = JSON.parse(r.fields_json) as FieldDef[];
        compileLibrarySqlView(this.driver, r.id, r.slug, fields);
      } catch {
        // ignore corrupted custom view
      }
    }
  }

  listLibraries(): LibraryRecord[] {
    return this.ensureCache().list;
  }

  getLibraryBySlug(slug: string): LibraryRecord | null {
    return this.ensureCache().bySlug.get(slug) ?? null;
  }

  getLibraryById(id: string): LibraryRecord | null {
    return this.ensureCache().byId.get(id) ?? null;
  }

  listLibraryViews(librarySlug: string): LibraryViewRecord[] {
    return this.ensureCache().bySlug.get(librarySlug)?.viewList ?? [];
  }

  listLibraryRelations(librarySlug?: string): LibraryRelationRecord[] {
    const { byId, bySlug } = this.ensureCache();
    const targetLib = librarySlug ? bySlug.get(librarySlug) : undefined;
    if (librarySlug && !targetLib) return [];

    type RawRelRow = {
      id: string;
      source_library_id: string;
      target_library_id: string;
      field_key: string;
      relation_kind: 'parent_child' | 'reference';
      allow_multiple: number;
      created_at: number;
    };

    const rows = targetLib
      ? this.driver.getAllSync<RawRelRow>(
          `SELECT id, source_library_id, target_library_id, field_key, relation_kind, allow_multiple, created_at
           FROM library_relations
           WHERE source_library_id = ? OR target_library_id = ?
           ORDER BY created_at ASC`,
          [targetLib.id, targetLib.id]
        )
      : this.driver.getAllSync<RawRelRow>(
          `SELECT id, source_library_id, target_library_id, field_key, relation_kind, allow_multiple, created_at
           FROM library_relations
           ORDER BY created_at ASC`
        );

    const result: LibraryRelationRecord[] = [];
    for (const r of rows) {
      const src = byId.get(r.source_library_id);
      const tgt = byId.get(r.target_library_id);
      if (!src || !tgt) continue;
      result.push({
        id: r.id,
        sourceLibraryId: src.id,
        sourceLibrarySlug: src.slug,
        sourceLibraryName: src.name,
        sourceLibraryIcon: src.icon,
        targetLibraryId: tgt.id,
        targetLibrarySlug: tgt.slug,
        targetLibraryName: tgt.name,
        targetLibraryIcon: tgt.icon,
        fieldKey: r.field_key,
        relationKind: r.relation_kind === 'parent_child' ? 'parent_child' : 'reference',
        allowMultiple: r.allow_multiple !== 0,
        createdAt: r.created_at,
      });
    }
    return result;
  }

  listChildLibraries(parentSlug: string): LibraryRecord[] {
    const { list, bySlug, byId } = this.ensureCache();
    const parent = bySlug.get(parentSlug);
    if (!parent) return [];

    const relRows = this.driver.getAllSync<{ source_library_id: string }>(
      `SELECT source_library_id FROM library_relations
       WHERE target_library_id = ? AND relation_kind = 'parent_child'`,
      [parent.id]
    );
    if (relRows.length > 0) {
      const idSet = new Set(relRows.map((r) => r.source_library_id));
      const matched = list.filter((l) => idSet.has(l.id) || l.parentLibrarySlug === parentSlug);
      if (matched.length > 0) return matched;
      return relRows.map((r) => byId.get(r.source_library_id)).filter(Boolean) as LibraryRecord[];
    }
    return list.filter((l) => l.parentLibrarySlug === parentSlug);
  }

  syncAllLibraryRelations(): void {
    rebuildLibraryRelationsTable(this.driver, { clearFirst: true });
  }

  buildDefaultConfigForViewType(
    lib: LibraryRecord,
    viewType: LibraryViewType
  ): Record<string, unknown> {
    const titleKey = lib.views.card.titleFieldKey || lib.fields[0]?.key || '';
    if (viewType === 'card') {
      return lib.views.card as unknown as Record<string, unknown>;
    }
    if (viewType === 'gallery') {
      return {
        titleFieldKey: titleKey,
        subtitleFieldKey: lib.views.card.subtitleFieldKey,
        coverImageFieldKey:
          lib.views.card.coverImageFieldKey || lib.fields.find((f) => f.type === 'image')?.key,
        badgeFieldKey: lib.views.card.rightBadgeFieldKey,
        ratingFieldKey: lib.fields.find((f) => f.type === 'rating')?.key,
      };
    }
    if (viewType === 'calendar') {
      return {
        dateFieldKey: lib.fields.find((f) => f.type === 'date')?.key || '',
        titleFieldKey: titleKey,
        metricFieldKey: lib.views.card.footerMetricKeys[0],
        tagFieldKey: lib.views.card.rightBadgeFieldKey,
      };
    }
    return {};
  }

  syncLibraryViewsFromBlueprint(
    libId: string,
    viewsBundle: LibraryLayoutBundle,
    isNewLibrary: boolean,
    explicitViewList?: LibraryViewInput[] | LibraryBlueprint['viewList'],
    fieldsForDefaults?: FieldDef[]
  ): void {
    const now = Date.now();
    const existingRows = this.driver.getAllSync<{
      id: string;
      view_type: LibraryViewType;
      config_json: string;
      sort_order: number;
      created_at: number;
    }>(
      'SELECT id, view_type, config_json, sort_order, created_at FROM library_views WHERE library_id = ? ORDER BY sort_order ASC',
      [libId]
    );

    const existingById = new Map(existingRows.map((r) => [r.id, r]));
    const existingByType = new Map<
      LibraryViewType,
      { id: string; config_json: string; sort_order: number; created_at: number }
    >();
    for (const r of existingRows) {
      if (!existingByType.has(r.view_type)) {
        existingByType.set(r.view_type, r);
      }
    }

    // 若显式提供了有序 viewList（来自 AI 建筑师或手动编辑器），精准按该列表重建 library_views
    if (explicitViewList && explicitViewList.length > 0) {
      const titleKey = viewsBundle.card?.titleFieldKey || fieldsForDefaults?.[0]?.key || '';
      const fallbackImgKey =
        viewsBundle.card?.coverImageFieldKey ||
        fieldsForDefaults?.find((f) => f.type === 'image')?.key;
      const fallbackDateKey = fieldsForDefaults?.find((f) => f.type === 'date')?.key || '';
      const fallbackRatingKey = fieldsForDefaults?.find((f) => f.type === 'rating')?.key;

      const resolvedGallery: GalleryViewConfig = viewsBundle.gallery ?? {
        titleFieldKey: titleKey,
        subtitleFieldKey: viewsBundle.card?.subtitleFieldKey,
        coverImageFieldKey: fallbackImgKey,
        badgeFieldKey: viewsBundle.card?.rightBadgeFieldKey,
        ratingFieldKey: fallbackRatingKey,
      };
      const resolvedCalendar: CalendarViewConfig = viewsBundle.calendar ?? {
        dateFieldKey: fallbackDateKey,
        titleFieldKey: titleKey,
        metricFieldKey: viewsBundle.card?.footerMetricKeys?.[0],
        tagFieldKey: viewsBundle.card?.rightBadgeFieldKey,
      };

      const usedIds = new Set<string>();
      this.driver.runSync('DELETE FROM library_views WHERE library_id = ?', [libId]);

      const resolvedConfigs = new Map<LibraryViewType, Record<string, unknown>>();

      explicitViewList.forEach((rawItem, idx) => {
        const item = rawItem as LibraryViewInput;
        const matchedById = item.id ? existingById.get(item.id) : undefined;
        const matchedByType = existingByType.get(item.viewType);
        const prev = matchedById ?? matchedByType;
        const reuseId = prev && !usedIds.has(prev.id) ? prev.id : createId('vw');
        usedIds.add(reuseId);

        const defaultCfg =
          item.viewType === 'card'
            ? ((viewsBundle.card ?? {}) as unknown as Record<string, unknown>)
            : item.viewType === 'gallery'
              ? (resolvedGallery as unknown as Record<string, unknown>)
              : item.viewType === 'calendar'
                ? (resolvedCalendar as unknown as Record<string, unknown>)
                : {};
        const cfg = item.config ?? defaultCfg;
        if (!resolvedConfigs.has(item.viewType)) {
          resolvedConfigs.set(item.viewType, cfg);
        }

        this.driver.runSync(
          `INSERT INTO library_views (id, library_id, name, view_type, config_json, sort_order, is_default, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            reuseId,
            libId,
            item.name.trim() || getDefaultViewLabel(item.viewType),
            item.viewType,
            JSON.stringify(cfg),
            idx,
            idx === 0 ? 1 : 0,
            prev?.created_at ?? now,
            now,
          ]
        );
      });

      const hasGallery = explicitViewList.some((v) => v.viewType === 'gallery');
      const hasCalendar = explicitViewList.some((v) => v.viewType === 'calendar');
      const syncedBundle: LibraryLayoutBundle = {
        card: (resolvedConfigs.get('card') as unknown as CardViewConfig) ?? viewsBundle.card,
        gallery: hasGallery
          ? ((resolvedConfigs.get('gallery') as unknown as GalleryViewConfig) ?? resolvedGallery)
          : undefined,
        calendar: hasCalendar
          ? ((resolvedConfigs.get('calendar') as unknown as CalendarViewConfig) ?? resolvedCalendar)
          : undefined,
      };
      this.driver.runSync('UPDATE libraries SET views_json = ?, updated_at = ? WHERE id = ?', [
        JSON.stringify(syncedBundle),
        now,
        libId,
      ]);
      return;
    }

    let nextOrder =
      existingRows.length > 0 ? Math.max(...existingRows.map((r) => r.sort_order)) + 1 : 0;

    // 1. 主列表视图始终存在，更新其配置
    const cardRow = existingByType.get('card');
    if (cardRow) {
      this.driver.runSync(
        'UPDATE library_views SET config_json = ?, updated_at = ? WHERE id = ?',
        [JSON.stringify(viewsBundle.card ?? {}), now, cardRow.id]
      );
    } else {
      this.driver.runSync(
        `INSERT INTO library_views (id, library_id, name, view_type, config_json, sort_order, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          createId('vw'),
          libId,
          DEFAULT_VIEW_LABELS.card,
          'card',
          JSON.stringify(viewsBundle.card ?? {}),
          isNewLibrary ? 0 : nextOrder++,
          1,
          now,
          now,
        ]
      );
      if (isNewLibrary) nextOrder = 1;
    }

    // 2. 画廊视图（仅在蓝图配置时创建/更新）
    if (viewsBundle.gallery) {
      const galRow = existingByType.get('gallery');
      if (galRow) {
        this.driver.runSync(
          'UPDATE library_views SET config_json = ?, updated_at = ? WHERE id = ?',
          [JSON.stringify(viewsBundle.gallery), now, galRow.id]
        );
      } else {
        this.driver.runSync(
          `INSERT INTO library_views (id, library_id, name, view_type, config_json, sort_order, is_default, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            createId('vw'),
            libId,
            DEFAULT_VIEW_LABELS.gallery,
            'gallery',
            JSON.stringify(viewsBundle.gallery),
            nextOrder++,
            0,
            now,
            now,
          ]
        );
      }
    }

    // 3. 日历视图（仅在蓝图配置时创建/更新）
    if (viewsBundle.calendar) {
      const calRow = existingByType.get('calendar');
      if (calRow) {
        this.driver.runSync(
          'UPDATE library_views SET config_json = ?, updated_at = ? WHERE id = ?',
          [JSON.stringify(viewsBundle.calendar), now, calRow.id]
        );
      } else {
        this.driver.runSync(
          `INSERT INTO library_views (id, library_id, name, view_type, config_json, sort_order, is_default, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            createId('vw'),
            libId,
            DEFAULT_VIEW_LABELS.calendar,
            'calendar',
            JSON.stringify(viewsBundle.calendar),
            nextOrder++,
            0,
            now,
            now,
          ]
        );
      }
    }
  }

  ensureStatsViewForLibrary(libSlug: string): void {
    const libRow = this.driver.getFirstSync<{ id: string }>(
      'SELECT id FROM libraries WHERE slug = ?',
      [libSlug]
    );
    if (!libRow) return;
    const existing = this.driver.getFirstSync<{ id: string }>(
      "SELECT id FROM library_views WHERE library_id = ? AND view_type = 'stats'",
      [libRow.id]
    );
    if (existing) return;

    const maxRow = this.driver.getFirstSync<{ max_order: number | null }>(
      'SELECT MAX(sort_order) AS max_order FROM library_views WHERE library_id = ?',
      [libRow.id]
    );
    const now = Date.now();
    this.driver.runSync(
      `INSERT INTO library_views (id, library_id, name, view_type, config_json, sort_order, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createId('vw'),
        libRow.id,
        DEFAULT_VIEW_LABELS.stats,
        'stats',
        '{}',
        (maxRow?.max_order ?? -1) + 1,
        0,
        now,
        now,
      ]
    );
  }

  saveLibraryViewsInternal(librarySlug: string, nextViews: LibraryViewInput[]): void {
    const lib = this.getLibraryBySlug(librarySlug);
    if (!lib) throw new Error(`记录本不存在: ${librarySlug}`);
    if (nextViews.length === 0) {
      throw new Error('每个记录本至少需要保留 1 个视图');
    }

    const now = Date.now();
    const existingById = new Map(lib.viewList.map((v) => [v.id, v]));
    const existingByType = new Map(lib.viewList.map((v) => [v.viewType, v]));

    this.driver.runSync('DELETE FROM library_views WHERE library_id = ?', [lib.id]);

    const resolvedConfigs = new Map<LibraryViewType, Record<string, unknown>>();
    nextViews.forEach((v, idx) => {
      const prev = (v.id ? existingById.get(v.id) : undefined) ?? existingByType.get(v.viewType);
      const cfg = v.config ?? prev?.config ?? this.buildDefaultConfigForViewType(lib, v.viewType);
      if (!resolvedConfigs.has(v.viewType)) {
        resolvedConfigs.set(v.viewType, cfg);
      }
      const id = v.id && existingById.has(v.id) ? v.id : createId('vw');
      this.driver.runSync(
        `INSERT INTO library_views (id, library_id, name, view_type, config_json, sort_order, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          lib.id,
          v.name.trim() || getDefaultViewLabel(v.viewType),
          v.viewType,
          JSON.stringify(cfg),
          idx,
          idx === 0 ? 1 : 0,
          prev?.createdAt ?? now,
          now,
        ]
      );
    });

    const syncedBundle: LibraryLayoutBundle = {
      card: (resolvedConfigs.get('card') as unknown as CardViewConfig) ?? lib.views.card,
      gallery: resolvedConfigs.has('gallery')
        ? (resolvedConfigs.get('gallery') as unknown as GalleryViewConfig)
        : undefined,
      calendar: resolvedConfigs.has('calendar')
        ? (resolvedConfigs.get('calendar') as unknown as CalendarViewConfig)
        : undefined,
    };
    this.driver.runSync('UPDATE libraries SET views_json = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(syncedBundle),
      now,
      lib.id,
    ]);
    this.invalidateCache();
  }

  upsertLibraryInternal(
    bp: LibraryBlueprint,
    options?: {
      sortOrder?: number;
      skipRelationSync?: boolean;
      viewInputs?: LibraryViewInput[];
    }
  ): string {
    const now = Date.now();
    const existing = this.driver.getFirstSync<{
      id: string;
      sort_order: number;
      parent_slug: string | null;
      show_on_home: number;
    }>('SELECT id, sort_order, parent_slug, show_on_home FROM libraries WHERE slug = ?', [bp.slug]);

    const id = existing ? existing.id : createId('lib');
    let order = options?.sortOrder ?? existing?.sort_order;
    if (order === undefined) {
      const maxRow = this.driver.getFirstSync<{ max_order: number | null }>(
        'SELECT MAX(sort_order) AS max_order FROM libraries'
      );
      order = (maxRow?.max_order ?? -1) + 1;
    }

    const parentSlug =
      bp.parentLibrarySlug && bp.parentLibrarySlug !== bp.slug ? bp.parentLibrarySlug : null;

    let normalizedFields = bp.fields;
    if (
      parentSlug &&
      !bp.fields.some(
        (f) => f.type === 'relation' && f.relationConfig?.targetLibrarySlug === parentSlug
      )
    ) {
      const baseKey = `parent_${parentSlug}`.replace(/[^a-z0-9_]/g, '_');
      const usedKeys = new Set(bp.fields.map((f) => f.key));
      const relKey = usedKeys.has(baseKey) ? `${baseKey}_ref` : baseKey;
      normalizedFields = [
        {
          key: relKey,
          label: '关联主记录',
          type: 'relation',
          required: false,
          relationConfig: {
            targetLibrarySlug: parentSlug,
            allowMultiple: false,
          },
        },
        ...bp.fields,
      ];
    }

    const showOnHome =
      bp.showOnHome !== undefined
        ? bp.showOnHome
          ? 1
          : 0
        : existing
          ? parentSlug && !existing.parent_slug
            ? 0
            : Number(existing.show_on_home ?? 1)
          : parentSlug
            ? 0
            : 1;

    if (existing) {
      this.driver.runSync(
        `UPDATE libraries
         SET name = ?, description = ?, icon = ?, color = ?, parent_slug = ?, show_on_home = ?, fields_json = ?, views_json = ?, updated_at = ?
         WHERE id = ?`,
        [
          bp.name,
          bp.description ?? '',
          bp.icon || '📦',
          bp.color || 'teal',
          parentSlug,
          showOnHome,
          JSON.stringify(normalizedFields),
          JSON.stringify(bp.views),
          now,
          id,
        ]
      );
    } else {
      this.driver.runSync(
        `INSERT INTO libraries (id, slug, name, description, icon, color, parent_slug, show_on_home, fields_json, views_json, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          bp.slug,
          bp.name,
          bp.description ?? '',
          bp.icon || '📦',
          bp.color || 'teal',
          parentSlug,
          showOnHome,
          JSON.stringify(normalizedFields),
          JSON.stringify(bp.views),
          order,
          now,
          now,
        ]
      );
    }

    compileLibrarySqlView(this.driver, id, bp.slug, normalizedFields);
    this.syncLibraryViewsFromBlueprint(
      id,
      bp.views,
      !existing,
      options?.viewInputs ?? bp.viewList,
      normalizedFields
    );
    if (!options?.skipRelationSync) {
      this.syncAllLibraryRelations();
    }
    this.invalidateCache();
    return id;
  }

  insertRawLibrary(l: Record<string, unknown>): void {
    const parentSlug = l.parent_slug ? String(l.parent_slug) : null;
    const showOnHome =
      l.show_on_home === undefined ? (parentSlug ? 0 : 1) : Number(l.show_on_home);
    this.driver.runSync(
      `INSERT INTO libraries (id, slug, name, description, icon, color, parent_slug, show_on_home, fields_json, views_json, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(l.id),
        String(l.slug),
        String(l.name),
        String(l.description ?? ''),
        String(l.icon ?? '📦'),
        String(l.color ?? 'teal'),
        parentSlug,
        showOnHome,
        String(l.fields_json),
        String(l.views_json),
        Number(l.sort_order ?? 0),
        Number(l.created_at ?? Date.now()),
        Number(l.updated_at ?? Date.now()),
      ]
    );
  }

  insertRawLibraryView(lv: Record<string, unknown>): void {
    this.driver.runSync(
      `INSERT OR REPLACE INTO library_views (id, library_id, name, view_type, config_json, sort_order, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(lv.id),
        String(lv.library_id),
        String(lv.name ?? DEFAULT_VIEW_LABELS.card),
        String(lv.view_type ?? 'card'),
        String(lv.config_json ?? '{}'),
        Number(lv.sort_order ?? 0),
        Number(lv.is_default ?? 0),
        Number(lv.created_at ?? Date.now()),
        Number(lv.updated_at ?? Date.now()),
      ]
    );
  }
}
