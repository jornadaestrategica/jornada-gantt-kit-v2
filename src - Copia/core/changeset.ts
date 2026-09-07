import { sameDate } from "./date"
import { dependencyFullKey, dependencyKey } from "./dependencies"
import type { GanttChangeset, GanttDataset, GanttDependency, GanttTask, GanttTaskPatch, TaskId } from "./types"

/**
 * Fields diffed on a row. `parentId` and `order` are deliberately absent: structural
 * change is reported once, in `movedTasks`, so a host never receives the same move as
 * both an update and a move. `wbs` is derived and never sent.
 */
const SCALAR_FIELDS = [
  "title",
  "kind",
  "entityType",
  "businessType",
  "isSummary",
  "showMilestone",
  "milestoneLabel",
  "duration",
  "durationUnit",
  "progress",
  "status",
  "priority",
  "responsibleId",
  "responsibleName",
  "weight",
  "effort",
  "storyPoints",
  "color",
  "notes",
  "isManual",
] as const

const DATE_FIELDS = ["startDate", "endDate", "baselineStartDate", "baselineEndDate", "milestoneDate"] as const

function normalizedScalar(task: GanttTask, field: (typeof SCALAR_FIELDS)[number]): unknown {
  const value = (task as unknown as Record<string, unknown>)[field]
  return value === undefined ? null : value
}

function sameTags(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) return false
  return left.every((item, position) => item === right[position])
}

function emptyChangeset(): GanttChangeset {
  return {
    createdTasks: [],
    updatedTasks: [],
    deletedTaskIds: [],
    movedTasks: [],
    createdDependencies: [],
    updatedDependencies: [],
    deletedDependencies: [],
  }
}

/**
 * Diffs two snapshots into the smallest set of host operations.
 *
 * Dependencies are keyed by (predecessor, successor) rather than by their whole
 * value, so retyping FS to SS or changing a lag becomes an UPDATE that preserves the
 * link's primary key instead of a DELETE followed by an INSERT. That distinction is
 * what lets the host keep referential history and audit rows intact.
 */
export function buildChangeset(original: GanttDataset, current: GanttDataset): GanttChangeset {
  const result = emptyChangeset()
  const before = new Map(original.tasks.map((task) => [task.id, task]))
  const after = new Map(current.tasks.map((task) => [task.id, task]))

  for (const task of current.tasks) {
    const old = before.get(task.id)
    if (!old) {
      result.createdTasks.push(task)
      continue
    }

    if (old.parentId !== task.parentId || old.order !== task.order) {
      result.movedTasks.push({
        id: task.id,
        parentId: task.parentId,
        previousParentId: old.parentId,
        order: task.order,
      })
    }

    const patch: GanttTaskPatch = {}
    for (const field of SCALAR_FIELDS) {
      const nextValue = normalizedScalar(task, field)
      if (nextValue !== normalizedScalar(old, field)) {
        ;(patch as Record<string, unknown>)[field] = nextValue
      }
    }
    for (const field of DATE_FIELDS) {
      const nextValue = task[field] ?? null
      if (!sameDate(nextValue, old[field] ?? null)) {
        ;(patch as Record<string, unknown>)[field] = nextValue
      }
    }
    if (!sameTags(task.tags, old.tags)) patch.tags = task.tags ?? null

    if (Object.keys(patch).length) {
      result.updatedTasks.push({ id: task.id, changes: patch, rowVersion: task.rowVersion ?? null })
    }
  }

  for (const task of original.tasks) if (!after.has(task.id)) result.deletedTaskIds.push(task.id)

  const oldDeps = new Map((original.dependencies ?? []).map((dependency) => [dependencyKey(dependency), dependency]))
  const newDeps = new Map((current.dependencies ?? []).map((dependency) => [dependencyKey(dependency), dependency]))

  for (const [key, dependency] of newDeps) {
    const old = oldDeps.get(key)
    if (!old) {
      result.createdDependencies.push(dependency)
      continue
    }
    if (dependencyFullKey(old) !== dependencyFullKey(dependency)) {
      result.updatedDependencies.push({ ...dependency, id: dependency.id ?? old.id })
    }
  }
  for (const [key, dependency] of oldDeps) if (!newDeps.has(key)) result.deletedDependencies.push(dependency)

  return result
}

export function isChangesetEmpty(changeset: GanttChangeset): boolean {
  return Object.values(changeset).every((items) => Array.isArray(items) && items.length === 0)
}

export function countChanges(changeset: GanttChangeset): number {
  return Object.values(changeset).reduce((total, items) => total + (Array.isArray(items) ? items.length : 0), 0)
}

/** Marker used when the whole row is new or was moved, rather than a single field. */
export const WHOLE_ROW = "__row__"

/**
 * Which fields changed on each row. Highlighting the exact cell is far less noisy than
 * tinting whole rows, so the UI needs the field names, not just the ids.
 */
export function changedFieldsByTask(changeset: GanttChangeset): Map<TaskId, Set<string>> {
  const result = new Map<TaskId, Set<string>>()
  const add = (id: TaskId, field: string) => {
    const bucket = result.get(id)
    if (bucket) bucket.add(field)
    else result.set(id, new Set([field]))
  }
  for (const task of changeset.createdTasks) add(task.id, WHOLE_ROW)
  for (const move of changeset.movedTasks) add(move.id, WHOLE_ROW)
  for (const item of changeset.updatedTasks) {
    for (const field of Object.keys(item.changes)) add(item.id, field)
  }
  const links = [...changeset.createdDependencies, ...changeset.updatedDependencies, ...changeset.deletedDependencies]
  for (const link of links) add(link.successorId, "predecessorText")
  return result
}

/** Rows the changeset touches, for optimistic-lock checks and UI highlighting. */
export function affectedTaskIds(changeset: GanttChangeset): TaskId[] {
  const ids = new Set<TaskId>()
  for (const task of changeset.createdTasks) ids.add(task.id)
  for (const item of changeset.updatedTasks) ids.add(item.id)
  for (const item of changeset.movedTasks) ids.add(item.id)
  for (const id of changeset.deletedTaskIds) ids.add(id)
  const links: GanttDependency[] = [
    ...changeset.createdDependencies,
    ...changeset.updatedDependencies,
    ...changeset.deletedDependencies,
  ]
  for (const dependency of links) {
    ids.add(dependency.predecessorId)
    ids.add(dependency.successorId)
  }
  return [...ids]
}
