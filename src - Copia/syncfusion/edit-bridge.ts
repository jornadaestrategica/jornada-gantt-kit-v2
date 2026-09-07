import type { GanttSession } from "../core/session"
import { patchFromSyncfusion, type RenderIds, type SyncfusionTask } from "./mapper"
import type { DependencyType, GanttDependency } from "../core/types"
import { dependencyFullKey } from "../core/dependencies"
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

export function applyNativeEdits(
  session: GanttSession,
  rows: SyncfusionTask[],
  ids: RenderIds,
  options: {
    allowDependencies?: boolean
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
  session.transact(() => {
    for (const [sourceId, row] of unique) {
      const patch = patchFromSyncfusion(row)
      if (row.responsibleId !== undefined) {
        const original = currentById.get(sourceId)
        patch.responsibleName = row.responsibleId
          ? resources.get(row.responsibleId)?.name ?? original?.responsibleName ?? null
          : null
      }
      session.updateTask(sourceId, patch)
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
