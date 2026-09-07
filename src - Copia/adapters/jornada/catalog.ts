import type { GanttCreationOption } from "../../core/adapter"
import type { EntregaTipo } from "./schema"

export const entregaTypes: Array<{ value: EntregaTipo; label: string }> = [
  { value: "Entrega", label: "Entrega" },
  { value: "Feature", label: "Feature" },
  { value: "Estoria", label: "Estória" },
  { value: "Bug", label: "Bug" },
  { value: "Melhoria", label: "Melhoria" },
  { value: "Debito Tecnico", label: "Débito técnico" },
  { value: "Resultado", label: "Resultado" },
  { value: "Grupo", label: "Grupo" },
]

export const jornadaCreationOptions: GanttCreationOption[] = [
  { id: "atividade", label: "Atividade", task: { title: "Nova atividade", kind: "task", entityType: "atividade" } },
  ...entregaTypes.map(({ value, label }) => ({
    id: value,
    label,
    task: {
      title: `Nova entrega — ${label}`, kind: "group" as const, entityType: "entrega",
      businessType: value, isSummary: true, showMilestone: false, status: "Nova",
    },
  })),
  {
    id: "grupo", label: "Grupo de entregas", task: {
      title: "Novo grupo", kind: "group", entityType: "entrega",
      businessType: "Entrega", isSummary: true, showMilestone: false, status: "Nova",
    }
  },
  {
    id: "marco", label: "Marco (nova entrega)", task: {
      title: "Novo marco de entrega", kind: "milestone", entityType: "entrega",
      businessType: "Entrega", isSummary: false, showMilestone: true, status: "Nova",
    }
  },
]
