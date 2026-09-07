import { WHOLE_ROW } from "../core/changeset"
import type { SyncfusionTask } from "./mapper"

/**
 * Columns the grid never edits, whatever the row.
 *
 * Dates and duration are deliberately NOT here: rescheduling is the whole point of a
 * Gantt, so the schedule is edited natively in the grid and on the taskbar. Rows whose
 * schedule is genuinely derived — summary bars and the visual milestone mirror — are
 * blocked by the domain policy through `lockedFields`, exactly as Syncfusion itself
 * disables parent rows.
 */
export const READ_ONLY_GRID_FIELDS = new Set(["TaskID", "WBS", "entityLabel", "rightLabel", "_sourceId"])

export const FIELD_NAMES: Record<string, string> = {
  TaskName: "title",
  StartDate: "startDate",
  EndDate: "endDate",
  Duration: "duration",
  DurationUnit: "duration",
  Progress: "progress",
  Notes: "notes",
  BaselineStartDate: "baselineStartDate",
  BaselineEndDate: "baselineEndDate",
  responsibleId: "responsibleId",
  milestoneDate: "milestoneDate",
  milestoneLabel: "milestoneLabel",
  tagsText: "tags",
}

/** Fields that only make sense on a real deliverable row. */
const DELIVERY_ONLY = new Set(["businessType", "showMilestone", "milestoneLabel", "milestoneDate"])

export function isDelivery(row: SyncfusionTask | null): boolean {
  return Boolean(row && row.entityType === "entrega" && !row._projection)
}

export function isActivity(row: SyncfusionTask | null): boolean {
  return Boolean(row && row.entityType === "atividade" && !row._projection)
}

/** The native task dialog is offered for any real row the user may edit. */
export function canOpenTaskDialog(row: SyncfusionTask | null): boolean {
  return Boolean(row && !row._readOnly && !row._projection)
}

export function canEditGridField(
  row: SyncfusionTask | null,
  field: string,
  locked: Set<string>,
  allowLinks: boolean,
): boolean {
  if (!row || row._readOnly || row._projection) return false
  if (READ_ONLY_GRID_FIELDS.has(field)) return false
  if (locked.has(FIELD_NAMES[field] ?? field)) return false
  if (field === "Predecessor" && (!allowLinks || isDelivery(row))) return false
  if (DELIVERY_ONLY.has(field) && !isDelivery(row)) return false
  return true
}

/** Rebinding the renderer is only justified when the visible tree itself changed. */
export function renderStructureKey(rows: SyncfusionTask[]): string {
  return rows.map((row) => `${row.TaskID}:${row.ParentID ?? "-"}:${row.isMilestone ? "m" : "t"}`).join("|")
}

/** Canonical field name -> grid column, for per-cell change marks. */
export const CHANGED_FIELD_COLUMNS: Record<string, string> = {
  title: "TaskName", startDate: "StartDate", endDate: "EndDate", duration: "Duration",
  progress: "Progress", status: "status", priority: "priority", notes: "Notes",
  responsibleId: "responsibleId", responsibleName: "responsibleId", businessType: "businessType",
  showMilestone: "showMilestone", milestoneLabel: "milestoneLabel", milestoneDate: "milestoneDate",
  effort: "effort", storyPoints: "storyPoints", weight: "weight", tags: "tagsText",
  predecessorText: "Predecessor",
}

/**
 * Strict on purpose: only a canonical field that maps to exactly this column marks it.
 * Matching the column name against the change set tinted whole neighbourhoods of cells.
 */
export function isChangedCell(
  row: SyncfusionTask | null,
  field: string,
  changed: Set<string> | undefined,
): boolean {
  // The mirror shares its `_sourceId` with the delivery and would inherit every mark.
  if (!row || row._projection || !changed || changed.size === 0) return false
  if (changed.has(WHOLE_ROW)) return true
  for (const name of changed) if (CHANGED_FIELD_COLUMNS[name] === field) return true
  return false
}
