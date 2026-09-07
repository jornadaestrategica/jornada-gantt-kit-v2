"use client"
import * as React from "react"
import type { GanttViewState } from "../core/types"
import { LABEL_FIELDS } from "./mapper"
import { DISPLAY_TOGGLES, isToggleOn } from "./display-toggles"

export { DISPLAY_TOGGLES, isToggleOn }
export type { DisplayToggle, DisplayToggleId } from "./display-toggles"

export interface SettingsPanelProps {
  view: GanttViewState
  onChange: (changes: Partial<GanttViewState>) => void
  onClose: () => void
  canBaseline: boolean
  canCriticalPath: boolean
}

const toInput = (value: string | null | undefined) => value ?? ""

export function SettingsPanel(props: SettingsPanelProps) {
  const { view, onChange } = props
  const dialog = React.useRef<HTMLDivElement>(null)
  const pinned = view.pinnedToggles ?? []

  React.useEffect(() => {
    dialog.current?.querySelector<HTMLElement>("input,select,button")?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") props.onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [props])

  const available = DISPLAY_TOGGLES.filter((toggle) =>
    (toggle.id !== "showBaseline" || props.canBaseline) &&
    (toggle.id !== "showCriticalPath" || props.canCriticalPath))

  const togglePin = (id: string) => {
    onChange({ pinnedToggles: pinned.includes(id) ? pinned.filter((item) => item !== id) : [...pinned, id] })
  }

  return <div className="jg-settings-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) props.onClose()
  }}>
    <div className="jg-settings" role="dialog" aria-modal="true" aria-label="Configurações do cronograma" ref={dialog}>
      <header>
        <h2>Configurações</h2>
        <button type="button" className="jg-close" aria-label="Fechar configurações" onClick={props.onClose}>×</button>
      </header>

      <section>
        <h3>Período do cronograma</h3>
        <p className="jg-hint">Em branco, o período acompanha as datas do plano.</p>
        <div className="jg-field-row">
          <label>Início
            <input type="date" value={toInput(view.projectStart)}
              onChange={(event) => onChange({ projectStart: event.target.value || null })} />
          </label>
          <label>Término
            <input type="date" value={toInput(view.projectEnd)}
              onChange={(event) => onChange({ projectEnd: event.target.value || null })} />
          </label>
        </div>
        {view.projectStart && view.projectEnd && view.projectStart > view.projectEnd &&
          <p className="jg-warn">O início está depois do término; o período será ignorado.</p>}
      </section>

      <section>
        <h3>Rótulos das barras</h3>
        <div className="jg-field-row">
          <label>À esquerda
            <select value={toInput(view.leftLabelField)}
              onChange={(event) => onChange({ leftLabelField: event.target.value || null })}>
              <option value="">Não exibir</option>
              {LABEL_FIELDS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label>À direita
            <select value={toInput(view.rightLabelField)}
              onChange={(event) => onChange({ rightLabelField: event.target.value || null })}>
              <option value="">Não exibir</option>
              {LABEL_FIELDS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
        </div>
        <label className="jg-check"><input type="checkbox" checked={view.showProgressLabel !== false}
          onChange={(event) => onChange({ showProgressLabel: event.target.checked })} />Mostrar o avanço sobre a barra</label>
      </section>

      <section>
        <h3>Linhas da grade</h3>
        <label>Exibir
          <select value={view.gridLines ?? "Horizontal"}
            onChange={(event) => onChange({ gridLines: event.target.value as GanttViewState["gridLines"] })}>
            <option value="None">Nenhuma</option>
            <option value="Horizontal">Somente horizontais</option>
            <option value="Vertical">Somente verticais</option>
            <option value="Both">Horizontais e verticais</option>
          </select>
        </label>
      </section>

      <section>
        <h3>Exibição</h3>
        <p className="jg-hint">O olho fixa a opção na barra superior, para alternar sem abrir as configurações.</p>
        <ul className="jg-toggle-list">
          {available.map((toggle) => (
            <li key={toggle.id}>
              <label className="jg-check">
                <input type="checkbox" checked={isToggleOn(view, toggle.id)}
                  onChange={(event) => onChange({ [toggle.id]: event.target.checked })} />
                {toggle.label}
              </label>
              <button type="button" className={`jg-pin${pinned.includes(toggle.id) ? " jg-pin-on" : ""}`}
                aria-pressed={pinned.includes(toggle.id)}
                title={pinned.includes(toggle.id) ? "Remover da barra superior" : "Fixar na barra superior"}
                onClick={() => togglePin(toggle.id)}>{pinned.includes(toggle.id) ? "👁" : "👁‍🗨"}</button>
            </li>
          ))}
        </ul>
      </section>

      <footer><button type="button" className="jg-primary" onClick={props.onClose}>Concluído</button></footer>
    </div>
  </div>
}
