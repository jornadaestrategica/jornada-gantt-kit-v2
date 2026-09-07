import { DEFAULT_OFFSET_UNITS, formatPredecessorText, parsePredecessorText, type OffsetUnitLabels } from "../core/dependencies"
import { indexTasks } from "../core/hierarchy"
import { presentTasks } from "../core/presentation"
import { lockedFields, type GanttDomainPolicy } from "../core/policy"
import type { GanttDataset, GanttDependency, GanttTask, TaskId } from "../core/types"

/**
 * Flat row shape bound to the Gantt. Field names match Syncfusion's `taskFields`
 * mapping so the component's native scheduling, editing and dependency engines all
 * work unmodified — the wrapper adapts data, never behaviour.
 */
export interface SyncfusionTask {
  TaskID: string
  ParentID: string | null
  TaskName: string
  StartDate: Date | null
  EndDate: Date | null
  Duration: number | null
  DurationUnit: string
  Progress: number
  Predecessor: string
  BaselineStartDate: Date | null
  BaselineEndDate: Date | null
  Notes: string | null
  isMilestone: boolean
  WBS: string
  responsibleId: string | null
  responsibleName: string | null
  status: string | null
  priority: string | null
  weight: number | null
  effort: number | null
  storyPoints: number | null
  entityType: string
  entityLabel: string
  order: number
  /** Rendering and edit hints derived from the domain policy. */
  _kind: GanttTask["kind"]
  _isTemporary: boolean
  _readOnly: boolean
  _locked: string[]
  _color: string | null
  _sourceId: TaskId
  _projection: boolean
  businessType: string
  showMilestone: boolean
  milestoneLabel: string | null
  milestoneDate: Date | null
  rightLabel: string
  leftLabelText: string
  rightLabelText: string
  startText: string
  endText: string
  periodText: string
  milestoneText: string
  businessTypeLabel: string
  tagsText: string
  color: string | null
}

/** Fields offered as bar labels in settings. */
export const LABEL_FIELDS: Array<{ value: string; label: string }> = [
  { value: "responsibleName", label: "Responsável" },
  { value: "TaskName", label: "Título" },
  { value: "businessTypeLabel", label: "Tipo" },
  { value: "status", label: "Situação" },
  { value: "priority", label: "Prioridade" },
  { value: "Duration", label: "Duração" },
  { value: "startText", label: "Data de início" },
  { value: "endText", label: "Data de término" },
  { value: "periodText", label: "Início — término" },
  { value: "milestoneText", label: "Marco" },
]

const DATE_LABEL = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" })

/**
 * Bar labels are rendered from a pre-computed string rather than from a raw field.
 * A template pointing at an absent value printed the word `undefined` on every bar, and
 * "do not show" printed it too — an empty string simply renders nothing.
 */
function labelText(row: Record<string, unknown>, field: string | null | undefined): string {
  if (!field) return ""
  const value = row[field]
  if (value == null || value === "") return ""
  if (value instanceof Date) return DATE_LABEL.format(value)
  return String(value)
}

const ENTITY_LABELS: Record<string, string> = {
  entrega: "Entrega",
  atividade: "Atividade",
}

export interface ToSyncfusionOptions {
  policy?: GanttDomainPolicy
  identities?: RenderIds
  /** Localized offset words, so the component accepts the relations it is given. */
  offsetUnits?: OffsetUnitLabels
  /** Human label for the row's business type, resolved by the host adapter. */
  businessTypeLabel?: (task: GanttTask) => string
  /** Fields chosen by the user for the left and right bar labels. */
  leftLabelField?: string | null
  rightLabelField?: string | null
}

/** Stable numeric UI keys keep dependency text separate from database UUIDs. */
export class RenderIds {
  private readonly forward = new Map<string, string>()
  private readonly reverse = new Map<string, string>()
  rowId(sourceId: string): string {
    const existing = this.forward.get(sourceId)
    if (existing) return existing
    const next = String(this.forward.size + 1)
    this.forward.set(sourceId, next)
    this.reverse.set(next, sourceId)
    return next
  }
  sourceId(rowId: string): string {
    const source = this.reverse.get(rowId)
    if (!source || source.startsWith("__milestone__:")) {
      throw new Error("A predecessora precisa ser uma linha real, não a representação visual de um marco.")
    }
    return source
  }
}

export function toSyncfusionDataset(dataset: GanttDataset, options: ToSyncfusionOptions = {}): SyncfusionTask[] {
  const identities = options.identities ?? new RenderIds()
  const dependencies = (dataset.dependencies ?? []).map((dependency) => ({
    ...dependency, predecessorId: identities.rowId(dependency.predecessorId),
    successorId: identities.rowId(dependency.successorId),
  }))
  const index = indexTasks(dataset.tasks)
  const context = { index }

  const rows = presentTasks(dataset).map((task) => {
    const locked = options.policy ? [...lockedFields(options.policy, task, context)] : (task.lockedFields ?? [])
    const entityType = task.entityType ?? "task"
    return {
      TaskID: identities.rowId(task.id),
      ParentID: task.parentId == null ? null : identities.rowId(task.parentId),
      TaskName: task.title,
      StartDate: task.startDate,
      EndDate: task.endDate,
      Duration: task.duration,
      DurationUnit: task.durationUnit ?? "day",
      Progress: Math.round(task.progress ?? 0),
      Predecessor: task.projection
        ? ""
        : formatPredecessorText(dependencies, identities.rowId(task.id), options.offsetUnits ?? DEFAULT_OFFSET_UNITS),
      BaselineStartDate: task.baselineStartDate ?? null,
      BaselineEndDate: task.baselineEndDate ?? null,
      Notes: task.notes ?? null,
      isMilestone: task.kind === "milestone",
      WBS: task.wbs ?? "",
      responsibleId: task.responsibleId ?? null,
      responsibleName: task.responsibleName ?? null,
      status: task.status ?? null,
      priority: task.priority ?? null,
      weight: task.weight ?? null,
      effort: task.effort ?? null,
      storyPoints: task.storyPoints ?? null,
      entityType,
      entityLabel: task.kind === "milestone" ? "Marco de entrega" : task.businessType ?? ENTITY_LABELS[entityType] ?? entityType,
      order: task.order,
      _kind: task.kind,
      _isTemporary: Boolean(task.isTemporary),
      _readOnly: Boolean(task.isReadOnly),
      _locked: locked,
      _color: task.color ?? null,
      _sourceId: task.sourceId,
      _projection: task.projection,
      businessType: task.businessType ?? "",
      showMilestone: task.showMilestone ?? false,
      milestoneLabel: task.milestoneLabel ?? null,
      milestoneDate: task.milestoneDate ?? null,
      rightLabel: task.kind === "milestone"
        ? task.milestoneLabel || (task.projection ? task.title : `Marco: ${task.title}`) : task.responsibleName ?? "",
      startText: "",
      endText: "",
      periodText: "",
      leftLabelText: "",
      rightLabelText: "",
      milestoneText: task.kind === "milestone" ? task.milestoneLabel || task.title : "",
      businessTypeLabel: options.businessTypeLabel?.(task) ?? (task.entityType === "atividade" ? "Atividade" : task.businessType ?? ""),
      tagsText: (task.tags ?? []).join(", "),
      color: task.color ?? null,
    }
  })

  for (const row of rows) {
    row.startText = labelText(row, "StartDate")
    row.endText = labelText(row, "EndDate")
    row.periodText = row.startText && row.endText ? `${row.startText} — ${row.endText}` : row.startText || row.endText
    row.leftLabelText = labelText(row, options.leftLabelField)
    row.rightLabelText = labelText(row, options.rightLabelField)
  }
  return rows
}

/**
 * Reads an edited row back into a canonical patch.
 *
 * `Predecessor` is deliberately absent: dependencies live in one place, the
 * dataset's `dependencies` array, and are applied through `setPredecessorText` so a
 * link change is diffed as a link change and never as a text field on a row.
 */
export function patchFromSyncfusion(record: Partial<SyncfusionTask>): Partial<GanttTask> {
  const patch: Partial<GanttTask> = {}
  if (record.TaskName !== undefined) patch.title = record.TaskName
  if (record.StartDate !== undefined) patch.startDate = record.StartDate ?? null
  if (record.EndDate !== undefined) patch.endDate = record.EndDate ?? null
  if (record.Duration !== undefined) patch.duration = record.Duration ?? null
  if (record.Progress !== undefined) patch.progress = Number(record.Progress ?? 0)
  if (record.BaselineStartDate !== undefined) patch.baselineStartDate = record.BaselineStartDate ?? null
  if (record.BaselineEndDate !== undefined) patch.baselineEndDate = record.BaselineEndDate ?? null
  if (record.Notes !== undefined) patch.notes = record.Notes ?? null
  if (record.responsibleId !== undefined) patch.responsibleId = record.responsibleId ?? null
  if (record.responsibleName !== undefined) patch.responsibleName = record.responsibleName ?? null
  if (record.status !== undefined) patch.status = record.status ?? null
  if (record.priority !== undefined) patch.priority = record.priority ?? null
  if (record.weight !== undefined) patch.weight = record.weight ?? null
  if (record.effort !== undefined) patch.effort = record.effort ?? null
  if (record.storyPoints !== undefined) patch.storyPoints = record.storyPoints ?? null
  if (record.tagsText !== undefined) patch.tags = [...new Set(record.tagsText.split(",").map((tag) => tag.trim()).filter(Boolean))]
  if (record.color !== undefined) patch.color = record.color?.trim() || null
  if (record.entityType === "entrega") {
    if (record.businessType !== undefined) patch.businessType = record.businessType
    if (record.showMilestone !== undefined) patch.showMilestone = record.showMilestone
    if (record.milestoneLabel !== undefined) patch.milestoneLabel = record.milestoneLabel
    if (record.milestoneDate !== undefined) patch.milestoneDate = record.milestoneDate
  }
  return patch
}

/** Pulls the canonical row id out of whatever shape an event handler received. */
export function readTaskId(candidate: unknown): TaskId | null {
  if (!candidate || typeof candidate !== "object") return null
  const record = candidate as { _sourceId?: unknown; TaskID?: unknown; taskData?: { _sourceId?: unknown; TaskID?: unknown }; ganttProperties?: { taskId?: unknown } }
  const direct = record.taskData?._sourceId ?? record._sourceId ?? record.taskData?.TaskID ?? record.TaskID ?? record.ganttProperties?.taskId
  return typeof direct === "string" ? direct : direct == null ? null : String(direct)
}

export function readTaskIds(candidates: unknown[]): TaskId[] {
  return candidates.map(readTaskId).filter((id): id is TaskId => Boolean(id))
}

/** Rebuilds a dependency list from the grid's own predecessor strings. */
export function dependenciesFromRows(rows: SyncfusionTask[]): GanttDependency[] {
  const result: GanttDependency[] = []
  for (const row of rows) {
    if (!row.Predecessor) continue
    result.push(...parsePredecessorText(row.Predecessor, row.TaskID))
  }
  return result
}
