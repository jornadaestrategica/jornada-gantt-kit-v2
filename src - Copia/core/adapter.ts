import type { GanttDomainPolicy } from "./policy"
import type {
  GanttChangeset,
  GanttDataset,
  GanttResource,
  GanttSaveResult,
  TaskId,
  GanttTask,
} from "./types"

export interface GanttCreationOption {
  id: string
  label: string
  task: Partial<GanttTask> & Pick<GanttTask, "title">
  seedMilestoneDate?: boolean
}

export interface GanttChoice { value: string; label: string }

export type ValidationSeverity = "error" | "warning"

export interface GanttValidationIssue {
  code: string
  message: string
  severity: ValidationSeverity
  taskId?: TaskId
}

export interface GanttValidationResult {
  valid: boolean
  issues: GanttValidationIssue[]
}

/**
 * The whole coupling surface between the Gantt and a host system.
 *
 * `load` maps host rows into the canonical dataset; `save` translates a changeset
 * back. SQL, HTTP, RLS and organisational rules stay on the host side of this line —
 * the core and the Syncfusion wrapper never learn what a deliverable is.
 */
export interface GanttDataAdapter<TContext = unknown> {
  load(context: TContext): Promise<GanttDataset>
  save(context: TContext, changeset: GanttChangeset): Promise<GanttSaveResult>
  /** Structural rules the renderer must enforce live, before a change is applied. */
  policy?: GanttDomainPolicy
  creationOptions?: GanttCreationOption[]
  businessTypeOptions?: Array<{ value: string; label: string }>
  editOptions?(field: "status" | "priority", entityType?: string): GanttChoice[]
  resolveResources?(context: TContext): Promise<GanttResource[]>
  /** Last gate before a write. Runs against the full changeset. */
  validate?(context: TContext, changeset: GanttChangeset): Promise<GanttValidationResult>
}

export function issuesBySeverity(result: GanttValidationResult, severity: ValidationSeverity): GanttValidationIssue[] {
  return result.issues.filter((issue) => issue.severity === severity)
}
