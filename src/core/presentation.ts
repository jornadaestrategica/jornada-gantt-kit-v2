import { indexTasks } from "./hierarchy"
import type { GanttDataset, GanttTask, TaskId } from "./types"

export interface PresentedTask extends GanttTask {
  sourceId: TaskId
  projection: boolean
}

// Presentation rows never enter the session, changeset or adapter.
export function presentTasks(dataset: GanttDataset): PresentedTask[] {
  const prefix = "__milestone__:"
  if (dataset.tasks.some((task) => task.id.startsWith(prefix))) {
    throw new Error("Identificador reservado para representação visual de marcos.")
  }
  const index = indexTasks(dataset.tasks)
  const result: PresentedTask[] = []
  const visit = (parentId: TaskId | null): void => {
    for (const task of index.childrenOf.get(parentId) ?? []) {
      const date = task.milestoneDate ?? task.endDate
      const hiddenStandaloneMilestone = task.entityType === "entrega" && task.kind === "milestone" && task.showMilestone === false
      result.push({
        ...task,
        ...(task.kind === "milestone" ? { startDate: date, endDate: date, duration: 0 } : {}),
        ...(hiddenStandaloneMilestone ? { kind: "task" as const, startDate: null, endDate: null, duration: null } : {}),
        sourceId: task.id,
        projection: false,
      })
      visit(task.id)
      if (task.showMilestone && task.kind !== "milestone") {
        result.push({
          ...task,
          id: `${prefix}${task.id}`,
          // A sibling avoids feeding a synthetic child into the owner's rollup.
          parentId: task.parentId,
          sourceId: task.id,
          projection: true,
          kind: "milestone",
          title: task.milestoneLabel?.trim() || `Marco: ${task.title}`,
          startDate: date,
          endDate: date,
          duration: 0,
          wbs: "",
          isReadOnly: true,
        })
      }
    }
  }
  visit(null)
  return result
}
