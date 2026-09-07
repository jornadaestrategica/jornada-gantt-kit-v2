import type { JornadaEntity } from "./ids"

/**
 * The two tables enforce different CHECK vocabularies and the codebase already
 * carries a known defect around accents ("Concluído" vs "Concluida"), which silently
 * breaks grouping and filtering. Everything that reaches a CHECK column is therefore
 * folded to a canonical value here, and a value that cannot be folded is reported
 * rather than written.
 */

export const ATIVIDADE_STATUS = [
  "Prevista",
  "Não iniciada",
  "Em andamento",
  "Concluída",
  "Bloqueada",
  "Cancelada",
] as const

export const ENTREGA_STATUS = ["Nova", "Refinada", "Pronta", "Em Sprint", "Concluída", "Cancelada"] as const

export const ATIVIDADE_PRIORIDADE = [
  "0-Crítica",
  "1-Muito Alta",
  "2-Alta",
  "3-Média",
  "4-Baixa",
  "5-Muito Baixa",
] as const

/**
 * Accented, matching tb_atividade. The two tables historically disagreed on the accent
 * and the host is standardising on this spelling; the normaliser still folds the old
 * unaccented rows on load, so existing data keeps working.
 */
export const ENTREGA_PRIORIDADE = [
  "0-Crítica",
  "1-Muito Alta",
  "2-Alta",
  "3-Média",
  "4-Baixa",
  "5-Muito Baixa",
] as const

export type AtividadeStatus = (typeof ATIVIDADE_STATUS)[number]
export type EntregaStatus = (typeof ENTREGA_STATUS)[number]

/** Accent- and case-insensitive comparison key. */
export function foldKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .toLowerCase()
}

function buildIndex(values: readonly string[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const value of values) index.set(foldKey(value), value)
  return index
}

const INDEXES = {
  atividadeStatus: buildIndex(ATIVIDADE_STATUS),
  entregaStatus: buildIndex(ENTREGA_STATUS),
  atividadePrioridade: buildIndex(ATIVIDADE_PRIORIDADE),
  entregaPrioridade: buildIndex(ENTREGA_PRIORIDADE),
}

/** Cross-vocabulary aliases seen in legacy rows and in user typing. */
const STATUS_ALIASES: Record<string, string> = {
  concluido: "Concluída",
  concluida: "Concluída",
  finalizada: "Concluída",
  finalizado: "Concluída",
  emandamento: "Em andamento",
  emexecucao: "Em andamento",
  andamento: "Em andamento",
  naoiniciada: "Não iniciada",
  naoiniciado: "Não iniciada",
  ainiciar: "Não iniciada",
  notstarted: "Não iniciada",
  inprogress: "Em andamento",
  completed: "Concluída",
  cancelado: "Cancelada",
  bloqueado: "Bloqueada",
}

export interface NormalizationResult<T extends string = string> {
  value: T | null
  /** True when the input had to be corrected, so the caller can warn or audit. */
  corrected: boolean
  original: string | null
}

function normalizeAgainst(
  raw: string | null | undefined,
  index: Map<string, string>,
  aliases: Record<string, string> = {},
): NormalizationResult {
  if (raw == null || raw === "") return { value: null, corrected: false, original: null }
  const key = foldKey(String(raw))
  const direct = index.get(key)
  if (direct) return { value: direct, corrected: direct !== raw, original: String(raw) }
  const alias = aliases[key]
  if (alias) {
    const resolved = index.get(foldKey(alias))
    if (resolved) return { value: resolved, corrected: true, original: String(raw) }
  }
  return { value: null, corrected: true, original: String(raw) }
}

export function normalizeStatus(entity: JornadaEntity, raw: string | null | undefined): NormalizationResult {
  const index = entity === "entrega" ? INDEXES.entregaStatus : INDEXES.atividadeStatus
  return normalizeAgainst(raw, index, STATUS_ALIASES)
}

export function normalizePrioridade(entity: JornadaEntity, raw: string | null | undefined): NormalizationResult {
  const index = entity === "entrega" ? INDEXES.entregaPrioridade : INDEXES.atividadePrioridade
  return normalizeAgainst(raw, index)
}

export function statusOptions(entity: JornadaEntity): readonly string[] {
  return entity === "entrega" ? ENTREGA_STATUS : ATIVIDADE_STATUS
}

export function prioridadeOptions(entity: JornadaEntity): readonly string[] {
  return entity === "entrega" ? ENTREGA_PRIORIDADE : ATIVIDADE_PRIORIDADE
}

/** Progress implied by a status, used when a row has no explicit `avanco`. */
export function progressFromStatus(status: string | null | undefined): number | null {
  const key = foldKey(String(status ?? ""))
  if (!key) return null
  if (key === foldKey("Concluída")) return 100
  if (key === foldKey("Não iniciada") || key === foldKey("Prevista") || key === foldKey("Nova")) return 0
  return null
}

export function isClosedStatus(entity: JornadaEntity, status: string | null | undefined): boolean {
  const normalized = normalizeStatus(entity, status).value
  return normalized === "Concluída" || normalized === "Cancelada"
}
