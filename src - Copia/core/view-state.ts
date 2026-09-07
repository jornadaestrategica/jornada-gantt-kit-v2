import type { GanttViewState } from "./types"

const DEFAULT_STATE: GanttViewState = {
  selectedTaskIds: [],
  collapsedTaskIds: [],
  viewMode: "Default",
  timelinePreset: "week",
  splitterPosition: "42%",
  showBaseline: false,
  showCriticalPath: false,
  showAnnotations: true,
  hiddenColumns: [],
  leftLabelField: null,
  rightLabelField: "responsibleName",
  showProgressLabel: true,
  toolbarLabels: true,
  projectStart: null,
  projectEnd: null,
  highlightChanges: false,
  pinnedToggles: ["showAnnotations"],
}

export function mergeViewState(current: GanttViewState, changes: Partial<GanttViewState>): GanttViewState {
  const next = { ...current, ...changes }
  return JSON.stringify(current) === JSON.stringify(next) ? current : next
}

/**
 * Persists everything the user arranged by hand. Losing the splitter position, the
 * zoom level or which branches were collapsed on every reload is the single most
 * noticeable way a Gantt feels unfinished.
 */
export class GanttViewStateStore {
  private readonly key: string
  private readonly storage?: Storage

  constructor(key: string, storage?: Storage) {
    this.key = key
    this.storage = storage
  }

  load(): GanttViewState {
    if (!this.storage) return structuredClone(DEFAULT_STATE)
    try {
      const raw = this.storage.getItem(this.key)
      if (!raw) return structuredClone(DEFAULT_STATE)
      const parsed = JSON.parse(raw) as Partial<GanttViewState>
      return {
        ...structuredClone(DEFAULT_STATE),
        ...parsed,
        selectedTaskIds: Array.isArray(parsed.selectedTaskIds) ? parsed.selectedTaskIds : [],
        collapsedTaskIds: Array.isArray(parsed.collapsedTaskIds) ? parsed.collapsedTaskIds : [],
        hiddenColumns: Array.isArray(parsed.hiddenColumns) ? parsed.hiddenColumns : [],
        // Absent (state saved by an older version) keeps the default; an explicit empty
        // list is the user having unpinned everything, and must be respected.
        pinnedToggles: Array.isArray(parsed.pinnedToggles)
          ? parsed.pinnedToggles
          : structuredClone(DEFAULT_STATE.pinnedToggles ?? []),
      }
    } catch {
      return structuredClone(DEFAULT_STATE)
    }
  }

  save(state: GanttViewState): void {
    try {
      this.storage?.setItem(this.key, JSON.stringify(state))
    } catch {
      /* quota or private mode — view state is not worth breaking the app for */
    }
  }

  patch(changes: Partial<GanttViewState>): GanttViewState {
    const next = { ...this.load(), ...changes }
    this.save(next)
    return next
  }

  clear(): void {
    this.storage?.removeItem(this.key)
  }
}
