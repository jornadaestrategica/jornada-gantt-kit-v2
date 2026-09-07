"use client"
import * as React from "react"
import { DialogUtility } from "@syncfusion/ej2-popups"
import {
  ColumnDirective, ColumnsDirective, ColumnMenu, ContextMenu, CriticalPath, DayMarkers,
  Edit, ExcelExport, Filter, GanttComponent, Inject, PdfExport, Reorder, Resize, RowDD,
  Selection, Sort, Toolbar, VirtualScroll,
} from "@syncfusion/ej2-react-gantt"
import type { GanttModel } from "@syncfusion/ej2-react-gantt"
import type { GanttChoice, GanttDataAdapter, GanttCreationOption } from "../core/adapter"
import type { SmartLinkStrategy } from "../core/dependencies"
import { GanttSession } from "../core/session"
import { permissivePolicy } from "../core/policy"
import type { GanttCapabilities, GanttDataset, GanttPermissions, GanttResource, GanttViewState, TimelinePreset } from "../core/types"
import { GanttViewStateStore, mergeViewState } from "../core/view-state"
import { RenderIds, sortRowsByDate, toSyncfusionDataset, type SyncfusionTask } from "./mapper"
import { changedFieldsByTask, WHOLE_ROW } from "../core/changeset"
import { applyNativeEdits, readNativeRow, readNativeSnapshot } from "./edit-bridge"
import {
  canEditGridField, canOpenTaskDialog, FIELD_NAMES, READ_ONLY_GRID_FIELDS, renderStructureKey,
} from "./editing-policy"
import { choiceEditor } from "./editors"
import { OFFSET_UNITS, registerPortuguese } from "./locale"
import { SettingsPanel } from "./settings"
import { DISPLAY_TOGGLES, isToggleOn } from "./display-toggles"
import { resolveTimelineSettings } from "./timeline-settings"
import { errorDetails, errorMessage, tierFormatNotice, type Notice } from "./notices"
export type { Notice } from "./notices"

export interface FeatureRichGanttProps<TContext> {
  adapter: GanttDataAdapter<TContext>
  context: TContext
  storageKey?: string
  capabilities?: GanttCapabilities
  permissions?: GanttPermissions
  height?: string | number
  locale?: string
  defaultEntityType?: string
  groupEntityType?: string
  /** Opens the cell editor on a single click, instead of the native double click. */
  editOnSingleClick?: boolean
  /** Drops the outer frame so the component fills a host tab or panel. */
  embedded?: boolean
  onSaved?: () => void
  onError?: (error: unknown) => void
  onNotice?: (notice: Notice) => void
}

const DEFAULT_CAPABILITIES: Required<GanttCapabilities> = {
  inlineEditing: true, dialogEditing: true, taskbarEditing: true, rowDragAndDrop: true,
  dependencies: true, baseline: true, filtering: true, sorting: true, columnResizing: true,
  columnReorder: true, columnMenu: true, contextMenu: true, undoRedo: true,
  indentOutdent: true, smartLink: true, criticalPath: true, excelExport: true,
  pdfExport: true, virtualScroll: false, wbs: true, search: true,
}
const DEFAULT_PERMISSIONS: Required<GanttPermissions> = {
  create: true, update: true, delete: true, save: true, link: true, reparent: true,
}
const TASK_FIELDS = {
  id: "TaskID", parentID: "ParentID", name: "TaskName", startDate: "StartDate", endDate: "EndDate",
  duration: "durationEstimatedDays", durationUnit: "DurationUnit", progress: "Progress", dependency: "Predecessor",
  milestone: "isMilestone", manual: "isManual",
  baselineStartDate: "BaselineStartDate", baselineEndDate: "BaselineEndDate", notes: "Notes",
  constraintType: "ConstraintType", constraintDate: "ConstraintDate",
}
const SERVICES = [
  Selection, Edit, Toolbar, DayMarkers, Filter, Sort, Resize, Reorder, RowDD,
  ColumnMenu, ContextMenu, CriticalPath, ExcelExport, PdfExport, VirtualScroll,
]
/** Fixed element id: toolbar item ids are `${GANTT_ID}_${item}`, so they stay predictable. */
const GANTT_ID = "jornadaGantt"
/** Our own toolbar commands. Native Indent/Outdent are NOT used: cancelling them was
 *  unreliable, and a missed cancel let the component nest rows past the domain rules. */
const COMMANDS = { indent: "jgIndent", outdent: "jgOutdent", undo: "jgUndo", redo: "jgRedo" } as const

const rowKey = (row: SyncfusionTask) => row._projection ? `__milestone__:${row._sourceId}` : row._sourceId
const isSummaryRow = (row: SyncfusionTask) => row.entityType === "entrega" && !row._projection && !row.isMilestone
/** A pure milestone marks a date; it has no position of its own to drag. */
const isFixedMilestone = (row: SyncfusionTask) => row.isMilestone || row._projection
const dayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())
const foldText = (value: string | null | undefined) => (value ?? "")
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase("pt-BR")
const isLateTask = (row: SyncfusionTask) => row.entityType === "atividade" && !row._projection && !row.isMilestone &&
  row.Progress < 100 && Boolean(row.EndDate && dayStart(row.EndDate) < dayStart(new Date()))

function predecessorLabel(text: string | null | undefined, rows: Map<string, SyncfusionTask>): string {
  if (!text?.trim()) return ""
  return text.split(",").map((token) => token.trim()).filter(Boolean).map((token) => {
    const match = /^(\d+)\s*(FS|SS|FF|SF)?(.*)$/i.exec(token)
    if (!match) return token
    const row = rows.get(match[1])
    if (!row) return token
    const relation = match[2]?.toUpperCase() ?? "FS"
    const offset = match[3]?.trim() ? ` ${match[3].trim()}` : ""
    return `${row.WBS || row.TaskID} ${relation}${offset}`
  }).join(", ")
}

/** Canonical field name -> grid column, for per-cell change marks. */
const CHANGED_FIELD_COLUMNS: Record<string, string> = {
  title: "TaskName", startDate: "StartDate", endDate: "EndDate", duration: "Duration",
  progress: "Progress", status: "status", priority: "priority", notes: "Notes",
  responsibleId: "responsibleId", responsibleName: "responsibleId", businessType: "businessType",
  showMilestone: "showMilestone", milestoneLabel: "milestoneLabel", milestoneDate: "milestoneDate",
  effort: "effort", storyPoints: "storyPoints", weight: "weight", tags: "tagsText",
  predecessorText: "Predecessor",
}
const NO_CHOICES: GanttChoice[] = []

function useEvent<T extends unknown[]>(handler: (...args: T) => void) {
  const latest = React.useRef(handler)
  React.useLayoutEffect(() => { latest.current = handler })
  return React.useCallback((...args: T) => latest.current(...args), [])
}

/**
 * The chart itself. Memoised so the surrounding bars — selection counters, notices,
 * toggles — never tear down and rebuild the component underneath the user.
 */
const NativeGantt = React.memo(function NativeGantt({
  model, ganttRef, wbs, businessTypes, resources, optionsFor,
}: {
  model: GanttModel
  ganttRef: React.RefObject<GanttComponent>
  wbs: boolean
  businessTypes: GanttChoice[]
  resources: GanttResource[]
  optionsFor: (field: "status" | "priority", row: SyncfusionTask) => GanttChoice[]
}) {
  const resourceNames = new Map(resources.map((resource) => [resource.id, resource.name]))
  const rowLabels = new Map(((model.dataSource as SyncfusionTask[] | undefined) ?? []).map((row) => [row.TaskID, row]))
  const columns = <ColumnsDirective>
    <ColumnDirective field="TaskID" headerText="ID" isPrimaryKey visible={false} allowEditing={false} />
    <ColumnDirective field="_sourceId" headerText="ID origem" width={220} visible={false} allowEditing={false} />
    <ColumnDirective field="WBS" headerText="EAP" width={80} visible={wbs} allowEditing={false} />
    <ColumnDirective field="TaskName" headerText="Título" width={290} clipMode="EllipsisWithTooltip" />
    <ColumnDirective field="businessType" headerText="Tipo" width={130} allowFiltering
      valueAccessor={(_f: string, data: object) => {
        // Custom fields live on taskData; reading the record directly returned undefined
        // and every row rendered as "Atividade".
        const row = readNativeRow(data)
        if (!row) return ""
        if (row._projection) return "Marco"
        if (row.entityType !== "entrega") return "Atividade"
        return businessTypes.find((item) => item.value === row.businessType)?.label ?? "Entrega"
      }}
      edit={choiceEditor(() => businessTypes, "Selecione o tipo")} />
    <ColumnDirective field="responsibleId" headerText="Responsável" width={165}
      allowEditing={resources.length > 0}
      valueAccessor={(_f: string, data: object) => {
        const row = readNativeRow(data)
        return row ? resourceNames.get(row.responsibleId ?? "") ?? row.responsibleName ?? "Não atribuído" : ""
      }}
      edit={choiceEditor(
        () => resources.map((item) => ({ value: item.id, label: item.name })),
        "Selecione o responsável",
      )} />
    <ColumnDirective field="StartDate" headerText="Início" width={115} format="dd/MM/yyyy" editType="datepickeredit" />
    <ColumnDirective field="EndDate" headerText="Término" width={115} format="dd/MM/yyyy" editType="datepickeredit" />
    <ColumnDirective field="Duration" headerText="Duração" width={100} editType="numericedit"
      edit={{ params: { min: 0, decimals: 0, format: "n0", showSpinButton: false } }} />
    <ColumnDirective field="Progress" headerText="Avanço (%)" width={105} editType="numericedit"
      edit={{ params: { min: 0, max: 100, decimals: 0, format: "n0" } }} />
    <ColumnDirective field="Predecessor" headerText="Predecessoras" width={220} clipMode="EllipsisWithTooltip"
      valueAccessor={(_f: string, data: object) => {
        const row = readNativeRow(data)
        return row ? predecessorLabel(row.Predecessor, rowLabels) : ""
      }} />
    <ColumnDirective field="isManual" headerText="Manual" width={95} type="boolean"
      displayAsCheckBox editType="booleanedit" textAlign="Center" visible={false} />
    <ColumnDirective field="status" headerText="Situação" width={145}
      edit={choiceEditor((row) => optionsFor("status", row), "Selecione a situação")} />
    <ColumnDirective field="priority" headerText="Prioridade" width={140}
      edit={choiceEditor((row) => optionsFor("priority", row), "Selecione a prioridade")} />
    <ColumnDirective field="showMilestone" headerText="Marco" width={95} type="boolean"
      displayAsCheckBox editType="booleanedit" textAlign="Center" />
    <ColumnDirective field="milestoneLabel" headerText="Rótulo do marco" width={190} visible={false} />
    <ColumnDirective field="milestoneDate" headerText="Data do marco" width={140} format="dd/MM/yyyy"
      editType="datepickeredit" visible={false} />
    <ColumnDirective field="Notes" headerText="Descrição" width={260} visible={false} />
    <ColumnDirective field="effort" headerText="Esforço (h)" width={110} visible={false}
      editType="numericedit" edit={{ params: { min: 0, format: "n0" } }} />
    <ColumnDirective field="storyPoints" headerText="Pontos" width={100} visible={false}
      editType="numericedit" edit={{ params: { min: 0, format: "n0" } }} />
    <ColumnDirective field="weight" headerText="Peso" width={95} visible={false}
      editType="numericedit" edit={{ params: { min: 0, format: "n2" } }} />
    <ColumnDirective field="tagsText" headerText="Etiquetas" width={170} visible={false} />
    <ColumnDirective field="entityLabel" headerText="Representação" width={150} visible={false} allowEditing={false} />
  </ColumnsDirective>
  // The chevron must render on the title column: derive its position from the actual
  // declared list instead of a hand-counted index, which drifts the moment a column
  // is added, removed or reordered above.
  let treeColumnIndex = 0
  React.Children.forEach(columns.props.children, (child, index) => {
    if (React.isValidElement(child) && (child.props as { field?: string }).field === "TaskName") treeColumnIndex = index
  })
  return <GanttComponent id={GANTT_ID} ref={ganttRef} {...model} treeColumnIndex={treeColumnIndex}>
    {columns}
    <Inject services={SERVICES} />
  </GanttComponent>
})

export function FeatureRichGantt<TContext>(props: FeatureRichGanttProps<TContext>) {
  const capabilities = React.useMemo(() => ({ ...DEFAULT_CAPABILITIES, ...props.capabilities }), [props.capabilities])
  const granted = React.useMemo(() => ({ ...DEFAULT_PERMISSIONS, ...props.permissions }), [props.permissions])
  const gantt = React.useRef<GanttComponent>(null)
  const sessionRef = React.useRef<GanttSession | null>(null)
  const identities = React.useRef(new RenderIds())
  const restoring = React.useRef(false)
  const needsRestore = React.useRef(true)
  const binding = React.useRef(true)
  const frame = React.useRef<number | null>(null)
  const busy = React.useRef(false)
  const cellEditFrame = React.useRef<number | null>(null)
  const nativeCommitFrame = React.useRef<number | null>(null)
  const nativeCommitHints = React.useRef<unknown[]>([])
  const nativeCommitAll = React.useRef(false)
  const saveAfterNativeCommit = React.useRef<(() => void) | null>(null)
  const captureNativeSchedule = React.useRef(false)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [reload, setReload] = React.useState(0)
  const [revision, setRevision] = React.useState(0)
  const [notice, setNotice] = React.useState<Notice | null>(null)
  const [selected, setSelected] = React.useState<string[]>([])
  const selectionRef = React.useRef<string[]>([])
  // Only the chain strategy is exposed; the others stay available in the core for a
  // future need, but they confused more than they helped in the toolbar.
  const strategy: SmartLinkStrategy = "chain"
  const [confirmReload, setConfirmReload] = React.useState(false)
  const [editing, setEditing] = React.useState(false)
  const [showSettings, setShowSettings] = React.useState(false)
  const [confirmExit, setConfirmExit] = React.useState(false)
  /** Outside edit mode the plan is browsable but never writable. */
  const permissions = React.useMemo(() => editing ? granted : {
    ...granted, create: false, update: false, delete: false, link: false, reparent: false, save: false,
  }, [granted, editing])
  const store = React.useMemo(() => new GanttViewStateStore(
    props.storageKey ?? "jornada-gantt", typeof window === "undefined" ? undefined : window.localStorage,
  ), [props.storageKey])
  const [view, setView] = React.useState(() => store.load())
  const viewRef = React.useRef(view)
  const businessTypes = props.adapter.businessTypeOptions ?? NO_CHOICES
  const creationOptions = React.useMemo<GanttCreationOption[]>(() => props.adapter.creationOptions ?? [
    { id: "atividade", label: "Atividade", task: { title: "Nova atividade", kind: "task", entityType: props.defaultEntityType } },
    { id: "grupo", label: "Grupo", task: { title: "Novo grupo", kind: "group", entityType: props.groupEntityType } },
    { id: "Entrega", label: "Entrega", task: { title: "Nova entrega", kind: "group", entityType: props.groupEntityType } },
  ], [props.adapter, props.defaultEntityType, props.groupEntityType])

  const noticeSignature = React.useRef<string | null>(null)
  const publish = useEvent((value: Notice | null) => {
    const signature = value ? `${value.tone}|${value.message}|${(value.details ?? []).join("\u0001")}` : null
    if (signature !== null && signature === noticeSignature.current) {
      if (import.meta.env?.DEV) console.warn("[jornada-gantt] aviso repetido suprimido:", value?.message)
      return
    }
    noticeSignature.current = signature
    setNotice(value)
    if (value) props.onNotice?.(value)
  })
  const fail = useEvent((reason: unknown) => {
    const message = errorMessage(reason)

    if (tierFormatNotice(message)) {
      if (import.meta.env?.DEV) {
        console.debug(
          "[jornada-gantt] aviso interno de timeline suprimido:",
          message,
        )
      }
      return
    }

    publish({
      tone: "error",
      message:
        message === "Ocorreu um erro inesperado."
          ? "Não foi possível concluir a ação no cronograma."
          : message,
      details: errorDetails(message),
    })

    props.onError?.(reason)
  })
  const patchView = useEvent((changes: Partial<GanttViewState>) => {
    if (restoring.current) return
    const next = mergeViewState(viewRef.current, changes)
    if (next === viewRef.current) return
    viewRef.current = next
    store.save(next)
    setView(next)
  })
  const rebind = React.useCallback(() => {
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      needsRestore.current = true
      binding.current = true
      setRevision((value) => value + 1)
    })
  }, [])
  React.useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    if (cellEditFrame.current !== null) cancelAnimationFrame(cellEditFrame.current)
    if (nativeCommitFrame.current !== null) cancelAnimationFrame(nativeCommitFrame.current)
  }, [])

  React.useEffect(() => {
    let active = true
    setLoading(true)
    sessionRef.current = null
    identities.current = new RenderIds()
    binding.current = true
    registerPortuguese()
    props.adapter.load(props.context).then(async (dataset) => {
      const resources = dataset.resources ?? await props.adapter.resolveResources?.(props.context) ?? []
      if (!active) return
      sessionRef.current = new GanttSession({ ...dataset, resources }, { policy: props.adapter.policy ?? permissivePolicy })
      needsRestore.current = true
      setLoading(false)
      setRevision((value) => value + 1)
    }).catch((reason: unknown) => { if (active) { setLoading(false); fail(reason) } })
    return () => { active = false }
  }, [props.adapter, props.context, reload, fail])

  const dataset = React.useMemo<GanttDataset>(() => sessionRef.current?.dataset ?? { tasks: [] }, [revision, loading])
  /*
   * Kept in a ref, not in the row data: tinting is presentation only, so toggling it
   * must never rebuild the data source — doing that left the chart stuck on its spinner.
   */
  const changedFields = React.useRef(new Map<string, Set<string>>())
  React.useMemo(() => {
    changedFields.current = sessionRef.current && editing
      ? changedFieldsByTask(sessionRef.current.changeset)
      : new Map()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, editing])
  const businessTypeLabel = React.useCallback((task: { entityType?: string; businessType?: string }) =>
    task.entityType === "atividade" ? "Atividade"
      : businessTypes.find((item) => item.value === task.businessType)?.label ?? "Entrega",
    [businessTypes])
  const rows = React.useMemo(() => sortRowsByDate(toSyncfusionDataset(dataset, {
    policy: props.adapter.policy, identities: identities.current, offsetUnits: OFFSET_UNITS,
    businessTypeLabel, leftLabelField: view.leftLabelField, rightLabelField: view.rightLabelField,
  })), [dataset, props.adapter, businessTypeLabel, view.leftLabelField, view.rightLabelField])
  const ganttRows = React.useMemo(() => rows.map((row) => ({
    ...row,
    isManual: view.scheduleMode === "manual" ? true : view.scheduleMode === "auto" ? false : row.isManual,
  })), [rows, view.scheduleMode])
  const session = sessionRef.current
  const structureKey = React.useMemo(() => renderStructureKey(rows), [rows])
  const resources = React.useMemo(() => dataset.resources ?? [], [dataset])
  const optionsFor = React.useCallback((field: "status" | "priority", row: SyncfusionTask) =>
    props.adapter.editOptions?.(field, row?.entityType) ?? NO_CHOICES, [props.adapter])

  const selectionRows = () => (gantt.current?.selectionModule.getSelectedRecords() ?? [])
    .map(readNativeRow).filter((row): row is SyncfusionTask => row !== null)
  const sourceIds = () => [...new Set(selectionRows().filter((row) => !row._projection).map((row) => row._sourceId))]
  const selectedSourceIds = () =>
    [...new Set(
      selectionRows()
        .filter((row) => !row._projection)
        .map((row) => row._sourceId)
    )]
  const lockedFor = (row: SyncfusionTask) => new Set(row._locked)
  const run = (operation: (current: GanttSession) => void) => {
    if (busy.current || !sessionRef.current) return
    const before = sessionRef.current.revision
    try {
      operation(sessionRef.current)
      if (sessionRef.current.revision !== before) rebind()
    } catch (reason) { fail(reason); rebind() }
  }

  const scheduleNativeCommit = useEvent((
    hints: unknown[] = [],
    captureAll: boolean = false,
  ) => {
    nativeCommitHints.current.push(...hints.filter(Boolean))
    nativeCommitAll.current = nativeCommitAll.current || captureAll === true
    if (nativeCommitFrame.current !== null) cancelAnimationFrame(nativeCommitFrame.current)
    nativeCommitFrame.current = requestAnimationFrame(() => {
      nativeCommitFrame.current = null
      const source = nativeCommitAll.current ? (gantt.current?.flatData ?? []) : nativeCommitHints.current
      nativeCommitHints.current = []
      nativeCommitAll.current = false
      const stabilized = [...new Map(source
        .map(readNativeSnapshot)
        .filter((row): row is SyncfusionTask => row !== null && !row._projection)
        .map((row) => [row._sourceId, row] as const)).values()]
      if (stabilized.length && !busy.current && !binding.current) {
        run((current) => applyNativeEdits(current, stabilized, identities.current, {
          allowDependencies: permissions.link && capabilities.dependencies,
          allowSchedulingMode: viewRef.current.scheduleMode === "custom",
          editOptions: props.adapter.editOptions?.bind(props.adapter),
        }))
      }
      const queuedSave = saveAfterNativeCommit.current
      saveAfterNativeCommit.current = null
      queuedSave?.()
    })
  })
  const createRow = useEvent((kind: string) => {
    if (!permissions.create) return
    const option = creationOptions.find((item) => item.id === kind)
    if (!option) return
    run((current) => {
      const anchor = selectionRows()[0]
      const owner = current.tasks.find((item) => item.id === anchor?._sourceId)
      const parentId = owner ? (owner.entityType === "entrega" || owner.kind === "group" ? owner.id : owner.parentId) : null

      // Calculate next WBS
      const siblings = current.tasks.filter((task) => task.parentId === parentId)
      const nextNumber = siblings.length + 1

      // Build WBS prefix
      let wbsPrefix = ""
      if (parentId) {
        const parent = current.tasks.find((task) => task.id === parentId)
        if (parent && parent.wbs) {
          wbsPrefix = parent.wbs + "."
        }
      }
      const nextWbs = wbsPrefix ? `${wbsPrefix}${nextNumber}` : String(nextNumber)

      // Get default status and priority from adapter
      let defaultStatus: string | null = null
      let defaultPriority: string | null = null

      if (kind === "atividade" || option.task.entityType === "atividade") {
        const statusOptions = props.adapter.editOptions?.("status", option.task.entityType)
        defaultStatus = statusOptions?.find((opt) => opt.label === "Não iniciada")?.value ?? statusOptions?.[0]?.value ?? null
        const priorityOptions = props.adapter.editOptions?.("priority", option.task.entityType)
        defaultPriority = priorityOptions?.find((opt) => opt.label === "3-Média")?.value ?? priorityOptions?.[Math.floor((priorityOptions?.length ?? 1) / 2)]?.value ?? null
      }

      const baseTitle = option.id === "atividade"
        ? "Nova atividade"
        : option.id === "grupo"
          ? "Novo grupo"
          : "Nova entrega"

      const title = `${baseTitle} ${nextWbs}`

      const id = current.createTask({
        ...option.task,
        title,
        parentId,
        ...(defaultStatus ? { status: defaultStatus } : {}),
        ...(defaultPriority ? { priority: defaultPriority } : {}),
        ...(option.seedMilestoneDate ? { milestoneDate: new Date() } : {}),
      })
      patchView({ selectedTaskIds: [id] })
    })
  })
  const openDialog = useEvent(() => {
    if (busy.current || !permissions.update || !capabilities.dialogEditing) return
    const source = [...new Set(selectionRows().map((row) => row._sourceId))]
    if (source.length !== 1) return
    const row = rows.find((item) => !item._projection && item._sourceId === source[0])
    if (!row || !gantt.current || !canOpenTaskDialog(row)) return

    // Cancel any pending cell edit frame
    if (cellEditFrame.current !== null) {
      cancelAnimationFrame(cellEditFrame.current)
      cellEditFrame.current = null
    }

    try {
      gantt.current?.treeGrid?.closeEdit()
    } catch { }

    requestAnimationFrame(() => {
      try {
        gantt.current?.openEditDialog(row.TaskID)
      } catch (reason) {
        fail(reason)
      }
    })
  })
  const structural = useEvent((direction: "indent" | "outdent") => {
    if (!permissions.update || !permissions.reparent || !capabilities.indentOutdent) return
    run((current) => {
      const before = sourceIds()
      const result = direction === "indent"
        ? current.indent(before, {
          // One activity under another is impossible in the schema; wrap it in a new
          // group at the same position instead of refusing the gesture.
          autoGroup: (task) => ({
            title: `Grupo de ${task.title}`,
            kind: "group", entityType: props.groupEntityType ?? "entrega",
            businessType: "Entrega", isSummary: true, showMilestone: false, status: "Nova",
          }),
        })
        : current.outdent(before)
      // The rows the user acted on stay selected, so a second indent needs no re-click.
      patchView({ selectedTaskIds: before })
      if (result.rejected.length) publish({
        tone: "warning", message: "Algumas linhas não puderam ser movidas.",
        details: result.rejected.map((item) => item.message),
      })
    })
  })
  const removeByIds = useEvent((ids: string[]) => {
    if (!permissions.delete || ids.length === 0) return

    run((current) => {
      const result = current.deleteTasks(ids)

      if (result.rejected.length) {
        publish({
          tone: "warning",
          message: "Exclusão recusada.",
          details: result.rejected.map((item) => item.message),
        })
      }
    })
  })
  const requestDelete = useEvent(() => {
    if (!permissions.delete || busy.current) return

    const selected = selectionRows()
    const projectionsOnly = selected.length > 0 && selected.every((row) => row._projection)

    if (projectionsOnly) {
      publish({
        tone: "info",
        message: "Este é um marco automático da entrega.",
        details: [
          "O marco automático não pode ser excluído como uma linha independente. Para removê-lo, edite a entrega correspondente e desmarque a opção de exibição do marco.",
        ],
      })
      return
    }

    const ids = selectedSourceIds().filter(id => {
      const row = selected.find(r => r._sourceId === id)
      return row && !row._projection
    })

    if (!ids.length) {
      publish({
        tone: "info",
        message: "Selecione pelo menos uma linha para excluir.",
      })
      return
    }

    const dialog = DialogUtility.confirm({
      title: "Confirmar exclusão",
      content: ids.length === 1
        ? "Deseja excluir a linha selecionada?"
        : `Deseja excluir as ${ids.length} linhas selecionadas?`,
      isModal: true,
      showCloseIcon: true,
      closeOnEscape: true,
      okButton: {
        text: "Excluir",
        cssClass: "e-danger",
        click: () => {
          dialog.hide()
          removeByIds(ids)
        },
      },
      cancelButton: {
        text: "Cancelar",
        click: () => dialog.hide(),
      },
    })
  })
  const connect = useEvent((disconnect = false) => {
    if (!permissions.update || !permissions.link || !capabilities.dependencies || !capabilities.smartLink) return
    run((current) => {
      if (disconnect) {
        const removed = current.disconnectSelection(sourceIds())
        publish({ tone: "info", message: `${removed.length} vínculo(s) removido(s).` })
      } else {
        const plan = current.connectSelection(sourceIds(), { strategy, useVisualOrder: true })
        if (plan.created.length && viewRef.current.scheduleMode !== "manual") captureNativeSchedule.current = true
        publish({
          tone: plan.rejected.length ? "warning" : "success",
          message: `${plan.created.length} vínculo(s) criado(s).`, details: plan.rejected.map((item) => item.message)
        })
      }
    })
  })
  const autoSequenceAll = useEvent(() => {
    if (!permissions.update || !permissions.link || !capabilities.dependencies || !capabilities.smartLink) return
    run((current) => {
      const plan = current.autoSequenceUnlinked()
      if (plan.created.length && viewRef.current.scheduleMode !== "manual") captureNativeSchedule.current = true
      publish({
        tone: plan.rejected.length ? "warning" : plan.created.length ? "success" : "info",
        message: plan.created.length
          ? `${plan.created.length} vínculo(s) criado(s) em cadeias por grupo.`
          : "Nenhuma atividade sem predecessora disponível para sequenciar.",
        details: plan.rejected.map((item) => item.message),
      })
    })
  })
  const history = useEvent((direction: "undo" | "redo") => {
    if (!permissions.update || !capabilities.undoRedo) return
    run((current) => current[direction]())
  })
  const cancelEdits = useEvent(() => {
    const current = sessionRef.current
    if (!current || busy.current) return
    if (current.dirty) run((session) => session.revert())
    leaveEditing()
  })
  /** Leaves edit mode and drops every presentation state that belongs to it. */
  const leaveEditing = useEvent(() => {
    setEditing(false)
    setConfirmExit(false)
    publish(null)
    // The marks are drawn per cell, so they only disappear on the next bind.
    changedFields.current = new Map()
    rebind()
  })
  const startEditing = useEvent(() => {
    if (!granted.update && !granted.create) return
    setEditing(true)
    publish(null)
  })
  const exitEditing = useEvent(() => {
    if (busy.current) return
    if (sessionRef.current?.dirty) { setConfirmExit(true); return }
    leaveEditing()
  })
  const requestReload = useEvent(() => {
    if (sessionRef.current?.dirty) setConfirmReload(true)
    else setReload((value) => value + 1)
  })
  const performSave = useEvent((onSaved?: () => void) => {
    const current = sessionRef.current
    if (!current || busy.current || !permissions.save) return
    if (!current.dirty) {
      onSaved?.()
      return
    }
    busy.current = true
    setSaving(true)
    void (async () => {
      try {
        const changeset = current.changeset
        const validation = await props.adapter.validate?.(props.context, changeset)
        if (validation && !validation.valid) throw new Error(validation.issues.map((item) => item.message).join("\n"))
        const result = await props.adapter.save(props.context, changeset)
        if (!result.success) throw new Error(result.message ?? "Não foi possível sincronizar.")
        const saved = result.dataset ?? await props.adapter.load(props.context)
        const savedResources = saved.resources ?? await props.adapter.resolveResources?.(props.context) ?? []
        current.reconcile({ ...saved, resources: savedResources })
        const remap = (id: string) => id.startsWith("__milestone__:")
          ? `__milestone__:${result.idMap?.[id.slice("__milestone__:".length)] ?? id.slice("__milestone__:".length)}`
          : result.idMap?.[id] ?? id
        patchView({
          selectedTaskIds: viewRef.current.selectedTaskIds.map(remap),
          collapsedTaskIds: viewRef.current.collapsedTaskIds.map(remap)
        })
        publish(null)
        props.onSaved?.()
        rebind()
        // Only now, with the write confirmed, may a "save and leave" actually leave.
        onSaved?.()
      } catch (reason) { fail(reason) }
      finally { busy.current = false; setSaving(false) }
    })()
  })

  const save = useEvent((onSaved?: () => void) => {
    if (nativeCommitFrame.current !== null) {
      saveAfterNativeCommit.current = () => performSave(onSaved)
      return
    }
    performSave(onSaved)
  })

  /** Native toolbar commands are enabled from our own state, not the component's. */
  const syncToolbarState = useEvent(() => {
    const chart = gantt.current as unknown as {
      toolbarModule?: { enableItems(ids: string[], enable: boolean): void }
      element?: { id?: string }
    }
    const id = chart?.element?.id ?? GANTT_ID
    try {
      const enable = (command: string, on: boolean) => chart?.toolbarModule?.enableItems([`${id}_${command}`], on)
      enable(COMMANDS.undo, Boolean(sessionRef.current?.canUndo) && permissions.update)
      enable(COMMANDS.redo, Boolean(sessionRef.current?.canRedo) && permissions.update)
      const canMove = permissions.update && permissions.reparent && selectionRef.current.length > 0
      enable(COMMANDS.indent, canMove)
      enable(COMMANDS.outdent, canMove)
    } catch { /* the toolbar is not mounted on every bind */ }
  })

  const onSelection = useEvent((value: unknown) => {
    if (restoring.current || binding.current || (value as { isInteracted?: boolean })?.isInteracted === false) return
    const keys = selectionRows().map(rowKey)
    selectionRef.current = keys
    syncToolbarState()
    if (JSON.stringify(keys) === JSON.stringify(viewRef.current.selectedTaskIds)) return
    patchView({ selectedTaskIds: keys })
    setSelected(keys)
  })
  const onExpand = useEvent((value: unknown, collapsed: boolean) => {
    if (restoring.current || binding.current) return
    const row = readNativeRow((value as { data?: unknown }).data)
    if (!row) return
    const ids = new Set(viewRef.current.collapsedTaskIds)
    if (collapsed) ids.add(rowKey(row)); else ids.delete(rowKey(row))
    patchView({ collapsedTaskIds: [...ids] })
  })
  const onDataBound = useEvent(() => {
    syncToolbarState()
    if (!needsRestore.current || !gantt.current) return
    needsRestore.current = false
    restoring.current = true
    try {
      const chart = gantt.current
      for (const record of chart.flatData) {
        const row = readNativeRow(record)
        if (row && record.expanded !== false && viewRef.current.collapsedTaskIds.includes(rowKey(row))) chart.collapseByID(row.TaskID)
      }
      const indexes = chart.updatedRecords.flatMap((record, index) => {
        const row = readNativeRow(record)
        return row && viewRef.current.selectedTaskIds.includes(rowKey(row)) ? [index] : []
      })
      chart.clearSelection()
      if (indexes.length) chart.selectRows(indexes)
      if (viewRef.current.timelinePreset === "fit") {
        requestAnimationFrame(() => {
          try { (chart as unknown as { fitToProject?: () => void }).fitToProject?.() } catch { /* best effort */ }
        })
      }
      if (captureNativeSchedule.current && editing) {
        captureNativeSchedule.current = false
        const scheduled = chart.updatedRecords.map(readNativeRow).filter((row): row is SyncfusionTask => row !== null)
        if (scheduled.length) run((current) => applyNativeEdits(current, scheduled, identities.current, {
          allowDependencies: permissions.link && capabilities.dependencies,
          allowSchedulingMode: viewRef.current.scheduleMode === "custom",
          editOptions: props.adapter.editOptions?.bind(props.adapter),
        }))
      }
      const restored = selectionRows().map(rowKey)
      selectionRef.current = restored
      setSelected(restored)
    } catch (reason) { fail(reason) }
    finally { restoring.current = false; binding.current = false }
  })
  const onActionBegin = useEvent((value: unknown) => {
    const event = value as {
      requestType?: string; cancel?: boolean; data?: unknown; rowData?: unknown;
      taskBarEditAction?: string; action?: string; modifiedRecords?: unknown[];[tab: string]: unknown
    }
    const type = String(event.requestType ?? "").toLowerCase()
    if (busy.current && ["beforesave", "beforeopeneditdialog", "beforedelete", "beforeadd"].includes(type)) {
      event.cancel = true
      return
    }
    const row = readNativeRow(event.data ?? event.rowData)

    if (type === "beforedelete") {
      event.cancel = true
      return
    }
    if (type === "beforeopeneditdialog") {
      if (!capabilities.dialogEditing || !permissions.update || !canOpenTaskDialog(row)) {
        event.cancel = true
        if (row?._projection) {
          publish({ tone: "info", message: `Este marco exibe a entrega "${row.TaskName.replace(/^Marco:\s*/, "")}". Abra a entrega para editá-la.` })
        }
        return
      }
      const locked = lockedFor(row as SyncfusionTask)
      for (const tab of Object.keys(event).filter((key) => key === "General" || key.startsWith("Custom"))) {
        const editors = event[tab]
        if (!editors || typeof editors !== "object") continue
        for (const [field, model] of Object.entries(editors)) {
          if (!model || typeof model !== "object") continue
          if (locked.has(FIELD_NAMES[field] ?? field) || READ_ONLY_GRID_FIELDS.has(field)) {
            Object.assign(model, { enabled: false })
          }
          if (field === "status" || field === "priority") {
            Object.assign(model, {
              dataSource: optionsFor(field, row as SyncfusionTask),
              fields: { text: "label", value: "value" },
            })
          }
        }
      }
      return
    }
    if (type === "beforesave" && row) {
      if (!permissions.update || row._projection || row._readOnly) { event.cancel = true; return }
      if ((event.taskBarEditAction || event.action === "TaskbarEditing") && lockedFor(row).has("startDate")) {
        event.cancel = true
        return
      }
      const current = sessionRef.current
      if (current) {
        const batch = [...(event.modifiedRecords ?? []), row].map(readNativeRow)
          .filter((item): item is SyncfusionTask => item !== null)
        try {
          applyNativeEdits(new GanttSession(current.dataset, { policy: current.policy }), batch, identities.current, {
            allowDependencies: permissions.link && capabilities.dependencies,
            allowSchedulingMode: viewRef.current.scheduleMode === "custom",
            editOptions: props.adapter.editOptions?.bind(props.adapter),
          })
        } catch (reason) { event.cancel = true; fail(reason) }
      }
    }
  })
  const onActionComplete = useEvent((value: unknown) => {
    const event = value as { requestType?: string; data?: unknown; modifiedRecords?: unknown[] }
    const requestType = String(event.requestType ?? "").toLowerCase()
    if (!requestType || busy.current || binding.current) return
    if (!["save", "recordupdate", "connectorlineupdate", "connectorlinedelete"].includes(requestType)) return
    const hints = [...(event.modifiedRecords ?? []), event.data].filter(Boolean)
    scheduleNativeCommit(hints, editing && viewRef.current.scheduleMode !== "manual")
  })
  const onCellEdit = useEvent((value: unknown) => {
    const event = value as {
      cancel?: boolean; rowData?: unknown; data?: unknown; columnName?: string
      column?: { field?: string }; columnObject?: { field?: string }
    }
    const row = readNativeRow(event.rowData ?? event.data)
    const field = event.columnName ?? event.columnObject?.field ?? event.column?.field ?? ""
    if (busy.current || !permissions.update || !capabilities.inlineEditing ||
      !canEditGridField(row, field, row ? lockedFor(row) : new Set(), permissions.link && capabilities.dependencies) ||
      (field === "responsibleId" && resources.length === 0)) {
      event.cancel = true
    }
  })
  const onTaskbarEditing = useEvent((value: unknown) => {
    const event = value as { cancel?: boolean; data?: unknown; taskBarEditAction?: string }
    const row = readNativeRow(event.data)
    if (busy.current || !permissions.update || row?._projection || row?._readOnly ||
      (event.taskBarEditAction?.startsWith("ConnectorPoint") && (!permissions.link || !capabilities.dependencies)) ||
      (row && lockedFor(row).has("startDate"))) event.cancel = true
  })
  /**
   * Refuses the drag before it starts. Hiding the handle was not enough: the row is
   * still draggable from its cells, so the gesture has to be vetoed at the source.
   */
  const onDragStart = useEvent((value: unknown) => {
    const event = value as { cancel?: boolean; data?: unknown }
    const records = (Array.isArray(event.data) ? event.data : [event.data]).map(readNativeRow)
    if (busy.current || !permissions.update || !permissions.reparent ||
      records.some((row) => row && (isFixedMilestone(row) || row._readOnly))) {
      event.cancel = true
    }
  })
  const onDrop = useEvent((value: unknown) => {
    const event = value as { cancel?: boolean; data?: unknown; dropIndex?: number; dropPosition?: string; dropRecord?: unknown }
    event.cancel = true
    if (busy.current || !permissions.update || !permissions.reparent) return
    const target = readNativeRow(event.dropRecord ?? gantt.current?.updatedRecords[event.dropIndex ?? -1])
    const moving = (Array.isArray(event.data) ? event.data : [event.data]).map(readNativeRow)
      .filter((row): row is SyncfusionTask => row !== null)
    const fixed = moving.find(isFixedMilestone)
    if (fixed && !fixed._projection) {
      publish({ tone: "info", message: `"${fixed.TaskName}" é um marco: ele marca uma data e não é reposicionado por arraste. Ajuste a data do marco.` })
      return
    }
    const mirror = moving.find((row) => row._projection) ?? (target?._projection ? target : undefined)
    if (mirror) {
      const owner = rows.find((row) => row._sourceId === mirror._sourceId && !row._projection)
      publish({
        tone: "info",
        message: `Marco de "${owner?.TaskName ?? mirror.TaskName}" (linha ${owner?.WBS || owner?.TaskID || "—"}).`,
        details: [
          `Data exibida: ${mirror.StartDate ? mirror.StartDate.toLocaleDateString("pt-BR") : "sem data definida"}.`,
          "Esta linha espelha a entrega e acompanha a posição dela. Arraste a entrega para reposicionar as duas.",
        ],
      })
      return
    }
    if (!target) return
    run((current) => {
      const targetTask = current.tasks.find((item) => item.id === target._sourceId)
      if (!targetTask) throw new Error("Destino não encontrado.")
      const child = event.dropPosition === "middleSegment"
      const parentId = child ? targetTask.id : targetTask.parentId
      const order = child ? current.tasks.filter((item) => item.parentId === parentId).length
        : targetTask.order + (event.dropPosition === "bottomSegment" ? 0.5 : -0.5)
      current.transact(() => {
        moving.forEach((row, index) => {
          const result = current.moveTask(row._sourceId, parentId, order + index / (moving.length + 1) / 10)
          if (result.rejected.length) throw new Error(result.rejected[0].message)
        })
      })
    })
  })
  const onToolbar = useEvent((value: unknown) => {
    const event = value as { item?: { id?: string }; cancel?: boolean }
    const id = String(event.item?.id ?? "")
    // The component prefixes ids with its own element id, which may itself contain "_",
    // so match on the suffix instead of slicing at the first separator.
    const normalized = id.toLowerCase()
    const is = (command: string) => normalized === command.toLowerCase() || normalized.endsWith(`_${command.toLowerCase()}`)
    if (is(COMMANDS.undo)) { event.cancel = true; history("undo"); return }
    if (is(COMMANDS.redo)) { event.cancel = true; history("redo"); return }
    if (is(COMMANDS.indent)) { event.cancel = true; structural("indent"); return }
    if (is(COMMANDS.outdent)) { event.cancel = true; structural("outdent"); return }
    if (is("Delete")) { event.cancel = true; requestDelete(); return }
    if (is("Edit")) { event.cancel = true; openDialog(); return }
    const chart = gantt.current as unknown as { pdfExport?: () => Promise<unknown>; excelExport?: () => Promise<unknown> }
    if (is("PdfExport")) { event.cancel = true; void chart?.pdfExport?.().catch(fail); return }
    if (is("ExcelExport")) { event.cancel = true; void chart?.excelExport?.().catch(fail); return }
  })
  const onContextMenu = useEvent((value: unknown) => {
    const id = (value as { item?: { id?: string } }).item?.id
    if (id === "jgConnect") connect()
    if (id === "jgDisconnect") connect(true)
  })
  const onFailure = useEvent((value: unknown) => fail((value as { error?: unknown }).error ?? value))
  const onSplitter = useEvent((value: unknown) => {
    const size = (value as { paneSize?: number[] }).paneSize?.[0]
    if (typeof size === "number") patchView({ splitterPosition: `${size}px` })
  })
  const onCollapsed = useEvent((value: unknown) => onExpand(value, true))
  const onExpanded = useEvent((value: unknown) => onExpand(value, false))
  /**
   * Opens the editor on a single click. The component edits on double click by default;
   * for a grid people fill in row by row that is one click too many.
   */
  const onRecordClick = useEvent((value: unknown) => {
    if (!props.editOnSingleClick || busy.current || !editing) return
    if (!permissions.update || !capabilities.inlineEditing) return
    const event = value as { rowData?: unknown; column?: { field?: string }; cellIndex?: number }
    const row = readNativeRow(event.rowData)
    const field = event.column?.field ?? ""
    if (!row || !field) return
    if (!canEditGridField(row, field, lockedFor(row), permissions.link && capabilities.dependencies)) return
    const chart = gantt.current as unknown as {
      treeGrid?: { editModule?: { editCell?: (index: number, field: string) => void } }
      updatedRecords?: unknown[]
    }
    const index = (chart?.updatedRecords ?? []).findIndex((item) => readNativeRow(item)?.TaskID === row.TaskID)
    if (index < 0) return

    // Cancel any pending cell edit frame
    if (cellEditFrame.current !== null) {
      cancelAnimationFrame(cellEditFrame.current)
      cellEditFrame.current = null
    }

    // Deferred: the click that opens the editor must finish before the editor is created.
    cellEditFrame.current = requestAnimationFrame(() => {
      cellEditFrame.current = null
      try { chart?.treeGrid?.editModule?.editCell?.(index, field) } catch { /* row left the view */ }
    })
  })
  const onCellInfo = useEvent((value: unknown) => {
    const event = value as { data?: unknown; column?: { field?: string }; cell?: HTMLElement }
    const row = readNativeRow(event.data)
    const field = event.column?.field ?? ""
    if (!row || !event.cell) return
    const editable = permissions.update && capabilities.inlineEditing &&
      canEditGridField(row, field, lockedFor(row), permissions.link && capabilities.dependencies)
    event.cell.classList.toggle("jg-readonly-cell", !editable)
    event.cell.classList.toggle("jg-late-cell", isLateTask(row))
    if (row._projection) event.cell.classList.add("jg-mirror-cell")
    if (isSummaryRow(row)) event.cell.classList.add("jg-summary-cell")
    if (isFixedMilestone(row)) event.cell.classList.add("jg-nodrag-cell")
    const changed = changedFields.current.get(row._sourceId)
    const marked = Boolean(changed && (changed.has(WHOLE_ROW) || changed.has(field) ||
      [...changed].some((name) => CHANGED_FIELD_COLUMNS[name] === field)))
    // The class is always applied; CSS on the container decides whether it shows.
    event.cell.classList.toggle("jg-changed-cell", marked)
  })
  const onTaskbarInfo = useEvent((value: unknown) => {
    const event = value as {
      data?: unknown; taskbarBgColor?: string; taskbarBorderColor?: string; progressBarBgColor?: string; milestoneColor?: string
    }
    const row = readNativeRow(event.data)
    if (!row) return
    const status = foldText(row.status)
    const completed = row.Progress >= 100 || ["concluida", "concluido", "finalizada", "finalizado"].includes(status)
    const blocked = ["bloqueada", "bloqueado"].includes(status)
    const late = isLateTask(row)
    const color = blocked ? "#dc2626" : completed ? "#2563eb" : late ? "#d1483c" : row.color
    if (!color) return
    event.taskbarBgColor = color
    event.taskbarBorderColor = color
    event.progressBarBgColor = blocked ? "#991b1b" : late ? "#8f251d" : color
    event.milestoneColor = color
  })

  const eventMarkers = React.useMemo(() => [
    ...(isToggleOn(view, "showAnnotations")
      ? [
        ...(dataset.markers ?? []).map((marker) => ({
          day: marker.date, label: marker.label, cssClass: marker.cssClass,
        })),
        ...(dataset.holidays ?? []).map((holiday) => ({
          day: holiday.from, label: holiday.label ?? "Feriado", cssClass: holiday.cssClass ?? "jg-holiday-marker",
        })),
      ]
      : []),
    ...(isToggleOn(view, "showTodayMarker")
      ? [{
        day: new Date(),
        label: "Hoje",
        cssClass: "jg-today-marker",
      }]
      : []),
  ], [view.showAnnotations, view.showTodayMarker, dataset.markers, dataset.holidays])

  const settingsWindow = React.useMemo(() => {
    const parse = (value: string | null | undefined) => {
      if (!value) return null
      const [year, month, day] = value.split("-").map(Number)
      return Number.isFinite(year) ? new Date(year, (month ?? 1) - 1, day ?? 1) : null
    }
    const start = parse(view.projectStart)
    const end = parse(view.projectEnd)
    // An inverted window would blank the chart; ignore it instead.
    return start && end && start > end ? { start: null, end: null } : { start, end }
  }, [view.projectStart, view.projectEnd])

  React.useEffect(syncToolbarState, [revision, permissions.update])
  const labelSignature = `${view.leftLabelField ?? ""}|${view.rightLabelField ?? ""}`
  const firstLabels = React.useRef(true)
  React.useEffect(() => {
    if (firstLabels.current) { firstLabels.current = false; return }
    rebind()
  }, [labelSignature, rebind])

  const splitterSettings = React.useMemo<GanttModel["splitterSettings"]>(() => {
    if (view.viewMode === "Grid") return { position: "100%", view: "Grid", separatorSize: 4, minimum: "260px" }
    if (view.viewMode === "Chart") return { position: "0%", view: "Chart", separatorSize: 4, minimum: "260px" }
    return { position: view.splitterPosition ?? "46%", view: "Default", separatorSize: 4, minimum: "260px" }
  }, [view.viewMode, view.splitterPosition])
  const model = React.useMemo<GanttModel>(() => ({
    height: props.height ?? "100%", dataSource: ganttRows, taskFields: TASK_FIELDS,
    locale: props.locale ?? "pt-BR", allowSelection: true, dateFormat: "dd/MM/yyyy", durationUnit: "Day",
    readOnly: saving || !permissions.update,
    selectionSettings: { type: "Multiple", mode: "Row", enableToggle: true },
    // Standard Gantt operations live on the chart's own toolbar; anything about our
    // data model stays on the bar above it.
    toolbar: [
      ...(editing && capabilities.dialogEditing ? ["Edit"] : []),
      ...(editing && permissions.delete ? ["Delete"] : []),
      ...(editing && (capabilities.dialogEditing || permissions.delete) ? [{ type: "Separator" }] : []),
      "ExpandAll", "CollapseAll",
      ...(editing && capabilities.indentOutdent ? [{ type: "Separator" },
      { id: COMMANDS.outdent, text: "Desindentar", tooltipText: "Desindentar (Alt+Shift+←)", prefixIcon: "e-icons e-outdent" },
      { id: COMMANDS.indent, text: "Indentar", tooltipText: "Indentar (Alt+Shift+→)", prefixIcon: "e-icons e-indent" }] : []),
      { type: "Separator" }, "ZoomIn", "ZoomOut", "ZoomToFit",
      ...(editing && capabilities.undoRedo
        ? [{ type: "Separator" },
        { id: COMMANDS.undo, text: "Desfazer", tooltipText: "Desfazer (Ctrl+Z)", prefixIcon: "e-icons e-undo" },
        { id: COMMANDS.redo, text: "Refazer", tooltipText: "Refazer (Ctrl+Y)", prefixIcon: "e-icons e-redo" }]
        : []),
      { type: "Separator" },
      ...(capabilities.excelExport ? ["ExcelExport"] : []),
      ...(capabilities.pdfExport ? ["PdfExport"] : []),
      ...(capabilities.search ? [{ type: "Separator" }, "Search"] : []),
    ] as GanttModel["toolbar"],
    searchSettings: { fields: ["TaskName", "responsibleName", "businessType", "status", "priority", "Notes", "tagsText"], ignoreCase: true },
    allowFiltering: capabilities.filtering, allowSorting: capabilities.sorting,
    allowResizing: capabilities.columnResizing, allowReordering: capabilities.columnReorder,
    showColumnMenu: capabilities.columnMenu,
    columnMenuItems: ["ColumnChooser", "SortAscending", "SortDescending", "AutoFitAll", "AutoFit", "Filter"],
    enableContextMenu: capabilities.contextMenu,
    contextMenuItems: [
      ...(editing && capabilities.dialogEditing ? ["TaskInformation"] : []),
      ...(editing && permissions.delete ? ["DeleteTask", "DeleteDependency"] : []),
      "AutoFitAll", "AutoFit",
      "SortAscending", "SortDescending",
      { text: "Conectar seleção", id: "jgConnect", target: ".e-content" },
      { text: "Desconectar seleção", id: "jgDisconnect", target: ".e-content" },
      // `ContextMenuItem[] | ContextMenuItemModel[]` is a union of arrays, so a list that
      // mixes built-in names with custom entries needs the cast.
    ] as GanttModel["contextMenuItems"],
    allowExcelExport: capabilities.excelExport, allowPdfExport: capabilities.pdfExport,
    enableVirtualization: capabilities.virtualScroll,
    allowRowDragAndDrop: capabilities.rowDragAndDrop && permissions.update && permissions.reparent && !saving,
    allowParentDependency: true, updateOffsetOnTaskbarEdit: false, autoFocusTasks: true, enableHover: true,
    autoCalculateDateScheduling: view.scheduleMode !== "manual",
    taskMode: view.scheduleMode === "custom" ? "Custom" : view.scheduleMode === "auto" ? "Auto" : "Manual",
    validateManualTasksOnLinking: false,
    enableCriticalPath: capabilities.criticalPath && isToggleOn(view, "showCriticalPath"),
    renderBaseline: capabilities.baseline && isToggleOn(view, "showBaseline"),
    /*
     * The core measures duration in inclusive calendar days. Left on its default
     * Monday-Friday week, the renderer rescheduled every row — a 5-day task starting
     * 01/09 ended on 08/09 instead of 05/09 — and those recalculated dates came back as
     * if the user had edited them. A seven-day week makes both sides agree.
     */
    workWeek: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    includeWeekend: true,
    gridLines: view.gridLines ?? "Horizontal", highlightWeekends: false, allowUnscheduledTasks: true, taskbarHeight: 24,
    // Holidays are shown as markers, not as `holidays`: that property also removes the
    // day from the schedule, which would shift stored dates the user never touched.
    eventMarkers: eventMarkers,
    splitterSettings,
    timelineSettings: resolveTimelineSettings(view.timelinePreset),
    // Template form: given a bare field name the component printed the literal
    // "rightLabel" for every bar.
    // Pre-computed strings: a template over a missing field printed "undefined" on
    // every bar, and so did the "do not show" option.
    // Custom fields are reachable only through taskData; a bare `${field}` resolved to
    // nothing and printed the word "undefined" on every bar.
    labelSettings: {
      leftLabel: "${taskData.leftLabelText}",
      rightLabel: "${taskData.rightLabelText}",
      taskLabel: view.showProgressLabel === false ? "" : "${Progress}%",
    },
    tooltipSettings: { showTooltip: true },
    projectStartDate: settingsWindow.start ?? dataset.projectStartDate ?? undefined,
    projectEndDate: settingsWindow.end ?? dataset.projectEndDate ?? undefined,
    connectorLineBackground: isToggleOn(view, "showDependencyLines") ? "#3F51B5" : "transparent",
    connectorLineWidth: isToggleOn(view, "showDependencyLines") ? 1 : 0,
    editSettings: {
      allowEditing: permissions.update && !saving && (capabilities.inlineEditing || capabilities.dialogEditing),
      allowTaskbarEditing: permissions.update && !saving && capabilities.taskbarEditing,
      allowAdding: false, allowDeleting: permissions.delete && !saving,
      showDeleteConfirmDialog: false, mode: "Auto",
    },
    actionBegin: onActionBegin, actionComplete: onActionComplete, actionFailure: onFailure,
    cellEdit: onCellEdit, taskbarEditing: onTaskbarEditing, queryTaskbarInfo: onTaskbarInfo, rowDrop: onDrop,
    toolbarClick: onToolbar, contextMenuClick: onContextMenu, queryCellInfo: onCellInfo,
    cellSelected: props.editOnSingleClick ? onRecordClick : undefined,
    rowDragStartHelper: onDragStart, rowDragStart: onDragStart,
    rowSelected: onSelection, rowDeselected: onSelection, collapsed: onCollapsed, expanded: onExpanded,
    splitterResized: onSplitter, dataBound: onDataBound,
  }), [
    rows, ganttRows, dataset, capabilities, permissions, saving, props.height, props.locale,
    // `highlightChanges` is absent on purpose: it is applied by a container class, so
    // toggling it must not rebuild the chart's data source.
    view.showAnnotations, view.showBaseline, view.showCriticalPath, view.splitterPosition, view.viewMode,
    view.timelinePreset, view.scheduleMode, view.showProgressLabel, view.gridLines, view.showDependencyLines, settingsWindow, editing,
    eventMarkers, splitterSettings,
    onActionBegin, onActionComplete, onFailure, onCellEdit, onTaskbarEditing, onDrop, onToolbar,
    onContextMenu, onSelection, onCollapsed, onExpanded, onSplitter, onDataBound, onCellInfo, onTaskbarInfo, onDragStart, onRecordClick, props.editOnSingleClick,
  ])

  const keyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (busy.current || (event.target as HTMLElement).closest("input,textarea,select,button,[contenteditable=true],.e-dialog")) return
    const meta = event.ctrlKey || event.metaKey
    if (meta && event.key.toLowerCase() === "s") { event.preventDefault(); save() }
    else if (meta && event.key.toLowerCase() === "z") { event.preventDefault(); history(event.shiftKey ? "redo" : "undo") }
    else if (meta && event.key.toLowerCase() === "y") { event.preventDefault(); history("redo") }
    else if (event.key === "F2") { event.preventDefault(); openDialog() }
    else if (event.key === "Delete") { event.preventDefault(); event.stopPropagation(); requestDelete() }
    else if (event.altKey && event.shiftKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault(); structural(event.key === "ArrowRight" ? "indent" : "outdent")
    }
  }
  const noSelection = selected.length === 0
  const selectedOwners = [...new Set(rows.filter((row) => selected.includes(rowKey(row))).map((row) => row._sourceId))]
  const hasMirrors = rows.some((row) => row._projection && selected.includes(rowKey(row)))
  const pinnedToggles = DISPLAY_TOGGLES.filter((toggle) => (view.pinnedToggles ?? []).includes(toggle.id) &&
    (toggle.id !== "showBaseline" || capabilities.baseline) &&
    (toggle.id !== "showCriticalPath" || capabilities.criticalPath))
  const dirty = session?.dirty ?? false

  return <section className={`jg-shell${props.embedded ? " jg-embedded" : ""}`}
    onKeyDownCapture={keyDown} aria-busy={saving || loading}>
    <header className="jg-toolbar">
      <fieldset disabled={saving || loading} className="jg-controls">
        {editing ? <>
          <div className="jg-group">
            <button type="button" className="jg-create" onClick={() => createRow("atividade")} disabled={!permissions.create}>+ Atividade</button>
            <button type="button" onClick={() => createRow("grupo")} disabled={!permissions.create}>+ Grupo</button>
            <button type="button" onClick={() => createRow("Entrega")} disabled={!permissions.create}>+ Entrega</button>
          </div>
          {capabilities.smartLink && <div className="jg-group">
            <button type="button" onClick={() => connect()}
              disabled={!permissions.link || selectedOwners.length < 2 || hasMirrors}>Auto-sequenciar seleção</button>
            <button type="button" onClick={autoSequenceAll}
              disabled={!permissions.link}>Auto-sequenciar sem dependência</button>
            <button type="button" onClick={() => connect(true)}
              disabled={!permissions.link || noSelection || hasMirrors}>Remover dependências</button>
          </div>}
        </> : null}

        {pinnedToggles.length > 0 && <div className="jg-group jg-pinned">
          {pinnedToggles.map((toggle) => (
            <label className="jg-check" key={toggle.id}>
              <input type="checkbox" checked={isToggleOn(view, toggle.id)}
                onChange={(event) => patchView({ [toggle.id]: event.target.checked })} />
              {toggle.short}
            </label>
          ))}
        </div>}

        <div className="jg-group jg-right">
          <label className="jg-view-scale">
            <span className="jg-sr-only">Modo de visualização</span>
            <select className="jg-select" value={view.viewMode} aria-label="Modo de visualização"
              onChange={(event) => patchView({ viewMode: event.target.value as GanttViewState["viewMode"] })}>
              <option value="Default">Tabela e gráfico</option>
              <option value="Grid">Somente tabela</option>
              <option value="Chart">Somente gráfico</option>
            </select>
          </label>
          <label className="jg-view-scale">
            <span className="jg-sr-only">Escala do cronograma</span>
            <select className="jg-select" value={view.timelinePreset} aria-label="Escala do cronograma"
              onChange={(event) => patchView({ timelinePreset: event.target.value as TimelinePreset })}>
              <option value="fit">Geral</option>
              <option value="day">Dia</option>
              <option value="week">Semana</option>
              <option value="month">Mês</option>
              <option value="quarter">Trimestre</option>
              <option value="year">Ano</option>
            </select>
          </label>
          <label className="jg-view-scale">
            <span className="jg-sr-only">Modo de agendamento</span>
            <select className="jg-select" value={view.scheduleMode ?? "manual"} aria-label="Modo de agendamento"
              onChange={(event) => patchView({ scheduleMode: event.target.value as GanttViewState["scheduleMode"] })}>
              <option value="manual">Manual</option>
              <option value="auto">Automático</option>
              <option value="custom">Por atividade</option>
            </select>
          </label>
          <button type="button" className="jg-icon-button" onClick={requestReload}
            title="Recarregar dados do Jornada" aria-label="Recarregar dados do Jornada">
            <span className="e-icons e-refresh" aria-hidden="true" />
          </button>
          <button type="button" className="jg-icon-button" onClick={() => setShowSettings(true)}
            title="Configurações" aria-label="Configurações">
            <span className="e-icons e-settings" aria-hidden="true" />
          </button>
          {editing ? <>
            <button type="button" onClick={cancelEdits} disabled={saving}>Cancelar</button>
            {/* Always enabled; it turns primary only when there is something to write. */}
            <button type="button" className={dirty ? "jg-primary" : undefined} onClick={() => save()} disabled={!permissions.save}>
              {saving ? "Salvando…" : "Salvar"}
            </button>
            <button type="button" className="jg-primary" onClick={exitEditing}>Sair da edição</button>
          </> : (
            <button type="button" className="jg-primary" onClick={startEditing}
              disabled={!granted.update && !granted.create}>Editar cronograma</button>
          )}
        </div>
      </fieldset>
    </header>

    {confirmExit && <div className="jg-banner jg-banner-warning" role="alert">
      <strong>Existem alterações não salvas.</strong>
      <div className="jg-banner-actions">
        <button type="button" className="jg-primary" onClick={() => { setConfirmExit(false); save(leaveEditing) }}>Salvar e sair</button>
        <button type="button" onClick={() => { setConfirmExit(false); cancelEdits() }}>Descartar e sair</button>
        <button type="button" onClick={() => setConfirmExit(false)}>Continuar editando</button>
      </div>
    </div>}
    {confirmReload && <div className="jg-banner jg-banner-warning" role="alert">
      <strong>Recarregar descarta as alterações ainda não salvas.</strong>
      <div className="jg-banner-actions">
        <button type="button" onClick={() => { setConfirmReload(false); setReload((value) => value + 1) }}>Descartar e recarregar</button>
        <button type="button" onClick={() => setConfirmReload(false)}>Continuar editando</button>
      </div>
    </div>}
    {notice && <div className={`jg-banner jg-banner-${notice.tone}`} role="status">
      <strong>{notice.message}</strong>
      {!!notice.details?.length && <ul>{notice.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul>}
      <button type="button" className="jg-close" aria-label="Fechar aviso" onClick={() => publish(null)}>×</button>
    </div>}

    {loading ? <div className="jg-state">Carregando o plano…</div>
      : session ? <div className={`jg-chart${isToggleOn(view, "toolbarLabels") ? "" : " jg-icons-only"}${isToggleOn(view, "highlightChanges") ? " jg-show-changes" : ""}`}>
        <NativeGantt key={structureKey} model={model} ganttRef={gantt} wbs={capabilities.wbs}
          businessTypes={businessTypes} resources={resources} optionsFor={optionsFor} />
      </div>
        : <div className="jg-state">Não foi possível carregar o plano.</div>}

    {showSettings && <SettingsPanel view={view} onChange={patchView} onClose={() => setShowSettings(false)}
      canBaseline={capabilities.baseline} canCriticalPath={capabilities.criticalPath} />}
  </section>

}
