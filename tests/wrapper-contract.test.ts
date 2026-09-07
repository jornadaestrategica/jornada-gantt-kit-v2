import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/*
 * Contract checks over the wrapper source.
 *
 * These guard two defects that reached the browser twice and that no logic test can
 * catch: a bar label bound to a field the component cannot resolve, and a native
 * toolbar command reaching the tree without passing the domain rules.
 */
const wrapper = readFileSync(fileURLToPath(new URL("../src/syncfusion/FeatureRichGantt.tsx", import.meta.url)), "utf8")
const mapper = readFileSync(fileURLToPath(new URL("../src/syncfusion/mapper.ts", import.meta.url)), "utf8")

test("bar labels read custom fields through taskData, the only path that resolves them", () => {
  const labels = /labelSettings:\s*\{([\s\S]*?)\n\s{4}\}/.exec(wrapper)
  assert.ok(labels, "labelSettings não encontrado")
  const block = labels[1]

  for (const side of ["leftLabel", "rightLabel"]) {
    const line = new RegExp(`${side}:\\s*"([^"]*)"`).exec(block)
    assert.ok(line, `${side} não encontrado`)
    const template = line[1]
    assert.ok(template.includes("taskData."), `${side} precisa ler taskData: ${template}`)
    const field = /\$\{taskData\.(\w+)\}/.exec(template)?.[1]
    assert.ok(field, `${side} sem campo`)
    // The field must actually be produced by the mapper, or the bar prints "undefined".
    assert.ok(mapper.includes(`${field}:`), `campo "${field}" não é produzido pelo mapper`)
  }
})

test("indent and outdent are our own commands, never the component's native ones", () => {
  const toolbar = /toolbar:\s*\[([\s\S]*?)\n\s{4}\] as GanttModel\["toolbar"\]/.exec(wrapper)
  assert.ok(toolbar, "toolbar não encontrada")
  const block = toolbar[1]

  // A native entry would run the component's own indent, bypassing the domain policy.
  assert.ok(!/["']Indent["']/.test(block), "toolbar não pode conter o comando nativo Indent")
  assert.ok(!/["']Outdent["']/.test(block), "toolbar não pode conter o comando nativo Outdent")
  assert.ok(block.includes("COMMANDS.indent") && block.includes("COMMANDS.outdent"))

  // Reload lives on the top bar; a second entry here was a duplicate.
  assert.ok(!block.includes("jgRefresh"), "Recarregar não deve ficar na barra do Gantt")
})

test("toolbar ids are matched by suffix, since the component prefixes its element id", () => {
  const handler = /const onToolbar = useEvent\(([\s\S]*?)\n  \}\)/.exec(wrapper)
  assert.ok(handler, "onToolbar não encontrado")
  const block = handler[1]
  assert.ok(block.includes("endsWith("), "a comparação precisa aceitar o prefixo do componente")
  // Slicing at the first "_" broke whenever the element id contained one.
  assert.ok(!block.includes('id.indexOf("_")'), "não fatiar no primeiro separador")
  for (const command of ["undo", "redo", "indent", "outdent"]) {
    assert.ok(block.includes(`COMMANDS.${command}`), `comando ausente: ${command}`)
  }
})

test("toolbar commands use the product's standard icon classes", () => {
  const icons = [...wrapper.matchAll(/prefixIcon:\s*"([^"]*)"/g)].map((match) => match[1])
  assert.ok(icons.length >= 4, `esperava ícones nos comandos, encontrei ${icons.length}`)
  for (const icon of icons) {
    // Standard EJ2 classes: the theme owns the glyph, so it matches the native buttons.
    assert.match(icon, /^e-icons e-[a-z0-9-]+$/, `ícone fora do padrão: ${icon}`)
  }
  for (const expected of ["e-indent", "e-outdent", "e-undo", "e-redo"]) {
    assert.ok(icons.includes(`e-icons ${expected}`), `faltou ${expected}`)
  }
})

test("the settings panel and the top bar share one source of truth for toggles", () => {
  assert.ok(wrapper.includes('from "./display-toggles"'))
  assert.ok(wrapper.includes("isToggleOn(view,"), "o wrapper deve usar o mesmo critério do painel")
})
