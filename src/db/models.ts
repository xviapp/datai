import type { EvaluatedHighlight } from '@/engine/formula';
import type { FieldDef, FieldType } from '@/schema/field-defs';
import type {
  AccentTone,
  DashboardWidget,
  LibraryLayoutBundle,
  LibraryViewType,
} from '@/schema/view-dsl';

export interface LibraryViewRecord {
  id: string;
  libraryId: string;
  name: string;
  viewType: LibraryViewType;
  config: Record<string, unknown>;
  sortOrder: number;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface LibraryViewInput {
  id?: string;
  name: string;
  viewType: LibraryViewType;
  config?: Record<string, unknown>;
}

export interface LibraryRelationRecord {
  id: string;
  sourceLibraryId: string;
  sourceLibrarySlug: string;
  sourceLibraryName: string;
  sourceLibraryIcon: string;
  targetLibraryId: string;
  targetLibrarySlug: string;
  targetLibraryName: string;
  targetLibraryIcon: string;
  fieldKey: string;
  relationKind: 'parent_child' | 'reference';
  allowMultiple: boolean;
  createdAt: number;
}

export interface LibraryRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string;
  color: AccentTone;
  parentLibrarySlug: string | null;
  showOnHome: boolean;
  fields: FieldDef[];
  /** 由独立 library_views 表驱动的按需视图列表（有序） */
  viewList: LibraryViewRecord[];
  /** 兼容视图配置汇总（由 library_views 聚合生成） */
  views: LibraryLayoutBundle;
  entryCount: number;
  updatedAt: number;
}

export interface ChildLibrarySection {
  childLibrary: LibraryRecord;
  relationFieldKey: string;
  entries: HydratedEntry[];
}

export interface BacklinkGroupSection {
  sourceLibrary: LibraryRecord;
  relationFieldKey: string;
  relationFieldLabel: string;
  entries: HydratedEntry[];
}

export interface LinkedEntryRef {
  id: string;
  title: string;
  libraryId: string;
  librarySlug: string;
  libraryName: string;
  libraryIcon: string;
  fieldKey: string;
}

export interface HydratedEntry {
  id: string;
  libraryId: string;
  librarySlug: string;
  titleSummary: string;
  rawData: Record<string, unknown>;
  /** 合并了 Rollup 聚合值与 Formula 计算值之后的完整字段字典 */
  computedData: Record<string, unknown>;
  /** 正向关联解析出的记录标签映射：fieldKey -> LinkedEntryRef[] */
  forwardLinks: Record<string, LinkedEntryRef[]>;
  /** 反向引用该记录的所有其它库条目（双向反链 Backlinks） */
  backlinks: LinkedEntryRef[];
  highlight: EvaluatedHighlight | null;
  createdAt: number;
  updatedAt: number;
}

export interface EntrySearchHit {
  id: string;
  title: string;
  libraryId: string;
  librarySlug: string;
  libraryName: string;
  libraryIcon: string;
  updatedAt: number;
}

export interface AiSnapshotItem {
  id: string;
  actionSummary: string;
  undone: boolean;
  createdAt: number;
}

export interface SnapshotUndoImpact {
  summary: string;
  isFullRestore: boolean;
  affectedEntriesCount: number;
  warningText: string;
}

export interface SavedDashboardWidget extends DashboardWidget {
  librarySlug: string | null;
  pinnedOverview: boolean;
  sortOrder: number;
}

export interface FullBackupBundle {
  version: 1 | 2;
  exportedAt: string;
  libraries: Array<Record<string, unknown>>;
  libraryViews?: Array<Record<string, unknown>>;
  libraryRelations?: Array<Record<string, unknown>>;
  entries: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
  widgets: Array<Record<string, unknown>>;
}

export interface ArchitectFieldTypeChange {
  key: string;
  label: string;
  fromType: FieldType;
  toType: FieldType;
}

export interface ArchitectLibraryDiff {
  slug: string;
  name: string;
  entryCount: number;
  removedFields: Array<{ key: string; label: string; type: FieldType }>;
  typeChangedFields: ArchitectFieldTypeChange[];
  newlyRequiredFields: Array<{ key: string; label: string }>;
  hasDestructiveChanges: boolean;
}

export interface LibraryCatalogItem {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string;
  parentLibrarySlug?: string | null;
  fields: FieldDef[];
  recentEntries?: Array<{ id: string; title: string }>;
}

export interface DetachedSourceRecord {
  id: string;
  prevDataJson: string;
  /** 按字段记录本次解绑实际移除的目标 ID，用于撤销时仅恢复被移除的关联而不覆盖其他字段的新编辑 */
  removedByField?: Record<string, string[]>;
}

export type SnapshotPayload =
  | {
      kind: 'entries_created';
      entryIds: string[];
    }
  | {
      kind: 'entry_deleted';
      entry: Record<string, unknown>;
      relations: Array<Record<string, unknown>>;
      detachedSources?: DetachedSourceRecord[];
    }
  | {
      kind: 'library_deleted';
      library: Record<string, unknown>;
      libraryViews?: Array<Record<string, unknown>>;
      entries: Array<Record<string, unknown>>;
      relations: Array<Record<string, unknown>>;
      widgets: Array<Record<string, unknown>>;
      detachedChildLibraries?: Array<{
        id: string;
        parent_slug: string | null;
        show_on_home: number;
      }>;
      detachedSources?: DetachedSourceRecord[];
    }
  | {
      kind: 'architect_plan';
      createdLibrarySlugs: string[];
      previousLibraries: Array<Record<string, unknown>>;
      previousLibraryViews?: Array<Record<string, unknown>>;
      createdWidgetIds: string[];
    }
  | FullBackupBundle;

export interface RawEntryRow {
  id: string;
  library_id: string;
  title_summary: string;
  data_json: string;
  created_at: number;
  updated_at: number;
}

export interface ForwardRelRow {
  source_entry_id: string;
  field_key: string;
  target_id: string;
  target_title: string;
  target_lib_id: string;
  target_data_json: string;
}

export interface BackRelRow {
  target_entry_id: string;
  field_key: string;
  source_id: string;
  source_title: string;
  source_lib_id: string;
  source_data_json: string;
}
