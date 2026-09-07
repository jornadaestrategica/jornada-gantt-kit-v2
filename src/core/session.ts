import { buildChangeset, isChangesetEmpty } from "./changeset"
import {
  dependencyKey,
  parsePredecessorText,
  planDisconnection,
  planSmartConnection,
  type SmartLinkOptions,
  type SmartLinkPlan,
} from "./dependencies"
import { applyRollups, computeWbs, descendantIds, indexTasks, normalizeOrders, previousSibling, topMostInVisualOrder } from "./hierarchy"
import { endFromDuration, inclusiveDuration, startOfCivilDay } from "./date"
import { isFieldEditable, permissivePolicy, type GanttDomainPolicy, type PolicyContext } from "./policy"
import type { GanttChangeset, GanttDataset, GanttDependency, GanttTask, GanttTaskPatch, TaskId } from "./types"

const clone = <T>(value: T): T => structuredClone(value)

export interface StructuralRejection {
  taskId: TaskId
  code: string
  message: string
}

export interface StructuralResult {
  applied: TaskId[]
  rejected: StructuralRejection[]
}

export interface IndentOptions {
  /** Builds the group used when the row above cannot be a parent. */
  autoGroup?: (task: GanttTask) => Partial<GanttTask> & Pick<GanttTask, "title">
}

export interface GanttSessionOptions {
  policy?: GanttDomainPolicy
  /** Deleting a summary row also deletes its subtree. Default true. */
  cascadeDelete?: boolean
  /** Recompute summary bars locally. Default true. */
  autoRollup?: boolean
  historyLimit?: number
  newIdFactory?: () => string
}

function defaultId(): string {
  const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (globalCrypto?.randomUUID) return globalCrypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Transactional working copy of a dataset.
 *
 * Everything the user does lands here first, never straight in the host. Undo/redo,
 * the dirty flag and the changeset are all derived from the same two snapshots, so
 * there is exactly one source of truth and no second stack to fall out of sync.
 */
export class GanttSession {
  private original: GanttDataset
  private current: GanttDataset
  private past: GanttDataset[] = []
  private future: GanttDataset[] = []
  private depth = 0
  private pending: GanttDataset | null = null
  private version = 0
  readonly policy: GanttDomainPolicy
  private readonly cascadeDelete: boolean
  private readonly autoRollup: boolean
  private readonly historyLimit: number
  private readonly newId: () => string

  constructor(dataset: GanttDataset, options: GanttSessionOptions = {}) {
    this.policy = options.policy ?? permissivePolicy
    this.cascadeDelete = options.cascadeDelete ?? true
    this.autoRollup = options.autoRollup ?? true
    this.historyLimit = options.historyLimit ?? 100
    this.newId = options.newIdFactory ?? defaultId
    const normalized = this.normalize(clone(dataset))
    this.original = clone(normalized)
    this.current = normalized
  }

  get dataset(): GanttDataset {
    return clone(this.current)
  }

  get revision(): number { return this.version }

  get tasks(): GanttTask[] {
    return this.current.tasks
  }

  get dependencies(): GanttDependency[] {
    return this.current.dependencies ?? []
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  get changeset(): GanttChangeset {
    return buildChangeset(this.original, this.current)
  }

  get dirty(): boolean {
    const changeset = this.changeset
    return (
      changeset.createdTasks.length > 0 ||
      changeset.updatedTasks.length > 0 ||
      changeset.deletedTaskIds.length > 0 ||
      changeset.movedTasks.length > 0 ||
      changeset.createdDependencies.length > 0 ||
      changeset.updatedDependencies.length > 0 ||
      changeset.deletedDependencies.length > 0
    )
  }

  private normalize(dataset: GanttDataset): GanttDataset {
    normalizeOrders(dataset.tasks)
    if (this.autoRollup) applyRollups(dataset.tasks)
    computeWbs(dataset.tasks)
    return dataset
  }

  private commit(mutator: (draft: GanttDataset) => void): void {
    if (this.depth > 0) {
      mutator(this.pending as GanttDataset)
      return
    }
    const before = clone(this.current)
    const draft = clone(this.current)
    mutator(draft)
    this.push(before, this.normalize(draft))
  }

  private push(before: GanttDataset, next: GanttDataset): void {
    if (isChangesetEmpty(buildChangeset(before, next))) return
    this.past.push(before)
    if (this.past.length > this.historyLimit) this.past.shift()
    this.current = next
    this.future = []
    this.version += 1
  }

  /** Groups several mutations into a single undo step. */
  transact<T>(body: () => T): T {
    if (this.depth > 0) return body()
    const before = clone(this.current)
    this.pending = clone(this.current)
    this.depth = 1
    try {
      const result = body()
      const draft = this.pending as GanttDataset
      this.push(before, this.normalize(draft))
      return result
    } finally {
      this.depth = 0
      this.pending = null
    }
  }

  // ---------------------------------------------------------------- rows

  updateTask(id: TaskId, patch: GanttTaskPatch): void {
    this.commit((draft) => {
      const task = draft.tasks.find((item) => item.id === id)
      if (!task) throw new Error("A linha editada não existe mais no plano.")
      const context: PolicyContext = { index: indexTasks(draft.tasks) }
      for (const [field, value] of Object.entries(patch)) {
        if (field === "id" || field === "wbs") continue
        if (!isFieldEditable(this.policy, task, field, context)) continue
        ;(task as unknown as Record<string, unknown>)[field] = value
      }
      if (task.kind === "milestone") {
        if (task.startDate) task.endDate = task.startDate
        task.duration = 0
        return
      }
      if (patch.duration != null && patch.endDate === undefined && task.startDate) {
        task.endDate = endFromDuration(task.startDate, patch.duration)
      } else if (patch.duration === undefined && (patch.startDate !== undefined || patch.endDate !== undefined) && task.startDate && task.endDate) {
        task.duration = inclusiveDuration(task.startDate, task.endDate)
      }
    })
  }

  /**
   * Creates a row after asking the policy whether the requested parent is legal.
   *
   * Validating here rather than at save time is what stops a user from building a
   * structure the host can never accept — the refusal arrives on the click that would
   * have created it, not minutes later on a rejected sync.
   */
  createTask(input: Partial<GanttTask> & Pick<GanttTask, "title">): TaskId {
    if (input.parentId != null) {
      // Inside a transaction the draft, not `current`, is the state being built.
      const source = this.depth > 0 ? (this.pending as GanttDataset) : this.current
      const index = indexTasks(source.tasks)
      const parent = index.byId.get(input.parentId)
      if (!parent) throw new Error("A linha selecionada como pai não existe mais no plano.")
      const candidate = { ...input, id: "new:probe", parentId: input.parentId } as GanttTask
      const decision = this.policy.canBeChildOf(candidate, parent, { index })
      if (!decision.allowed) throw new Error(decision.message ?? "Não é possível criar um item aqui.")
      if (decision.redirectParentId !== undefined) input = { ...input, parentId: decision.redirectParentId }
      const depth = (index.depth.get(parent.id) ?? 0) + 1
      if (this.policy.maxDepth != null && depth >= this.policy.maxDepth) {
        throw new Error(`A hierarquia aceita no máximo ${this.policy.maxDepth} níveis.`)
      }
    }
    const id = `new:${input.entityType ? `${input.entityType}:` : ""}${this.newId()}`
    const kind = input.kind ?? "task"
    const startDate = input.startDate !== undefined
      ? (input.startDate === null ? null : startOfCivilDay(input.startDate))
      : kind === "group" ? null : startOfCivilDay(new Date())
    const duration = kind === "group" ? null : kind === "milestone" ? 0 : Math.max(1, Math.round(input.duration ?? 1))
    const task: GanttTask = {
      parentId: null,
      order: Number.MAX_SAFE_INTEGER,
      entityType: input.entityType,
      durationUnit: "day",
      progress: 0,
      responsibleId: null,
      responsibleName: null,
      ...input,
      id,
      kind,
      startDate,
      endDate:
        kind === "group"
          ? (input.endDate ?? null)
          : kind === "milestone"
            ? startDate
            : (input.endDate ?? (startDate ? endFromDuration(startDate, duration ?? 1) : null)),
      duration,
      isTemporary: true,
    }
    this.commit((draft) => {
      draft.tasks.push(task)
    })
    return id
  }

  createGroup(title = "Nova entrega", parentId: TaskId | null = null, entityType?: string): TaskId {
    return this.createTask({ title, parentId, entityType, kind: "group", startDate: null, endDate: null, duration: null })
  }

  createMilestone(title = "Novo marco", parentId: TaskId | null = null, entityType?: string): TaskId {
    const today = new Date()
    return this.createTask({ title, parentId, entityType, kind: "milestone", startDate: today, endDate: today, duration: 0 })
  }

  /** Inserts a sibling directly below `siblingId`, the way Enter behaves in MS Project. */
  createSiblingBelow(siblingId: TaskId, input: Partial<GanttTask> & Pick<GanttTask, "title">): TaskId | null {
    const reference = this.current.tasks.find((task) => task.id === siblingId)
    if (!reference) return null
    return this.transact(() => {
      const id = this.createTask({ ...input, parentId: reference.parentId, entityType: input.entityType ?? reference.entityType })
      const draft = this.pending as GanttDataset
      const created = draft.tasks.find((task) => task.id === id)
      if (created) created.order = reference.order + 0.5
      return id
    })
  }

  deleteTasks(ids: TaskId[]): StructuralResult {
    const result: StructuralResult = { applied: [], rejected: [] }
    const index = indexTasks(this.current.tasks)
    const context: PolicyContext = { index }
    const removing = new Set<TaskId>()
    
    // Take a snapshot of the tree to check for children
    const originalTasks = [...this.current.tasks]
    const hasChildren = (id: string) =>
      originalTasks.some((task) => task.parentId === id)
    
    for (const id of ids) {
      const task = index.byId.get(id)
      if (!task) continue
      
      // Check if it's a container with children
      const isContainer = task.kind === "group" || task.entityType === "entrega"
      if (isContainer && hasChildren(task.id)) {
        result.rejected.push({
          taskId: id,
          code: "CONTAINER_NOT_EMPTY",
          message: `"${task.title}" possui atividades ou grupos internos e não pode ser excluído.`,
        })
        continue
      }
      
      const decision = this.policy.canDelete?.(task, context)
      if (decision && !decision.allowed) {
        result.rejected.push({ taskId: id, code: decision.code ?? "POLICY", message: decision.message ?? "Exclusão não permitida." })
        continue
      }
      removing.add(id)
      if (this.cascadeDelete) for (const child of descendantIds(index, id)) removing.add(child)
    }
    if (!removing.size) return result
    result.applied = [...removing]
    this.commit((draft) => {
      if (!this.cascadeDelete) {
        for (const id of removing) {
          const task = draft.tasks.find((item) => item.id === id)
          if (!task) continue
          for (const child of draft.tasks.filter((item) => item.parentId === id && !removing.has(item.id))) {
            child.parentId = task.parentId
          }
        }
      }
      draft.tasks = draft.tasks.filter((item) => !removing.has(item.id))
      draft.dependencies = (draft.dependencies ?? []).filter(
        (dependency) => !removing.has(dependency.predecessorId) && !removing.has(dependency.successorId),
      )
    })
    return result
  }

  // ---------------------------------------------------- hierarchy

  private reparent(draft: GanttDataset, taskId: TaskId, parentId: TaskId | null, order: number): void {
    const task = draft.tasks.find((item) => item.id === taskId)
    if (!task) return
    task.parentId = parentId
    task.order = order
  }

  /**
   * Demotes rows under the sibling above them.
   *
   * The selection is collapsed to its top-most members so a subtree moves once, and
   * each candidate is offered to the domain policy, which may accept, refuse with a
   * reason, or redirect to a different parent when the literal target is not
   * representable in the host schema.
   */
  indent(taskIds: TaskId[], options: IndentOptions = {}): StructuralResult {
    const result: StructuralResult = { applied: [], rejected: [] }
    const selected = topMostInVisualOrder(indexTasks(this.current.tasks), taskIds).map((task) => task.id)
    this.transact(() => {
      for (const id of selected) {
        const draft = this.pending as GanttDataset
        const index = indexTasks(draft.tasks)
        const context: PolicyContext = { index }
        const task = index.byId.get(id)
        if (!task) continue

        const target = previousSibling(index, id)
        if (!target) {
          result.rejected.push({ taskId: id, code: "NO_PREVIOUS_SIBLING", message: `"${task.title}" já é a primeira linha do seu nível.` })
          continue
        }
        const depth = (index.depth.get(target.id) ?? 0) + 1
        if (this.policy.maxDepth != null && depth > this.policy.maxDepth) {
          result.rejected.push({ taskId: id, code: "MAX_DEPTH", message: `A hierarquia aceita no máximo ${this.policy.maxDepth + 1} níveis.` })
          continue
        }
        const decision = this.policy.canBeChildOf(task, target, context)
        if (!decision.allowed) {
          /*
           * The row above cannot be a parent — typically one activity indented under
           * another, which the schema forbids. Rather than refusing the gesture, insert a
           * group where the row sits and put the row inside it. Everything happens in the
           * surrounding transaction, so it is a single undo step.
           */
          const grouped = decision.code === "ACTIVITY_UNDER_ACTIVITY" && options.autoGroup
            ? this.groupInPlace(task, target, options.autoGroup, result)
            : false
          if (grouped) {
            result.applied.push(id)
            continue
          }
          result.rejected.push({ taskId: id, code: decision.code ?? "POLICY", message: decision.message ?? "Recuo não permitido." })
          continue
        }
        const parentId = decision.redirectParentId !== undefined ? decision.redirectParentId : target.id
        if (parentId === task.parentId) {
          result.rejected.push({ taskId: id, code: "NO_OP", message: `"${task.title}" já está sob esse pai.` })
          continue
        }
        const siblings = index.childrenOf.get(parentId) ?? []
        this.reparent(draft, id, parentId, siblings.length)
        result.applied.push(id)
      }
    })
    return result
  }

  /** Promotes rows one level, re-inserting them directly after their former parent. */
  outdent(taskIds: TaskId[]): StructuralResult {
    const result: StructuralResult = { applied: [], rejected: [] }
    const selected = topMostInVisualOrder(indexTasks(this.current.tasks), taskIds).map((task) => task.id)
    this.transact(() => {
      const ordered = selected.reverse()
      for (const id of ordered) {
        const draft = this.pending as GanttDataset
        const index = indexTasks(draft.tasks)
        const context: PolicyContext = { index }
        const task = index.byId.get(id)
        if (!task) continue
        if (task.parentId == null) {
          result.rejected.push({ taskId: id, code: "ALREADY_ROOT", message: `"${task.title}" já está no nível raiz.` })
          continue
        }
        const parent = index.byId.get(task.parentId)
        const grandParentId = parent?.parentId ?? null
        const grandParent = grandParentId != null ? (index.byId.get(grandParentId) ?? null) : null
        const decision = this.policy.canBeChildOf(task, grandParent, context)
        if (!decision.allowed) {
          result.rejected.push({ taskId: id, code: decision.code ?? "POLICY", message: decision.message ?? "Recuo à esquerda não permitido." })
          continue
        }
        const parentId = decision.redirectParentId !== undefined ? decision.redirectParentId : grandParentId
        this.reparent(draft, id, parentId, (parent?.order ?? 0) + 0.5)
        result.applied.push(id)
      }
    })
    return result
  }

  /**
   * Wraps `task` in a freshly created group that takes the row's own place among its
   * siblings. Returns false when the group itself would be illegal there.
   */
  private groupInPlace(
    task: GanttTask,
    target: GanttTask,
    factory: (task: GanttTask) => Partial<GanttTask> & Pick<GanttTask, "title">,
    result: StructuralResult,
  ): boolean {
    const draft = this.pending as GanttDataset
    const index = indexTasks(draft.tasks)
    const parent = target.parentId != null ? (index.byId.get(target.parentId) ?? null) : null
    const blueprint = factory(task)
    const probe = { ...blueprint, id: "new:probe", parentId: target.parentId } as GanttTask
    const decision = this.policy.canBeChildOf(probe, parent, { index })
    if (!decision.allowed) {
      result.rejected.push({
        taskId: task.id,
        code: decision.code ?? "POLICY",
        message: decision.message ?? "Não foi possível criar um grupo aqui.",
      })
      return false
    }
    const groupId = this.createTask({ ...blueprint, parentId: target.parentId })
    const created = (this.pending as GanttDataset).tasks.find((item) => item.id === groupId)
    if (created) created.order = task.order
    this.reparent(this.pending as GanttDataset, task.id, groupId, 0)
    return true
  }

  /** Explicit move used by row drag-and-drop. Validated exactly like indent. */
  moveTask(id: TaskId, parentId: TaskId | null, order: number): StructuralResult {
    const result: StructuralResult = { applied: [], rejected: [] }
    const index = indexTasks(this.current.tasks)
    const task = index.byId.get(id)
    if (!task) return result
    const parent = parentId != null ? (index.byId.get(parentId) ?? null) : null
    if (parentId != null && (parentId === id || descendantIds(index, id).includes(parentId))) {
      result.rejected.push({ taskId: id, code: "CYCLE", message: `"${task.title}" não pode ser movida para dentro de si mesma.` })
      return result
    }
    const decision = this.policy.canBeChildOf(task, parent, { index })
    if (!decision.allowed) {
      result.rejected.push({ taskId: id, code: decision.code ?? "POLICY", message: decision.message ?? "Movimento não permitido." })
      return result
    }
    const effectiveParent = decision.redirectParentId !== undefined ? decision.redirectParentId : parentId
    this.commit((draft) => this.reparent(draft, id, effectiveParent, order))
    result.applied.push(id)
    return result
  }

  /** Reorders a row among its own siblings without changing its parent. */
  reorderWithinParent(id: TaskId, targetIndex: number): void {
    this.commit((draft) => {
      const task = draft.tasks.find((item) => item.id === id)
      if (task) task.order = targetIndex - 0.5
    })
  }

  // -------------------------------------------------- dependencies

  addDependency(dependency: GanttDependency): void {
    this.commit((draft) => {
      const list = draft.dependencies ?? []
      const key = dependencyKey(dependency)
      draft.dependencies = [...list.filter((item) => dependencyKey(item) !== key), { ...dependency }]
    })
  }

  removeDependency(dependency: GanttDependency): void {
    const key = dependencyKey(dependency)
    this.commit((draft) => {
      draft.dependencies = (draft.dependencies ?? []).filter((item) => dependencyKey(item) !== key)
    })
  }

  /** Applies the grid's predecessor cell for one row, replacing that row's inbound links. */
  replaceIncoming(successorId: TaskId, incoming: GanttDependency[]): void {
    this.commit((draft) => {
      const others = (draft.dependencies ?? []).filter((item) => item.successorId !== successorId)
      const previous = new Map((draft.dependencies ?? []).map((item) => [dependencyKey(item), item]))
      const accepted: GanttDependency[] = []
      for (const item of incoming) {
        if (item.successorId !== successorId) throw new Error("Vínculo com sucessora incorreta.")
        const plan = planSmartConnection(draft.tasks, [...others, ...accepted],
          [item.predecessorId, successorId], this.policy, {
            type: item.type, lag: item.lag ?? 0, useVisualOrder: false,
          })
        if (plan.rejected.length) throw new Error(plan.rejected[0].message)
        accepted.push({ ...item, id: previous.get(dependencyKey(item))?.id ?? item.id })
      }
      draft.dependencies = [...others, ...accepted]
    })
  }

  setPredecessorText(successorId: TaskId, text: string | null | undefined): SmartLinkPlan {
    const parsed = parsePredecessorText(text, successorId)
    const index = indexTasks(this.current.tasks)
    const context: PolicyContext = { index }
    const successor = index.byId.get(successorId)
    const plan: SmartLinkPlan = { created: [], updated: [], removed: [], rejected: [], sequence: [successorId] }
    if (!successor) return plan

    const accepted: GanttDependency[] = []
    for (const candidate of parsed) {
      const predecessor = index.byId.get(candidate.predecessorId)
      if (!predecessor) {
        plan.rejected.push({ ...candidate, code: "UNKNOWN_PREDECESSOR", message: `Predecessora "${candidate.predecessorId}" não existe.` })
        continue
      }
      const decision = this.policy.canLink(predecessor, successor, candidate.type, context)
      if (!decision.allowed) {
        plan.rejected.push({ ...candidate, code: decision.code ?? "POLICY", message: decision.message ?? "Vínculo não permitido." })
        continue
      }
      accepted.push(candidate)
    }

    if (plan.rejected.length) return plan
    this.replaceIncoming(successorId, accepted)
    plan.created = accepted
    return plan
  }

  /** One-gesture connection of the whole selection. */
  connectSelection(taskIds: TaskId[], options: SmartLinkOptions = {}): SmartLinkPlan {
    const plan = planSmartConnection(this.current.tasks, this.dependencies, taskIds, this.policy, options)
    if (!plan.created.length && !plan.updated.length) return plan
    this.commit((draft) => {
      const list = draft.dependencies ?? []
      const updatedKeys = new Set(plan.updated.map(dependencyKey))
      draft.dependencies = [
        ...list.filter((item) => !updatedKeys.has(dependencyKey(item))),
        ...plan.updated,
        ...plan.created,
      ]
    })
    return plan
  }

  /** Removes every link inside the selection, or all links of a single selected row. */
  disconnectSelection(taskIds: TaskId[]): GanttDependency[] {
    const removed = planDisconnection(this.current.tasks, this.dependencies, taskIds)
    if (!removed.length) return removed
    const keys = new Set(removed.map(dependencyKey))
    this.commit((draft) => {
      draft.dependencies = (draft.dependencies ?? []).filter((item) => !keys.has(dependencyKey(item)))
    })
    return removed
  }
  /** Creates independent FS chains, one per parent, using current visual order. */
  autoSequenceUnlinked(): SmartLinkPlan {
    const plan: SmartLinkPlan = { created: [], updated: [], removed: [], rejected: [], sequence: [] }
    const index = indexTasks(this.current.tasks)
    const hasIncoming = new Set(this.dependencies.map((item) => item.successorId))
    const groups = new Map<TaskId | null, TaskId[]>()
    for (const task of index.visual) {
      if (task.kind !== "task" || hasIncoming.has(task.id)) continue
      const bucket = groups.get(task.parentId) ?? []
      bucket.push(task.id)
      groups.set(task.parentId, bucket)
    }
    this.transact(() => {
      for (const ids of groups.values()) {
        if (ids.length < 2) continue
        const partial = this.connectSelection(ids, { strategy: "chain", type: "FS", useVisualOrder: true })
        plan.created.push(...partial.created)
        plan.updated.push(...partial.updated)
        plan.removed.push(...partial.removed)
        plan.rejected.push(...partial.rejected)
        plan.sequence.push(...partial.sequence)
      }
    })
    return plan
  }

  // ------------------------------------------------------- history

  undo(): void {
    const previous = this.past.pop()
    if (!previous) return
    this.future.push(clone(this.current))
    this.current = previous
    this.version += 1
  }

  redo(): void {
    const next = this.future.pop()
    if (!next) return
    this.past.push(clone(this.current))
    this.current = next
    this.version += 1
  }

  /** Discards every local change and returns to the last loaded/saved state. */
  revert(): void {
    if (!this.dirty) return
    const before = clone(this.current)
    this.current = clone(this.original)
    this.past.push(before)
    if (this.past.length > this.historyLimit) this.past.shift()
    this.future = []
    this.version += 1
  }

  resetHistory(): void {
    this.past = []
    this.future = []
  }

  /** Adopts the authoritative post-save dataset and clears the dirty state. */
  reconcile(dataset: GanttDataset): void {
    const normalized = this.normalize(clone(dataset))
    this.original = clone(normalized)
    this.current = normalized
    this.resetHistory()
    this.version += 1
  }

  /**
   * Rewrites temporary ids to host primary keys in place, for adapters that return an
   * `idMap` without a full dataset.
   */
  applyIdMap(idMap: Record<string, string>): void {
    if (!Object.keys(idMap).length) return
    const remap = (id: TaskId): TaskId => idMap[id] ?? id
    this.current.tasks = this.current.tasks.map((task) => ({
      ...task,
      id: remap(task.id),
      parentId: task.parentId == null ? null : remap(task.parentId),
      isTemporary: idMap[task.id] ? false : task.isTemporary,
    }))
    this.current.dependencies = (this.current.dependencies ?? []).map((dependency) => ({
      ...dependency,
      predecessorId: remap(dependency.predecessorId),
      successorId: remap(dependency.successorId),
    }))
    this.reconcile(this.current)
  }
}
