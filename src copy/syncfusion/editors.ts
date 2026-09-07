import { DropDownList } from "@syncfusion/ej2-react-dropdowns"
import type { GanttChoice } from "../core/adapter"
import { readNativeRow } from "./edit-bridge"
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
    read: () => typeof instance?.value === "string" ? instance.value : null,    //JRG: AJUSTE MANUAL REALIZADO    
    destroy: () => {
      instance?.destroy()
      instance = null
    },
    write: (args: { element: Element; rowData: SyncfusionTask; column: { field: string } }) => {
      /*
       * The grid hands us our flat row, but the edit dialog hands us the component's own
       * record, whose custom fields live under `taskData`. Reading `rowData` directly
       * there produced an undefined entityType, so a delivery was offered the activity
       * status list and then refused every value in it.
       */
      const row = readNativeRow(args.rowData) ?? args.rowData
      const dataSource = optionsFor(row)
      const current = (row as unknown as Record<string, unknown>)[args.column.field]
      instance = new DropDownList({
        dataSource: dataSource as unknown as { [key: string]: Object }[], //JRG: ajuste manual realizado
        fields: { text: "label", value: "value" },
        value: dataSource.some((item) => item.value === current) ? (current as string) : null,
        placeholder,
        floatLabelType: "Never",
        popupHeight: "220px",
        allowFiltering: dataSource.length > 8,
      })
      instance.appendTo(args.element as HTMLElement)
    },
  }
}
