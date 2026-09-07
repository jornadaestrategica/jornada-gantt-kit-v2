import type { TimelineSettingsModel } from "@syncfusion/ej2-react-gantt"
import type { TimelinePreset } from "../core/types"

const TIMELINES: Record<Exclude<TimelinePreset, "fit">, TimelineSettingsModel> = {
  hour: { topTier: { unit: "Day", format: "dd MMM" }, bottomTier: { unit: "Hour", format: "HH" } },
  day: { topTier: { unit: "Week", format: "dd MMM yyyy" }, bottomTier: { unit: "Day", format: "dd" } },
  week: { topTier: { unit: "Month", format: "MMM yyyy" }, bottomTier: { unit: "Week", format: "dd MMM" } },
  month: { topTier: { unit: "Year", format: "yyyy" }, bottomTier: { unit: "Month", format: "MMM" } },
  quarter: { topTier: { unit: "Year", format: "yyyy" }, bottomTier: { unit: "Month", count: 3, format: "MMM" } },
  year: { topTier: { unit: "Year", format: "yyyy" }, bottomTier: { unit: "Month", count: 6, format: "MMM" } },
}

/**
 * `timelineViewMode` defaults to "Week" in the installed build (the type's own doc comment
 * claims "None", but the shipped decorator says otherwise — verified in
 * node_modules/@syncfusion/ej2-gantt/src/gantt/models/timeline-settings.js). Left unset, a
 * mode other than "None" makes the component blend in its own suggested tier defaults
 * alongside ours, which is what produced the "top tier format is invalid" self-check —
 * our own formats all pass that check in isolation. "None" disables that blending.
 * The tier objects are also cloned per computation: TIMELINES entries are shared module
 * constants, and handing Syncfusion the same object reference on every mount is an
 * avoidable risk if any internal path ever writes back into it.
 */
export function resolveTimelineSettings(preset: TimelinePreset): TimelineSettingsModel {
  const base = TIMELINES[preset === "fit" ? "week" : preset]
  return { timelineViewMode: "None", topTier: { ...base.topTier }, bottomTier: { ...base.bottomTier } }
}
