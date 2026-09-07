import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/*
 * Guards for the type errors that only surface in the host's build.
 *
 * The wrapper cannot be type-checked here (React and Syncfusion typings are not
 * installed), so these read the source for the exact shapes that broke the build.
 */
const wrapper = readFileSync(fileURLToPath(new URL("../src/syncfusion/FeatureRichGantt.tsx", import.meta.url)), "utf8")
const editors = readFileSync(fileURLToPath(new URL("../src/syncfusion/editors.ts", import.meta.url)), "utf8")

test("context menu items are cast, because the property is a union of arrays", () => {
  // `ContextMenuItem[] | ContextMenuItemModel[]` rejects a list mixing names and objects.
  const block = /contextMenuItems:\s*\[([\s\S]*?)\]\s*as\s*GanttModel\["contextMenuItems"\]/.exec(wrapper)
  assert.ok(block, "contextMenuItems precisa do cast para o tipo do componente")
  assert.ok(block[1].includes('"TaskInformation"'), "os itens nativos continuam na lista")
  assert.ok(block[1].includes("jgConnect"), "os itens próprios continuam na lista")
})

test("the toolbar is cast for the same reason", () => {
  assert.ok(/toolbar:\s*\[[\s\S]*?\]\s*as\s*GanttModel\["toolbar"\]/.test(wrapper))
})

test("save is never wired straight to onClick", () => {
  /*
   * `save` takes an optional continuation. Passing it as the handler hands React's
   * MouseEvent to that parameter, and calling it after a successful write throws.
   */
  assert.ok(!/onClick=\{save\}/.test(wrapper), "onClick precisa envolver save em uma função")
  assert.ok(wrapper.includes("onClick={() => save()}"))
  assert.ok(wrapper.includes("save(leaveEditing)"), '"Salvar e sair" continua passando a continuação')
})

test("every handler that takes arguments is wrapped before reaching onClick", () => {
  const handlers = new Map<string, number>()
  for (const match of wrapper.matchAll(/const (\w+) = useEvent\(\((\w*)/g)) {
    handlers.set(match[1], match[2] ? 1 : 0)
  }
  for (const match of wrapper.matchAll(/onClick=\{(\w+)\}/g)) {
    const name = match[1]
    assert.equal(handlers.get(name) ?? 0, 0,
      `${name} recebe argumento e não pode ser ligado direto ao onClick`)
  }
})

test("shared types are imported from the module that exports them", () => {
  // edit-bridge re-uses SyncfusionTask but does not re-export it.
  assert.ok(editors.includes('import type { SyncfusionTask } from "./mapper"'))
  assert.ok(!/import\s*\{[^}]*SyncfusionTask[^}]*\}\s*from\s*"\.\/edit-bridge"/.test(editors))
})

test("optional dates are narrowed before entering a non-nullable list", () => {
  const mapping = readFileSync(fileURLToPath(new URL("../src/adapters/jornada/mapping.ts", import.meta.url)), "utf8")
  // A type predicate over an optional field does not satisfy the target type.
  assert.ok(!/item is \{ from: Date; label\?: string \}/.test(mapping))
  assert.ok(/holidays:[\s\S]{0,220}flatMap/.test(mapping), "a lista é montada já no formato final")
})
