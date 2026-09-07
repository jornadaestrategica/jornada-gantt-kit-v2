import type { GanttDataAdapter, GanttValidationResult } from "../core/adapter"
import { dependencyKey } from "../core/dependencies"
import { permissivePolicy, type GanttDomainPolicy } from "../core/policy"
import type { GanttChangeset, GanttDataset, GanttSaveResult } from "../core/types"
import { validateChangeset } from "../core/validation"

function newId(): string {
  const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return globalCrypto?.randomUUID ? globalCrypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

/** Reference adapter for isolated development and tests. */
export class InMemoryGanttAdapter<TContext = unknown> implements GanttDataAdapter<TContext> {
  private dataset: GanttDataset
  readonly policy: GanttDomainPolicy

  constructor(dataset: GanttDataset, policy: GanttDomainPolicy = permissivePolicy) {
    this.dataset = structuredClone(dataset)
    this.policy = policy
  }

  async load(): Promise<GanttDataset> {
    return structuredClone(this.dataset)
  }

  async validate(_context: TContext, changeset: GanttChangeset): Promise<GanttValidationResult> {
    return validateChangeset(this.dataset, changeset, this.policy)
  }

  async save(_context: TContext, changeset: GanttChangeset): Promise<GanttSaveResult> {
    const next = structuredClone(this.dataset)
    const idMap: Record<string, string> = {}

    for (const created of changeset.createdTasks) {
      const realId = newId()
      idMap[created.id] = realId
      next.tasks.push({ ...structuredClone(created), id: realId, isTemporary: false })
    }
    const remap = (id: string): string => idMap[id] ?? id
    for (const task of next.tasks) if (task.parentId) task.parentId = remap(task.parentId)

    for (const item of changeset.updatedTasks) {
      const task = next.tasks.find((candidate) => candidate.id === item.id)
      if (task) Object.assign(task, structuredClone(item.changes))
    }
    for (const item of changeset.movedTasks) {
      const task = next.tasks.find((candidate) => candidate.id === remap(item.id))
      if (task) Object.assign(task, { parentId: item.parentId ? remap(item.parentId) : null, order: item.order })
    }
    const deleted = new Set(changeset.deletedTaskIds)
    next.tasks = next.tasks.filter((task) => !deleted.has(task.id))

    const links = (next.dependencies ?? []).filter(
      (dependency) => !deleted.has(dependency.predecessorId) && !deleted.has(dependency.successorId),
    )
    const removed = new Set(changeset.deletedDependencies.map(dependencyKey))
    const changed = new Map(changeset.updatedDependencies.map((dependency) => [dependencyKey(dependency), dependency]))
    next.dependencies = [
      ...links
        .filter((dependency) => !removed.has(dependencyKey(dependency)))
        .map((dependency) => changed.get(dependencyKey(dependency)) ?? dependency),
      ...changeset.createdDependencies.map((dependency) => ({
        ...dependency,
        id: dependency.id ?? newId(),
        predecessorId: remap(dependency.predecessorId),
        successorId: remap(dependency.successorId),
      })),
    ]

    this.dataset = next
    return { success: true, idMap, dataset: structuredClone(next) }
  }
}
