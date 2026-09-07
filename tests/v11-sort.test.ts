import assert from "node:assert/strict"
import test from "node:test"
import { GanttSession } from "../src/core/session"
import { RenderIds, sortRowsByDate, toSyncfusionDataset } from "../src/syncfusion/mapper"
import { renderStructureKey } from "../src/syncfusion/editing-policy"
import type { GanttTask } from "../src/core/types"

const task = (id: string, order = 0, parentId: string | null = null): GanttTask => ({
  id, order, parentId, kind: "task", entityType: "atividade", title: id,
  startDate: null, endDate: null, duration: null, durationUnit: "day", progress: 0,
})
const dated = (id: string, order: number, start: Date, end: Date, parentId: string | null = null): GanttTask => ({
  ...task(id, order, parentId), startDate: start, endDate: end,
})

test("siblings are ordered by start date, then end date, without touching the session", () => {
  const tasks = [
    dated("c", 0, new Date(2026, 8, 10), new Date(2026, 8, 12)),
    dated("a", 1, new Date(2026, 8, 1), new Date(2026, 8, 5)),
    dated("b", 2, new Date(2026, 8, 1), new Date(2026, 8, 3)),
  ]
  const session = new GanttSession({ tasks })
  const ids = new RenderIds()
  const rows = sortRowsByDate(toSyncfusionDataset(session.dataset, { identities: ids }))
  assert.deepEqual(rows.map((row) => row._sourceId), ["b", "a", "c"], "início crescente, término como desempate")
  assert.equal(session.dirty, false, "a ordenação inicial não suja a sessão")
  assert.equal(session.tasks.find((item) => item.id === "a")!.order, 1, "a ordem persistida não muda")
})

test("hierarchy is preserved: a child never leaves its parent's block", () => {
  const tasks = [
    dated("parentA", 0, new Date(2026, 8, 20), new Date(2026, 8, 25)),
    dated("childA", 0, new Date(2026, 8, 21), new Date(2026, 8, 22), "parentA"),
    dated("parentB", 1, new Date(2026, 8, 1), new Date(2026, 8, 5)),
  ]
  const rows = sortRowsByDate(toSyncfusionDataset({ tasks }, { identities: new RenderIds() }))
  const order = rows.map((row) => row._sourceId)
  // parentB sorts first by date, but childA must stay right after parentA, not
  // get pulled to the front just because its own dates are earlier than parentB's.
  assert.deepEqual(order, ["parentB", "parentA", "childA"])
})

test("rows without a date are pushed after dated siblings, deterministically", () => {
  const tasks = [
    dated("dated", 1, new Date(2026, 8, 1), new Date(2026, 8, 2)),
    task("undated-first", 0),
    task("undated-second", 2),
  ]
  const rows = sortRowsByDate(toSyncfusionDataset({ tasks }, { identities: new RenderIds() }))
  assert.deepEqual(rows.map((row) => row._sourceId), ["dated", "undated-first", "undated-second"])
})

test("a milestone mirror is never sorted by its own date: it stays glued to its owner", () => {
  const tasks: GanttTask[] = [
    { ...dated("late-owner", 0, new Date(2026, 8, 20), new Date(2026, 8, 20)),
      entityType: "entrega", kind: "group", showMilestone: true, milestoneLabel: "Entrega tardia" },
    dated("early-activity", 1, new Date(2026, 8, 1), new Date(2026, 8, 2), "late-owner"),
  ]
  const rows = sortRowsByDate(toSyncfusionDataset({ tasks }, { identities: new RenderIds() }))
  const ownerIndex = rows.findIndex((row) => row._sourceId === "late-owner" && !row._projection)
  const mirrorIndex = rows.findIndex((row) => row._projection)
  assert.equal(mirrorIndex, ownerIndex + 1, "o marco espelho segue imediatamente a entrega, não a própria data")
})

test("renderStructureKey ignores order: only membership, parent and milestone flag matter", () => {
  const tasks = [task("a", 0), task("b", 1)]
  const ids = new RenderIds()
  const forward = toSyncfusionDataset({ tasks }, { identities: ids })
  const backward = [...forward].reverse()
  assert.equal(renderStructureKey(forward), renderStructureKey(backward), "reordenar não deve mudar a chave")
  // Same RenderIds instance: "c" earns a new render id distinct from "b"'s, so only a
  // genuine membership change (not a coincidence of two independent id counters) is compared.
  const differentTree = toSyncfusionDataset({ tasks: [task("a", 0), task("c", 1)] }, { identities: ids })
  assert.notEqual(renderStructureKey(forward), renderStructureKey(differentTree), "um nó diferente ainda muda a chave")
})

test("an ordinary date edit that reorders siblings does not change the structure key", () => {
  const tasks = [
    dated("a", 0, new Date(2026, 8, 1), new Date(2026, 8, 2)),
    dated("b", 1, new Date(2026, 8, 5), new Date(2026, 8, 6)),
  ]
  const session = new GanttSession({ tasks })
  const ids = new RenderIds()
  const before = renderStructureKey(sortRowsByDate(toSyncfusionDataset(session.dataset, { identities: ids })))
  // Reverses the visual sort order without adding, removing or reparenting anything.
  session.updateTask("a", { startDate: new Date(2026, 8, 10), endDate: new Date(2026, 8, 11) })
  const after = renderStructureKey(sortRowsByDate(toSyncfusionDataset(session.dataset, { identities: ids })))
  assert.equal(before, after, "um remount completo aqui descartaria seleção, rolagem e estado nativo à toa")
})
