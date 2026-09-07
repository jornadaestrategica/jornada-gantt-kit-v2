import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { GanttSession } from "../src/core/session"
import { changedFieldsByTask } from "../src/core/changeset"
import { JornadaGanttAdapter } from "../src/adapters/jornada/adapter"
import { InMemoryJornadaTransport } from "../src/adapters/jornada/memory-transport"
import { jornadaDemoSnapshot, demoContext } from "../src/demo/jornada-data"
import { RenderIds, toSyncfusionDataset } from "../src/syncfusion/mapper"
import { applyNativeEdits } from "../src/syncfusion/edit-bridge"
import { errorDetails } from "../src/syncfusion/notices"

const wrapper = readFileSync(fileURLToPath(new URL("../src/syncfusion/FeatureRichGantt.tsx", import.meta.url)), "utf8")
const viewState = readFileSync(fileURLToPath(new URL("../src/core/view-state.ts", import.meta.url)), "utf8")

const load = async () => {
  const transport = new InMemoryJornadaTransport(jornadaDemoSnapshot)
  const adapter = new JornadaGanttAdapter(transport)
  const session = new GanttSession(await adapter.load(demoContext), { policy: adapter.policy })
  const ids = new RenderIds()
  return { adapter, session, ids, rows: () => toSyncfusionDataset(session.dataset, { identities: ids, policy: adapter.policy }) }
}

test("a freshly loaded plan reports no changes at all", async () => {
  const { session } = await load()
  assert.equal(session.dirty, false)
  assert.equal(changedFieldsByTask(session.changeset).size, 0)
})

test("the renderer echoing every row back changes nothing", async () => {
  const { session, ids, rows } = await load()
  // The component rebinds and reports whole rows; none of it is a user edit.
  applyNativeEdits(session, rows().filter((row) => !row._projection), ids)
  assert.equal(session.dirty, false, JSON.stringify([...changedFieldsByTask(session.changeset)]))
})

test("changing only the person leaves every date and duration untouched", async () => {
  const { session, ids, rows } = await load()
  const before = session.dataset.tasks.map((row) => ({
    id: row.id, start: row.startDate?.getTime() ?? null, end: row.endDate?.getTime() ?? null, duration: row.duration,
  }))
  const target = rows().find((row) => row.entityType === "atividade" && !row._projection)!
  const other = session.dataset.resources!.find((item) => item.id !== target.responsibleId)!

  const batch = rows().filter((row) => !row._projection)
    .map((row) => row._sourceId === target._sourceId ? { ...row, responsibleId: other.id } : { ...row })
  applyNativeEdits(session, batch, ids)

  for (const row of session.dataset.tasks) {
    const original = before.find((item) => item.id === row.id)!
    assert.equal(row.startDate?.getTime() ?? null, original.start, `início de ${row.title}`)
    assert.equal(row.endDate?.getTime() ?? null, original.end, `término de ${row.title}`)
    assert.equal(row.duration, original.duration, `duração de ${row.title}`)
  }
  const changed = changedFieldsByTask(session.changeset)
  assert.equal(changed.size, 1, "apenas a linha editada")
  assert.deepEqual([...changed.get(target._sourceId)!].sort(), ["responsibleId", "responsibleName"])
})

test("a rescheduled row coming back from the renderer never rewrites a summary bar", async () => {
  const { session, ids, rows } = await load()
  const summary = rows().find((row) => row.entityType === "entrega" && !row._projection && !row.isMilestone)!
  const before = session.tasks.find((row) => row.id === summary._sourceId)!
  const originalEnd = before.endDate?.getTime() ?? null

  // Exactly what the component does when its own day math disagrees with ours.
  const shifted = { ...summary, EndDate: new Date(2027, 0, 31), Duration: 999 }
  applyNativeEdits(session, [shifted], ids)

  const after = session.tasks.find((row) => row.id === summary._sourceId)!
  assert.equal(after.endDate?.getTime() ?? null, originalEnd, "a barra de resumo é derivada")
  assert.equal(session.dirty, false)
})

test("a real schedule edit by the user is still accepted", async () => {
  const { session, ids, rows } = await load()
  const target = rows().find((row) => row.entityType === "atividade" && !row._projection)!
  const moved = { ...target, StartDate: new Date(2026, 10, 3), EndDate: new Date(2026, 10, 6), Duration: 4 }
  applyNativeEdits(session, [moved], ids)

  const after = session.tasks.find((row) => row.id === target._sourceId)!
  assert.equal(after.startDate?.getDate(), 3)
  assert.equal(after.endDate?.getDate(), 6)
  assert.ok(changedFieldsByTask(session.changeset).get(target._sourceId)?.has("startDate"))
})

test("the renderer counts days the same way the core does", () => {
  // Monday-to-Friday scheduling turned a 5-day task starting 01/09 into one ending 08/09.
  const week = /workWeek:\s*\[([^\]]*)\]/.exec(wrapper)
  assert.ok(week, "workWeek não configurado")
  for (const day of ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]) {
    assert.ok(week[1].includes(day), `falta ${day} na semana`)
  }
  assert.ok(wrapper.includes("includeWeekend: true"))
  // Holidays must not remove days from the schedule either.
  assert.ok(!/^\s*holidays:/m.test(wrapper), "feriados não podem entrar no cálculo do cronograma")
  assert.ok(wrapper.includes("jg-holiday-marker"), "feriados continuam visíveis como marcadores")
})

test("the top bar follows the agreed layout", () => {
  assert.ok(wrapper.includes("Editar cronograma"))
  assert.ok(wrapper.includes('aria-label="Modo de agendamento"'))
  for (const mode of ["manual", "auto", "custom"]) {
    assert.ok(new RegExp(`value="${mode}"`).test(wrapper), `falta o modo ${mode}`)
  }
  assert.ok(!wrapper.includes("Alterações não salvas"), "o aviso textual foi removido")
  assert.ok(!wrapper.includes("Tudo salvo"))
  // Save is neutral until there is something to write; leaving is a primary action.
  assert.ok(/className=\{dirty \? "jg-primary" : undefined\}[\s\S]{0,120}Salvando/.test(wrapper))
  assert.ok(/className="jg-primary" onClick=\{exitEditing\}/.test(wrapper))
  assert.ok(wrapper.includes('aria-label="Configurações"'), "configurações vira ícone com nome acessível")
})

test("the timeline scale is selectable, includes Geral, and today is marked", () => {
  assert.ok(viewState.includes('timelinePreset: "fit"'), "Geral é a escala inicial")
  assert.ok(wrapper.includes('aria-label="Escala do cronograma"'))
  for (const scale of ["fit", "day", "week", "month", "quarter", "year"]) {
    assert.ok(new RegExp(`value="${scale}"`).test(wrapper), `falta a escala ${scale}`)
  }
  assert.ok(wrapper.includes("resolveTimelineSettings(view.timelinePreset)"), "Geral usa a mesma escala resolvida")
  assert.ok(wrapper.includes("fitToProject"))
  assert.ok(wrapper.includes('label: "Hoje"'))
})

test("manual scheduling is the default and automatic scheduling is opt-in", () => {
  assert.ok(viewState.includes('scheduleMode: "manual"'))
  assert.ok(wrapper.includes('autoCalculateDateScheduling: view.scheduleMode !== "manual"'))
  assert.ok(wrapper.includes('taskMode: view.scheduleMode === "custom" ? "Custom" : view.scheduleMode === "auto" ? "Auto" : "Manual"'))
  assert.ok(wrapper.includes('allowSchedulingMode: viewRef.current.scheduleMode === "custom"'))
  assert.ok(wrapper.includes("validateManualTasksOnLinking: false"))
})

test("edit-only toolbar actions disappear outside editing", () => {
  assert.ok(wrapper.includes('editing && capabilities.dialogEditing ? ["Edit"] : []'))
  assert.ok(wrapper.includes('editing && permissions.delete ? ["Delete"] : []'))
  assert.ok(wrapper.includes("editing && capabilities.indentOutdent"))
  assert.ok(wrapper.includes("editing && capabilities.undoRedo"))
})

test("delete requires confirmation and save messages stay quiet", () => {
  assert.ok(wrapper.includes("confirmDelete"))
  assert.ok(wrapper.includes("requestDelete()"))
  assert.ok(wrapper.includes("Excluir {selectedOwners.length || selected.length} linha(s) selecionada(s)?"))
  assert.ok(!wrapper.includes("Não há alterações para salvar."))
  assert.ok(!wrapper.includes("Alterações salvas. Você pode continuar editando."))
})

test("errors, exports and predecessor labels give the user a next action", () => {
  assert.ok(wrapper.includes("errorDetails(message)"))
  assert.ok(errorDetails("Predecessora inválida: linha X").some((line) => line.includes("Confira a coluna Predecessoras")))
  assert.ok(wrapper.includes("function predecessorLabel(text: string | null | undefined"))
  assert.ok(wrapper.includes("if (!text?.trim()) return \"\""))
  assert.ok(wrapper.includes("predecessorLabel(row.Predecessor"))
  assert.ok(wrapper.includes("pdfExport?.().catch(fail)"))
  assert.ok(wrapper.includes("excelExport?.().catch(fail)"))
})

test("activity color and late activities reach the rendered taskbar", () => {
  assert.ok(wrapper.includes("isLateTask"))
  assert.ok(wrapper.includes("queryTaskbarInfo: onTaskbarInfo"))
  assert.ok(wrapper.includes("row.color"))
  assert.ok(wrapper.includes("jg-late-cell"))
})

test("unsupported recordClick prop is not forwarded to React DOM", () => {
  assert.ok(!wrapper.includes("recordClick:"), "recordClick não existe no Gantt desta versão")
  assert.ok(wrapper.includes("cellSelected: props.editOnSingleClick ? onRecordClick : undefined"))
})

test("top bar uses theme icons and never duplicates the column chooser button", () => {
  assert.ok(wrapper.includes('className="e-icons e-refresh"'))
  assert.ok(wrapper.includes('className="e-icons e-settings"'))
  assert.ok(!wrapper.includes("e-columnchooserdiv"), "o botão de colunas foi removido das duas barras")
  assert.ok(!wrapper.includes("openColumnChooser"), "não sobra função morta para abrir o seletor")
  assert.ok(!/jgColumns|COMMANDS\.columns/.test(wrapper), "o comando de colunas do toolbar próprio foi removido")
  assert.ok(wrapper.includes('columnMenuItems: ["ColumnChooser"'), "o seletor continua acessível pelo menu de cada coluna")
  assert.ok(wrapper.includes('field="_sourceId"'))
  assert.ok(wrapper.includes('field="isManual"'))
})

test("the tree chevron position is derived from the real column list, not a hand-counted index", () => {
  assert.ok(!/treeColumnIndex:\s*\d+/.test(wrapper), "não deve haver um índice fixo no model")
  assert.ok(wrapper.includes('(child.props as { field?: string }).field === "TaskName"'),
    "o índice deve ser encontrado procurando a coluna do título")
  assert.ok(wrapper.includes("treeColumnIndex={treeColumnIndex}"), "o valor calculado deve chegar ao GanttComponent")
})

