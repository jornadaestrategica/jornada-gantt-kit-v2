import assert from "node:assert/strict"
import test from "node:test"

import { formatCivilTimestamp, inclusiveDuration, parseCivilDate } from "../src/core/date"
import { computeWbs, indexTasks, normalizeOrders, previousSibling } from "../src/core/hierarchy"
import { parsePredecessorText, planSmartConnection, wouldCreateDependencyCycle } from "../src/core/dependencies"
import { buildChangeset } from "../src/core/changeset"
import { GanttSession } from "../src/core/session"
import { permissivePolicy } from "../src/core/policy"
import { validateDataset } from "../src/core/validation"
import type { GanttDataset, GanttTask } from "../src/core/types"

import { createJornadaPolicy } from "../src/adapters/jornada/policy"
import { atividadeId, entregaId, hostKey, parseId } from "../src/adapters/jornada/ids"
import { normalizePrioridade, normalizeStatus } from "../src/adapters/jornada/status"
import { snapshotToDataset } from "../src/adapters/jornada/mapping"
import { buildSyncPlan, resolveRefs } from "../src/adapters/jornada/sync-plan"
import { JornadaGanttAdapter } from "../src/adapters/jornada/adapter"
import { InMemoryJornadaTransport } from "../src/adapters/jornada/memory-transport"
import { demoContext, jornadaDemoSnapshot } from "../src/demo/jornada-data"

function task(partial: Partial<GanttTask> & Pick<GanttTask, "id">): GanttTask {
  return {
    parentId: null,
    order: 0,
    kind: "task",
    title: partial.id,
    startDate: null,
    endDate: null,
    duration: null,
    durationUnit: "day",
    progress: 0,
    ...partial,
  }
}

// ----------------------------------------------------------------- dates

test("civil dates survive a UTC-midnight timestamptz round trip", () => {
  // The legacy Gantt rendered this as the 7th in America/Sao_Paulo.
  const parsed = parseCivilDate("2026-04-08T00:00:00+00:00")
  assert.equal(parsed?.getDate(), 8)
  assert.equal(parsed?.getMonth(), 3)
  assert.equal(formatCivilTimestamp(parsed), "2026-04-08T12:00:00.000Z")
})

test("duration is inclusive of both endpoints", () => {
  assert.equal(inclusiveDuration(new Date(2026, 8, 1), new Date(2026, 8, 1)), 1)
  assert.equal(inclusiveDuration(new Date(2026, 8, 1), new Date(2026, 8, 5)), 5)
})

// ------------------------------------------------------------- hierarchy

test("a corrupt parent_id re-roots instead of hiding the row", () => {
  const index = indexTasks([task({ id: "a" }), task({ id: "b", parentId: "ghost" })])
  assert.equal(index.visual.length, 2)
  assert.equal(index.depth.get("b"), 0)
})

test("a parent cycle in host data does not hang or drop rows", () => {
  const index = indexTasks([task({ id: "a", parentId: "b" }), task({ id: "b", parentId: "a" })])
  assert.equal(index.visual.length, 2)
})

test("previousSibling finds the indent target", () => {
  const index = indexTasks([task({ id: "a", order: 0 }), task({ id: "b", order: 1 })])
  assert.equal(previousSibling(index, "b")?.id, "a")
  assert.equal(previousSibling(index, "a"), null)
})

test("orders densify and WBS follows the outline", () => {
  const tasks = [
    task({ id: "a", order: 10 }),
    task({ id: "b", order: 5 }),
    task({ id: "b1", parentId: "b", order: 99 }),
  ]
  computeWbs(normalizeOrders(tasks))
  assert.equal(tasks.find((item) => item.id === "b")?.wbs, "1")
  assert.equal(tasks.find((item) => item.id === "b1")?.wbs, "1.1")
  assert.equal(tasks.find((item) => item.id === "a")?.wbs, "2")
})

// ------------------------------------------------------ indent / outdent

test("indent moves a row under the sibling above it", () => {
  const session = new GanttSession({ tasks: [task({ id: "a", order: 0 }), task({ id: "b", order: 1 })] })
  const result = session.indent(["b"])
  assert.deepEqual(result.applied, ["b"])
  assert.equal(session.tasks.find((item) => item.id === "b")?.parentId, "a")
})

test("indent carries the whole subtree exactly once", () => {
  const session = new GanttSession({
    tasks: [task({ id: "a", order: 0 }), task({ id: "b", order: 1 }), task({ id: "b1", parentId: "b", order: 0 })],
  })
  session.indent(["b", "b1"])
  assert.equal(session.tasks.find((item) => item.id === "b")?.parentId, "a")
  // The child stays under b rather than being pulled up alongside it.
  assert.equal(session.tasks.find((item) => item.id === "b1")?.parentId, "b")
})

test("the first row of a level cannot be indented and says why", () => {
  const session = new GanttSession({ tasks: [task({ id: "a" })] })
  const result = session.indent(["a"])
  assert.equal(result.applied.length, 0)
  assert.equal(result.rejected[0].code, "NO_PREVIOUS_SIBLING")
})

test("outdent promotes a row and lands it right after its former parent", () => {
  const session = new GanttSession({
    tasks: [task({ id: "a", order: 0 }), task({ id: "a1", parentId: "a", order: 0 }), task({ id: "z", order: 1 })],
  })
  session.outdent(["a1"])
  const index = indexTasks(session.tasks)
  assert.equal(session.tasks.find((item) => item.id === "a1")?.parentId, null)
  assert.deepEqual(index.visual.map((item) => item.id), ["a", "a1", "z"])
})

test("indent and outdent round-trip through one undo step", () => {
  const session = new GanttSession({ tasks: [task({ id: "a", order: 0 }), task({ id: "b", order: 1 })] })
  session.indent(["b"])
  assert.equal(session.tasks.find((item) => item.id === "b")?.parentId, "a")
  session.undo()
  assert.equal(session.tasks.find((item) => item.id === "b")?.parentId, null)
  session.redo()
  assert.equal(session.tasks.find((item) => item.id === "b")?.parentId, "a")
})

// -------------------------------------------------------- smart linking

test("predecessor text parses type and lag", () => {
  const parsed = parsePredecessorText("a,bFS+2 dias,cSS-1 dia", "z")
  assert.deepEqual(
    parsed.map((item) => [item.predecessorId, item.type, item.lag]),
    [
      ["a", "FS", 0],
      ["b", "FS", 2],
      ["c", "SS", -1],
    ],
  )
})

test("connecting a selection builds a chain in visual order", () => {
  const tasks = [task({ id: "a", order: 0 }), task({ id: "b", order: 1 }), task({ id: "c", order: 2 })]
  const plan = planSmartConnection(tasks, [], ["c", "a", "b"], permissivePolicy, { useVisualOrder: true })
  assert.deepEqual(plan.sequence, ["a", "b", "c"])
  assert.deepEqual(
    plan.created.map((item) => `${item.predecessorId}->${item.successorId}`),
    ["a->b", "b->c"],
  )
})

test("click order is honoured when visual order is switched off", () => {
  const tasks = [task({ id: "a", order: 0 }), task({ id: "b", order: 1 }), task({ id: "c", order: 2 })]
  const plan = planSmartConnection(tasks, [], ["c", "a"], permissivePolicy, { useVisualOrder: false })
  assert.deepEqual(
    plan.created.map((item) => `${item.predecessorId}->${item.successorId}`),
    ["c->a"],
  )
})

test("fan-out and fan-in strategies", () => {
  const tasks = [task({ id: "a", order: 0 }), task({ id: "b", order: 1 }), task({ id: "c", order: 2 })]
  const out = planSmartConnection(tasks, [], ["a", "b", "c"], permissivePolicy, { strategy: "fan-out" })
  assert.deepEqual(out.created.map((item) => `${item.predecessorId}->${item.successorId}`), ["a->b", "a->c"])
  const into = planSmartConnection(tasks, [], ["a", "b", "c"], permissivePolicy, { strategy: "fan-in" })
  assert.deepEqual(into.created.map((item) => `${item.predecessorId}->${item.successorId}`), ["a->c", "b->c"])
})

test("smart connection refuses parent/child pairs and duplicates", () => {
  const tasks = [task({ id: "p", order: 0 }), task({ id: "c", parentId: "p", order: 0 })]
  const plan = planSmartConnection(tasks, [], ["p", "c"], permissivePolicy)
  assert.equal(plan.created.length, 0)
  assert.equal(plan.rejected[0].code, "ANCESTRY")

  const flat = [task({ id: "a", order: 0 }), task({ id: "b", order: 1 })]
  const existing = [{ predecessorId: "a", successorId: "b", type: "FS" as const }]
  const second = planSmartConnection(flat, existing, ["a", "b"], permissivePolicy)
  assert.equal(second.rejected[0].code, "ALREADY_LINKED")
})

test("a link that would close a loop is refused", () => {
  const existing = [
    { predecessorId: "a", successorId: "b", type: "FS" as const },
    { predecessorId: "b", successorId: "c", type: "FS" as const },
  ]
  assert.equal(wouldCreateDependencyCycle(existing, { predecessorId: "c", successorId: "a", type: "FS" }), true)
  assert.equal(wouldCreateDependencyCycle(existing, { predecessorId: "a", successorId: "c", type: "FS" }), false)
})

test("disconnect removes only links inside the selection", () => {
  const session = new GanttSession({
    tasks: [task({ id: "a", order: 0 }), task({ id: "b", order: 1 }), task({ id: "c", order: 2 })],
    dependencies: [
      { predecessorId: "a", successorId: "b", type: "FS" },
      { predecessorId: "b", successorId: "c", type: "FS" },
    ],
  })
  const removed = session.disconnectSelection(["a", "b"])
  assert.equal(removed.length, 1)
  assert.equal(session.dependencies.length, 1)
})

// --------------------------------------------------------- changeset

test("retyping a link is an update, not a delete plus insert", () => {
  const original: GanttDataset = {
    tasks: [task({ id: "a" }), task({ id: "b" })],
    dependencies: [{ id: "link-1", predecessorId: "a", successorId: "b", type: "FS", lag: 0 }],
  }
  const current: GanttDataset = {
    tasks: original.tasks,
    dependencies: [{ id: "link-1", predecessorId: "a", successorId: "b", type: "SS", lag: 3 }],
  }
  const changeset = buildChangeset(original, current)
  assert.equal(changeset.createdDependencies.length, 0)
  assert.equal(changeset.deletedDependencies.length, 0)
  assert.equal(changeset.updatedDependencies[0].id, "link-1")
})

test("a structural move is reported once, as a move", () => {
  const original: GanttDataset = { tasks: [task({ id: "a" }), task({ id: "b", order: 1 })] }
  const current: GanttDataset = { tasks: [task({ id: "a" }), task({ id: "b", parentId: "a", order: 0 })] }
  const changeset = buildChangeset(original, current)
  assert.equal(changeset.movedTasks.length, 1)
  assert.equal(changeset.movedTasks[0].previousParentId, null)
  assert.equal(changeset.updatedTasks.length, 0)
})

test("an untouched dataset produces no changes", () => {
  const session = new GanttSession({ tasks: [task({ id: "a" })] })
  assert.equal(session.dirty, false)
  session.updateTask("a", { title: "renomeada" })
  assert.equal(session.dirty, true)
})

// ------------------------------------------------------ Jornada policy

test("an activity cannot be indented under another activity", () => {
  const policy = createJornadaPolicy()
  const tasks = [
    task({ id: atividadeId("1"), entityType: "atividade", order: 0 }),
    task({ id: atividadeId("2"), entityType: "atividade", order: 1 }),
  ]
  const session = new GanttSession({ tasks }, { policy })
  const result = session.indent([atividadeId("2")])
  assert.equal(result.applied.length, 0)
  assert.equal(result.rejected[0].code, "ACTIVITY_UNDER_ACTIVITY")
})

test("an activity indents happily under a deliverable", () => {
  const policy = createJornadaPolicy()
  const tasks = [
    task({ id: entregaId("1"), entityType: "entrega", kind: "group", order: 0 }),
    task({ id: atividadeId("1"), entityType: "atividade", order: 1 }),
  ]
  const session = new GanttSession({ tasks }, { policy })
  const result = session.indent([atividadeId("1")])
  assert.deepEqual(result.applied, [atividadeId("1")])
  assert.equal(session.tasks.find((item) => item.id === atividadeId("1"))?.parentId, entregaId("1"))
})

test("redirect mode reroutes an activity to the target's deliverable", () => {
  const policy = createJornadaPolicy({ redirectActivityIndent: true })
  const tasks = [
    task({ id: entregaId("1"), entityType: "entrega", kind: "group", order: 0 }),
    task({ id: atividadeId("1"), entityType: "atividade", parentId: entregaId("1"), order: 0 }),
    task({ id: atividadeId("2"), entityType: "atividade", parentId: entregaId("1"), order: 1 }),
  ]
  const session = new GanttSession({ tasks }, { policy })
  session.indent([atividadeId("2")])
  assert.equal(session.tasks.find((item) => item.id === atividadeId("2"))?.parentId, entregaId("1"))
})

test("a deliverable cannot sit under an activity", () => {
  const policy = createJornadaPolicy()
  const tasks = [
    task({ id: atividadeId("1"), entityType: "atividade", order: 0 }),
    task({ id: entregaId("1"), entityType: "entrega", order: 1 }),
  ]
  const session = new GanttSession({ tasks }, { policy })
  const result = session.indent([entregaId("1")])
  assert.equal(result.rejected[0].code, "DELIVERABLE_UNDER_ACTIVITY")
})

test("a deliverable can never be the successor of a link", () => {
  const policy = createJornadaPolicy()
  const tasks = [
    task({ id: atividadeId("1"), entityType: "atividade", order: 0 }),
    task({ id: entregaId("1"), entityType: "entrega", order: 1 }),
  ]
  const plan = planSmartConnection(tasks, [], [atividadeId("1"), entregaId("1")], policy)
  assert.equal(plan.created.length, 0)
  assert.equal(plan.rejected[0].code, "SUCCESSOR_MUST_BE_ACTIVITY")

  // Picking the deliverable first is legal: it may be a predecessor, never a successor.
  const reversed = planSmartConnection(tasks, [], [entregaId("1"), atividadeId("1")], policy, {
    useVisualOrder: false,
  })
  assert.equal(reversed.created.length, 1)
  assert.equal(reversed.created[0].predecessorId, entregaId("1"))
})

test("a deliverable holding activities cannot be deleted", () => {
  const policy = createJornadaPolicy()
  const session = new GanttSession(
    {
      tasks: [
        task({ id: entregaId("1"), entityType: "entrega", kind: "group", order: 0 }),
        task({ id: atividadeId("1"), entityType: "atividade", parentId: entregaId("1"), order: 0 }),
      ],
    },
    { policy },
  )
  const result = session.deleteTasks([entregaId("1")])
  assert.equal(result.rejected[0].code, "DELIVERABLE_HAS_ACTIVITIES")
  assert.equal(session.tasks.length, 2)
})

// --------------------------------------------------------- identifiers

test("qualified ids keep the two tables apart", () => {
  const shared = "same-uuid"
  assert.notEqual(entregaId(shared), atividadeId(shared))
  assert.equal(parseId(entregaId(shared))?.entity, "entrega")
  assert.equal(parseId(atividadeId(shared))?.entity, "atividade")
  assert.equal(hostKey(atividadeId(shared)), shared)
  assert.equal(hostKey("new:atividade:local-1"), null)
})

// ------------------------------------------------------ status folding

test("accented and unaccented statuses fold to the CHECK value", () => {
  assert.equal(normalizeStatus("atividade", "Concluido").value, "Concluída")
  assert.equal(normalizeStatus("atividade", "concluída").value, "Concluída")
  assert.equal(normalizeStatus("atividade", "Em Andamento").value, "Em andamento")
  // The two tables really do use different vocabularies.
  assert.equal(normalizeStatus("entrega", "Em Sprint").value, "Em Sprint")
  assert.equal(normalizeStatus("entrega", "Em andamento").value, null)
  // Both tables now use the accented spelling; legacy unaccented rows still fold in.
  assert.equal(normalizePrioridade("atividade", "3-Media").value, "3-Média")
  assert.equal(normalizePrioridade("entrega", "3-Media").value, "3-Média")
  assert.equal(normalizePrioridade("entrega", "0-Critica").value, "0-Crítica")
})

// ---------------------------------------------------------- mapping

test("the snapshot folds both tables into one outline", () => {
  const { dataset, diagnostics } = snapshotToDataset(jornadaDemoSnapshot)
  const byId = new Map(dataset.tasks.map((item) => [item.id, item]))
  // resultado_entrega_id becomes parentId: the FK is the outline.
  const activity = byId.get(atividadeId("00000000-0000-4000-8000-00000000a001"))
  assert.equal(activity?.parentId, entregaId("00000000-0000-4000-8000-00000000e002"))
  // The mis-accented status was folded, and reported.
  assert.equal(activity?.status, "Concluída")
  assert.ok(diagnostics.some((item) => item.code === "STATUS_NORMALIZED"))
  // Deliverables carry no dates of their own.
  const deliverable = byId.get(entregaId("00000000-0000-4000-8000-00000000e002"))
  assert.equal(deliverable?.startDate, null)
  assert.ok(deliverable?.lockedFields?.includes("startDate"))
  // The deliverable-as-predecessor link survived the fold.
  assert.ok(
    dataset.dependencies?.some(
      (item) => item.predecessorId === entregaId("00000000-0000-4000-8000-00000000e003"),
    ),
  )
  // Sprint boundaries became timeline markers.
  assert.equal(dataset.markers?.length, 6)
})

test("a mis-shaped vinculo is reported, not silently applied", () => {
  const snapshot = structuredClone(jornadaDemoSnapshot)
  snapshot.vinculos.push({
    id: "bad",
    atividade_id: snapshot.atividades[0].id,
    predecessora_id: snapshot.atividades[1].id,
    resultado_entrega_id: snapshot.entregas[0].id,
    tipo_vinculo: "FS",
    lag: 0,
  })
  const { diagnostics } = snapshotToDataset(snapshot)
  assert.ok(diagnostics.some((item) => item.code === "VINCULO_EXCLUSIVO_VIOLADO"))
})

// -------------------------------------------------------- sync plan

test("new rows are inserted parents first and refs resolve", () => {
  const session = new GanttSession({ tasks: [] }, { policy: createJornadaPolicy() })
  const parent = session.createGroup("Entrega nova", null, "entrega")
  const child = session.createTask({ title: "Atividade nova", parentId: parent, entityType: "atividade" })
  const plan = buildSyncPlan(session.changeset, session.tasks, { defaultPessoaId: "pessoa-1" })

  assert.equal(plan.insertEntregas.length, 1)
  assert.equal(plan.insertAtividades.length, 1)
  assert.deepEqual(plan.insertAtividades[0].values.resultado_entrega_id, { $ref: parent })

  const idMap = { [parent]: entregaId("real-entrega") }
  const resolved = resolveRefs(plan.insertAtividades[0].values, idMap) as Record<string, unknown>
  assert.equal(resolved.resultado_entrega_id, "real-entrega")
  assert.equal(child.startsWith("new:"), true)
})

test("an unresolved ref throws instead of writing a null foreign key", () => {
  assert.throws(() => resolveRefs({ parent_id: { $ref: "new:entrega:abc" } }, {}), /chave definitiva/)
})

test("a new activity with no owner is refused: pessoa_id is NOT NULL", () => {
  const session = new GanttSession({ tasks: [] }, { policy: createJornadaPolicy() })
  session.createTask({ title: "Sem responsável", entityType: "atividade" })
  const plan = buildSyncPlan(session.changeset, session.tasks, {})
  assert.equal(plan.insertAtividades.length, 0)
  assert.equal(plan.issues[0].code, "MISSING_PESSOA_ID")
})

test("deleted deliverables are ordered deepest first", () => {
  const tasks = [
    task({ id: entregaId("root"), entityType: "entrega" }),
    task({ id: entregaId("mid"), entityType: "entrega", parentId: entregaId("root") }),
    task({ id: entregaId("leaf"), entityType: "entrega", parentId: entregaId("mid") }),
  ]
  const plan = buildSyncPlan(
    {
      createdTasks: [],
      updatedTasks: [],
      deletedTaskIds: [entregaId("root"), entregaId("leaf"), entregaId("mid")],
      movedTasks: [],
      createdDependencies: [],
      updatedDependencies: [],
      deletedDependencies: [],
    },
    tasks,
  )
  assert.deepEqual(plan.deleteEntregas, ["leaf", "mid", "root"])
})

test("moving an activity writes resultado_entrega_id, not a parent_id", () => {
  const tasks = [
    task({ id: entregaId("e1"), entityType: "entrega", kind: "group" }),
    task({ id: atividadeId("a1"), entityType: "atividade", parentId: entregaId("e1") }),
  ]
  const plan = buildSyncPlan(
    {
      createdTasks: [],
      updatedTasks: [],
      deletedTaskIds: [],
      movedTasks: [{ id: atividadeId("a1"), parentId: entregaId("e1"), previousParentId: null, order: 0 }],
      createdDependencies: [],
      updatedDependencies: [],
      deletedDependencies: [],
    },
    tasks,
  )
  assert.deepEqual(plan.updateAtividades[0].values, { resultado_entrega_id: { $ref: entregaId("e1") } })
})

test("a link routes the predecessor to the correct exclusive column", () => {
  const tasks = [
    task({ id: entregaId("e1"), entityType: "entrega" }),
    task({ id: atividadeId("a1"), entityType: "atividade" }),
    task({ id: atividadeId("a2"), entityType: "atividade" }),
  ]
  const plan = buildSyncPlan(
    {
      createdTasks: [],
      updatedTasks: [],
      deletedTaskIds: [],
      movedTasks: [],
      createdDependencies: [
        { predecessorId: atividadeId("a1"), successorId: atividadeId("a2"), type: "FS", lag: 0 },
        { predecessorId: entregaId("e1"), successorId: atividadeId("a1"), type: "FS", lag: 1 },
      ],
      updatedDependencies: [],
      deletedDependencies: [],
    },
    tasks,
  )
  assert.equal(plan.upsertVinculos[0].predecessoraRef, atividadeId("a1"))
  assert.equal(plan.upsertVinculos[0].resultadoEntregaRef, null)
  assert.equal(plan.upsertVinculos[1].predecessoraRef, null)
  assert.equal(plan.upsertVinculos[1].resultadoEntregaRef, entregaId("e1"))
})

// --------------------------------------------------- full round trip

test("edit, indent, link and sync round-trips through the host", async () => {
  const transport = new InMemoryJornadaTransport(jornadaDemoSnapshot)
  const adapter = new JornadaGanttAdapter(transport)
  const dataset = await adapter.load(demoContext)
  const session = new GanttSession(dataset, { policy: adapter.policy })

  const loose = atividadeId("00000000-0000-4000-8000-00000000a006")
  const deliverable = entregaId("00000000-0000-4000-8000-00000000e004")

  session.updateTask(loose, { title: "Revisar contrato de suporte (2026)" })
  session.moveTask(loose, deliverable, 0)
  const created = session.createTask({
    title: "Homologar com a área de negócio",
    parentId: deliverable,
    entityType: "atividade",
    responsibleId: demoContext.pessoaId,
  })
  session.connectSelection([loose, created], { strategy: "chain" })

  const validation = await adapter.validate(demoContext, session.changeset)
  assert.equal(validation.valid, true, validation.issues.map((issue) => issue.message).join(" | "))

  const result = await adapter.save(demoContext, session.changeset)
  assert.equal(result.success, true, result.message)
  assert.ok(result.idMap?.[created], "o host precisa devolver a chave da linha criada")

  const state = transport.state
  const renamed = state.atividades.find((row) => row.id === "00000000-0000-4000-8000-00000000a006")
  assert.equal(renamed?.titulo, "Revisar contrato de suporte (2026)")
  // The move became a real foreign key, not a display-only nesting.
  assert.equal(renamed?.resultado_entrega_id, "00000000-0000-4000-8000-00000000e004")

  const inserted = state.atividades.find((row) => row.titulo === "Homologar com a área de negócio")
  assert.ok(inserted, "a atividade criada precisa existir no host")
  assert.equal(inserted?.resultado_entrega_id, "00000000-0000-4000-8000-00000000e004")
  assert.equal(inserted?.pessoa_id, demoContext.pessoaId)

  const link = state.vinculos.find((row) => row.atividade_id === inserted?.id)
  assert.ok(link, "o vínculo precisa apontar para a chave definitiva")
  assert.equal(link?.predecessora_id, "00000000-0000-4000-8000-00000000a006")
  assert.equal(link?.resultado_entrega_id, null)

  // After reconciling, nothing is pending and no temporary id survived.
  session.reconcile(result.dataset as GanttDataset)
  assert.equal(session.dirty, false)
  assert.equal(session.tasks.some((item) => item.id.startsWith("new:")), false)
})

test("a stale row version is refused rather than overwriting someone else", async () => {
  const transport = new InMemoryJornadaTransport(jornadaDemoSnapshot)
  const adapter = new JornadaGanttAdapter(transport)
  const dataset = await adapter.load(demoContext)
  const session = new GanttSession(dataset, { policy: adapter.policy })
  const id = atividadeId("00000000-0000-4000-8000-00000000a002")

  session.updateTask(id, { progress: 75 })
  const changeset = session.changeset
  changeset.updatedTasks[0].rowVersion = "1999-01-01T00:00:00.000Z"

  await assert.rejects(adapter.save(demoContext, changeset), /alterada por outra pessoa/)
})

test("dataset validation catches inverted dates and dangling links", () => {
  const result = validateDataset(
    {
      tasks: [task({ id: "a", startDate: new Date(2026, 8, 10), endDate: new Date(2026, 8, 1) })],
      dependencies: [{ predecessorId: "ghost", successorId: "a", type: "FS" }],
    },
    permissivePolicy,
  )
  assert.equal(result.valid, false)
  const codes = result.issues.map((issue) => issue.code)
  assert.ok(codes.includes("INVERTED_DATES"))
  assert.ok(codes.includes("DANGLING_DEPENDENCY"))
})
