import type { GanttCreationOption, GanttDataAdapter, GanttValidationResult } from "../../core/adapter"
import type { GanttDomainPolicy } from "../../core/policy"
import type { GanttChangeset, GanttDataset, GanttResource, GanttSaveResult, TaskId } from "../../core/types"
import { validateChangeset } from "../../core/validation"
import { dependencyKey } from "../../core/dependencies"
import { entregaTypes, jornadaCreationOptions } from "./catalog"
import { statusOptions, prioridadeOptions } from "./status"
import { createJornadaPolicy, type JornadaPolicyOptions } from "./policy"
import { snapshotToDataset, type MappingDiagnostic, type MappingOptions } from "./mapping"
import type { JornadaSnapshot, Uuid } from "./schema"
import { buildSyncPlan, planIsEmpty, type BuildPlanOptions, type JornadaSyncPlan } from "./sync-plan"

export interface JornadaContext {
  planoId?: Uuid | null
  pessoaId?: Uuid | null
}

/**
 * Everything the adapter needs from the outside world. Implement this against
 * Supabase, a Next.js route handler or a single Postgres RPC — the kit does not care,
 * and never imports a database client.
 */
export interface JornadaTransport {
  readonly presentationSupported?: boolean
  fetchSnapshot(context: JornadaContext): Promise<JornadaSnapshot>
  /**
   * Executes the plan. Must be atomic: partially applying a plan leaves dangling
   * foreign keys that the next load will silently re-root.
   *
   * Returns the primary key assigned to each `pendingRef`, as a qualified id.
   */
  applyPlan(context: JornadaContext, plan: JornadaSyncPlan): Promise<{ idMap: Record<string, string> }>
  fetchResources?(context: JornadaContext): Promise<GanttResource[]>
}

export interface JornadaAdapterOptions extends MappingOptions, JornadaPolicyOptions {
  persistOrder?: boolean
  onDiagnostics?: (diagnostics: MappingDiagnostic[]) => void
}

/**
 * Binds the Gantt kit to the Jornada schema.
 *
 * Reading folds tb_resultado_entrega and tb_atividade into one keyed row set; writing
 * unfolds a changeset back into ordered table operations. The kit stays unaware of
 * both tables, and Jornada stays unaware of the Gantt.
 */
export class JornadaGanttAdapter implements GanttDataAdapter<JornadaContext> {
  readonly policy: GanttDomainPolicy
  readonly businessTypeOptions = entregaTypes
  readonly creationOptions: GanttCreationOption[]
  private readonly transport: JornadaTransport
  private readonly options: JornadaAdapterOptions
  private lastTasks: GanttDataset["tasks"] = []
  private lastDependencies: NonNullable<GanttDataset["dependencies"]> = []
  private lastDiagnostics: MappingDiagnostic[] = []

  constructor(transport: JornadaTransport, options: JornadaAdapterOptions = {}) {
    this.transport = transport
    this.options = options
    this.policy = createJornadaPolicy(options)
    this.creationOptions = jornadaCreationOptions.map((option) => ({
      ...option,
      seedMilestoneDate: option.task.kind === "milestone" && transport.presentationSupported === true,
      task: {
        ...option.task,
        ...(option.task.entityType === "entrega" ? {
          startDate: null, endDate: null,
          lockedFields: transport.presentationSupported ? [] : ["milestoneDate", "milestoneLabel"],
        } : {}),
      },
    }))
  }

  get diagnostics(): MappingDiagnostic[] {
    return this.lastDiagnostics
  }

  editOptions(field: "status" | "priority", entityType?: string) {
    const entity = entityType === "entrega" ? "entrega" : "atividade"
    const options = field === "status" ? statusOptions(entity) : prioridadeOptions(entity)
    return options.map((value) => ({ value, label: value }))
  }

  async load(context: JornadaContext): Promise<GanttDataset> {
    const snapshot = await this.transport.fetchSnapshot(context)
    const { dataset, diagnostics } = snapshotToDataset(snapshot, {
      ...this.options, presentationEditable: this.transport.presentationSupported === true,
    })
    dataset.resources = await this.resolveResources(context)
    this.lastTasks = dataset.tasks
    this.lastDependencies = dataset.dependencies ?? []
    this.lastDiagnostics = diagnostics
    if (diagnostics.length) this.options.onDiagnostics?.(diagnostics)
    return dataset
  }

  async validate(_context: JornadaContext, changeset: GanttChangeset): Promise<GanttValidationResult> {
    const deleted = new Set(changeset.deletedTaskIds)
    const removedLinks = new Set(changeset.deletedDependencies.map(dependencyKey))
    const updatedLinks = new Map(changeset.updatedDependencies.map((link) => [dependencyKey(link), link]))
    const dataset: GanttDataset = {
      tasks: this.snapshotTasks(changeset).filter((task) => !deleted.has(task.id)),
      dependencies: [
        ...this.lastDependencies.filter((link) => !removedLinks.has(dependencyKey(link)))
          .map((link) => updatedLinks.get(dependencyKey(link)) ?? link),
        ...changeset.createdDependencies,
      ].filter((link) => !deleted.has(link.predecessorId) && !deleted.has(link.successorId)),
    }
    const base = validateChangeset(dataset, changeset, this.policy)
    const plan = this.plan(changeset, _context)
    return {
      valid: base.valid && !plan.issues.length,
      issues: [
        ...base.issues,
        ...plan.issues.map((issue) => ({
          code: issue.code,
          message: issue.message,
          severity: "error" as const,
          taskId: issue.taskId,
        })),
      ],
    }
  }

  /** Exposed so a host can preview or log exactly what a save will do. */
  plan(changeset: GanttChangeset, context: JornadaContext): JornadaSyncPlan {
    const options: BuildPlanOptions = {
      planoId: context.planoId ?? null,
      defaultPessoaId: context.pessoaId ?? null,
      dateSource: this.options.dateSource,
      persistOrder: this.options.persistOrder ?? true,
      presentationSupported: this.transport.presentationSupported === true,
    }
    return buildSyncPlan(changeset, this.snapshotTasks(changeset), options)
  }

  /**
   * Rows the plan builder needs to reason about: the last loaded state plus anything
   * created locally since, so a move onto a brand-new deliverable still resolves.
   */
  private snapshotTasks(changeset: GanttChangeset): GanttDataset["tasks"] {
    const merged = new Map<TaskId, GanttDataset["tasks"][number]>()
    for (const task of this.lastTasks) merged.set(task.id, task)
    for (const task of changeset.createdTasks) merged.set(task.id, task)
    for (const update of changeset.updatedTasks) {
      const existing = merged.get(update.id)
      if (existing) merged.set(update.id, { ...existing, ...update.changes })
    }
    for (const move of changeset.movedTasks) {
      const existing = merged.get(move.id)
      if (existing) merged.set(move.id, { ...existing, parentId: move.parentId, order: move.order })
    }
    return [...merged.values()]
  }

  async save(context: JornadaContext, changeset: GanttChangeset): Promise<GanttSaveResult> {
    const plan = this.plan(changeset, context)
    if (plan.issues.length) {
      return { success: false, message: plan.issues[0].message, conflicts: plan.issues.map((issue) => ({ taskId: issue.taskId, message: issue.message })) }
    }
    if (planIsEmpty(plan)) return { success: true, idMap: {} }

    const { idMap } = await this.transport.applyPlan(context, plan)
    const missing = plan.pendingRefs.filter((ref) => !idMap[ref])
    if (missing.length) {
      return {
        success: false,
        message: `O Jornada não devolveu a chave definitiva de ${missing.length} linha(s) criada(s). Não repita a gravação sem conferir o estado no servidor; não é possível confirmar reversão.`,
      }
    }
    // Reload rather than merge: the host owns generated columns, triggers and the
    // auto-close rule for deliverables, so its post-write state is the only truth.
    const dataset = await this.load(context)
    return { success: true, idMap, dataset }
  }

  async resolveResources(context: JornadaContext): Promise<GanttResource[]> {
    return (await this.transport.fetchResources?.(context)) ?? []
  }
}
