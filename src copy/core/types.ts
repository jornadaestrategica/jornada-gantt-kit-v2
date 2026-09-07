export type TaskId = string
export type DependencyId = string

/** Visual shape of a row in the chart. Independent of the host domain entity. */
export type GanttTaskKind = "task" | "group" | "milestone"

export type DependencyType = "FS" | "SS" | "FF" | "SF"
export type DurationUnit = "day" | "hour" | "minute"

/**
 * Domain discriminator supplied by the host adapter (e.g. "entrega" | "atividade").
 * The core never interprets it; policies and adapters do. It is what makes a single
 * flat Gantt row set routable back to more than one host table.
 */
export type EntityType = string

export interface GanttDependency {
  /** Host primary key of the link row, when it already exists remotely. */
  id?: DependencyId
  predecessorId: TaskId
  successorId: TaskId
  type: DependencyType
  /** Offset in whole days. Negative means lead. */
  lag?: number
  metadata?: Record<string, unknown>
}

export interface GanttResource {
  id: string
  name: string
  unit?: number
  metadata?: Record<string, unknown>
}

export interface GanttTask {
  /** Qualified, globally unique row id. Adapters encode entity + host PK here. */
  id: TaskId
  parentId: TaskId | null
  /** Dense sibling index. Owned by the core; normalized after every mutation. */
  order: number
  kind: GanttTaskKind
  /** Host entity this row came from. Drives policy and write routing. */
  entityType?: EntityType
  /** Business category, independent of the row's visual shape. */
  businessType?: string
  isSummary?: boolean
  showMilestone?: boolean
  milestoneLabel?: string | null
  milestoneDate?: Date | null
  title: string
  startDate: Date | null
  endDate: Date | null
  duration: number | null
  durationUnit: DurationUnit
  /** 0..100 */
  progress: number
  status?: string | null
  priority?: string | null
  responsibleId?: string | null
  responsibleName?: string | null
  baselineStartDate?: Date | null
  baselineEndDate?: Date | null
  /** Outline number, derived by the core. Never persisted. */
  wbs?: string
  /** Relative weight used for weighted progress rollup. */
  weight?: number | null
  effort?: number | null
  storyPoints?: number | null
  color?: string | null
  tags?: string[] | null
  notes?: string | null
  isManual?: boolean
  isExpanded?: boolean
  /** True while the row exists only locally and has no host PK yet. */
  isTemporary?: boolean
  isReadOnly?: boolean
  /** Fields the host refuses to accept for this row (generated, derived, denied). */
  lockedFields?: string[]
  /** Optimistic-concurrency token, typically updated_at. Echoed back on save. */
  rowVersion?: string | null
  metadata?: Record<string, unknown>
}

export interface GanttDataset {
  tasks: GanttTask[]
  dependencies?: GanttDependency[]
  resources?: GanttResource[]
  projectStartDate?: Date | null
  projectEndDate?: Date | null
  /** Vertical markers on the timeline (sprint boundaries, gates, releases). */
  markers?: GanttMarker[]
  holidays?: GanttHoliday[]
  metadata?: Record<string, unknown>
}

export interface GanttMarker {
  date: Date
  label: string
  cssClass?: string
}

export interface GanttHoliday {
  from: Date
  to?: Date
  label?: string
  cssClass?: string
}

export type GanttTaskPatch = Partial<Omit<GanttTask, "id">>

export interface GanttMove {
  id: TaskId
  parentId: TaskId | null
  previousParentId: TaskId | null
  order: number
}

export interface GanttChangeset {
  createdTasks: GanttTask[]
  updatedTasks: Array<{ id: TaskId; changes: GanttTaskPatch; rowVersion?: string | null }>
  deletedTaskIds: TaskId[]
  movedTasks: GanttMove[]
  createdDependencies: GanttDependency[]
  updatedDependencies: GanttDependency[]
  deletedDependencies: GanttDependency[]
}

export interface GanttConflict {
  taskId?: TaskId
  dependencyId?: DependencyId
  field?: string
  message: string
}

export interface GanttSaveResult {
  success: boolean
  /** Temporary local id -> host primary key. Required for every created row. */
  idMap?: Record<string, string>
  /** Authoritative dataset after the write. Preferred over a client-side merge. */
  dataset?: GanttDataset
  conflicts?: GanttConflict[]
  message?: string
}

export type TimelinePreset = "fit" | "hour" | "day" | "week" | "month" | "quarter" | "year"

export interface GanttViewState {
  selectedTaskIds: TaskId[]
  collapsedTaskIds: TaskId[]
  viewMode: "Default" | "Grid" | "Chart"
  timelinePreset: TimelinePreset
  scheduleMode?: "auto" | "manual" | "custom"
  splitterPosition?: string
  showBaseline?: boolean
  showCriticalPath?: boolean
  showAnnotations?: boolean
  showTodayMarker?: boolean
  /** Bar label fields, chosen by the user. `null` hides that label. */
  leftLabelField?: string | null
  rightLabelField?: string | null
  showProgressLabel?: boolean
  /** Compact toolbars show icons only. */
  toolbarLabels?: boolean
  /** Timeline window; `null` lets the data decide. */
  projectStart?: string | null
  projectEnd?: string | null
  /** Tint rows touched since the last save. */
  highlightChanges?: boolean
  /** Display toggles the user pinned to the top bar. */
  pinnedToggles?: string[]
  hiddenColumns?: string[]
  scrollTop?: number
  /** Which grid separators are drawn; native Syncfusion `gridLines` values. */
  gridLines?: "Both" | "Horizontal" | "Vertical" | "None"
  /** Show or hide dependency connector lines. */
  showDependencyLines?: boolean
}

export interface GanttCapabilities {
  inlineEditing?: boolean
  dialogEditing?: boolean
  taskbarEditing?: boolean
  rowDragAndDrop?: boolean
  dependencies?: boolean
  baseline?: boolean
  filtering?: boolean
  sorting?: boolean
  columnResizing?: boolean
  columnReorder?: boolean
  columnMenu?: boolean
  contextMenu?: boolean
  undoRedo?: boolean
  indentOutdent?: boolean
  smartLink?: boolean
  criticalPath?: boolean
  excelExport?: boolean
  pdfExport?: boolean
  virtualScroll?: boolean
  wbs?: boolean
  search?: boolean
}

export interface GanttPermissions {
  create?: boolean
  update?: boolean
  delete?: boolean
  save?: boolean
  link?: boolean
  reparent?: boolean
}
