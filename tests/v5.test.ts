import assert from "node:assert/strict"
import test from "node:test"
import { GanttSession } from "../src/core/session"
import { isChangesetEmpty, changedFieldsByTask, WHOLE_ROW } from "../src/core/changeset"
import { createJornadaPolicy } from "../src/adapters/jornada/policy"
import { atividadeId, entregaId } from "../src/adapters/jornada/ids"
import { normalizePrioridade, ENTREGA_PRIORIDADE, ATIVIDADE_PRIORIDADE } from "../src/adapters/jornada/status"
import { JornadaGanttAdapter } from "../src/adapters/jornada/adapter"
import { InMemoryJornadaTransport } from "../src/adapters/jornada/memory-transport"
import { jornadaDemoSnapshot, demoContext } from "../src/demo/jornada-data"
import { toSyncfusionDataset, LABEL_FIELDS } from "../src/syncfusion/mapper"
import type { GanttTask } from "../src/core/types"

const policy = createJornadaPolicy()
const delivery = (id: string, parentId: string | null = null, order = 0): GanttTask => ({
  id: entregaId(id), parentId, order, kind: "group", entityType: "entrega", businessType: "Entrega",
  title: id, startDate: null, endDate: null, duration: null, durationUnit: "day", progress: 0,
})
const activity = (id: string, parentId: string | null = null, order = 0): GanttTask => ({
  id: atividadeId(id), parentId, order, kind: "task", entityType: "atividade", title: id,
  startDate: new Date(2026, 8, 1), endDate: new Date(2026, 8, 3), duration: 3, durationUnit: "day", progress: 0,
})
const load = async () => {
  const transport = new InMemoryJornadaTransport(jornadaDemoSnapshot)
  const adapter = new JornadaGanttAdapter(transport)
  const session = new GanttSession(await adapter.load(demoContext), { policy: adapter.policy })
  return { adapter, transport, session }
}

// ---------------------------------------------------------------- criação

test("nesting beyond the limit is refused at creation, not at save time", () => {
  const chain = Array.from({ length: 10 }, (_, level) =>
    delivery(`n${level}`, level === 0 ? null : entregaId(`n${level - 1}`)))
  const session = new GanttSession({ tasks: chain }, { policy })
  assert.throws(
    () => session.createTask({ title: "Décimo primeiro", entityType: "entrega", kind: "group", parentId: entregaId("n9") }),
    /10 níveis/,
  )
  assert.equal(session.tasks.length, 10)
  assert.equal(session.dirty, false)
  // One level higher the same creation is accepted.
  assert.ok(session.createTask({ title: "Ok", entityType: "entrega", kind: "group", parentId: entregaId("n8") }))
})

test("repeated group creation cannot silently build an illegal chain", () => {
  const session = new GanttSession({ tasks: [delivery("root")] }, { policy })
  let parent: string | null = entregaId("root")
  let created = 0
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      parent = session.createTask({ title: `G${attempt}`, entityType: "entrega", kind: "group", parentId: parent })
      created += 1
    } catch {
      break
    }
  }
  assert.equal(created, 9, "dez níveis no total, contando a raiz")
})

test("nothing can be created or indented under an activity or a milestone", () => {
  const session = new GanttSession({
    tasks: [
      delivery("e"),
      activity("a", entregaId("e"), 0),
      { ...delivery("m", entregaId("e"), 1), kind: "milestone", isSummary: false, showMilestone: true },
      activity("b", entregaId("e"), 2),
    ],
  }, { policy })

  assert.throws(() => session.createTask({ title: "x", entityType: "atividade", parentId: atividadeId("a") }), /folha/i)
  assert.throws(() => session.createTask({ title: "x", entityType: "atividade", parentId: entregaId("m") }), /marco/i)

  const underActivity = session.indent([atividadeId("b")])
  assert.equal(underActivity.applied.length, 0)
  assert.equal(underActivity.rejected[0].code, "PARENT_IS_MILESTONE")
})

// ------------------------------------------------------- edição e gravação

test("cancel discards local work and leaves the plan exactly as loaded", async () => {
  const { session } = await load()
  const original = JSON.stringify(session.dataset.tasks.map((row) => [row.id, row.title, row.parentId]))
  const target = session.tasks.find((row) => row.entityType === "atividade")!

  session.updateTask(target.id, { title: "Renomeada", progress: 42 })
  session.createTask({ title: "Temporária", entityType: "atividade", responsibleId: demoContext.pessoaId })
  assert.equal(session.dirty, true)

  session.revert()
  assert.equal(session.dirty, false)
  assert.equal(isChangesetEmpty(session.changeset), true)
  assert.equal(JSON.stringify(session.dataset.tasks.map((row) => [row.id, row.title, row.parentId])), original)
  // Cancelling is itself undoable.
  session.undo()
  assert.equal(session.tasks.find((row) => row.id === target.id)?.title, "Renomeada")
})

test("saving repeatedly keeps working: each save starts a clean edit", async () => {
  const { adapter, transport, session } = await load()
  const target = session.tasks.find((row) => row.entityType === "atividade")!

  for (let round = 1; round <= 4; round += 1) {
    session.updateTask(target.id, { title: `Rodada ${round}`, progress: round * 10 })
    const created = session.createTask({
      title: `Extra ${round}`, entityType: "atividade", responsibleId: demoContext.pessoaId,
    })
    assert.equal(session.dirty, true, `rodada ${round}`)

    const result = await adapter.save(demoContext, session.changeset)
    assert.equal(result.success, true, result.message)
    session.reconcile(result.dataset!)

    // A clean slate after every save: no dirt, no temporary ids, no stale history.
    assert.equal(session.dirty, false, `rodada ${round}`)
    assert.equal(isChangesetEmpty(session.changeset), true, `rodada ${round}`)
    assert.equal(session.tasks.some((row) => row.id.startsWith("new:")), false, `rodada ${round}`)
    assert.equal(session.canUndo, false, `rodada ${round}`)
    assert.equal(session.tasks.find((row) => row.id === target.id)?.title, `Rodada ${round}`)
    assert.ok(result.idMap?.[created])
  }
  assert.equal(transport.state.atividades.length, jornadaDemoSnapshot.atividades.length + 4)
})

test("a failed save keeps every local change so a retry loses nothing", async () => {
  const { session } = await load()
  const target = session.tasks.find((row) => row.entityType === "atividade")!
  session.updateTask(target.id, { title: "Pendente" })

  const offline = new JornadaGanttAdapter({
    fetchSnapshot: async () => jornadaDemoSnapshot,
    applyPlan: async () => { throw new Error("Falha de conexão.") },
  })
  await offline.load(demoContext)
  await assert.rejects(offline.save(demoContext, session.changeset), /conexão/i)

  assert.equal(session.dirty, true)
  assert.equal(session.tasks.find((row) => row.id === target.id)?.title, "Pendente")
})

// ------------------------------------------------------------- apresentação

test("the change mark is per field, so only the edited cell is highlighted", async () => {
  const { adapter, session } = await load()
  const target = session.tasks.find((row) => row.entityType === "atividade")!
  session.updateTask(target.id, { progress: 77 })

  const changed = changedFieldsByTask(session.changeset)
  assert.deepEqual([...(changed.get(target.id) ?? [])], ["progress"])
  assert.equal(changed.has("entrega:inexistente"), false)

  const result = await adapter.save(demoContext, session.changeset)
  session.reconcile(result.dataset!)
  assert.equal(changedFieldsByTask(session.changeset).size, 0)
})

test("a created or moved row is marked whole, not field by field", () => {
  const session = new GanttSession({ tasks: [delivery("e"), activity("a", entregaId("e"))] }, { policy })
  const created = session.createTask({ title: "Nova", entityType: "atividade", parentId: entregaId("e") })
  assert.deepEqual([...(changedFieldsByTask(session.changeset).get(created) ?? [])], [WHOLE_ROW])

  const moved = new GanttSession({ tasks: [delivery("e"), delivery("f", null, 1), activity("a", entregaId("e"))] }, { policy })
  moved.moveTask(atividadeId("a"), entregaId("f"), 0)
  assert.ok(changedFieldsByTask(moved.changeset).get(atividadeId("a"))?.has(WHOLE_ROW))
})

test("bar labels expose real row fields, so a label never renders its own field name", () => {
  const rows = toSyncfusionDataset({
    tasks: [
      { ...activity("a"), responsibleName: "Ana Ribeiro", status: "Em andamento", priority: "2-Alta" },
      { ...delivery("e"), showMilestone: true, milestoneLabel: "Aceite" },
    ],
  }, { businessTypeLabel: (task) => task.entityType === "atividade" ? "Atividade" : "Entrega" })

  for (const field of LABEL_FIELDS) {
    assert.ok(field.value in rows[0], `campo ausente: ${field.value}`)
  }
  assert.equal(rows[0].responsibleName, "Ana Ribeiro")
  assert.equal(rows[0].businessTypeLabel, "Atividade")
  assert.equal(rows.find((row) => row._projection)?.milestoneText, "Aceite")
})

test("both tables now offer the accented priority and fold the legacy spelling", () => {
  assert.deepEqual([...ENTREGA_PRIORIDADE], [...ATIVIDADE_PRIORIDADE])
  assert.equal(normalizePrioridade("entrega", "0-Critica").value, "0-Crítica")
  assert.equal(normalizePrioridade("entrega", "0-Crítica").corrected, false)
})
