 
import { GanttPanel } from "./GanttPanel"

/**
 * Demo host only. The embeddable piece is `GanttPanel`; this file exists to run it
 * standalone and is not part of what the host application imports.
 */
export function App() {
  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>Jornada Estratégica Gantt</h1>
      </header>
      <div className="gantt-container">
        <GanttPanel />
      </div>
    </main>
  )
}
