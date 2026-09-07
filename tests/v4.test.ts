import assert from "node:assert/strict"
import test from "node:test"
import {
  DEFAULT_OFFSET_UNITS, PT_BR_OFFSET_UNITS, formatPredecessorText, parsePredecessorText,
} from "../src/core/dependencies"
import { GanttSession } from "../src/core/session"
import { createJornadaPolicy } from "../src/adapters/jornada/policy"
import { entregaId } from "../src/adapters/jornada/ids"
import { RenderIds, toSyncfusionDataset } from "../src/syncfusion/mapper"
import { parseNativeLinks } from "../src/syncfusion/edit-bridge"
import { canEditGridField } from "../src/syncfusion/editing-policy"
import type { GanttTask } from "../src/core/types"

const task = (id: string, order = 0, parentId: string | null = null): GanttTask => ({
  id, order, parentId, kind: "group", entityType: "entrega", businessType: "Entrega",
  title: id, startDate: null, endDate: null, duration: null, durationUnit: "day", progress: 0,
})

test("a localized offset survives the whole render and read-back chain", () => {
  // The reported failure: the component rejected "5FS+1 dia" as an invalid relation.
  const ids = new RenderIds()
  const rows = toSyncfusionDataset({
    tasks: [
      { ...task("atividade:a"), kind: "task", entityType: "atividade" },
      { ...task("atividade:b", 1), kind: "task", entityType: "atividade" },
    ],
    dependencies: [{ predecessorId: "atividade:a", successorId: "atividade:b", type: "FS", lag: 1 }],
  }, { identities: ids, offsetUnits: PT_BR_OFFSET_UNITS })

  assert.equal(rows[1].Predecessor, "1FS+1 dia")
  const parsed = parseNativeLinks(rows[1].Predecessor, "atividade:b", ids)
  assert.deepEqual(parsed, [{ predecessorId: "atividade:a", successorId: "atividade:b", type: "FS", lag: 1 }])
})

test("offset wording follows the locale in both number and language", () => {
  const link = [{ predecessorId: "7", successorId: "9", type: "FS" as const, lag: 3 }]
  assert.equal(formatPredecessorText(link, "9", PT_BR_OFFSET_UNITS), "7FS+3 dias")
  assert.equal(formatPredecessorText(link, "9", DEFAULT_OFFSET_UNITS), "7FS+3 days")
  assert.equal(formatPredecessorText([{ ...link[0], lag: -1 }], "9", PT_BR_OFFSET_UNITS), "7FS-1 dia")
  assert.equal(formatPredecessorText([{ ...link[0], lag: 0 }], "9", PT_BR_OFFSET_UNITS), "7FS")
})

test("any locale's unit word is read back, and a bare id is still a relation", () => {
  for (const text of ["2FS+3 dias", "2FS+3 days", "2FS+3d", "2FS+3 journées", "2FS + 3 dias"]) {
    const [link] = parsePredecessorText(text, "z")
    assert.equal(link.predecessorId, "2", text)
    assert.equal(link.lag, 3, text)
  }
  assert.deepEqual(parsePredecessorText("a", "z").map((item) => [item.predecessorId, item.lag]), [["a", 0]])
})

test("grouping is allowed down to ten levels and refused beyond it", () => {
  const policy = createJornadaPolicy()
  assert.equal(policy.maxDepth, 10)
  // A chain ten deliverables deep: depths 0..9, which is the ten levels we allow.
  const chain = Array.from({ length: 10 }, (_, level) =>
    task(entregaId(`n${level}`), 0, level === 0 ? null : entregaId(`n${level - 1}`)))
  const session = new GanttSession({
    tasks: [...chain, task(entregaId("extra"), 1, entregaId("n8"))],
  }, { policy })

  assert.equal(session.tasks.find((row) => row.id === entregaId("n9"))?.parentId, entregaId("n8"))

  // Indenting the sibling under the tenth level would open an eleventh.
  const refused = session.indent([entregaId("extra")])
  assert.equal(refused.applied.length, 0)
  assert.equal(refused.rejected[0].code, "MAX_DELIVERABLE_DEPTH")
  assert.match(refused.rejected[0].message, /10 níveis/)
  assert.equal(session.tasks.find((row) => row.id === entregaId("extra"))?.parentId, entregaId("n8"))

  // The same gesture one level higher is still accepted.
  const shallow = new GanttSession({
    tasks: [...chain.slice(0, 9), task(entregaId("extra"), 1, entregaId("n7"))],
  }, { policy })
  assert.deepEqual(shallow.indent([entregaId("extra")]).applied, [entregaId("extra")])
})

test("a delivery keeps its own editable fields while its derived schedule stays locked", () => {
  const row = toSyncfusionDataset({
    tasks: [{ ...task(entregaId("1")), lockedFields: ["startDate", "endDate", "duration", "progress"] }],
  })[0]
  const locked = new Set(row._locked)
  assert.equal(canEditGridField(row, "businessType", locked, true), true)
  assert.equal(canEditGridField(row, "showMilestone", locked, true), true)
  assert.equal(canEditGridField(row, "TaskName", locked, true), true)
  assert.equal(canEditGridField(row, "StartDate", locked, true), false)
  // Links are written on the activity side, so a delivery never edits that cell.
  assert.equal(canEditGridField(row, "Predecessor", locked, true), false)
})
