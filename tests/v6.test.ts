import assert from "node:assert/strict"
import test from "node:test"
import { GanttSession } from "../src/core/session"
import { changedFieldsByTask } from "../src/core/changeset"
import { createJornadaPolicy } from "../src/adapters/jornada/policy"
import { atividadeId, entregaId } from "../src/adapters/jornada/ids"
import { indexTasks } from "../src/core/hierarchy"
import { toSyncfusionDataset, LABEL_FIELDS } from "../src/syncfusion/mapper"
import { isToggleOn, DISPLAY_TOGGLES } from "../src/syncfusion/display-toggles"
import type { GanttTask, GanttViewState } from "../src/core/types"

const policy = createJornadaPolicy()
const group = (id: string, parentId: string | null = null, order = 0): GanttTask => ({
  id: entregaId(id), parentId, order, kind: "group", entityType: "entrega", businessType: "Entrega",
  isSummary: true, title: id, startDate: null, endDate: null, duration: null, durationUnit: "day", progress: 0,
})
const act = (id: string, parentId: string | null = null, order = 0): GanttTask => ({
  id: atividadeId(id), parentId, order, kind: "task", entityType: "atividade", title: id,
  startDate: new Date(2026, 8, 1), endDate: new Date(2026, 8, 3), duration: 3, durationUnit: "day", progress: 0,
})
const autoGroup = (task: GanttTask) => ({
  title: `Grupo de ${task.title}`, kind: "group" as const, entityType: "entrega",
  businessType: "Entrega", isSummary: true, showMilestone: false, status: "Nova",
})

test("indenting an activity under another creates a group in its place", () => {
  const session = new GanttSession({ tasks: [act("um", null, 0), act("dois", null, 1)] }, { policy })
  const result = session.indent([atividadeId("dois")], { autoGroup })
  assert.deepEqual(result.applied, [atividadeId("dois")])
  assert.equal(result.rejected.length, 0)

  const index = indexTasks(session.tasks)
  const order = index.visual.map((row) => row.title)
  assert.deepEqual(order, ["um", "Grupo de dois", "dois"])

  const created = session.tasks.find((row) => row.title === "Grupo de dois")!
  assert.equal(created.entityType, "entrega")
  assert.equal(created.parentId, null, "o grupo nasce no nível da atividade")
  assert.equal(session.tasks.find((row) => row.id === atividadeId("dois"))?.parentId, created.id)
  // A atividade continua folha: nada foi aninhado sob outra atividade.
  assert.equal(session.tasks.find((row) => row.id === atividadeId("um"))?.parentId, null)
})

test("the created group and the move are a single undo step", () => {
  const session = new GanttSession({ tasks: [act("um", null, 0), act("dois", null, 1)] }, { policy })
  session.indent([atividadeId("dois")], { autoGroup })
  assert.equal(session.tasks.length, 3)
  session.undo()
  assert.equal(session.tasks.length, 2)
  assert.equal(session.tasks.find((row) => row.id === atividadeId("dois"))?.parentId, null)
  assert.equal(session.dirty, false)
})

test("auto-grouping keeps working inside a delivery and respects the depth limit", () => {
  const inside = new GanttSession({
    tasks: [group("e"), act("um", entregaId("e"), 0), act("dois", entregaId("e"), 1)],
  }, { policy })
  inside.indent([atividadeId("dois")], { autoGroup })
  const created = inside.tasks.find((row) => row.title === "Grupo de dois")!
  assert.equal(created.parentId, entregaId("e"))

  const chain = Array.from({ length: 10 }, (_, level) =>
    group(`n${level}`, level === 0 ? null : entregaId(`n${level - 1}`)))
  const deep = new GanttSession({
    tasks: [...chain, act("um", entregaId("n9"), 0), act("dois", entregaId("n9"), 1)],
  }, { policy })
  const refused = deep.indent([atividadeId("dois")], { autoGroup })
  assert.equal(refused.applied.length, 0)
  assert.equal(deep.tasks.some((row) => row.title === "Grupo de dois"), false, "não cria grupo ilegal")
})

test("indent without the auto-group option still refuses, as before", () => {
  const session = new GanttSession({ tasks: [act("um", null, 0), act("dois", null, 1)] }, { policy })
  const result = session.indent([atividadeId("dois")])
  assert.equal(result.applied.length, 0)
  assert.equal(result.rejected[0].code, "ACTIVITY_UNDER_ACTIVITY")
  assert.equal(session.tasks.length, 2)
})

test("indenting one activity marks the session dirty, so saving is meaningful", () => {
  const session = new GanttSession({ tasks: [group("e"), act("um", entregaId("e"), 0), act("dois", null, 1)] }, { policy })
  assert.equal(session.dirty, false)
  const result = session.indent([atividadeId("dois")], { autoGroup })
  assert.deepEqual(result.applied, [atividadeId("dois")])
  assert.equal(session.dirty, true)
  assert.equal(session.changeset.movedTasks.length, 1)
})

test("bar labels never render undefined, whatever the field or the absence of one", () => {
  const dataset = {
    tasks: [
      { ...act("com dados"), responsibleName: "Ana Ribeiro", status: "Em andamento" },
      { ...act("sem dados", null, 1), responsibleName: null, status: null, startDate: null, endDate: null, duration: null },
      { ...group("entrega", null, 2), showMilestone: true, milestoneLabel: null },
    ],
  }
  for (const field of [...LABEL_FIELDS.map((item) => item.value), null]) {
    const rows = toSyncfusionDataset(dataset, { leftLabelField: field, rightLabelField: field })
    for (const row of rows) {
      for (const text of [row.leftLabelText, row.rightLabelText]) {
        assert.equal(typeof text, "string", `${field}`)
        assert.ok(!text.includes("undefined"), `${field}: ${text}`)
        assert.ok(!text.includes("null"), `${field}: ${text}`)
      }
    }
  }
  const withDates = toSyncfusionDataset(dataset, { rightLabelField: "periodText" })
  assert.match(withDates[0].rightLabelText, /^\d{2}\/\d{2}\/\d{4} — \d{2}\/\d{2}\/\d{4}$/)
  assert.equal(withDates[1].rightLabelText, "")
  // "Não exibir" produz texto vazio, nunca a palavra undefined.
  assert.equal(toSyncfusionDataset(dataset, {})[0].rightLabelText, "")
})

test("display toggles fall back to sensible defaults and honour an explicit false", () => {
  const empty = { selectedTaskIds: [], collapsedTaskIds: [], viewMode: "Default", timelinePreset: "week" } as GanttViewState
  assert.equal(isToggleOn(empty, "showAnnotations"), true)
  assert.equal(isToggleOn(empty, "highlightChanges"), true)
  assert.equal(isToggleOn(empty, "toolbarLabels"), true)
  assert.equal(isToggleOn(empty, "showBaseline"), false)
  assert.equal(isToggleOn({ ...empty, highlightChanges: false }, "highlightChanges"), false)
  assert.equal(DISPLAY_TOGGLES.every((toggle) => toggle.short.length <= 20), true)
})

test("changed fields survive a cancel: nothing stays marked", () => {
  const session = new GanttSession({ tasks: [act("um")] }, { policy })
  session.updateTask(atividadeId("um"), { title: "Editada", progress: 50 })
  assert.deepEqual([...(changedFieldsByTask(session.changeset).get(atividadeId("um")) ?? [])].sort(),
    ["progress", "title"])
  session.revert()
  assert.equal(changedFieldsByTask(session.changeset).size, 0)
})
