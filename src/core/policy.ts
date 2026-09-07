import type { TaskIndex } from "./hierarchy"
import type { DependencyType, GanttTask, TaskId } from "./types"

export interface PolicyDecision {
  allowed: boolean
  code?: string
  message?: string
  /**
   * A policy may accept the intent but redirect it — e.g. indenting an activity
   * under another activity becomes indenting it under that activity's deliverable.
   */
  redirectParentId?: TaskId | null
}

export const ALLOW: PolicyDecision = { allowed: true }

export function deny(code: string, message: string): PolicyDecision {
  return { allowed: false, code, message }
}

export interface PolicyContext {
  index: TaskIndex
}

/**
 * The contract that keeps the Gantt honest about a host schema it cannot see.
 *
 * The renderer offers indent, outdent, drag-drop and link on every row. Whether a
 * given move is representable in the host database is a question only the host can
 * answer, so every structural mutation is routed through here before it is applied.
 */
export interface GanttDomainPolicy {
  readonly name: string
  /** Can `task` become a child of `parent`? `parent` is null for the root level. */
  canBeChildOf(task: GanttTask, parent: GanttTask | null, context: PolicyContext): PolicyDecision
  /** Can a dependency link be drawn from `predecessor` to `successor`? */
  canLink(
    predecessor: GanttTask,
    successor: GanttTask,
    type: DependencyType,
    context: PolicyContext,
  ): PolicyDecision
  /** Can this row be deleted? */
  canDelete?(task: GanttTask, context: PolicyContext): PolicyDecision
  /** Fields the user may not edit on this row, on top of `task.lockedFields`. */
  lockedFieldsFor?(task: GanttTask, context: PolicyContext): string[]
  /** Default link type used by smart connection. */
  readonly defaultDependencyType: DependencyType
  /** Maximum outline depth, 0-based. Undefined means unlimited. */
  readonly maxDepth?: number
}

/** No domain rules. Only structural integrity is enforced by the core. */
export const permissivePolicy: GanttDomainPolicy = {
  name: "permissive",
  defaultDependencyType: "FS",
  canBeChildOf: () => ALLOW,
  canLink: () => ALLOW,
}

export function lockedFields(policy: GanttDomainPolicy, task: GanttTask, context: PolicyContext): Set<string> {
  const result = new Set(task.lockedFields ?? [])
  for (const field of policy.lockedFieldsFor?.(task, context) ?? []) result.add(field)
  return result
}

export function isFieldEditable(
  policy: GanttDomainPolicy,
  task: GanttTask,
  field: string,
  context: PolicyContext,
): boolean {
  if (task.isReadOnly) return false
  return !lockedFields(policy, task, context).has(field)
}
