import * as React from "react"
import { FeatureRichGantt } from "./syncfusion/FeatureRichGantt"
import { JornadaGanttAdapter } from "./adapters/jornada/adapter"
import { InMemoryJornadaTransport } from "./adapters/jornada/memory-transport"
import { demoContext, jornadaDemoSnapshot } from "./demo/jornada-data"

/**
 * Runs the kit fully decoupled from Jornada: the same adapter that will talk to
 * Supabase in production is driven here by an in-memory transport that enforces the
 * same constraints. Swapping `InMemoryJornadaTransport` for a real one is the only
 * change needed to point this at the live database.
 */
const transport = new InMemoryJornadaTransport(jornadaDemoSnapshot)

export function App() {
  const adapter = React.useMemo(
    () =>
      new JornadaGanttAdapter(transport, {
        dateSource: "previsto",
        showRealizadoAsBaseline: true,
        // Load adjustments are host business, not something to put in the user's way.
        onDiagnostics: (items) => console.info("[gantt] ajustes na carga", items),
      }),
    [],
  )

  const context = React.useMemo(() => demoContext, [])

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>Jornada Estratégica Gantt</h1>
        <p>Entre em edição, ajuste na linha ou pelas barras, salve quantas vezes quiser.</p>
      </header>

      <div className="gantt-container">
        <FeatureRichGantt
          adapter={adapter}
          context={context}
          storageKey="jornada-gantt-kit:standalone"
          locale="pt-BR"
          height="100%"
          defaultEntityType="atividade"
          groupEntityType="entrega"
        />
      </div>
    </main>
  )
}
