import { DropDownList } from "@syncfusion/ej2-react-dropdowns"
import type { GanttChoice } from "../core/adapter"
import type { SyncfusionTask } from "./mapper"

/**
 * Real EJ2 editors, created the way Syncfusion's own reference sample does.
 *
 * A `dropdownedit` declared only through `edit.params` renders the raw cell value
 * while the popup initialises, which is what put a literal `null` in the grid. An
 * explicit `write`/`read`/`destroy` triple owns the component instance instead, so the
 * editor opens on the row's current value, or on a placeholder when it has none.
 */
export interface CellEditor {
  create(): Element
  read(): string | null
  destroy(): void
  write(args: { element: Element; rowData: SyncfusionTask; column: { field: string } }): void
}

export function choiceEditor(
  optionsFor: (row: SyncfusionTask) => GanttChoice[],
  placeholder: string,
): CellEditor {
  let instance: DropDownList | null = null
  return {
    create: () => document.createElement("input"),
    read: () => typeof instance?.value === "string" ? instance.value : null,
    destroy: () => {
      instance?.destroy()
      instance = null
    },
    write: (args: { element: Element; rowData: SyncfusionTask; column: { field: string } }) => {
      const dataSource = optionsFor(args.rowData)
      const current = (args.rowData as unknown as Record<string, unknown>)[args.column.field]
      instance = new DropDownList({
        dataSource: dataSource as unknown as { [key: string]: Object }[],
        fields: { text: "label", value: "value" },
        value: typeof current === "string" && dataSource.some((item) => item.value === current) ? current : null,
        placeholder,
        floatLabelType: "Never",
        popupHeight: "220px",
        allowFiltering: dataSource.length > 8,
      })
      instance.appendTo(args.element as HTMLElement)
    },
  }
}
