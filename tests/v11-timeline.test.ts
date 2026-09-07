import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { resolveTimelineSettings } from "../src/syncfusion/timeline-settings"
import { errorMessage, tierFormatNotice } from "../src/syncfusion/notices"
import { GanttViewStateStore } from "../src/core/view-state"

const wrapper = readFileSync(fileURLToPath(new URL("../src/syncfusion/FeatureRichGantt.tsx", import.meta.url)), "utf8")

// Mirrors the exact check Syncfusion runs once per mount (node_modules/@syncfusion/ej2-gantt
// src/gantt/base/gantt.js, Gantt.prototype.actionFailures): only letters, spaces and slashes.
const LETTERS_ONLY = /^[a-zA-Z\s/]+$/

test("every timeline preset resolves a tier format that passes Syncfusion's own validation", () => {
  for (const preset of ["fit", "hour", "day", "week", "month", "quarter", "year"] as const) {
    const settings = resolveTimelineSettings(preset)
    assert.equal(settings.timelineViewMode, "None", `${preset} deve desativar o combo sugerido pelo modo`)
    for (const tier of [settings.topTier, settings.bottomTier]) {
      assert.ok(tier?.format, `${preset} sem format`)
      assert.ok(LETTERS_ONLY.test(tier!.format!), `${preset}: "${tier!.format}" falharia na checagem do Syncfusion`)
    }
  }
})

test("resolveTimelineSettings never hands out the same tier object twice", () => {
  const first = resolveTimelineSettings("week")
  const second = resolveTimelineSettings("week")
  assert.notEqual(first.topTier, second.topTier, "topTier deve ser clonado a cada chamada")
  assert.notEqual(first.bottomTier, second.bottomTier, "bottomTier deve ser clonado a cada chamada")
  assert.deepEqual(first, second, "o conteúdo continua o mesmo")
})

test("a tier-format failure is recognised and explained without touching data", () => {
  const raw = "The provided top tier format is invalid. Please ensure that you provide a valid format for these tier. Make sure to use only letters and avoid numbers or special characters!"
  const notice = tierFormatNotice(raw)
  assert.ok(notice)
  assert.equal(notice!.tone, "warning")
  assert.match(notice!.message, /escala superior/)
  assert.ok(notice!.details?.includes(raw), "a mensagem real do Syncfusion continua disponível")
  assert.ok(notice!.details?.some((line) => /dados do cronograma não foram alterados/.test(line)))
})

test("bottom tier wording differs from top tier wording", () => {
  const notice = tierFormatNotice("The provided bottom  tier format is invalid. Please ensure...")
  assert.match(notice!.message, /escala inferior/)
})

test("an unrelated error is never mistaken for the tier-format notice", () => {
  assert.equal(tierFormatNotice("Predecessora inválida"), null)
})

test("Syncfusion's numeric-keyed failureCases object is normalized like a real array", () => {
  const shaped = { 0: "The provided top tier format is invalid." }
  assert.equal(errorMessage(shaped), "The provided top tier format is invalid.")
})

test("errorMessage still handles Error, string, array and nested message objects", () => {
  assert.equal(errorMessage("texto simples"), "texto simples")
  assert.equal(errorMessage(new Error("falha real")), "falha real")
  assert.equal(errorMessage(["a", "b"]), "a b")
  assert.equal(errorMessage({ message: "vindo de dentro" }), "vindo de dentro")
  assert.equal(errorMessage({ error: { message: "aninhado" } }), "aninhado")
  assert.equal(errorMessage(null), "Ocorreu um erro inesperado.")
  assert.equal(errorMessage({}), "Ocorreu um erro inesperado.")
})

test("gridLines defaults to Horizontal and every native value round-trips through view state", () => {
  const memory = new Map<string, string>()
  const storage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, value) },
    removeItem: (key: string) => { memory.delete(key) },
    clear: () => memory.clear(),
    key: () => null,
    length: 0,
  } as Storage
  const store = new GanttViewStateStore("test-gridlines", storage)
  const loaded = store.load()
  assert.equal(loaded.gridLines, "Horizontal", "linhas horizontais é o padrão inicial")
  for (const value of ["None", "Horizontal", "Vertical", "Both"] as const) {
    const patched = store.patch({ gridLines: value })
    assert.equal(patched.gridLines, value)
    assert.equal(store.load().gridLines, value, `${value} deve persistir`)
  }
})

test("gridLines is wired to the model and to the settings panel, not hardcoded", () => {
  assert.ok(wrapper.includes('gridLines: view.gridLines ?? "Horizontal"'), "o model lê o estado, não um valor fixo")
  assert.ok(!/gridLines:\s*"Both",\s*highlightWeekends/.test(wrapper), "o antigo valor fixo \"Both\" foi removido")
})

test("the row-drag column keeps its handle; only its separating line is removed", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/styles/gantt.css", import.meta.url)), "utf8")
  assert.ok(css.includes(".e-rowdragdropcell { border-right-width: 0"), "a linha divisória some por borda, não a coluna")
  assert.ok(!/\.e-rowdragdrop[\s\S]{0,60}\{[^}]*display:\s*none/.test(css), "a coluna de drag não pode ser ocultada")
  assert.ok(!/\.e-icon-rowdragicon[^}]*\{[^}]*display:\s*none/.test(css), "o ícone da alça não pode ser escondido globalmente")
})

test("no code path calls showColumn/hideColumn from inside a column or sort event", () => {
  // The discarded round's "Maximum call stack size exceeded" came from exactly this
  // pattern: a columnstate/actionBegin/actionComplete handler calling showColumn back.
  assert.ok(!/\bshowColumns?\s*\(/.test(wrapper), "showColumn(s) não deve existir no componente")
  assert.ok(!/\bhideColumns?\s*\(/.test(wrapper), "hideColumn(s) não deve existir no componente")
  assert.ok(!/requestType.*columnstate/i.test(wrapper), "nenhum handler reage a columnstate")
})

