import { ancestorIds, indexTasks, isDescendantOf, sortByVisualOrder, type TaskIndex } from "./hierarchy"
import type { GanttDomainPolicy, PolicyContext } from "./policy"
import type { DependencyType, GanttDependency, GanttTask, TaskId } from "./types"

const DEPENDENCY_TYPES: DependencyType[] = ["FS", "SS", "FF", "SF"]

/** Stable identity of a link, independent of the host primary key. */
export function dependencyKey(dependency: GanttDependency): string {
  return `${dependency.predecessorId}\u0000${dependency.successorId}`
}

export function dependencyFullKey(dependency: GanttDependency): string {
  return `${dependencyKey(dependency)}\u0000${dependency.type}\u0000${dependency.lag ?? 0}`
}

/**
 * Parses Syncfusion predecessor text. Accepts `2`, `2FS`, `2FS+3d`, `2SS-1d` and
 * comma or semicolon separated lists. Ids containing the separator characters are
 * out of scope by design — adapters emit opaque ids that avoid them.
 */
export function parsePredecessorText(text: string | null | undefined, successorId: TaskId): GanttDependency[] {
  if (!text) return []
  const result: GanttDependency[] = []
  for (const rawToken of String(text).split(/[,;]/)) {
    const token = rawToken.trim()
    if (!token) continue
    // The unit word is only meaningful behind an offset; on its own it would swallow
    // a bare predecessor id such as `a`.
    const match = /^(.*?)(FS|SS|FF|SF)?(?:\s*([+-]\s*\d+(?:\.\d+)?)\s*[\p{L}]*\.?)?$/iu.exec(token)
    if (!match) continue
    const predecessorId = (match[1] ?? "").trim()
    if (!predecessorId || predecessorId === successorId) continue
    const type = (match[2] ?? "FS").toUpperCase() as DependencyType
    const lag = match[3] ? Number(match[3].replace(/\s+/g, "")) : 0
    result.push({
      predecessorId,
      successorId,
      type: DEPENDENCY_TYPES.includes(type) ? type : "FS",
      lag: Number.isFinite(lag) ? lag : 0,
    })
  }
  return result
}

/**
 * Offset units are localized by Syncfusion: `1 day` in en-US, `1 dia` in pt-BR. Emitting
 * a unit the running locale does not recognise makes the component reject the whole
 * relation, so the label is supplied by the renderer rather than hard-coded here.
 */
export interface OffsetUnitLabels {
  singular: string
  plural: string
}

export const DEFAULT_OFFSET_UNITS: OffsetUnitLabels = { singular: "day", plural: "days" }

/** Single source for the pt-BR words; the locale registration reuses it verbatim. */
export const PT_BR_OFFSET_UNITS: OffsetUnitLabels = { singular: "dia", plural: "dias" }

export function formatPredecessorText(
  dependencies: GanttDependency[],
  successorId: TaskId,
  units: OffsetUnitLabels = DEFAULT_OFFSET_UNITS,
): string {
  return dependencies
    .filter((dependency) => dependency.successorId === successorId)
    .map((dependency) => {
      const lag = dependency.lag ?? 0
      if (lag === 0) return `${dependency.predecessorId}${dependency.type}`
      const unit = Math.abs(lag) === 1 ? units.singular : units.plural
      return `${dependency.predecessorId}${dependency.type}${lag > 0 ? "+" : ""}${lag} ${unit}`
    })
    .join(",")
}

/** Detects whether adding `candidate` would close a loop in the network. */
export function wouldCreateDependencyCycle(
  dependencies: GanttDependency[],
  candidate: GanttDependency,
): boolean {
  if (candidate.predecessorId === candidate.successorId) return true
  const successors = new Map<TaskId, TaskId[]>()
  const push = (from: TaskId, to: TaskId): void => {
    const bucket = successors.get(from)
    if (bucket) bucket.push(to)
    else successors.set(from, [to])
  }
  for (const dependency of dependencies) push(dependency.predecessorId, dependency.successorId)
  push(candidate.predecessorId, candidate.successorId)

  const stack: TaskId[] = [candidate.successorId]
  const seen = new Set<TaskId>()
  while (stack.length) {
    const current = stack.pop() as TaskId
    if (current === candidate.predecessorId) return true
    if (seen.has(current)) continue
    seen.add(current)
    stack.push(...(successors.get(current) ?? []))
  }
  return false
}

/** Returns every dependency that takes part in a cycle. Used to fence off bad host data. */
export function findCyclicDependencies(dependencies: GanttDependency[]): GanttDependency[] {
  const accepted: GanttDependency[] = []
  const cyclic: GanttDependency[] = []
  for (const dependency of dependencies) {
    if (wouldCreateDependencyCycle(accepted, dependency)) cyclic.push(dependency)
    else accepted.push(dependency)
  }
  return cyclic
}

export type SmartLinkStrategy = "chain" | "fan-out" | "fan-in" | "pairwise"

export interface SmartLinkOptions {
  strategy?: SmartLinkStrategy
  type?: DependencyType
  lag?: number
  /** Order the selection by the grid's visual order rather than click order. */
  useVisualOrder?: boolean
  /** Replace any existing link between two rows instead of skipping the pair. */
  replaceExisting?: boolean
}

export interface SmartLinkRejection {
  predecessorId: TaskId
  successorId: TaskId
  code: string
  message: string
}

export interface SmartLinkPlan {
  created: GanttDependency[]
  updated: GanttDependency[]
  removed: GanttDependency[]
  rejected: SmartLinkRejection[]
  /** Rows considered, in the order the links were laid out. */
  sequence: TaskId[]
}

function orderedSelection(index: TaskIndex, taskIds: TaskId[], useVisualOrder: boolean): GanttTask[] {
  const unique: TaskId[] = []
  const seen = new Set<TaskId>()
  for (const id of taskIds) {
    if (seen.has(id)) continue
    seen.add(id)
    unique.push(id)
  }
  if (useVisualOrder) return sortByVisualOrder(index, unique)
  return unique.map((id) => index.byId.get(id)).filter((task): task is GanttTask => Boolean(task))
}

function pairsFor(strategy: SmartLinkStrategy, rows: GanttTask[]): Array<[GanttTask, GanttTask]> {
  const pairs: Array<[GanttTask, GanttTask]> = []
  if (rows.length < 2) return pairs
  if (strategy === "chain") {
    for (let position = 0; position < rows.length - 1; position += 1) pairs.push([rows[position], rows[position + 1]])
    return pairs
  }
  if (strategy === "fan-out") {
    for (let position = 1; position < rows.length; position += 1) pairs.push([rows[0], rows[position]])
    return pairs
  }
  if (strategy === "fan-in") {
    const last = rows[rows.length - 1]
    for (let position = 0; position < rows.length - 1; position += 1) pairs.push([rows[position], last])
    return pairs
  }
  for (let a = 0; a < rows.length; a += 1) {
    for (let b = a + 1; b < rows.length; b += 1) pairs.push([rows[a], rows[b]])
  }
  return pairs
}

/**
 * Connects a whole selection in one gesture.
 *
 * This is the operation users actually want and no Gantt ships out of the box:
 * select six activities, press Link, and get a validated FS chain. Every candidate
 * pair is filtered through four gates — self-reference, ancestry, the host domain
 * policy, and network acyclicity — and whatever is refused comes back as a typed
 * rejection so the UI can explain itself instead of silently dropping links.
 */
export function planSmartConnection(
  tasks: GanttTask[],
  dependencies: GanttDependency[],
  taskIds: TaskId[],
  policy: GanttDomainPolicy,
  options: SmartLinkOptions = {},
): SmartLinkPlan {
  const index = indexTasks(tasks)
  const context: PolicyContext = { index }
  const strategy = options.strategy ?? "chain"
  const type = options.type ?? policy.defaultDependencyType ?? "FS"
  const lag = options.lag ?? 0
  const rows = orderedSelection(index, taskIds, options.useVisualOrder ?? true)

  const plan: SmartLinkPlan = {
    created: [],
    updated: [],
    removed: [],
    rejected: [],
    sequence: rows.map((row) => row.id),
  }
  if (rows.length < 2) {
    plan.rejected.push({
      predecessorId: rows[0]?.id ?? "",
      successorId: "",
      code: "SELECTION_TOO_SMALL",
      message: "Selecione pelo menos duas linhas para conectar.",
    })
    return plan
  }

  const working = dependencies.map((dependency) => ({ ...dependency }))
  const byKey = new Map(working.map((dependency) => [dependencyKey(dependency), dependency]))

  for (const [predecessor, successor] of pairsFor(strategy, rows)) {
    const reject = (code: string, message: string): void => {
      plan.rejected.push({ predecessorId: predecessor.id, successorId: successor.id, code, message })
    }

    if (predecessor.id === successor.id) {
      reject("SELF_LINK", "Uma linha não pode depender de si mesma.")
      continue
    }
    if (isDescendantOf(index, successor.id, predecessor.id) || isDescendantOf(index, predecessor.id, successor.id)) {
      reject(
        "ANCESTRY",
        `"${predecessor.title}" e "${successor.title}" estão na mesma linhagem; um vínculo entre pai e filho é sempre circular.`,
      )
      continue
    }

    const existing = byKey.get(dependencyKey({ predecessorId: predecessor.id, successorId: successor.id, type }))
    const reverse = byKey.get(dependencyKey({ predecessorId: successor.id, successorId: predecessor.id, type }))
    if (reverse) {
      reject("REVERSE_LINK", `Já existe um vínculo no sentido oposto entre "${successor.title}" e "${predecessor.title}".`)
      continue
    }

    const decision = policy.canLink(predecessor, successor, type, context)
    if (!decision.allowed) {
      reject(decision.code ?? "POLICY", decision.message ?? "Vínculo não permitido pelo domínio.")
      continue
    }

    if (existing) {
      if (!options.replaceExisting || (existing.type === type && (existing.lag ?? 0) === lag)) {
        reject("ALREADY_LINKED", `"${predecessor.title}" já é predecessora de "${successor.title}".`)
        continue
      }
      const next = { ...existing, type, lag }
      plan.updated.push(next)
      byKey.set(dependencyKey(next), next)
      continue
    }

    const candidate: GanttDependency = { predecessorId: predecessor.id, successorId: successor.id, type, lag }
    if (wouldCreateDependencyCycle([...byKey.values()], candidate)) {
      reject("CYCLE", `Ligar "${predecessor.title}" a "${successor.title}" criaria uma dependência circular.`)
      continue
    }
    plan.created.push(candidate)
    byKey.set(dependencyKey(candidate), candidate)
  }

  return plan
}

/** Removes every link that exists strictly between rows of the selection. */
export function planDisconnection(
  _tasks: GanttTask[],
  dependencies: GanttDependency[],
  taskIds: TaskId[],
): GanttDependency[] {
  const selected = new Set(taskIds)
  if (selected.size === 1) {
    return dependencies.filter(
      (dependency) => selected.has(dependency.predecessorId) || selected.has(dependency.successorId),
    )
  }
  return dependencies.filter(
    (dependency) => selected.has(dependency.predecessorId) && selected.has(dependency.successorId),
  )
}

/** Links that would be orphaned by removing a set of rows, including their subtrees. */
export function dependenciesTouching(
  tasks: GanttTask[],
  dependencies: GanttDependency[],
  taskIds: TaskId[],
): GanttDependency[] {
  const index = indexTasks(tasks)
  const affected = new Set<TaskId>()
  for (const id of taskIds) {
    affected.add(id)
    for (const ancestor of ancestorIds(index, id)) void ancestor
  }
  return dependencies.filter(
    (dependency) => affected.has(dependency.predecessorId) || affected.has(dependency.successorId),
  )
}
