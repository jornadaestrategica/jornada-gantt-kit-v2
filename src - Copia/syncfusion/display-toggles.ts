import type { GanttViewState } from "../core/types"

export type DisplayToggleId =
  | "showAnnotations" | "showBaseline" | "showCriticalPath" | "highlightChanges" | "toolbarLabels"

export interface DisplayToggle {
  id: DisplayToggleId
  label: string
  /** Short form used when the toggle is pinned to the top bar. */
  short: string
}

/** Every display toggle in one place, so panel and top bar cannot disagree. */
export const DISPLAY_TOGGLES: DisplayToggle[] = [
  { id: "showAnnotations", label: "Anotações temporais", short: "Anotações" },
  { id: "showBaseline", label: "Linha de base", short: "Linha de base" },
  { id: "showCriticalPath", label: "Caminho crítico", short: "Caminho crítico" },
  { id: "highlightChanges", label: "Destacar células alteradas desde a última gravação", short: "Alterações" },
  { id: "toolbarLabels", label: "Mostrar texto nos botões, além dos ícones", short: "Texto nos botões" },
]

const DEFAULT_ON = new Set<DisplayToggleId>(["showAnnotations", "toolbarLabels"])

export function isToggleOn(view: GanttViewState, id: DisplayToggleId): boolean {
  const value = view[id]
  return value === undefined ? DEFAULT_ON.has(id) : Boolean(value)
}
