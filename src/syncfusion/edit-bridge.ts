import type { GanttSession } from "../core/session"
import { patchFromSyncfusion, type RenderIds, type SyncfusionTask } from "./mapper"
import type { DependencyType, GanttDependency } from "../core/types"
import { dependencyFullKey } from "../core/dependencies"
import { sameDate } from "../core/date"
import { indexTasks } from "../core/hierarchy"
import type { GanttTask, GanttTaskPatch } from "../core/types"
import type { GanttChoice } from "../core/adapter"

export function parseNativeLinks(text: string, successorId: string, ids: RenderIds): GanttDependency[] {
  if (!text.trim()) return []
  return text.split(",").map((token) => {
    // The trailing unit is whatever word the running locale uses ("day", "dia", ...).
    const match = /^(\d+)\s*(FS|SS|FF|SF)?(?:\s*([+-]\s*\d+)\s*[\p{L}]*\.?)?$/iu.exec(token.trim())
    if (!match) throw new Error(`Predecessora inválida: "${token}". Use o número da linha e FS, SS, FF ou SF.`)
    return {
      predecessorId: ids.sourceId(match[1]), successorId,
      type: (match[2]?.toUpperCase() ?? "FS") as DependencyType,
      lag: Number((match[3] ?? "0").replace(/\s+/g, "")),
    }
  })
}

/**
 * Keeps only the fields that genuinely differ from the session.
 *
 * The renderer reschedules on every bind and reports whole rows back, so accepting a
 * patch wholesale marked untouched dates and durations as edits — and, through the
 * rollups, changed the plan's total duration when the user had only picked a person.
 */
function realChanges(current: GanttTask, patch: GanttTaskPatch, derived: boolean): GanttTaskPatch {
  const result: GanttTaskPatch = {}
  for (const [field, value] of Object.entries(patch) as Array<[keyof GanttTask, unknown]>) {
    // A summary row's schedule belongs to its children; never take it from the renderer.
    if (derived && ["startDate", "endDate", "duration", "progress"].includes(field)) continue
    const now = current[field]
    if (value instanceof Date || now instanceof Date) {
      if (sameDate(value as Date | null, now as Date | null)) continue
    } else if (typeof value === "number" && typeof now === "number") {
      if (Math.round(value) === Math.round(now)) continue
    } else if ((value ?? null) === (now ?? null)) {
      continue
    }
    ;(result as Record<string, unknown>)[field] = value
  }
  return result
}

export function applyNativeEdits(
  session: GanttSession,
  rows: SyncfusionTask[],
  ids: RenderIds,
  options: {
    allowDependencies?: boolean
    allowSchedulingMode?: boolean
    editOptions?: (field: "status" | "priority", entityType?: string) => GanttChoice[]
  } = {},
): void {
  const unique = new Map(rows.filter((row) => !row._projection).map((row) => [row._sourceId, row]))
  const incomingById = new Map<string, GanttDependency[]>()
  const currentById = new Map(session.tasks.map((task) => [task.id, task]))
  const resources = new Map((session.dataset.resources ?? []).map((resource) => [resource.id, resource]))
  for (const [sourceId, row] of unique) {
    const original = currentById.get(sourceId)
    if (!original) throw new Error("A linha editada não existe no plano.")
    if (row.responsibleId !== original.responsibleId && row.responsibleId && !resources.has(row.responsibleId)) {
      throw new Error("Selecione um responsável disponível na lista.")
    }
    for (const field of ["status", "priority"] as const) {
      const choices = options.editOptions?.(field, row.entityType)
      if (choices?.length && (row[field] ?? null) !== (original[field] ?? null) && !choices.some((choice) => choice.value === row[field])) {
        throw new Error(`Selecione ${field === "status" ? "uma situação" : "uma prioridade"} disponível na lista.`)
      }
    }
    const incoming = parseNativeLinks(row.Predecessor ?? "", sourceId, ids)
    if (options.allowDependencies === false) {
      // Compare canonical data, never the mutable dataSource edited by Syncfusion.
      const before = session.dependencies.filter((link) => link.successorId === sourceId).map(dependencyFullKey).sort()
      const after = incoming.map(dependencyFullKey).sort()
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        throw new Error("Você não tem permissão para alterar vínculos neste Gantt.")
      }
    }
    incomingById.set(sourceId, incoming)
  }
  const index = indexTasks(session.tasks)
  session.transact(() => {
    for (const [sourceId, row] of unique) {
      const original = currentById.get(sourceId)
      if (!original) continue
      const derived = (index.childrenOf.get(sourceId) ?? []).length > 0
      const patch = realChanges(original, patchFromSyncfusion(row), derived)
      if (!options.allowSchedulingMode) delete patch.isManual
      if (patch.responsibleId !== undefined) {
        patch.responsibleName = row.responsibleId
          ? resources.get(row.responsibleId)?.name ?? original?.responsibleName ?? null
          : null
      }
      if (Object.keys(patch).length) session.updateTask(sourceId, patch)
      if (options.allowDependencies !== false) session.replaceIncoming(sourceId, incomingById.get(sourceId) ?? [])
    }
  })
}

export function readNativeRow(value: unknown): SyncfusionTask | null {
  if (!value || typeof value !== "object") return null
  if ("taskData" in value) return readNativeRow(value.taskData)
  if ("TaskID" in value && "_sourceId" in value && typeof value._sourceId === "string") {
    return value as SyncfusionTask
  }
  return null
}

/** Reads the values already consolidated by the Syncfusion scheduling engine. */
export function readNativeSnapshot(value: unknown): SyncfusionTask | null {
  const base = readNativeRow(value)
  if (!base || !value || typeof value !== "object") return base
  const gp = (value as { ganttProperties?: Record<string, unknown> }).ganttProperties
  if (!gp) return base
  return {
    ...base,
    StartDate: (gp.startDate as Date | null | undefined) ?? base.StartDate,
    EndDate: (gp.endDate as Date | null | undefined) ?? base.EndDate,
    durationEstimatedDays: (gp.duration as number | null | undefined) ?? base.durationEstimatedDays,
    Progress: (gp.progress as number | undefined) ?? base.Progress,
    Predecessor: typeof gp.predecessorsName === "string" ? gp.predecessorsName : base.Predecessor,
    isManual: typeof gp.isManual === "boolean" ? gp.isManual : base.isManual,
  }
}
