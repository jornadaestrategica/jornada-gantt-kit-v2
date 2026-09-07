import { formatCivilTimestamp } from "../../core/date"
import type { GanttChangeset, GanttDependency, GanttTask, TaskId } from "../../core/types"
import {
  ENTITY_ATIVIDADE,
  ENTITY_ENTREGA,
  hostKey,
  isTemporaryId,
  parseId,
  type JornadaEntity,
  type ParsedId,
} from "./ids"
import type { Uuid } from "./schema"
import { normalizePrioridade, normalizeStatus } from "./status"
import { entregaTypes } from "./catalog"

export interface EntregaWrite {
  /** Local id while the row is new; the host echoes it back in `idMap`. */
  ref: TaskId
  id: Uuid | null
  values: Record<string, unknown>
  rowVersion?: string | null
}

export interface AtividadeWrite {
  ref: TaskId
  id: Uuid | null
  values: Record<string, unknown>
  rowVersion?: string | null
}

export interface VinculoWrite {
  id: Uuid | null
  /** Successor. Always an activity ref. */
  atividadeRef: TaskId
  /** Exactly one of these two is populated, mirroring chk_vinculo_exclusivo. */
  predecessoraRef: TaskId | null
  resultadoEntregaRef: TaskId | null
  tipo_vinculo: GanttDependency["type"]
  lag: number
}

export interface ReorderWrite {
  entity: JornadaEntity
  ref: TaskId
  ordem: number
}

export interface SyncPlanIssue {
  code: string
  message: string
  taskId?: TaskId
}

/**
 * A database-shaped, order-safe description of one save. Nothing here talks to a
 * transport: the plan is pure data, which is what makes it testable and what lets the
 * same changeset be executed by Supabase, a REST endpoint or a single RPC.
 */
export interface JornadaSyncPlan {
  /** Executed in exactly this order. Every step is safe against the FK graph. */
  deleteVinculos: Uuid[]
  deleteAtividades: Uuid[]
  /** Deepest first, so a parent is never removed while a child still points at it. */
  deleteEntregas: Uuid[]
  /** Parents first, so parent_id is resolvable at insert time. */
  insertEntregas: EntregaWrite[]
  insertAtividades: AtividadeWrite[]
  updateEntregas: EntregaWrite[]
  updateAtividades: AtividadeWrite[]
  reorder: ReorderWrite[]
  /** Written last: a link may reference rows created earlier in the same plan. */
  upsertVinculos: VinculoWrite[]
  issues: SyncPlanIssue[]
  /** Refs the host must return in `idMap`. */
  pendingRefs: TaskId[]
  presentation: Array<{
    ref: TaskId
    milestoneDate?: string | null
    milestoneLabel?: string | null
  }>
}

function emptyPlan(): JornadaSyncPlan {
  return {
    deleteVinculos: [],
    deleteAtividades: [],
    deleteEntregas: [],
    insertEntregas: [],
    insertAtividades: [],
    updateEntregas: [],
    updateAtividades: [],
    reorder: [],
    upsertVinculos: [],
    issues: [],
    pendingRefs: [],
    presentation: [],
  }
}

export interface BuildPlanOptions {
  planoId?: Uuid | null
  /** Fallback owner for new activities; tb_atividade.pessoa_id is NOT NULL. */
  defaultPessoaId?: Uuid | null
  dateSource?: "previsto" | "realizado"
  /** Emit an `ordem` write for every moved row. */
  persistOrder?: boolean
  presentationSupported?: boolean
}

function entityOfTask(task: { id: TaskId; entityType?: string }): JornadaEntity {
  const declared = task.entityType as JornadaEntity | undefined
  if (declared === ENTITY_ENTREGA || declared === ENTITY_ATIVIDADE) return declared
  return parseId(task.id)?.entity ?? ENTITY_ATIVIDADE
}

function dateColumns(source: "previsto" | "realizado"): { start: string; end: string } {
  return source === "realizado"
    ? { start: "dtinicio", end: "dttermino" }
    : { start: "dtinicio_previsto", end: "dttermino_previsto" }
}

/** Deliverables in parent-before-child order, so inserts can resolve parent_id. */
function topologicalEntregas(created: GanttTask[]): GanttTask[] {
  const pending = new Map(created.map((task) => [task.id, task]))
  const emitted = new Set<TaskId>()
  const result: GanttTask[] = []
  let progressed = true
  while (pending.size && progressed) {
    progressed = false
    for (const [id, task] of [...pending]) {
      const parentId = task.parentId
      const parentIsPending = parentId != null && pending.has(parentId) && !emitted.has(parentId)
      if (parentIsPending) continue
      result.push(task)
      emitted.add(id)
      pending.delete(id)
      progressed = true
    }
  }
  // A cycle among brand-new rows cannot happen through the UI, but if it somehow
  // does, emit the remainder flat rather than dropping rows.
  result.push(...pending.values())
  return result
}

function entregaValues(_task: GanttTask, patch: Partial<GanttTask>, options: BuildPlanOptions): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  if (patch.title !== undefined) values.titulo = patch.title
  if (patch.status !== undefined) values.status = normalizeStatus(ENTITY_ENTREGA, patch.status).value
  if (patch.priority !== undefined) values.prioridade = normalizePrioridade(ENTITY_ENTREGA, patch.priority).value
  if (patch.responsibleId !== undefined) values.pessoa_id = patch.responsibleId
  if (patch.storyPoints !== undefined) values.story_points = patch.storyPoints
  if (patch.color !== undefined) values.cor = patch.color
  if (patch.tags !== undefined) values.tags = patch.tags
  if (patch.notes !== undefined) values.criterios_aceite = patch.notes
  if (patch.effort !== undefined) values.esforco_horas = patch.effort
  if (patch.businessType !== undefined) values.tipo = patch.businessType
  if (patch.isSummary !== undefined) values.eh_agrupador = patch.isSummary
  if (patch.showMilestone !== undefined) values.exibir_marco = patch.showMilestone
  if (options.planoId !== undefined && options.planoId !== null) values.plano_id = options.planoId
  return values
}

function atividadeValues(_task: GanttTask, patch: Partial<GanttTask>, options: BuildPlanOptions): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  const columns = dateColumns(options.dateSource ?? "previsto")
  if (patch.title !== undefined) values.titulo = patch.title
  if (patch.notes !== undefined) values.descricao = patch.notes
  if (patch.status !== undefined) values.status = normalizeStatus(ENTITY_ATIVIDADE, patch.status).value
  if (patch.priority !== undefined) values.prioridade = normalizePrioridade(ENTITY_ATIVIDADE, patch.priority).value
  if (patch.responsibleId !== undefined) values.pessoa_id = patch.responsibleId
  if (patch.progress !== undefined) values.avanco = patch.progress
  if (patch.weight !== undefined) values.peso = patch.weight
  if (patch.effort !== undefined) values.esforco = patch.effort
  if (patch.storyPoints !== undefined) values.story_points = patch.storyPoints
  if (patch.color !== undefined) values.cor = patch.color
  if (patch.tags !== undefined) values.tag = patch.tags
  if (patch.startDate !== undefined) values[columns.start] = formatCivilTimestamp(patch.startDate ?? null)
  if (patch.endDate !== undefined) values[columns.end] = formatCivilTimestamp(patch.endDate ?? null)
  if (options.planoId !== undefined) values.plano_id = options.planoId
  return values
}

/**
 * Translates a changeset into ordered database work.
 *
 * Three invariants are enforced here rather than left to the caller: a deleted
 * parent's children go first, a created parent is inserted before anything that
 * points at it, and links are written only after both endpoints certainly exist.
 * Any change that cannot be expressed against the schema is reported as an issue
 * instead of being written as a best guess.
 */
export function buildSyncPlan(
  changeset: GanttChangeset,
  currentTasks: GanttTask[],
  options: BuildPlanOptions = {},
): JornadaSyncPlan {
  const plan = emptyPlan()
  const byId = new Map(currentTasks.map((task) => [task.id, task]))
  const persistOrder = options.persistOrder ?? true
  const typeChanges = [
    ...changeset.createdTasks.map((task) => ({ id: task.id, type: task.businessType ?? task.metadata?.tipo ?? "Entrega" })),
    ...changeset.updatedTasks.filter((update) => update.changes.businessType !== undefined)
      .map((update) => ({ id: update.id, type: update.changes.businessType })),
  ]
  for (const change of typeChanges) {
    const task = byId.get(change.id)
    if (task && entityOfTask(task) === ENTITY_ENTREGA &&
        !entregaTypes.some((item) => item.value === change.type)) {
      plan.issues.push({ code: "INVALID_DELIVERY_TYPE", taskId: change.id,
        message: `Tipo de entrega não suportado: ${String(change.type)}. Marco e Grupo são representações, não novos tipos do banco.` })
    }
  }

  // ---- deletions, children before parents -------------------------------
  const deletedEntregas: Array<{ id: Uuid; depth: number }> = []
  const depthOf = (id: TaskId): number => {
    let depth = 0
    let cursor = byId.get(id)?.parentId ?? null
    while (cursor && depth < 50) {
      depth += 1
      cursor = byId.get(cursor)?.parentId ?? null
    }
    return depth
  }
  for (const id of changeset.deletedTaskIds) {
    const parsed = parseId(id)
    if (!parsed || parsed.isNew || !parsed.key) continue
    if (parsed.entity === ENTITY_ATIVIDADE) plan.deleteAtividades.push(parsed.key)
    else deletedEntregas.push({ id: parsed.key, depth: depthOf(id) })
  }
  deletedEntregas.sort((a, b) => b.depth - a.depth)
  plan.deleteEntregas = deletedEntregas.map((item) => item.id)

  for (const dependency of changeset.deletedDependencies) {
    if (dependency.id) plan.deleteVinculos.push(dependency.id)
  }

  // ---- creations ---------------------------------------------------------
  const createdEntregas = changeset.createdTasks.filter((task) => entityOfTask(task) === ENTITY_ENTREGA)
  const createdAtividades = changeset.createdTasks.filter((task) => entityOfTask(task) === ENTITY_ATIVIDADE)

  for (const task of topologicalEntregas(createdEntregas)) {
    const values = entregaValues(task, task, options)
    values.titulo = task.title
    values.tipo = task.businessType ?? task.metadata?.tipo ?? "Entrega"
    values.eh_agrupador = task.isSummary ?? task.kind !== "milestone"
    values.exibir_marco = task.showMilestone ?? task.kind === "milestone"
    values.parent_id = task.parentId ? { $ref: task.parentId } : null
    values.ordem = task.order
    plan.insertEntregas.push({ ref: task.id, id: hostKey(task.id), values })
    plan.pendingRefs.push(task.id)
  }

  for (const task of createdAtividades) {
    const parent = task.parentId ? byId.get(task.parentId) : undefined
    if (task.parentId && parent && entityOfTask(parent) !== ENTITY_ENTREGA) {
      plan.issues.push({
        code: "ACTIVITY_PARENT_NOT_DELIVERABLE",
        taskId: task.id,
        message: `A atividade "${task.title}" está sob "${parent.title}", que não é uma entrega. tb_atividade.resultado_entrega_id só aceita entregas.`,
      })
      continue
    }
    const values = atividadeValues(task, task, options)
    values.titulo = task.title
    values.resultado_entrega_id = task.parentId ? { $ref: task.parentId } : null
    values.avanco = task.progress ?? 0
    values.status = normalizeStatus(ENTITY_ATIVIDADE, task.status ?? "Prevista").value ?? "Prevista"
    if (values.pessoa_id == null) values.pessoa_id = options.defaultPessoaId ?? null
    if (values.pessoa_id == null) {
      plan.issues.push({
        code: "MISSING_PESSOA_ID",
        taskId: task.id,
        message: `A atividade "${task.title}" precisa de um responsável: tb_atividade.pessoa_id é NOT NULL.`,
      })
      continue
    }
    plan.insertAtividades.push({ ref: task.id, id: hostKey(task.id), values })
    plan.pendingRefs.push(task.id)
  }

  // ---- field updates -----------------------------------------------------
  for (const update of changeset.updatedTasks) {
    const task = byId.get(update.id)
    if (!task) continue
    const parsed = parseId(update.id)
    if (!parsed || parsed.isNew) continue
    if (parsed.entity === ENTITY_ENTREGA) {
      const values = entregaValues(task, update.changes, options)
      if (Object.keys(values).length) {
        plan.updateEntregas.push({ ref: update.id, id: parsed.key, values, rowVersion: update.rowVersion })
      }
    } else {
      const values = atividadeValues(task, update.changes, options)
      if (Object.keys(values).length) {
        plan.updateAtividades.push({ ref: update.id, id: parsed.key, values, rowVersion: update.rowVersion })
      }
    }
  }

  // ---- structural moves: the foreign key IS the outline -------------------
  for (const move of changeset.movedTasks) {
    const task = byId.get(move.id)
    if (!task) continue
    const parsed = parseId(move.id)
    if (!parsed) continue
    const parentChanged = move.parentId !== move.previousParentId
    const parent = move.parentId ? byId.get(move.parentId) : undefined

    if (parsed.entity === ENTITY_ATIVIDADE) {
      if (parentChanged) {
        if (move.parentId && parent && entityOfTask(parent) !== ENTITY_ENTREGA) {
          plan.issues.push({
            code: "ACTIVITY_PARENT_NOT_DELIVERABLE",
            taskId: move.id,
            message: `"${task.title}" não pode ser movida para dentro de "${parent.title}": atividades só se vinculam a entregas.`,
          })
          continue
        }
        const values: Record<string, unknown> = {
          resultado_entrega_id: move.parentId ? { $ref: move.parentId } : null,
        }
        pushUpdate(plan.updateAtividades, move.id, parsed, values, task.rowVersion)
      }
      if (persistOrder) plan.reorder.push({ entity: ENTITY_ATIVIDADE, ref: move.id, ordem: move.order })
      continue
    }

    if (parentChanged) {
      if (move.parentId && parent && entityOfTask(parent) !== ENTITY_ENTREGA) {
        plan.issues.push({
          code: "DELIVERABLE_PARENT_NOT_DELIVERABLE",
          taskId: move.id,
          message: `"${task.title}" não pode ser movida para dentro de "${parent.title}": tb_resultado_entrega.parent_id só aceita entregas.`,
        })
        continue
      }
      pushUpdate(
        plan.updateEntregas,
        move.id,
        parsed,
        { parent_id: move.parentId ? { $ref: move.parentId } : null },
        task.rowVersion,
      )
    }
    if (persistOrder) plan.reorder.push({ entity: ENTITY_ENTREGA, ref: move.id, ordem: move.order })
  }

  // ---- dependencies, written last ---------------------------------------
  for (const dependency of [...changeset.createdDependencies, ...changeset.updatedDependencies]) {
    const predecessorEntity = parseId(dependency.predecessorId)?.entity ?? ENTITY_ATIVIDADE
    const successorEntity = parseId(dependency.successorId)?.entity ?? ENTITY_ATIVIDADE
    if (successorEntity !== ENTITY_ATIVIDADE) {
      plan.issues.push({
        code: "SUCCESSOR_MUST_BE_ACTIVITY",
        taskId: dependency.successorId,
        message: "tb_atividade_vinculo.atividade_id é NOT NULL e só aceita atividades como sucessoras.",
      })
      continue
    }
    plan.upsertVinculos.push({
      id: dependency.id ?? null,
      atividadeRef: dependency.successorId,
      predecessoraRef: predecessorEntity === ENTITY_ATIVIDADE ? dependency.predecessorId : null,
      resultadoEntregaRef: predecessorEntity === ENTITY_ENTREGA ? dependency.predecessorId : null,
      tipo_vinculo: dependency.type,
      lag: dependency.lag ?? 0,
    })
  }

  for (const item of [
    ...changeset.createdTasks.map((task) => ({ id: task.id, changes: task })),
    ...changeset.updatedTasks,
  ]) {
    const task = byId.get(item.id)
    if (!task || entityOfTask(task) !== ENTITY_ENTREGA) continue
    const patch = item.changes
    if (patch.milestoneDate === undefined && patch.milestoneLabel === undefined) continue
    if (!options.presentationSupported) {
      if (patch.milestoneDate != null || patch.milestoneLabel != null) {
        plan.issues.push({
          taskId: item.id, code: "PRESENTATION_STORAGE_REQUIRED",
          message: "O middleware do Jornada precisa oferecer persistência de data/rótulo de marco antes de sincronizá-los.",
        })
      }
      continue
    }
    plan.presentation.push({
      ref: item.id,
      ...(patch.milestoneDate !== undefined ? { milestoneDate: formatCivilTimestamp(patch.milestoneDate) } : {}),
      ...(patch.milestoneLabel !== undefined ? { milestoneLabel: patch.milestoneLabel } : {}),
    })
  }
  return plan
}

function pushUpdate(
  bucket: Array<EntregaWrite | AtividadeWrite>,
  ref: TaskId,
  parsed: ParsedId,
  values: Record<string, unknown>,
  rowVersion?: string | null,
): void {
  const existing = bucket.find((item) => item.ref === ref)
  if (existing) Object.assign(existing.values, values)
  else bucket.push({ ref, id: parsed.key, values, rowVersion })
}

/**
 * Replaces every `{ $ref }` placeholder with the primary key the host assigned.
 * Called after inserts, before updates and link writes are executed.
 */
export function resolveRefs(value: unknown, idMap: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, idMap))
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    if (typeof record.$ref === "string") {
      const ref = record.$ref
      const mapped = idMap[ref]
      if (mapped) return parseId(mapped)?.key ?? mapped
      if (isTemporaryId(ref)) {
        throw new Error(`A linha "${ref}" ainda não tem chave definitiva; o Jornada não devolveu o id do registro criado.`)
      }
      return hostKey(ref)
    }
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(record)) result[key] = resolveRefs(item, idMap)
    return result
  }
  return value
}

export function planIsEmpty(plan: JornadaSyncPlan): boolean {
  return (
    !plan.deleteVinculos.length &&
    !plan.deleteAtividades.length &&
    !plan.deleteEntregas.length &&
    !plan.insertEntregas.length &&
    !plan.insertAtividades.length &&
    !plan.updateEntregas.length &&
    !plan.updateAtividades.length &&
    !plan.reorder.length &&
    !plan.upsertVinculos.length &&
    !plan.presentation.length
  )
}
