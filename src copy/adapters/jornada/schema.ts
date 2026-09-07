/**
 * Row shapes as they exist in the Jornada database. Field names are the database
 * names on purpose: this file is the only place in the kit that speaks Portuguese
 * schema, and keeping the spelling identical makes a mismatch obvious at review time.
 */

export type Uuid = string

/** tb_resultado_entrega — the product side: what is to be delivered. */
export interface ResultadoEntregaRow {
  id: Uuid
  plano_id: Uuid | null
  titulo: string
  tipo: EntregaTipo
  /** Self-referencing hierarchy: Entrega -> Feature -> Estória. */
  parent_id: Uuid | null
  status: string | null
  sprint_plano_id?: Uuid | null
  prioridade?: string | null
  criterios_aceite?: string | null
  valor_negocio?: number | null
  urgencia?: number | null
  risco_reducao?: number | null
  /** GENERATED ALWAYS ... STORED. Read-only for every client. */
  wsjf_score?: number | null
  pessoa_id?: Uuid | null
  pessoa_nome?: string | null
  tags?: string[] | null
  esforco_horas?: number | null
  story_points?: number | null
  ordem: number
  cor?: string | null
  /** Render as a summary bar rather than a plain row. */
  eh_agrupador?: boolean | null
  /** Render a diamond for the deliverable itself. */
  exibir_marco?: boolean | null
  updated_at?: string | null
}

export type EntregaTipo =
  | "Resultado"
  | "Grupo"
  | "Entrega"
  | "Sprint Goal"
  | "Feature"
  | "Estoria"
  | "Bug"
  | "Melhoria"
  | "Debito Tecnico"

/** tb_atividade — the work side: how it gets done. Never nests under another activity. */
export interface AtividadeRow {
  id: Uuid
  titulo: string
  descricao?: string | null
  plano_id: Uuid | null
  /** FK to tb_resultado_entrega. This is the only parent an activity can have. */
  resultado_entrega_id: Uuid | null
  pessoa_id: Uuid
  pessoa_nome?: string | null
  unidade_id?: Uuid | null
  portfolio_id?: Uuid | null
  status: string | null
  prioridade?: string | null
  /** 0..100 */
  avanco?: number | null
  /** Weight for weighted progress rollup. */
  peso?: number | null
  /** Hours. */
  esforco?: number | null
  tipo?: "Padrão" | "Vínculo de plano" | null
  plano_vinculado_id?: Uuid | null
  dtinicio_previsto: string | null
  dttermino_previsto: string | null
  dtinicio?: string | null
  dttermino?: string | null
  story_points?: number | null
  grupo?: string | null
  cor?: string | null
  tag?: string[] | null
  is_archived?: boolean | null
  campos_personalizados?: Record<string, unknown> | null
  created_at?: string | null
  updated_at?: string | null
}

/** tb_atividade_vinculo — dependencies. The successor is always an activity. */
export interface AtividadeVinculoRow {
  id: Uuid
  /** Successor. NOT NULL, always an activity. */
  atividade_id: Uuid
  /** Predecessor when it is an activity. Mutually exclusive with resultado_entrega_id. */
  predecessora_id: Uuid | null
  /** Predecessor when it is a deliverable. Mutually exclusive with predecessora_id. */
  resultado_entrega_id: Uuid | null
  tipo_vinculo: "FS" | "FF" | "SS" | "SF"
  /** Days. Negative means lead. */
  lag: number | null
}

export interface SprintRow {
  id: Uuid
  titulo: string
  dtinicio: string | null
  dttermino: string | null
}

export interface JornadaSnapshot {
  entregas: ResultadoEntregaRow[]
  atividades: AtividadeRow[]
  vinculos: AtividadeVinculoRow[]
  sprints?: SprintRow[]
  feriados?: Array<{ data: string; descricao?: string }>
  annotations?: Array<{ date: string; label: string; cssClass?: string }>
  /** Middleware data; these are NOT assumed columns of tb_resultado_entrega. */
  presentation?: Array<{
    entrega_id: Uuid
    milestoneLabel?: string | null
    milestoneDate?: string | null
  }>
}
