import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { toSyncfusionDataset } from "../src/syncfusion/mapper"
import type { GanttTask } from "../src/core/types"
import { GanttViewStateStore } from "../src/core/view-state"

const wrapper = readFileSync(fileURLToPath(new URL("../src/syncfusion/FeatureRichGantt.tsx", import.meta.url)), "utf8")

const task = (id: string): GanttTask => ({
  id, parentId: null, order: 0, kind: "task", entityType: "atividade", title: id,
  startDate: null, endDate: null, duration: null, durationUnit: "day", progress: 0,
})

test("an activity with no explicit duration unit is presented in days, never hours", () => {
  // durationUnit is required by the type, but legacy/host rows can still arrive without
  // it; the mapper's fallback is what actually protects the "day" default at runtime.
  const legacyRow = { ...task("a") } as Partial<GanttTask> as GanttTask
  delete (legacyRow as { durationUnit?: unknown }).durationUnit
  const [row] = toSyncfusionDataset({ tasks: [legacyRow] })
  assert.equal(row.DurationUnit, "day")
})

test("manual scheduling is the product default; automatic and per-activity are opt-in", () => {
  assert.equal(new GanttViewStateStore("test-schedule").load().scheduleMode, "manual")
  assert.ok(wrapper.includes('taskMode: view.scheduleMode === "custom" ? "Custom" : view.scheduleMode === "auto" ? "Auto" : "Manual"'))
  assert.ok(wrapper.includes('autoCalculateDateScheduling: view.scheduleMode !== "manual"'))
})

test("the general schedule-mode selector and the per-activity Manual column are two separate, honestly-scoped controls", () => {
  assert.ok(wrapper.includes('aria-label="Modo de agendamento"'), "controle geral no topo")
  assert.ok(wrapper.includes('field="isManual"'), "controle por atividade na grade")
  // Per-row scheduling mode is a view/session concern today (applyNativeEdits keeps it
  // only when scheduleMode is "custom"); it is not claimed to be written to the backend
  // beyond whatever the host adapter's own patch already persists.
  assert.ok(wrapper.includes('allowSchedulingMode: viewRef.current.scheduleMode === "custom"'))
})
