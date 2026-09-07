import type { GanttValidationIssue, GanttValidationResult } from "./adapter"
import { civilKey } from "./date"
import { findCyclicDependencies } from "./dependencies"
import { indexTasks, wouldCreateCycle } from "./hierarchy"
import type { GanttDomainPolicy, PolicyContext } from "./policy"
import type { GanttChangeset, GanttDataset } from "./types"

/**
 * Re-checks the whole working set against the domain policy immediately before a
 * write. The renderer already blocks illegal gestures, but data can also arrive
 * corrupt from the host, and a save is the wrong moment to discover it.
 */
export function validateDataset(dataset: GanttDataset, policy: GanttDomainPolicy): GanttValidationResult {
  const issues: GanttValidationIssue[] = []
  const index = indexTasks(dataset.tasks)
  const context: PolicyContext = { index }

  for (const task of dataset.tasks) {
    if (task.parentId != null) {
      const parent = index.byId.get(task.parentId)
      if (!parent) {
        issues.push({
          code: "ORPHAN_PARENT",
          severity: "warning",
          taskId: task.id,
          message: `"${task.title}" aponta para um pai inexistente e foi movida para a raiz.`,
        })
      } else if (wouldCreateCycle(index, task.id, task.parentId)) {
        issues.push({
          code: "HIERARCHY_CYCLE",
          severity: "error",
          taskId: task.id,
          message: `"${task.title}" participa de um ciclo na hierarquia.`,
        })
      } else {
        const decision = policy.canBeChildOf(task, parent, context)
        if (!decision.allowed) {
          issues.push({
            code: decision.code ?? "POLICY",
            severity: "error",
            taskId: task.id,
            message: decision.message ?? `"${task.title}" não pode ficar sob "${parent.title}".`,
          })
        }
      }
    }

    if (task.kind !== "group" && task.startDate && task.endDate && civilKey(task.endDate) < civilKey(task.startDate)) {
      issues.push({
        code: "INVERTED_DATES",
        severity: "error",
        taskId: task.id,
        message: `"${task.title}" termina antes de começar.`,
      })
    }
    if (task.progress != null && (task.progress < 0 || task.progress > 100)) {
      issues.push({
        code: "PROGRESS_RANGE",
        severity: "error",
        taskId: task.id,
        message: `O avanço de "${task.title}" precisa ficar entre 0 e 100.`,
      })
    }
  }

  for (const dependency of dataset.dependencies ?? []) {
    const predecessor = index.byId.get(dependency.predecessorId)
    const successor = index.byId.get(dependency.successorId)
    if (!predecessor || !successor) {
      issues.push({
        code: "DANGLING_DEPENDENCY",
        severity: "error",
        taskId: dependency.successorId,
        message: "Existe um vínculo apontando para uma linha que não está no plano.",
      })
      continue
    }
    const decision = policy.canLink(predecessor, successor, dependency.type, context)
    if (!decision.allowed) {
      issues.push({
        code: decision.code ?? "POLICY",
        severity: "error",
        taskId: successor.id,
        message: decision.message ?? `Vínculo entre "${predecessor.title}" e "${successor.title}" não é permitido.`,
      })
    }
  }

  for (const cyclic of findCyclicDependencies(dataset.dependencies ?? [])) {
    issues.push({
      code: "DEPENDENCY_CYCLE",
      severity: "error",
      taskId: cyclic.successorId,
      message: "A rede de dependências contém um ciclo.",
    })
  }

  return { valid: !issues.some((issue) => issue.severity === "error"), issues }
}

export function validateChangeset(
  dataset: GanttDataset,
  changeset: GanttChangeset,
  policy: GanttDomainPolicy,
): GanttValidationResult {
  const base = validateDataset(dataset, policy)
  const issues = [...base.issues]
  for (const created of changeset.createdTasks) {
    if (!created.title?.trim()) {
      issues.push({ code: "EMPTY_TITLE", severity: "error", taskId: created.id, message: "Toda linha nova precisa de um título." })
    }
  }
  return { valid: !issues.some((issue) => issue.severity === "error"), issues }
}
