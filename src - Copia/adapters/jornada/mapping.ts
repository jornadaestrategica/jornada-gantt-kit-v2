import { inclusiveDuration, parseCivilDate } from "../../core/date"
import type { GanttDataset, GanttDependency, GanttMarker, GanttTask } from "../../core/types"
import { ENTITY_ATIVIDADE, ENTITY_ENTREGA, atividadeId, entregaId } from "./ids"
import type { JornadaSnapshot, ResultadoEntregaRow } from "./schema"
import { normalizePrioridade, normalizeStatus, progressFromStatus } from "./status"

export interface MappingOptions {
  /**
   * Which pair of date columns drives the bars. `previsto` is the plan and is what a
   * user edits in a Gantt; `realizado` is what actually happened and renders as the
   * baseline underneath. Swapping them is a deliberate, explicit choice.
   */
  dateSource?: "previsto" | "realizado"
  /** Show dtinicio/dttermino as the baseline bar. */
  showRealizadoAsBaseline?: boolean
  includeArchived?: boolean
  presentationEditable?: boolean
}

export interface MappingDiagnostic {
  code: string
  message: string
  taskId?: string
}

export interface MappingResult {
  dataset: GanttDataset
  diagnostics: MappingDiagnostic[]
}

function entregaKind(row: ResultadoEntregaRow, hasChildren: boolean): GanttTask["kind"] {
  if (row.exibir_marco && row.eh_agrupador === false && !hasChildren) return "milestone"
  if (row.eh_agrupador || hasChildren) return "group"
  return "task"
}

/**
 * Folds two host tables into one flat, canonically-keyed row set.
 *
 * The activity's `resultado_entrega_id` becomes `parentId`, which is the whole trick:
 * a foreign key the database already enforces is what produces the outline the user
 * sees, so indent and outdent are edits to a real relationship rather than to a
 * display-only tree that has to be reconciled later.
 */
export function snapshotToDataset(snapshot: JornadaSnapshot, options: MappingOptions = {}): MappingResult {
  const dateSource = options.dateSource ?? "previsto"
  const showBaseline = options.showRealizadoAsBaseline ?? dateSource === "previsto"
  const diagnostics: MappingDiagnostic[] = []

  const entregaIds = new Set(snapshot.entregas.map((row) => row.id))
  const childCount = new Map<string, number>()
  for (const row of snapshot.entregas) {
    if (row.parent_id) childCount.set(row.parent_id, (childCount.get(row.parent_id) ?? 0) + 1)
  }
  for (const row of snapshot.atividades) {
    if (row.resultado_entrega_id) {
      childCount.set(row.resultado_entrega_id, (childCount.get(row.resultado_entrega_id) ?? 0) + 1)
    }
  }

  const tasks: GanttTask[] = []

  for (const row of snapshot.entregas) {
    const id = entregaId(row.id)
    const presentation = snapshot.presentation?.find((item) => item.entrega_id === row.id)
    let parentId: string | null = null
    if (row.parent_id) {
      if (entregaIds.has(row.parent_id)) {
        parentId = entregaId(row.parent_id)
      } else {
        diagnostics.push({
          code: "ORPHAN_ENTREGA",
          taskId: id,
          message: `A entrega "${row.titulo}" aponta para um parent_id que não existe; foi trazida para a raiz.`,
        })
      }
    }
    const status = normalizeStatus(ENTITY_ENTREGA, row.status)
    if (status.corrected && status.original) {
      diagnostics.push({
        code: "STATUS_NORMALIZED",
        taskId: id,
        message: `Status "${status.original}" da entrega "${row.titulo}" foi normalizado para "${status.value ?? "vazio"}".`,
      })
    }
    const prioridade = normalizePrioridade(ENTITY_ENTREGA, row.prioridade)

    tasks.push({
      id,
      parentId,
      order: row.ordem ?? 0,
      kind: entregaKind(row, (childCount.get(row.id) ?? 0) > 0),
      entityType: ENTITY_ENTREGA,
      businessType: row.tipo,
      isSummary: row.eh_agrupador ?? true,
      showMilestone: row.exibir_marco ?? false,
      milestoneLabel: presentation?.milestoneLabel ?? null,
      milestoneDate: parseCivilDate(presentation?.milestoneDate),
      title: row.titulo,
      // tb_resultado_entrega has no date columns: the bar is always a rollup.
      startDate: null,
      endDate: null,
      duration: null,
      durationUnit: "day",
      progress: 0,
      status: status.value,
      priority: prioridade.value,
      responsibleId: row.pessoa_id ?? null,
      responsibleName: row.pessoa_nome ?? null,
      storyPoints: row.story_points ?? null,
      effort: row.esforco_horas ?? null,
      color: row.cor ?? null,
      tags: row.tags ?? null,
      notes: row.criterios_aceite ?? null,
      rowVersion: row.updated_at ?? null,
      lockedFields: [
        "startDate", "endDate", "duration", "progress",
        ...(options.presentationEditable ? [] : ["milestoneDate", "milestoneLabel"]),
      ],
      metadata: {
        tipo: row.tipo,
        plano_id: row.plano_id,
        sprint_plano_id: row.sprint_plano_id ?? null,
        wsjf_score: row.wsjf_score ?? null,
        valor_negocio: row.valor_negocio ?? null,
        urgencia: row.urgencia ?? null,
        risco_reducao: row.risco_reducao ?? null,
        eh_agrupador: row.eh_agrupador ?? null,
        exibir_marco: row.exibir_marco ?? null,
      },
    })
  }

  for (const row of snapshot.atividades) {
    if (row.is_archived && !options.includeArchived) continue
    const id = atividadeId(row.id)
    let parentId: string | null = null
    if (row.resultado_entrega_id) {
      if (entregaIds.has(row.resultado_entrega_id)) {
        parentId = entregaId(row.resultado_entrega_id)
      } else {
        diagnostics.push({
          code: "ORPHAN_ATIVIDADE",
          taskId: id,
          message: `A atividade "${row.titulo}" referencia uma entrega inexistente; foi trazida para a raiz.`,
        })
      }
    }

    const planned = {
      start: parseCivilDate(row.dtinicio_previsto),
      end: parseCivilDate(row.dttermino_previsto),
    }
    const actual = { start: parseCivilDate(row.dtinicio), end: parseCivilDate(row.dttermino) }
    const primary = dateSource === "realizado" ? actual : planned
    const secondary = dateSource === "realizado" ? planned : actual

    const status = normalizeStatus(ENTITY_ATIVIDADE, row.status)
    if (status.corrected && status.original) {
      diagnostics.push({
        code: "STATUS_NORMALIZED",
        taskId: id,
        message: `Status "${status.original}" da atividade "${row.titulo}" foi normalizado para "${status.value ?? "vazio"}".`,
      })
    }
    const prioridade = normalizePrioridade(ENTITY_ATIVIDADE, row.prioridade)
    const progress = row.avanco ?? progressFromStatus(status.value) ?? 0

    tasks.push({
      id,
      parentId,
      order: 0,
      kind: "task",
      entityType: ENTITY_ATIVIDADE,
      title: row.titulo,
      startDate: primary.start,
      endDate: primary.end,
      duration: inclusiveDuration(primary.start, primary.end),
      durationUnit: "day",
      progress: Math.min(100, Math.max(0, progress)),
      status: status.value,
      priority: prioridade.value,
      responsibleId: row.pessoa_id ?? null,
      responsibleName: row.pessoa_nome ?? null,
      baselineStartDate: showBaseline ? secondary.start : null,
      baselineEndDate: showBaseline ? secondary.end : null,
      weight: row.peso ?? null,
      effort: row.esforco ?? null,
      storyPoints: row.story_points ?? null,
      color: row.cor ?? null,
      tags: row.tag ?? null,
      notes: row.descricao ?? null,
      rowVersion: row.updated_at ?? null,
      metadata: {
        plano_id: row.plano_id,
        unidade_id: row.unidade_id ?? null,
        portfolio_id: row.portfolio_id ?? null,
        tipo: row.tipo ?? "Padrão",
        plano_vinculado_id: row.plano_vinculado_id ?? null,
        grupo: row.grupo ?? null,
        campos_personalizados: row.campos_personalizados ?? null,
        dtinicio_previsto: row.dtinicio_previsto,
        dttermino_previsto: row.dttermino_previsto,
        dtinicio: row.dtinicio ?? null,
        dttermino: row.dttermino ?? null,
      },
    })
  }

  // Preserve host ordering per parent, then let the core densify it.
  const seen = new Map<string, number>()
  for (const task of tasks) {
    const bucket = task.parentId ?? "\u0000root"
    const position = seen.get(bucket) ?? 0
    if (task.entityType === ENTITY_ATIVIDADE) task.order = position
    seen.set(bucket, position + 1)
  }

  const atividadeIds = new Set(snapshot.atividades.map((row) => row.id))
  const dependencies: GanttDependency[] = []
  for (const link of snapshot.vinculos) {
    if (!atividadeIds.has(link.atividade_id)) {
      diagnostics.push({
        code: "DANGLING_VINCULO",
        message: `O vínculo ${link.id} aponta para uma atividade que não está no plano e foi ignorado.`,
      })
      continue
    }
    if (Boolean(link.predecessora_id) === Boolean(link.resultado_entrega_id)) {
      diagnostics.push({
        code: "VINCULO_EXCLUSIVO_VIOLADO",
        message: `O vínculo ${link.id} precisa ter exatamente uma predecessora (atividade OU entrega) e foi ignorado.`,
      })
      continue
    }
    const predecessorId = link.predecessora_id
      ? atividadeId(link.predecessora_id)
      : entregaId(link.resultado_entrega_id as string)
    dependencies.push({
      id: link.id,
      predecessorId,
      successorId: atividadeId(link.atividade_id),
      type: link.tipo_vinculo ?? "FS",
      lag: link.lag ?? 0,
    })
  }

  const markers: GanttMarker[] = []
  for (const annotation of snapshot.annotations ?? []) {
    const date = parseCivilDate(annotation.date)
    if (!date) {
      diagnostics.push({ code: "INVALID_ANNOTATION_DATE", message: `Anotação temporal sem data válida: ${annotation.label}` })
      continue
    }
    markers.push({ date, label: annotation.label, cssClass: annotation.cssClass })
  }
  for (const sprint of snapshot.sprints ?? []) {
    const start = parseCivilDate(sprint.dtinicio)
    const end = parseCivilDate(sprint.dttermino)
    if (start) markers.push({ date: start, label: `▶ ${sprint.titulo}`, cssClass: "jg-marker-sprint-start" })
    if (end) markers.push({ date: end, label: `■ ${sprint.titulo}`, cssClass: "jg-marker-sprint-end" })
  }

  return {
    dataset: {
      tasks,
      dependencies,
      markers,
      holidays: (snapshot.feriados ?? [])
        .map((item) => ({ from: parseCivilDate(item.data), label: item.descricao }))
        .filter((item): item is { from: Date; label: string | undefined } => item.from != null),
      metadata: { source: "jornada", dateSource },
    },
    diagnostics,
  }
}
