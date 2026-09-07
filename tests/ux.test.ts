import assert from "node:assert/strict"
import test from "node:test"
import { GanttSession } from "../src/core/session"
import { presentTasks } from "../src/core/presentation"
import { mergeViewState } from "../src/core/view-state"
import { RenderIds, toSyncfusionDataset } from "../src/syncfusion/mapper"
import { PT_BR_OFFSET_UNITS as OFFSET_UNITS } from "../src/core/dependencies"
import { applyNativeEdits, parseNativeLinks } from "../src/syncfusion/edit-bridge"
import { JornadaGanttAdapter } from "../src/adapters/jornada/adapter"
import { InMemoryJornadaTransport } from "../src/adapters/jornada/memory-transport"
import { buildSyncPlan } from "../src/adapters/jornada/sync-plan"
import { jornadaCreationOptions } from "../src/adapters/jornada/catalog"
import { snapshotToDataset } from "../src/adapters/jornada/mapping"
import { jornadaDemoSnapshot, demoContext } from "../src/demo/jornada-data"
import type { GanttTask, GanttViewState } from "../src/core/types"

const task = (id: string, order = 0, parentId: string | null = null): GanttTask => ({
  id, order, parentId, kind: "task", title: id, startDate: null, endDate: null,
  duration: null, durationUnit: "day", progress: 0,
})
const host = async () => {
  const transport = new InMemoryJornadaTransport(jornadaDemoSnapshot)
  const adapter = new JornadaGanttAdapter(transport)
  const dataset = await adapter.load(demoContext)
  return { adapter, transport, session: new GanttSession(dataset, { policy: adapter.policy }) }
}

test("one entrega can render twice without creating a second canonical entity", () => {
  const session = new GanttSession({ tasks: [
    { ...task("entrega:one"), entityType: "entrega", kind: "group", showMilestone: true, milestoneLabel: "Aceite final" },
    { ...task("atividade:one", 0, "entrega:one"), startDate: new Date(2026, 8, 1), endDate: new Date(2026, 8, 4), duration: 4 },
  ] })
  const rows = presentTasks(session.dataset)
  assert.equal(rows.length, 3)
  const mirror = rows.find((row) => row.projection)!
  assert.equal(mirror.sourceId, "entrega:one")
  assert.equal(mirror.title, "Aceite final")
  assert.equal(mirror.duration, 0)
  assert.equal(mirror.endDate?.getDate(), 4)
  assert.equal(mirror.parentId, null)
  assert.equal(session.tasks.length, 2)
  assert.equal(session.dirty, false)
})

test("mirror row cannot become an endpoint of a native predecessor", () => {
  const ids = new RenderIds()
  const rows = toSyncfusionDataset({ tasks: [
    { ...task("entrega:x"), showMilestone: true, kind: "group", entityType: "entrega" },
  ] }, { identities: ids })
  const mirror = rows.find((row) => row._projection)!
  assert.throws(() => parseNativeLinks(`${mirror.TaskID}FS`, "activity", ids), /representação visual/)
})

test("canonical UUIDs never leak into native predecessor syntax", () => {
  const ids = new RenderIds()
  const rows = toSyncfusionDataset({
    tasks: [task("atividade:abc-123"), task("atividade:def-456", 1)],
    dependencies: [{ predecessorId: "atividade:abc-123", successorId: "atividade:def-456", type: "FS", lag: 2 }],
  }, { identities: ids, offsetUnits: OFFSET_UNITS })
  assert.match(rows[1].Predecessor, /^\d+FS\+2 dias$/)
  assert.equal(parseNativeLinks(rows[1].Predecessor, "atividade:def-456", ids)[0].predecessorId, "atividade:abc-123")
})

test("native no-op updates do not grow undo history", () => {
  const session = new GanttSession({ tasks: [task("a")] })
  for (let i = 0; i < 100; i++) session.updateTask("a", { title: "a" })
  assert.equal(session.canUndo, false)
  session.updateTask("a", { title: "edited" })
  session.updateTask("a", { title: "edited" })
  session.undo()
  assert.equal(session.tasks[0].title, "a")
  assert.equal(session.canUndo, false)
})

test("view restoration echoes keep object identity and annotations do not dirty data", () => {
  const view: GanttViewState = {
    selectedTaskIds: ["a"], collapsedTaskIds: ["g"], viewMode: "Default", timelinePreset: "week", showAnnotations: true,
  }
  for (let i = 0; i < 1000; i++) assert.equal(mergeViewState(view, { collapsedTaskIds: ["g"] }), view)
  const changed = mergeViewState(view, { showAnnotations: false })
  assert.notEqual(changed, view)
  assert.equal(changed.showAnnotations, false)
  const session = new GanttSession({ tasks: [task("a")], markers: [
    { date: new Date(2026, 8, 12), label: "Janela de homologação" },
  ] })
  assert.equal(session.dirty, false)
})

test("all records from a native reschedule form one atomic undo operation", () => {
  const session = new GanttSession({ tasks: [task("a"), task("b", 1)] })
  const ids = new RenderIds()
  const rows = toSyncfusionDataset(session.dataset, { identities: ids })
  rows[0].TaskName = "a changed"
  rows[1].TaskName = "b changed"
  applyNativeEdits(session, rows, ids)
  session.undo()
  assert.deepEqual(session.tasks.map((row) => row.title), ["a", "b"])
  assert.equal(session.canUndo, false)
})

test("invalid native predecessor rolls back the entire edit, preserving data and PK", () => {
  const session = new GanttSession({ tasks: [task("a"), task("b", 1)], dependencies: [
    { id: "link-pk", predecessorId: "a", successorId: "b", type: "FS" },
  ] })
  const ids = new RenderIds()
  const rows = toSyncfusionDataset(session.dataset, { identities: ids })
  rows[0].TaskName = "do not commit"
  rows[0].Predecessor = `${rows[1].TaskID}FS`
  assert.throws(() => applyNativeEdits(session, rows, ids), /oposto|circular/)
  assert.equal(session.tasks[0].title, "a")
  assert.equal(session.dependencies[0].id, "link-pk")
  assert.equal(session.dirty, false)
})

test("retyping native links preserves their database primary key", () => {
  const session = new GanttSession({ tasks: [task("a"), task("b", 1)], dependencies: [
    { id: "link-pk", predecessorId: "a", successorId: "b", type: "FS" },
  ] })
  const ids = new RenderIds()
  const rows = toSyncfusionDataset(session.dataset, { identities: ids })
  rows[1].Predecessor = `${rows[0].TaskID}SS+2d`
  applyNativeEdits(session, [rows[1]], ids)
  assert.equal(session.changeset.updatedDependencies[0].id, "link-pk")
})

test("native working-calendar end dates are not replaced with civil-day arithmetic", () => {
  const session = new GanttSession({ tasks: [task("a")] })
  session.updateTask("a", { startDate: new Date(2026, 8, 4), endDate: new Date(2026, 8, 7), duration: 2 })
  assert.equal(session.tasks[0].endDate?.getDate(), 7)
})

test("multi-indent/outdent uses the initial top-most selection, not click order", () => {
  const session = new GanttSession({ tasks: [task("p"), task("a", 1), task("child", 0, "a"), task("b", 2)] })
  session.indent(["b", "child", "a"])
  assert.equal(session.tasks.find((row) => row.id === "a")?.parentId, "p")
  assert.equal(session.tasks.find((row) => row.id === "b")?.parentId, "p")
  session.outdent(["child", "a", "b"])
  assert.equal(session.tasks.find((row) => row.id === "child")?.parentId, "a")
})

test("catalog offers all delivery types but no subproject and never activity milestones", () => {
  const values = jornadaCreationOptions.map((item) => item.task.businessType)
  for (const value of ["Entrega", "Feature", "Estoria", "Bug", "Melhoria", "Debito Tecnico", "Resultado"]) assert.ok(values.includes(value))
  assert.equal(jornadaCreationOptions.some((item) => item.task.entityType === "atividade" && item.task.kind === "milestone"), false)
  assert.equal(jornadaCreationOptions.find((item) => item.id === "marco")?.task.businessType, "Entrega")
})

test("delivery type, show flag and middleware label/date survive save and reload", async () => {
  const { adapter, transport, session } = await host()
  const owner = session.tasks.find((row) => row.entityType === "entrega")!
  session.updateTask(owner.id, {
    businessType: "Feature", showMilestone: true, milestoneLabel: "Aceite da entrega",
    milestoneDate: new Date(2026, 9, 15),
  })
  const result = await adapter.save(demoContext, session.changeset)
  assert.equal(result.success, true)
  assert.equal(transport.state.entregas.length, jornadaDemoSnapshot.entregas.length)
  const row = result.dataset!.tasks.find((item) => item.id === owner.id)!
  assert.equal(row.businessType, "Feature")
  assert.equal(row.showMilestone, true)
  assert.equal(row.milestoneLabel, "Aceite da entrega")
  assert.equal(row.milestoneDate?.getDate(), 15)
  session.reconcile(result.dataset!)
  session.updateTask(owner.id, { milestoneDate: null, milestoneLabel: null, showMilestone: false })
  const cleared = await adapter.save(demoContext, session.changeset)
  assert.equal(cleared.dataset!.tasks.find((item) => item.id === owner.id)?.milestoneDate, null)
})

test("new milestone is one delivery and no activity, including subsequent rename", async () => {
  const { adapter, transport, session } = await host()
  const creation = jornadaCreationOptions.find((item) => item.id === "marco")!
  const id = session.createTask({ ...creation.task, milestoneDate: new Date(2026, 10, 3) })
  session.updateTask(id, { title: "Marco final" })
  const result = await adapter.save(demoContext, session.changeset)
  assert.equal(result.success, true)
  assert.equal(transport.state.atividades.length, jornadaDemoSnapshot.atividades.length)
  const created = transport.state.entregas.find((row) => row.titulo === "Marco final")!
  assert.ok(created)
  assert.equal(created.tipo, "Entrega")
  assert.equal(created.exibir_marco, true)
  assert.ok(result.idMap![id].startsWith("entrega:"))
  assert.equal(result.dataset!.tasks.find((row) => row.id === result.idMap![id])?.milestoneDate?.getDate(), 3)
})

test("new delivery used as predecessor writes delivery FK, not activity FK", async () => {
  const { adapter, session } = await host()
  const id = session.createTask({ title: "Nova entrega", entityType: "entrega", kind: "group", businessType: "Entrega" })
  const successor = session.tasks.find((row) => row.entityType === "atividade")!
  session.connectSelection([id, successor.id], { useVisualOrder: false })
  const plan = adapter.plan(session.changeset, demoContext)
  assert.equal(plan.upsertVinculos[0].resultadoEntregaRef, id)
  assert.equal(plan.upsertVinculos[0].predecessoraRef, null)
})

test("unsupported middleware persistence fails closed instead of inventing SQL columns", () => {
  const session = new GanttSession({ tasks: [] })
  session.createTask({ title: "Marco", entityType: "entrega", businessType: "Entrega",
    kind: "milestone", milestoneDate: new Date(2026, 8, 1) })
  const plan = buildSyncPlan(session.changeset, session.tasks)
  assert.ok(plan.issues.some((issue) => issue.code === "PRESENTATION_STORAGE_REQUIRED"))
  assert.equal("milestoneDate" in plan.insertEntregas[0].values, false)
})

test("milestone creation without extra storage remains savable and does not seed an unsupported date", async () => {
  const memory = new InMemoryJornadaTransport(jornadaDemoSnapshot)
  const adapter = new JornadaGanttAdapter({
    fetchSnapshot: () => memory.fetchSnapshot(),
    applyPlan: (context, plan) => memory.applyPlan(context, plan),
  })
  const session = new GanttSession(await adapter.load(demoContext), { policy: adapter.policy })
  const option = adapter.creationOptions.find((item) => item.id === "marco")!
  assert.equal(option.seedMilestoneDate, false)
  const id = session.createTask(option.task)
  assert.equal(session.tasks.find((row) => row.id === id)?.startDate, null)
  const validation = await adapter.validate(demoContext, session.changeset)
  assert.equal(validation.valid, true, JSON.stringify(validation.issues))
  const result = await adapter.save(demoContext, session.changeset)
  assert.equal(result.success, true)
})

test("legacy delivery categories on untouched rows do not block unrelated edits", async () => {
  const { adapter, session } = await host()
  const loaded = session.dataset
  const old = loaded.tasks.find((row) => row.entityType === "entrega")!
  old.businessType = "Epico"
  const activity = loaded.tasks.find((row) => row.entityType === "atividade")!
  const local = new GanttSession(loaded, { policy: adapter.policy })
  local.updateTask(activity.id, { title: "Atividade revisada" })
  const plan = buildSyncPlan(local.changeset, local.tasks)
  assert.equal(plan.issues.some((issue) => issue.code === "INVALID_DELIVERY_TYPE"), false)
  local.updateTask(old.id, { businessType: "Subprojeto" })
  assert.ok(buildSyncPlan(local.changeset, local.tasks).issues.some((issue) => issue.code === "INVALID_DELIVERY_TYPE"))
})

test("arbitrary temporal annotations are loaded alongside sprint boundaries", () => {
  const snapshot = structuredClone(jornadaDemoSnapshot)
  snapshot.annotations = [{ date: "2026-10-20", label: "Janela de homologação" }]
  const { dataset } = snapshotToDataset(snapshot)
  assert.ok(dataset.markers?.some((marker) => marker.label === "Janela de homologação"))
  assert.equal(dataset.markers?.length, 7)
})

test("native connector creation is rejected without link permission before any row changes", () => {
  const session = new GanttSession({ tasks: [task("a"), task("b", 1)] })
  const ids = new RenderIds()
  const rows = toSyncfusionDataset(session.dataset, { identities: ids })
  rows[0].TaskName = "must roll back"
  rows[1].Predecessor = `${rows[0].TaskID}FS`
  assert.throws(() => applyNativeEdits(session, rows, ids, { allowDependencies: false }), /permissão/)
  assert.equal(session.tasks[0].title, "a")
  assert.equal(session.dependencies.length, 0)
  assert.equal(session.dirty, false)
})

test("native connector deletion, type and lag changes are rejected with dependencies disabled", () => {
  const session = new GanttSession({ tasks: [task("a"), task("b", 1)], dependencies: [
    { id: "link-pk", predecessorId: "a", successorId: "b", type: "FS", lag: 0 },
  ] })
  const ids = new RenderIds()
  const rows = toSyncfusionDataset(session.dataset, { identities: ids })
  for (const text of ["", `${rows[0].TaskID}SS`, `${rows[0].TaskID}FS+3d`]) {
    rows[1].Predecessor = text
    assert.throws(() => applyNativeEdits(session, [rows[1]], ids, { allowDependencies: false }), /permissão/)
    assert.equal(session.dependencies[0].id, "link-pk")
    assert.equal(session.dirty, false)
  }
})

test("denied link edits do not prevent ordinary title/date edits with unchanged dependencies", () => {
  const session = new GanttSession({ tasks: [task("a"), task("b", 1)], dependencies: [
    { id: "link-pk", predecessorId: "a", successorId: "b", type: "FS", lag: 0 },
  ] })
  const ids = new RenderIds()
  const rows = toSyncfusionDataset(session.dataset, { identities: ids })
  rows[1].TaskName = "Revisada"
  rows[1].StartDate = new Date(2026, 8, 7)
  rows[1].EndDate = new Date(2026, 8, 8)
  rows[1].Duration = 2
  applyNativeEdits(session, [rows[1]], ids, { allowDependencies: false })
  assert.equal(session.tasks[1].title, "Revisada")
  assert.equal(session.tasks[1].endDate?.getDate(), 8)
  assert.equal(session.dependencies[0].id, "link-pk")
  assert.equal(session.changeset.updatedDependencies.length, 0)
})
