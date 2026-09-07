"use client"
import * as React from "react"
import {
  ColumnDirective, ColumnsDirective, ColumnMenu, ContextMenu, CriticalPath, DayMarkers,
  Edit, ExcelExport, Filter, GanttComponent, Inject, PdfExport, Reorder, Resize, RowDD,
  Selection, Sort, Toolbar, VirtualScroll,
} from "@syncfusion/ej2-react-gantt"
import type { GanttModel, TimelineSettingsModel } from "@syncfusion/ej2-react-gantt"
import type { GanttChoice, GanttDataAdapter, GanttCreationOption } from "../core/adapter"
import type { SmartLinkStrategy } from "../core/dependencies"
import { GanttSession } from "../core/session"
import { permissivePolicy } from "../core/policy"
import type { GanttCapabilities, GanttDataset, GanttPermissions, GanttResource, GanttViewState, TimelinePreset } from "../core/types"
import { GanttViewStateStore, mergeViewState } from "../core/view-state"
import { RenderIds, toSyncfusionDataset, type SyncfusionTask } from "./mapper"
import { changedFieldsByTask } from "../core/changeset"
import { applyNativeEdits, readNativeRow } from "./edit-bridge"
import {
  canEditGridField, canOpenTaskDialog, FIELD_NAMES, isChangedCell, READ_ONLY_GRID_FIELDS, renderStructureKey,
} from "./editing-policy"
import { choiceEditor } from "./editors"
import { OFFSET_UNITS, registerPortuguese } from "./locale"
import { SettingsPanel } from "./settings"
import { DISPLAY_TOGGLES, isToggleOn } from "./display-toggles"

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
  onSaved?: () => void
  onError?: (error: unknown) => void
  onNotice?: (notice: Notice) => void
}

export interface Notice {
  tone: "info" | "warning" | "error" | "success"
  message: string
  details?: string[]
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
const TIMELINES: Record<TimelinePreset, TimelineSettingsModel> = {
  hour: { topTier: { unit: "Day", format: "dd MMM" }, bottomTier: { unit: "Hour", format: "HH" } },
  day: { topTier: { unit: "Week", format: "dd MMM yyyy" }, bottomTier: { unit: "Day", format: "dd" } },
  week: { topTier: { unit: "Month", format: "MMM yyyy" }, bottomTier: { unit: "Week", format: "dd MMM" } },
  month: { topTier: { unit: "Year", format: "yyyy" }, bottomTier: { unit: "Month", format: "MMM" } },
  quarter: { topTier: { unit: "Year", format: "yyyy" }, bottomTier: { unit: "Month", count: 3, format: "MMM" } },
  year: { topTier: { unit: "Year", format: "yyyy" }, bottomTier: { unit: "Month", count: 6, format: "MMM" } },
}
const TASK_FIELDS = {
  id: "TaskID", parentID: "ParentID", name: "TaskName", startDate: "StartDate", endDate: "EndDate",
  duration: "Duration", durationUnit: "DurationUnit", progress: "Progress", dependency: "Predecessor",
  milestone: "isMilestone", baselineStartDate: "BaselineStartDate", baselineEndDate: "BaselineEndDate", notes: "Notes",
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
/** Never surfaces "[object Object]": digs a readable sentence out of whatever was thrown. */
function errorMessage(error: unknown): string {
  if (error == null) return "Ocorreu um erro inesperado (1)."
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  
  if (Array.isArray(error)) {
    const parts = error.map(errorMessage).filter(Boolean)
    return parts.length ? parts.join(" ") : "Ocorreu um erro inesperado (2)."
  }
  
  if (typeof error === "object") {
    const record = error as Record<string, unknown>
    for (const key of ["message", "error", "reason", "statusText", "value"]) {
      const value = record[key]
      if (typeof value === "string" && value.trim()) return value
      if (value && typeof value === "object") {
        const nested = errorMessage(value)
        if (nested && nested !== "Ocorreu um erro inesperado (3).") return nested
      }
    }
  }
  const text = String(error)
  return text === "[object Object]" ? "Ocorreu um erro inesperado (4)." : text
}

const NO_CHOICES: GanttChoice[] = []

function useEvent<T extends unknown[], R>(handler: (...args: T) => R) {
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
  return <GanttComponent id={GANTT_ID} ref={ganttRef} {...model}>
    <ColumnsDirective>
      <ColumnDirective field="TaskID" headerText="ID" isPrimaryKey visible={false} allowEditing={false} />
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
      <ColumnDirective field="Predecessor" headerText="Predecessoras" width={140} />
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

  const publish = useEvent((value: Notice | null) => { setNotice(value); if (value) props.onNotice?.(value) })
  const fail = useEvent((reason: unknown) => {
    publish({ tone: "error", message: errorMessage(reason) })
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
  React.useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current) }, [])

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
    changedFields.current = sessionRef.current
      ? changedFieldsByTask(sessionRef.current.changeset)
      : new Map()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])
  const businessTypeLabel = React.useCallback((task: { entityType?: string; businessType?: string }) =>
    task.entityType === "atividade" ? "Atividade"
      : businessTypes.find((item) => item.value === task.businessType)?.label ?? "Entrega",
    [businessTypes])
  const rows = React.useMemo(() => toSyncfusionDataset(dataset, {
    policy: props.adapter.policy, identities: identities.current, offsetUnits: OFFSET_UNITS,
    businessTypeLabel, leftLabelField: view.leftLabelField, rightLabelField: view.rightLabelField,
  }), [dataset, props.adapter, businessTypeLabel, view.leftLabelField, view.rightLabelField])
  const session = sessionRef.current
  const structureKey = React.useMemo(() => renderStructureKey(rows), [rows])
  const resources = React.useMemo(() => dataset.resources ?? [], [dataset])
  const optionsFor = React.useCallback((field: "status" | "priority", row: SyncfusionTask) =>
    props.adapter.editOptions?.(field, row?.entityType) ?? NO_CHOICES, [props.adapter])

  const selectionRows = () => (gantt.current?.selectionModule.getSelectedRecords() ?? [])
    .map(readNativeRow).filter((row): row is SyncfusionTask => row !== null)
  const sourceIds = () => [...new Set(selectionRows().filter((row) => !row._projection).map((row) => row._sourceId))]
  const lockedFor = (row: SyncfusionTask) => new Set(row._locked)
  const run = (operation: (current: GanttSession) => void) => {
    if (busy.current || !sessionRef.current) return
    const before = sessionRef.current.revision
    try {
      operation(sessionRef.current)
      if (sessionRef.current.revision !== before) rebind()
    } catch (reason) { fail(reason); rebind() }
  }

  const createRow = useEvent((kind: string) => {
    if (!permissions.create) return
    const option = creationOptions.find((item) => item.id === kind)
    if (!option) return
    run((current) => {
      const anchor = selectionRows()[0]
      const owner = current.tasks.find((item) => item.id === anchor?._sourceId)
      const parentId = owner ? (owner.entityType === "entrega" || owner.kind === "group" ? owner.id : owner.parentId) : null
      const id = current.createTask({
        ...option.task, parentId,
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
    gantt.current.openEditDialog(row.TaskID)
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
              businessType: "Grupo", isSummary: true, showMilestone: false, status: "Nova",
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
  const remove = useEvent(() => {
    if (!permissions.delete) return
    run((current) => {
      const selection = selectionRows()
      const realIds = sourceIds()
      current.transact(() => {
        for (const row of selection.filter((item) => item._projection && !realIds.includes(item._sourceId))) {
          current.updateTask(row._sourceId, { showMilestone: false })
        }
        const result = current.deleteTasks(realIds)
        if (result.rejected.length) publish({ tone: "warning", message: "Exclusão recusada.",
          details: result.rejected.map((item) => item.message) })
      })
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
        publish({ tone: plan.rejected.length ? "warning" : "success",
          message: `${plan.created.length} vínculo(s) criado(s).`, details: plan.rejected.map((item) => item.message) })
      }
    })
  })
  const history = useEvent((direction: "undo" | "redo") => {
    if (!permissions.update || !capabilities.undoRedo) return
    run((current) => current[direction]())
  })
  const cancelEdits = useEvent(() => {
    const current = sessionRef.current
    if (!current || busy.current) return
    const discarded = current.dirty
    if (discarded) run((session) => session.revert())
    setConfirmExit(false)
    setEditing(false)
    publish(discarded ? { tone: "info", message: "Alterações locais descartadas." } : null)
  })
  const startEditing = useEvent(() => {
    if (!granted.update && !granted.create) return
    setEditing(true)
    publish(null)
  })
  const exitEditing = useEvent(() => {
    if (busy.current) return
    if (sessionRef.current?.dirty) { setConfirmExit(true); return }
    setEditing(false)
    setConfirmExit(false)
    publish(null)
  })
  const requestReload = useEvent(() => {
    if (sessionRef.current?.dirty) setConfirmReload(true)
    else setReload((value) => value + 1)
  })
  const save = useEvent(async (): Promise<boolean> => {
    const current = sessionRef.current
    if (!current || busy.current || !permissions.save) return false
    if (!current.dirty) {
      publish({ tone: "info", message: "Não há alterações para salvar." })
      return false
    }
    busy.current = true
    setSaving(true)
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
      patchView({ selectedTaskIds: viewRef.current.selectedTaskIds.map(remap),
        collapsedTaskIds: viewRef.current.collapsedTaskIds.map(remap) })
      publish({ tone: "success", message: "Alterações salvas. Você pode continuar editando." })
      props.onSaved?.()
      rebind()
      return true
    } catch (reason) {
      // The session keeps its edits: staying in edit mode is what lets the user retry.
      fail(reason)
      return false
    } finally { busy.current = false; setSaving(false) }
  })
  const saveAndExit = useEvent(() => {
    setConfirmExit(false)
    void save().then((saved) => { if (saved) setEditing(false) })
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
      const restored = selectionRows().map(rowKey)
      selectionRef.current = restored
      setSelected(restored)
    } catch (reason) { fail(reason) }
    finally { restoring.current = false; binding.current = false }
  })
  const onActionBegin = useEvent((value: unknown) => {
    const event = value as {
      requestType?: string; cancel?: boolean; data?: unknown; rowData?: unknown;
      taskBarEditAction?: string; action?: string; modifiedRecords?: unknown[]; [tab: string]: unknown
    }
    const type = String(event.requestType ?? "").toLowerCase()
    if (busy.current && ["beforesave", "beforeopeneditdialog", "beforedelete", "beforeadd"].includes(type)) {
      event.cancel = true
      return
    }
    const row = readNativeRow(event.data ?? event.rowData)

    if (type === "beforedelete") {
      // Deletion is a domain decision: refuse the native path and route the selection
      // through the session, which knows what a milestone mirror and a busy delivery are.
      event.cancel = true
      remove()
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
            editOptions: props.adapter.editOptions?.bind(props.adapter),
          })
        } catch (reason) { event.cancel = true; fail(reason) }
      }
    }
  })
  const onActionComplete = useEvent((value: unknown) => {
    const event = value as { requestType?: string; data?: unknown; modifiedRecords?: unknown[] }
    if (!["save", "recordupdate"].includes(String(event.requestType ?? "").toLowerCase()) || busy.current || binding.current) return
    const modified = [...(event.modifiedRecords ?? []), event.data].map(readNativeRow)
      .filter((row): row is SyncfusionTask => row !== null)
    if (!modified.length) return
    run((current) => applyNativeEdits(current, modified, identities.current, {
      allowDependencies: permissions.link && capabilities.dependencies,
      editOptions: props.adapter.editOptions?.bind(props.adapter),
    }))
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
    const is = (command: string) => id === command || id.endsWith(`_${command}`)
    if (is(COMMANDS.undo)) { history("undo"); return }
    if (is(COMMANDS.redo)) { history("redo"); return }
    if (is(COMMANDS.indent)) { structural("indent"); return }
    if (is(COMMANDS.outdent)) { structural("outdent"); return }
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
  const onCellInfo = useEvent((value: unknown) => {
    const event = value as { data?: unknown; column?: { field?: string }; cell?: HTMLElement }
    const row = readNativeRow(event.data)
    const field = event.column?.field ?? ""
    if (!row || !event.cell) return
    const editable = permissions.update && capabilities.inlineEditing &&
      canEditGridField(row, field, lockedFor(row), permissions.link && capabilities.dependencies)
    event.cell.classList.toggle("jg-readonly-cell", !editable)
    if (row._projection) event.cell.classList.add("jg-mirror-cell")
    if (isSummaryRow(row)) event.cell.classList.add("jg-summary-cell")
    if (isFixedMilestone(row)) event.cell.classList.add("jg-nodrag-cell")
    // The class is always applied; CSS on the container decides whether it shows.
    event.cell.classList.toggle("jg-changed-cell", isChangedCell(row, field, changedFields.current.get(row._sourceId)))
  })

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

  const model = React.useMemo<GanttModel>(() => ({
    height: props.height ?? "100%", dataSource: rows, taskFields: TASK_FIELDS, treeColumnIndex: 2,
    locale: props.locale ?? "pt-BR", allowSelection: true, dateFormat: "dd/MM/yyyy", durationUnit: "Day",
    readOnly: saving || !permissions.update,
    selectionSettings: { type: "Multiple", mode: "Row", enableToggle: true },
    // Standard Gantt operations live on the chart's own toolbar; anything about our
    // data model stays on the bar above it.
    toolbar: [
      ...(capabilities.dialogEditing ? ["Edit"] : []),
      ...(permissions.delete ? ["Delete"] : []),
      { type: "Separator" },
      "ExpandAll", "CollapseAll",
      ...(capabilities.indentOutdent ? [{ type: "Separator" },
        { id: COMMANDS.outdent, text: "Desindentar", tooltipText: "Desindentar (Alt+Shift+←)", prefixIcon: "e-icons e-outdent" },
        { id: COMMANDS.indent, text: "Indentar", tooltipText: "Indentar (Alt+Shift+→)", prefixIcon: "e-icons e-indent" }] : []),
      { type: "Separator" }, "ZoomIn", "ZoomOut", "ZoomToFit",
      ...(capabilities.undoRedo
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
      { text: "TaskInformation" }, { text: "DeleteTask" }, { text: "DeleteDependency" },
      { text: "AutoFitAll" }, { text: "AutoFit" }, { text: "SortAscending" }, { text: "SortDescending" },
      { text: "Conectar seleção", id: "jgConnect", target: ".e-content" },
      { text: "Desconectar seleção", id: "jgDisconnect", target: ".e-content" },
    ],
    allowExcelExport: capabilities.excelExport, allowPdfExport: capabilities.pdfExport,
    enableVirtualization: capabilities.virtualScroll,
    allowRowDragAndDrop: capabilities.rowDragAndDrop && permissions.update && permissions.reparent && !saving,
    allowParentDependency: true, updateOffsetOnTaskbarEdit: false, autoFocusTasks: true, enableHover: true,
    enableCriticalPath: capabilities.criticalPath && isToggleOn(view, "showCriticalPath"),
    renderBaseline: capabilities.baseline && isToggleOn(view, "showBaseline"),
    gridLines: "Both", highlightWeekends: true, allowUnscheduledTasks: true, taskbarHeight: 24,
    eventMarkers: isToggleOn(view, "showAnnotations") ? (dataset.markers ?? []).map((marker) => ({
      day: marker.date, label: marker.label, cssClass: marker.cssClass,
    })) : [],
    holidays: (dataset.holidays ?? []).map((holiday) => ({
      from: holiday.from, to: holiday.to ?? holiday.from, label: holiday.label ?? "", cssClass: holiday.cssClass,
    })),
    splitterSettings: { position: view.splitterPosition ?? "46%", separatorSize: 4, minimum: "260px" },
    timelineSettings: TIMELINES[view.timelinePreset],
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
    editSettings: {
      allowEditing: permissions.update && !saving && (capabilities.inlineEditing || capabilities.dialogEditing),
      allowTaskbarEditing: permissions.update && !saving && capabilities.taskbarEditing,
      allowAdding: false, allowDeleting: permissions.delete && !saving,
      showDeleteConfirmDialog: false, mode: "Auto",
    },
    actionBegin: onActionBegin, actionComplete: onActionComplete, actionFailure: onFailure,
    cellEdit: onCellEdit, taskbarEditing: onTaskbarEditing, rowDrop: onDrop,
    toolbarClick: onToolbar, contextMenuClick: onContextMenu, queryCellInfo: onCellInfo,
    rowSelected: onSelection, rowDeselected: onSelection, collapsed: onCollapsed, expanded: onExpanded,
    splitterResized: onSplitter, dataBound: onDataBound,
  }), [
    rows, dataset, capabilities, permissions, saving, props.height, props.locale,
    // `highlightChanges` is absent on purpose: it is applied by a container class, so
    // toggling it must not rebuild the chart's data source.
    view.showAnnotations, view.showBaseline, view.showCriticalPath, view.splitterPosition,
    view.timelinePreset, view.showProgressLabel, settingsWindow,
    onActionBegin, onActionComplete, onFailure, onCellEdit, onTaskbarEditing, onDrop, onToolbar,
    onContextMenu, onSelection, onCollapsed, onExpanded, onSplitter, onDataBound, onCellInfo,
  ])

  const keyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (busy.current || (event.target as HTMLElement).closest("input,textarea,select,button,[contenteditable=true],.e-dialog")) return
    const meta = event.ctrlKey || event.metaKey
    if (meta && event.key.toLowerCase() === "s") { event.preventDefault(); void save() }
    else if (meta && event.key.toLowerCase() === "z") { event.preventDefault(); history(event.shiftKey ? "redo" : "undo") }
    else if (meta && event.key.toLowerCase() === "y") { event.preventDefault(); history("redo") }
    else if (event.key === "F2") { event.preventDefault(); openDialog() }
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

  return <section className="jg-shell" onKeyDown={keyDown} aria-busy={saving || loading}>
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
              disabled={!permissions.link || selectedOwners.length < 2 || hasMirrors}>Conectar</button>
            <button type="button" onClick={() => connect(true)}
              disabled={!permissions.link || noSelection || hasMirrors}>Desconectar</button>
          </div>}
        </> : <div className="jg-group">
          <button type="button" className="jg-create" onClick={startEditing}
            disabled={!granted.update && !granted.create}>Editar plano</button>
          <span className="jg-clean">Somente leitura</span>
        </div>}

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
          <button type="button" onClick={requestReload} title="Recarregar dados do Jornada">↻ Recarregar</button>
          <button type="button" onClick={() => setShowSettings(true)} title="Configurações do cronograma">⚙ Configurações</button>
          {editing && <>
            <span className={dirty ? "jg-pending" : "jg-clean"}>
              {dirty ? "Alterações não salvas" : "Tudo salvo"}
            </span>
            <button type="button" onClick={cancelEdits} disabled={saving}>Cancelar</button>
            {/* Deliberately always enabled: a save that finds nothing to do just says so. */}
            <button type="button" className="jg-primary" onClick={() => { void save() }} disabled={!permissions.save}>
              {saving ? "Salvando…" : "Salvar"}
            </button>
            <button type="button" onClick={exitEditing}>Sair da edição</button>
          </>}
        </div>
      </fieldset>
    </header>

    {confirmExit && <div className="jg-banner jg-banner-warning" role="alert">
      <strong>Existem alterações não salvas.</strong>
      <div className="jg-banner-actions">
        <button type="button" className="jg-primary" onClick={saveAndExit}>Salvar e sair</button>
        <button type="button" onClick={cancelEdits}>Descartar e sair</button>
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
