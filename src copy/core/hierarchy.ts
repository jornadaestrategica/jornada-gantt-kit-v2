import { civilKey, maxDate, minDate } from "./date"
import type { GanttTask, TaskId } from "./types"

export interface TaskIndex {
  byId: Map<TaskId, GanttTask>
  childrenOf: Map<TaskId | null, GanttTask[]>
  /** Depth-first visual order, exactly what the grid renders. */
  visual: GanttTask[]
  depth: Map<TaskId, number>
}

const ROOT: TaskId | null = null

function bySiblingOrder(a: GanttTask, b: GanttTask): number {
  if (a.order !== b.order) return a.order - b.order
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Builds the render index. Rows whose parent is missing or would close a cycle are
 * re-rooted instead of being dropped, so a corrupt `parent_id` in the host database
 * degrades to a flat row rather than an empty chart.
 */
export function indexTasks(tasks: GanttTask[]): TaskIndex {
  const byId = new Map<TaskId, GanttTask>()
  for (const task of tasks) byId.set(task.id, task)

  const effectiveParent = new Map<TaskId, TaskId | null>()
  for (const task of tasks) {
    let parentId = task.parentId
    if (parentId != null && !byId.has(parentId)) parentId = ROOT
    if (parentId != null) {
      const seen = new Set<TaskId>([task.id])
      let cursor: TaskId | null = parentId
      while (cursor != null) {
        if (seen.has(cursor)) {
          parentId = ROOT
          break
        }
        seen.add(cursor)
        const next: GanttTask | undefined = byId.get(cursor)
        cursor = next && next.parentId != null && byId.has(next.parentId) ? next.parentId : null
      }
    }
    effectiveParent.set(task.id, parentId)
  }

  const childrenOf = new Map<TaskId | null, GanttTask[]>()
  for (const task of tasks) {
    const parentId = effectiveParent.get(task.id) ?? ROOT
    const bucket = childrenOf.get(parentId)
    if (bucket) bucket.push(task)
    else childrenOf.set(parentId, [task])
  }
  for (const bucket of childrenOf.values()) bucket.sort(bySiblingOrder)

  const visual: GanttTask[] = []
  const depth = new Map<TaskId, number>()
  const walk = (parentId: TaskId | null, level: number): void => {
    for (const child of childrenOf.get(parentId) ?? []) {
      visual.push(child)
      depth.set(child.id, level)
      walk(child.id, level + 1)
    }
  }
  walk(ROOT, 0)

  return { byId, childrenOf, visual, depth }
}

export function childrenOf(index: TaskIndex, parentId: TaskId | null): GanttTask[] {
  return index.childrenOf.get(parentId) ?? []
}

export function siblingsOf(index: TaskIndex, taskId: TaskId): GanttTask[] {
  const task = index.byId.get(taskId)
  if (!task) return []
  return childrenOf(index, task.parentId)
}

/** The row directly above at the same level — the indent target in every serious Gantt. */
export function previousSibling(index: TaskIndex, taskId: TaskId): GanttTask | null {
  const siblings = siblingsOf(index, taskId)
  const position = siblings.findIndex((item) => item.id === taskId)
  return position > 0 ? siblings[position - 1] : null
}

export function nextSibling(index: TaskIndex, taskId: TaskId): GanttTask | null {
  const siblings = siblingsOf(index, taskId)
  const position = siblings.findIndex((item) => item.id === taskId)
  return position >= 0 && position < siblings.length - 1 ? siblings[position + 1] : null
}

export function ancestorIds(index: TaskIndex, taskId: TaskId): TaskId[] {
  const result: TaskId[] = []
  const seen = new Set<TaskId>([taskId])
  let cursor = index.byId.get(taskId)?.parentId ?? null
  while (cursor != null && !seen.has(cursor)) {
    seen.add(cursor)
    result.push(cursor)
    cursor = index.byId.get(cursor)?.parentId ?? null
  }
  return result
}

export function descendantIds(index: TaskIndex, taskId: TaskId): TaskId[] {
  const result: TaskId[] = []
  const stack = [...childrenOf(index, taskId)]
  while (stack.length) {
    const current = stack.pop() as GanttTask
    result.push(current.id)
    stack.push(...childrenOf(index, current.id))
  }
  return result
}

export function isDescendantOf(index: TaskIndex, taskId: TaskId, possibleAncestorId: TaskId): boolean {
  return ancestorIds(index, taskId).includes(possibleAncestorId)
}

export function wouldCreateCycle(index: TaskIndex, taskId: TaskId, nextParentId: TaskId | null): boolean {
  if (nextParentId == null) return false
  if (nextParentId === taskId) return true
  return isDescendantOf(index, nextParentId, taskId) || nextParentId === taskId
}

/**
 * Sorts a selection into top-down visual order and drops any row whose ancestor is
 * also selected. Indent/outdent must move a subtree once, not once per descendant.
 */
export function topMostInVisualOrder(index: TaskIndex, taskIds: Iterable<TaskId>): GanttTask[] {
  const selected = new Set(taskIds)
  return index.visual.filter((task) => {
    if (!selected.has(task.id)) return false
    return !ancestorIds(index, task.id).some((id) => selected.has(id))
  })
}

export function sortByVisualOrder(index: TaskIndex, taskIds: Iterable<TaskId>): GanttTask[] {
  const selected = new Set(taskIds)
  return index.visual.filter((task) => selected.has(task.id))
}

/** Rewrites `order` to a dense 0..n-1 per parent, preserving current visual order. */
export function normalizeOrders(tasks: GanttTask[]): GanttTask[] {
  const index = indexTasks(tasks)
  for (const [, bucket] of index.childrenOf) {
    bucket.forEach((task, position) => {
      task.order = position
    })
  }
  return tasks
}

/** Assigns outline numbers (1, 1.1, 1.2, 2). Display only — never written back. */
export function computeWbs(tasks: GanttTask[]): GanttTask[] {
  const index = indexTasks(tasks)
  const assign = (parentId: TaskId | null, prefix: string): void => {
    childrenOf(index, parentId).forEach((task, position) => {
      const code = prefix ? `${prefix}.${position + 1}` : String(position + 1)
      task.wbs = code
      assign(task.id, code)
    })
  }
  assign(ROOT, "")
  return tasks
}

export interface RollupResult {
  startDate: Date | null
  endDate: Date | null
  progress: number
}

/**
 * Weighted rollup for summary rows. Syncfusion computes parent bars itself, but the
 * host needs the same numbers for read-only columns and for save-time validation,
 * and `peso` weighting is a domain rule the renderer knows nothing about.
 */
export function rollup(index: TaskIndex, taskId: TaskId): RollupResult {
  const leaves: GanttTask[] = []
  const stack = [...childrenOf(index, taskId)]
  while (stack.length) {
    const current = stack.pop() as GanttTask
    const children = childrenOf(index, current.id)
    if (children.length) stack.push(...children)
    else leaves.push(current)
  }
  if (!leaves.length) {
    const self = index.byId.get(taskId)
    return { startDate: self?.startDate ?? null, endDate: self?.endDate ?? null, progress: self?.progress ?? 0 }
  }
  const startDate = minDate(leaves.map((leaf) => leaf.startDate))
  const endDate = maxDate(leaves.map((leaf) => leaf.endDate))
  let weightSum = 0
  let weighted = 0
  for (const leaf of leaves) {
    const weight = leaf.weight == null || leaf.weight <= 0 ? 1 : leaf.weight
    weightSum += weight
    weighted += weight * (leaf.progress ?? 0)
  }
  return { startDate, endDate, progress: weightSum ? Math.round(weighted / weightSum) : 0 }
}

/** Recomputes every summary row bottom-up. Returns the same array for chaining. */
export function applyRollups(tasks: GanttTask[]): GanttTask[] {
  const index = indexTasks(tasks)
  const ordered = [...index.visual].reverse()
  for (const task of ordered) {
    if (!childrenOf(index, task.id).length) {
      if (task.kind === "group" && !task.isManual) {
        task.startDate = null
        task.endDate = null
        task.duration = null
        task.progress = 0
      }
      continue
    }
    const result = rollup(index, task.id)
    task.kind = task.kind === "milestone" ? "milestone" : "group"
    task.startDate = result.startDate
    task.endDate = result.endDate
    task.progress = result.progress
    task.duration =
      result.startDate && result.endDate
        ? Math.max(1, Math.round((civilKey(result.endDate) - civilKey(result.startDate)) / 86_400_000) + 1)
        : null
  }
  return tasks
}
