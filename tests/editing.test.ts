import assert from "node:assert/strict"
import test from "node:test"
import { GanttSession } from "../src/core/session"
import { isChangesetEmpty } from "../src/core/changeset"
import { toSyncfusionDataset, RenderIds } from "../src/syncfusion/mapper"
import { applyNativeEdits } from "../src/syncfusion/edit-bridge"
import { canEditGridField, canOpenTaskDialog, renderStructureKey } from "../src/syncfusion/editing-policy"
import { JornadaGanttAdapter } from "../src/adapters/jornada/adapter"
import { InMemoryJornadaTransport } from "../src/adapters/jornada/memory-transport"
import { jornadaDemoSnapshot, demoContext } from "../src/demo/jornada-data"
import type { GanttTask } from "../src/core/types"

const task = (id: string): GanttTask => ({
  id, parentId: null, order: 0, kind: "task", entityType: "atividade", title: id,
  startDate: null, endDate: null, duration: null, durationUnit: "day", progress: 0,
})
const load = async () => {
  const transport = new InMemoryJornadaTransport(jornadaDemoSnapshot)
  const adapter = new JornadaGanttAdapter(transport)
  const session = new GanttSession(await adapter.load(demoContext), { policy: adapter.policy })
  return { adapter, transport, session }
}

test("created then edited stays one INSERT with final values", () => {
  const session = new GanttSession({ tasks: [] })
  const id = session.createTask({ title: "Inicial", entityType: "atividade" })
  session.updateTask(id, { title: "Final", progress: 65, priority: "2-Alta" })
  const changes = session.changeset
  assert.equal(changes.createdTasks.length, 1)
  assert.equal(changes.createdTasks[0].title, "Final")
  assert.equal(changes.createdTasks[0].progress, 65)
  assert.equal(changes.updatedTasks.length, 0)
  assert.equal(changes.deletedTaskIds.length, 0)
})

test("created edited and deleted in session emits no persistence work, including links", () => {
  const session = new GanttSession({ tasks: [task("existing")] })
  const id = session.createTask({ title: "Efêmera", entityType: "atividade" })
  session.updateTask(id, { title: "Alterada" })
  session.addDependency({ predecessorId: "existing", successorId: id, type: "FS" })
  session.deleteTasks([id])
  assert.equal(isChangesetEmpty(session.changeset), true)
  assert.equal(session.dirty, false)
})

test("a transient child does not leave phantom rolled-up changes on an empty group", () => {
  const group = { ...task("g"), entityType: "entrega", kind: "group" as const }
  const session = new GanttSession({ tasks: [group] })
  const child = session.createTask({ title: "Efêmera", parentId: "g", entityType: "atividade" })
  session.updateTask(child, { progress: 50 })
  session.deleteTasks([child])
  assert.equal(isChangesetEmpty(session.changeset), true)
  assert.equal(session.tasks[0].startDate, null)
})

test("deleting an existing edited row emits one DELETE and no UPDATE", () => {
  const session = new GanttSession({ tasks: [task("existing")] })
  session.updateTask("existing", { title: "Editada" })
  session.deleteTasks(["existing"])
  assert.deepEqual(session.changeset.deletedTaskIds, ["existing"])
  assert.equal(session.changeset.updatedTasks.length, 0)
  assert.equal(session.changeset.createdTasks.length, 0)
})

test("an activity schedules itself: dates and duration are editable in the grid", () => {
  const row = toSyncfusionDataset({ tasks: [task("a")] })[0]
  for (const field of ["StartDate", "EndDate", "Duration", "Progress", "TaskName", "responsibleId", "priority", "status", "Notes", "effort", "weight", "storyPoints", "tagsText"]) {
    assert.equal(canEditGridField(row, field, new Set(), true), true, field)
  }
  for (const field of ["TaskID", "WBS", "entityLabel", "rightLabel"]) {
    assert.equal(canEditGridField(row, field, new Set(), true), false, field)
  }
})

test("a rolled-up delivery still refuses the schedule the domain derives for it", () => {
  const row = toSyncfusionDataset({ tasks: [
    { ...task("e"), entityType: "entrega", kind: "group", lockedFields: ["startDate", "endDate", "duration", "progress"] },
  ] })[0]
  for (const field of ["StartDate", "EndDate", "Duration", "Progress"]) {
    assert.equal(canEditGridField(row, field, new Set(row._locked), true), false, field)
  }
  assert.equal(canEditGridField(row, "TaskName", new Set(row._locked), true), true)
})

test("readonly records and domain-locked fields refuse both inline editing and dialogs", () => {
  const row = toSyncfusionDataset({ tasks: [task("a")] })[0]
  assert.equal(canEditGridField(row, "priority", new Set(["priority"]), true), false)
  row._readOnly = true
  assert.equal(canEditGridField(row, "TaskName", new Set(), true), false)
  assert.equal(canOpenTaskDialog(row), false)
})

test("the native task dialog opens for real rows and never for a milestone mirror", () => {
  const rows = toSyncfusionDataset({ tasks: [
    task("a"), { ...task("e"), entityType: "entrega", kind: "group", showMilestone: true },
  ] })
  assert.equal(canOpenTaskDialog(rows.find((row) => row._sourceId === "a")!), true)
  assert.equal(canOpenTaskDialog(rows.find((row) => row._sourceId === "e" && !row._projection)!), true)
  assert.equal(canOpenTaskDialog(rows.find((row) => row._projection)!), false)
})

test("delivery classification and milestone setting are editable only on real delivery rows", () => {
  const rows = toSyncfusionDataset({ tasks: [
    task("a"), { ...task("e"), entityType: "entrega", kind: "group", showMilestone: true },
  ] })
  for (const field of ["businessType", "showMilestone"]) {
    assert.equal(canEditGridField(rows[0], field, new Set(), true), false)
    assert.equal(canEditGridField(rows[1], field, new Set(), true), true)
    assert.equal(canEditGridField(rows[2], field, new Set(), true), false)
  }
})

test("milestone toggle changes renderer structure identity; repeated native echoes do not advance revision", async () => {
  const { session, adapter } = await load()
  const delivery = session.tasks.find((row) => row.entityType === "entrega")!
  const ids = new RenderIds()
  const initial = renderStructureKey(toSyncfusionDataset(session.dataset, { identities: ids, policy: adapter.policy }))
  session.updateTask(delivery.id, { showMilestone: true })
  const visible = toSyncfusionDataset(session.dataset, { identities: ids, policy: adapter.policy })
  assert.notEqual(renderStructureKey(visible), initial)
  const revision = session.revision
  for (let count = 0; count < 20; count++) {
    applyNativeEdits(session, visible, ids, { editOptions: adapter.editOptions.bind(adapter) })
  }
  assert.equal(session.revision, revision)
  session.updateTask(delivery.id, { showMilestone: false })
  assert.equal(renderStructureKey(toSyncfusionDataset(session.dataset, { identities: ids, policy: adapter.policy })), initial)
})

test("resource dropdown saves the foreign key and refreshes the visible name through reload", async () => {
  const { session, adapter, transport } = await load()
  const activity = session.tasks.find((row) => row.entityType === "atividade")!
  const resource = session.dataset.resources!.find((item) => item.id !== activity.responsibleId)!
  const ids = new RenderIds()
  const row = toSyncfusionDataset(session.dataset, { identities: ids, policy: adapter.policy }).find((item) => item._sourceId === activity.id)!
  row.responsibleId = resource.id
  applyNativeEdits(session, [row], ids)
  assert.equal(session.tasks.find((item) => item.id === activity.id)?.responsibleName, resource.name)
  await adapter.save(demoContext, session.changeset)
  assert.equal(transport.state.atividades.find((item) => `atividade:${item.id}` === activity.id)?.pessoa_id, resource.id)
  const reloaded = await adapter.load(demoContext)
  assert.ok(reloaded.resources?.length)
  assert.equal(reloaded.tasks.find((item) => item.id === activity.id)?.responsibleName, resource.name)
})

test("unknown resources and priorities are refused rather than silently changing a foreign key", async () => {
  const { session, adapter } = await load()
  const ids = new RenderIds()
  const row = toSyncfusionDataset(session.dataset, { identities: ids }).find((item) => item.entityType === "atividade")!
  const originalResource = row.responsibleId
  row.responsibleId = "unknown"
  assert.throws(() => applyNativeEdits(session, [row], ids), /responsável/)
  row.responsibleId = originalResource
  row.priority = "invented"
  assert.throws(() => applyNativeEdits(session, [row], ids, { editOptions: adapter.editOptions.bind(adapter) }), /prioridade/)
  assert.equal(session.dirty, false)
})

test("new activity permits first inline title edit with initially empty optional fields", async () => {
  const { session, adapter } = await load()
  const id = session.createTask({ title: "Nova", entityType: "atividade" })
  const ids = new RenderIds()
  const row = toSyncfusionDataset(session.dataset, { identities: ids, policy: adapter.policy }).find((item) => item._sourceId === id)!
  row.TaskName = "Título preenchido"
  applyNativeEdits(session, [row], ids, { editOptions: adapter.editOptions.bind(adapter) })
  assert.equal(session.changeset.createdTasks[0].title, "Título preenchido")
})
