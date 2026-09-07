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
  durationEstimatedDays: "duration",
  DurationUnit: "duration",
  Progress: "progress",
  isManual: "isManual",
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

/**
 * Rebinding the renderer is only justified when the visible tree itself changed — which
 * node exists, under which parent, milestone or not. The keys are sorted before joining
 * so a change in visual order alone (e.g. the initial date sort reacting to an edited
 * date) never looks like a structural change and forces an expensive full remount.
 */
export function renderStructureKey(rows: SyncfusionTask[]): string {
  return rows.map((row) => `${row.TaskID}:${row.ParentID ?? "-"}:${row.isMilestone ? "m" : "t"}`).sort().join("|")
}
