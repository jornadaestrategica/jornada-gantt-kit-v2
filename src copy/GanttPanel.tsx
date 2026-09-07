"use client"
import * as React from "react"
import { FeatureRichGantt } from "./syncfusion/FeatureRichGantt"
import { JornadaGanttAdapter, type JornadaContext, type JornadaTransport } from "./adapters/jornada/adapter"
import { InMemoryJornadaTransport } from "./adapters/jornada/memory-transport"
import { demoContext, jornadaDemoSnapshot } from "./demo/jornada-data"
import type { GanttCapabilities, GanttPermissions } from "./core/types"

export interface GanttPanelProps {
  /** Production transport. Omitted, the panel runs on the in-memory demo data. */
  transport?: JornadaTransport
  context?: JornadaContext
  capabilities?: GanttCapabilities
  permissions?: GanttPermissions
  /** Distinct key per plan, so view preferences do not leak between plans. */
  storageKey?: string
  editOnSingleClick?: boolean
  onSaved?: () => void
  onError?: (error: unknown) => void
}

/**
 * Drop-in panel: the whole Gantt with no page around it.
 *
 * Mount it inside a tab and give the container a height — the panel fills it.
 *
 * ```tsx
 * <div style={{ height: "100%", minHeight: 0 }}>
 *   <GanttPanel transport={transport} context={{ planoId, pessoaId }} storageKey={`gantt:${planoId}`} />
 * </div>
 * ```
 */
export function GanttPanel(props: GanttPanelProps) {
  const adapter = React.useMemo(
    () => new JornadaGanttAdapter(props.transport ?? new InMemoryJornadaTransport(jornadaDemoSnapshot), {
      dateSource: "previsto",
      showRealizadoAsBaseline: true,
    }),
    [props.transport],
  )
  const context = React.useMemo(() => props.context ?? demoContext, [props.context])

  return <FeatureRichGantt
    adapter={adapter}
    context={context}
    storageKey={props.storageKey ?? "jornada-gantt"}
    locale="pt-BR"
    height="100%"
    embedded
    editOnSingleClick={props.editOnSingleClick ?? true}
    defaultEntityType="atividade"
    groupEntityType="entrega"
    capabilities={props.capabilities}
    permissions={props.permissions}
    onSaved={props.onSaved}
    onError={props.onError}
  />
}
