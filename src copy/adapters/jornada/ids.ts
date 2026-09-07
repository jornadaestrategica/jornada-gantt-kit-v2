import type { TaskId } from "../../core/types"
import type { Uuid } from "./schema"

/**
 * Two host tables share one grid, so a bare uuid is not a safe row key: nothing stops
 * a deliverable and an activity from colliding, and on save the writer would have no
 * way to tell which table a row belongs to. Every id is therefore qualified with its
 * entity, and the qualifier survives the whole round trip.
 */

export type JornadaEntity = "entrega" | "atividade"

export const ENTITY_ENTREGA: JornadaEntity = "entrega"
export const ENTITY_ATIVIDADE: JornadaEntity = "atividade"

const SEPARATOR = ":"
const NEW_PREFIX = "new"

export interface ParsedId {
  entity: JornadaEntity
  /** Host primary key, or null while the row is still local. */
  key: Uuid | null
  isNew: boolean
  raw: TaskId
}

export function qualify(entity: JornadaEntity, key: Uuid): TaskId {
  return `${entity}${SEPARATOR}${key}`
}

export function entregaId(key: Uuid): TaskId {
  return qualify(ENTITY_ENTREGA, key)
}

export function atividadeId(key: Uuid): TaskId {
  return qualify(ENTITY_ATIVIDADE, key)
}

export function parseId(id: TaskId | null | undefined): ParsedId | null {
  if (!id) return null
  const parts = String(id).split(SEPARATOR)
  if (parts[0] === NEW_PREFIX) {
    const entity = parts[1] as JornadaEntity
    if (entity !== ENTITY_ENTREGA && entity !== ENTITY_ATIVIDADE) {
      return { entity: ENTITY_ATIVIDADE, key: null, isNew: true, raw: id }
    }
    return { entity, key: null, isNew: true, raw: id }
  }
  const entity = parts[0] as JornadaEntity
  if (entity !== ENTITY_ENTREGA && entity !== ENTITY_ATIVIDADE) return null
  return { entity, key: parts.slice(1).join(SEPARATOR) || null, isNew: false, raw: id }
}

export function entityOf(id: TaskId | null | undefined): JornadaEntity | null {
  return parseId(id)?.entity ?? null
}

export function isEntrega(id: TaskId | null | undefined): boolean {
  return entityOf(id) === ENTITY_ENTREGA
}

export function isAtividade(id: TaskId | null | undefined): boolean {
  return entityOf(id) === ENTITY_ATIVIDADE
}

/**
 * Host key for a row that already exists. Returns null for local rows, which is the
 * caller's signal to resolve the temporary id through the save-time id map first.
 */
export function hostKey(id: TaskId | null | undefined): Uuid | null {
  const parsed = parseId(id)
  return parsed && !parsed.isNew ? parsed.key : null
}

/** Temporary id for a row created in the browser: `new:atividade:<local>`. */
export function temporaryId(entity: JornadaEntity, local: string): TaskId {
  return `${NEW_PREFIX}${SEPARATOR}${entity}${SEPARATOR}${local}`
}

export function isTemporaryId(id: TaskId | null | undefined): boolean {
  return String(id ?? "").startsWith(`${NEW_PREFIX}${SEPARATOR}`)
}

/**
 * Resolves a possibly-temporary id to a host key using the map returned by `save`.
 * Throws rather than writing a dangling foreign key — a null FK that should have
 * pointed somewhere is far more expensive to unpick later than a failed save now.
 */
export function resolveHostKey(id: TaskId, idMap: Record<string, string>): Uuid {
  const mapped = idMap[id]
  if (mapped) {
    const parsed = parseId(mapped)
    return parsed?.key ?? mapped
  }
  const key = hostKey(id)
  if (!key) {
    throw new Error(`Não foi possível resolver a chave da linha "${id}": nenhum id definitivo foi devolvido pelo Jornada.`)
  }
  return key
}
