import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { GanttSession } from "../src/core/session"
import { changedFieldsByTask } from "../src/core/changeset"
import { createJornadaPolicy } from "../src/adapters/jornada/policy"
import { entregaTypes, jornadaCreationOptions } from "../src/adapters/jornada/catalog"
import { statusOptions } from "../src/adapters/jornada/status"
import { JornadaGanttAdapter } from "../src/adapters/jornada/adapter"
import { InMemoryJornadaTransport } from "../src/adapters/jornada/memory-transport"
import { jornadaDemoSnapshot } from "../src/demo/jornada-data"
import { buildSyncPlan } from "../src/adapters/jornada/sync-plan"
import { atividadeId } from "../src/adapters/jornada/ids"
import type { GanttTask } from "../src/core/types"

const wrapper = readFileSync(fileURLToPath(new URL("../src/syncfusion/FeatureRichGantt.tsx", import.meta.url)), "utf8")
const editors = readFileSync(fileURLToPath(new URL("../src/syncfusion/editors.ts", import.meta.url)), "utf8")
const policy = createJornadaPolicy()
const act = (id: string, order = 0): GanttTask => ({
  id: atividadeId(id), parentId: null, order, kind: "task", entityType: "atividade", title: id,
  startDate: new Date(2026, 8, 1), endDate: new Date(2026, 8, 3), duration: 3, durationUnit: "day", progress: 0,
})

test("a new group is created as the Grupo business type", () => {
  const option = jornadaCreationOptions.find((item) => item.id === "grupo")!
  assert.equal(option.task.businessType, "Grupo")
  assert.equal(option.task.entityType, "entrega")
  assert.equal(option.task.isSummary, true)
  // The type must be offered in the column list too, or the row cannot be re-classified.
  assert.ok(entregaTypes.some((item) => item.value === "Grupo"))
})

test("the Grupo type passes plan validation, so the only gate left is the database", () => {
  const session = new GanttSession({ tasks: [] }, { policy })
  const option = jornadaCreationOptions.find((item) => item.id === "grupo")!
  session.createTask(option.task)
  const plan = buildSyncPlan(session.changeset, session.tasks, { planoId: "p1" })
  assert.equal(plan.issues.length, 0, JSON.stringify(plan.issues))
  assert.equal(plan.insertEntregas[0].values.tipo, "Grupo")
})

test("a delivery is offered its own status list, never the activity one", async () => {
  const adapter = new JornadaGanttAdapter(new InMemoryJornadaTransport(jornadaDemoSnapshot))
  const delivery = adapter.editOptions("status", "entrega").map((item) => item.value)
  const activity = adapter.editOptions("status", "atividade").map((item) => item.value)
  assert.deepEqual(delivery, [...statusOptions("entrega")])
  assert.notDeepEqual(delivery, activity)
  assert.ok(delivery.includes("Em Sprint") && !activity.includes("Em Sprint"))

  // The dialog hands the component's own record, so the editor must resolve it first.
  assert.ok(editors.includes("readNativeRow(args.rowData)"),
    "o editor precisa resolver a linha canônica, senão o diálogo recebe a lista errada")
})

test("an unknown status is refused rather than written to a CHECK column", async () => {
  const adapter = new JornadaGanttAdapter(new InMemoryJornadaTransport(jornadaDemoSnapshot))
  // "Em andamento" is an activity status; a delivery must not accept it.
  assert.equal(adapter.editOptions("status", "entrega").some((item) => item.value === "Em andamento"), false)
})

test("leaving edit mode clears the change marks", () => {
  const session = new GanttSession({ tasks: [act("um")] }, { policy })
  session.updateTask(atividadeId("um"), { title: "Editada" })
  assert.equal(changedFieldsByTask(session.changeset).size, 1)
  session.revert()
  assert.equal(changedFieldsByTask(session.changeset).size, 0)

  // The wrapper must also drop the marks it already painted, and rebind.
  assert.ok(wrapper.includes("changedFields.current = new Map()"))
  assert.ok(/const leaveEditing = useEvent\(\(\) => \{[\s\S]*?rebind\(\)/.test(wrapper))
})

test("cancel discards and leaves edit mode, and stays available with nothing pending", () => {
  const cancel = /const cancelEdits = useEvent\(([\s\S]*?)\n  \}\)/.exec(wrapper)
  assert.ok(cancel, "cancelEdits não encontrado")
  assert.ok(cancel[1].includes("leaveEditing()"), "Cancelar precisa sair da edição")
  assert.ok(!cancel[1].includes("!current.dirty) return"), "Cancelar não pode exigir pendências")
  assert.ok(!cancel[1].includes("Alterações locais descartadas"), "sem mensagem ao cancelar")
  assert.ok(/onClick=\{cancelEdits\} disabled=\{saving\}/.test(wrapper), "Cancelar sempre habilitado")
})

test("save and leave only leaves after the write succeeded", () => {
  assert.ok(wrapper.includes("save(leaveEditing)"), '"Salvar e sair" precisa passar a continuação')
  const save = /const save = useEvent\(\(onSaved\?: \(\) => void\) => \{([\s\S]*?)\n  \}\)/.exec(wrapper)
  assert.ok(save, "save não encontrado")
  // The continuation must sit after the successful branch, never in `finally`.
  const body = save[1]
  const call = body.lastIndexOf("onSaved?.()")
  const failure = body.indexOf("catch (reason)")
  assert.ok(call > 0 && call < failure, "sair só depois da gravação bem-sucedida")
})

test("a milestone refuses the drag at its start, not only by hiding the handle", () => {
  const drag = /const onDragStart = useEvent\(([\s\S]*?)\n  \}\)/.exec(wrapper)
  assert.ok(drag, "onDragStart não encontrado")
  assert.ok(drag[1].includes("isFixedMilestone"), "o marco precisa ser recusado")
  assert.ok(drag[1].includes("event.cancel = true"))
  assert.ok(wrapper.includes("rowDragStart: onDragStart"), "o evento precisa estar ligado")
})

test("single-click editing is opt-in and respects the same field rules", () => {
  assert.ok(wrapper.includes("editOnSingleClick?: boolean"))
  const click = /const onRecordClick = useEvent\(([\s\S]*?)\n  \}\)/.exec(wrapper)
  assert.ok(click, "onRecordClick não encontrado")
  assert.ok(click[1].includes("canEditGridField"), "precisa respeitar as regras de campo")
  assert.ok(click[1].includes("props.editOnSingleClick"), "precisa ser opcional")
  assert.ok(click[1].includes("editing"), "só vale dentro do modo de edição")
})

test("the panel is embeddable: no page shell and no load banner", () => {
  const panel = readFileSync(fileURLToPath(new URL("../src/GanttPanel.tsx", import.meta.url)), "utf8")
  assert.ok(panel.includes("embedded"))
  assert.ok(panel.includes("transport?:"), "o host precisa injetar o transporte real")
  const app = readFileSync(fileURLToPath(new URL("../src/App.tsx", import.meta.url)), "utf8")
  assert.ok(app.includes("Jornada Estratégica Gantt"))
  assert.ok(!app.includes("app-diagnostics"), "o aviso de carga não deve ser renderizado")
})
