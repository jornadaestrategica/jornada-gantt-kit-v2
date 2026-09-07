import { ENTITY_ATIVIDADE, ENTITY_ENTREGA, qualify } from "./ids"
import type { AtividadeRow, AtividadeVinculoRow, JornadaSnapshot, ResultadoEntregaRow, Uuid } from "./schema"
import { resolveRefs, type JornadaSyncPlan } from "./sync-plan"
import type { JornadaContext, JornadaTransport } from "./adapter"

function newUuid(): string {
  const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (globalCrypto?.randomUUID) return globalCrypto.randomUUID()
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`
}

/**
 * Executes a sync plan against an in-memory copy of the Jornada tables.
 *
 * It is not a mock: it applies the plan in the same order, resolves the same `$ref`
 * placeholders and enforces the same NOT NULL and exclusivity checks the database
 * does. That makes the whole round trip — including temporary-id reconciliation —
 * testable and demonstrable with no Supabase connection, which is the point of
 * shipping this kit decoupled from Jornada.
 */
export class InMemoryJornadaTransport implements JornadaTransport {
  readonly presentationSupported = true
  private snapshot: JornadaSnapshot
  private readonly people = new Map<string, string>()

  constructor(snapshot: JornadaSnapshot) {
    this.snapshot = structuredClone(snapshot)
    for (const row of [...snapshot.atividades, ...snapshot.entregas]) {
      if (row.pessoa_id && row.pessoa_nome) this.people.set(row.pessoa_id, row.pessoa_nome)
    }
  }

  get state(): JornadaSnapshot {
    return structuredClone(this.snapshot)
  }

  async fetchSnapshot(): Promise<JornadaSnapshot> {
    const snapshot = structuredClone(this.snapshot)
    for (const row of [...snapshot.atividades, ...snapshot.entregas]) {
      if (row.pessoa_id && this.people.has(row.pessoa_id)) row.pessoa_nome = this.people.get(row.pessoa_id)
    }
    return snapshot
  }

  async applyPlan(_context: JornadaContext, plan: JornadaSyncPlan): Promise<{ idMap: Record<string, string> }> {
    const next = structuredClone(this.snapshot)
    const idMap: Record<string, string> = {}

    // 1. links first — nothing else can be blocked by a dangling vinculo
    const removedLinks = new Set(plan.deleteVinculos)
    next.vinculos = next.vinculos.filter((link) => !removedLinks.has(link.id))

    // 2. rows, children before parents (the plan is already ordered)
    const removedAtividades = new Set(plan.deleteAtividades)
    next.atividades = next.atividades.filter((row) => !removedAtividades.has(row.id))
    next.vinculos = next.vinculos.filter(
      (link) =>
        !removedAtividades.has(link.atividade_id) && !removedAtividades.has(link.predecessora_id ?? "\u0000"),
    )
    const removedEntregas = new Set(plan.deleteEntregas)
    next.entregas = next.entregas.filter((row) => !removedEntregas.has(row.id))
    for (const row of next.entregas) if (row.parent_id && removedEntregas.has(row.parent_id)) row.parent_id = null
    for (const row of next.atividades) {
      if (row.resultado_entrega_id && removedEntregas.has(row.resultado_entrega_id)) row.resultado_entrega_id = null
    }
    next.vinculos = next.vinculos.filter((link) => !removedEntregas.has(link.resultado_entrega_id ?? "\u0000"))

    // 3. inserts, parents before children
    for (const write of plan.insertEntregas) {
      const id: Uuid = write.id ?? newUuid()
      const values = resolveRefs(write.values, idMap) as Partial<ResultadoEntregaRow>
      next.entregas.push({
        id,
        plano_id: values.plano_id ?? null,
        titulo: values.titulo ?? "Entrega",
        tipo: values.tipo ?? "Entrega",
        parent_id: values.parent_id ?? null,
        status: values.status ?? "Nova",
        ordem: values.ordem ?? next.entregas.length,
        updated_at: new Date().toISOString(),
        ...values,
      } as ResultadoEntregaRow)
      idMap[write.ref] = qualify(ENTITY_ENTREGA, id)
    }

    for (const write of plan.insertAtividades) {
      const id: Uuid = write.id ?? newUuid()
      const values = resolveRefs(write.values, idMap) as Partial<AtividadeRow>
      if (!values.pessoa_id) throw new Error("tb_atividade.pessoa_id é NOT NULL.")
      next.atividades.push({
        id,
        titulo: values.titulo ?? "Atividade",
        plano_id: values.plano_id ?? null,
        resultado_entrega_id: values.resultado_entrega_id ?? null,
        pessoa_id: values.pessoa_id,
        status: values.status ?? "Prevista",
        dtinicio_previsto: values.dtinicio_previsto ?? null,
        dttermino_previsto: values.dttermino_previsto ?? null,
        updated_at: new Date().toISOString(),
        ...values,
      } as AtividadeRow)
      idMap[write.ref] = qualify(ENTITY_ATIVIDADE, id)
    }

    // 4. updates, with optimistic-lock checks
    for (const write of plan.updateEntregas) {
      const row = next.entregas.find((item) => item.id === write.id)
      if (!row) continue
      if (write.rowVersion && row.updated_at && write.rowVersion !== row.updated_at) {
        throw new Error(`A entrega "${row.titulo}" foi alterada por outra pessoa. Recarregue o plano antes de gravar.`)
      }
      Object.assign(row, resolveRefs(write.values, idMap))
      row.updated_at = new Date().toISOString()
    }
    for (const write of plan.updateAtividades) {
      const row = next.atividades.find((item) => item.id === write.id)
      if (!row) continue
      if (write.rowVersion && row.updated_at && write.rowVersion !== row.updated_at) {
        throw new Error(`A atividade "${row.titulo}" foi alterada por outra pessoa. Recarregue o plano antes de gravar.`)
      }
      Object.assign(row, resolveRefs(write.values, idMap))
      row.updated_at = new Date().toISOString()
    }

    // 5. ordering
    for (const item of plan.reorder) {
      const key = (resolveRefs({ $ref: item.ref }, idMap) as string | null) ?? null
      if (!key) continue
      if (item.entity === ENTITY_ENTREGA) {
        const row = next.entregas.find((candidate) => candidate.id === key)
        if (row) row.ordem = item.ordem
      }
    }

    // 6. links last, when both endpoints certainly exist
    for (const link of plan.upsertVinculos) {
      const atividadeId = resolveRefs({ $ref: link.atividadeRef }, idMap) as string
      const predecessoraId = link.predecessoraRef ? (resolveRefs({ $ref: link.predecessoraRef }, idMap) as string) : null
      const entregaId = link.resultadoEntregaRef
        ? (resolveRefs({ $ref: link.resultadoEntregaRef }, idMap) as string)
        : null
      if (Boolean(predecessoraId) === Boolean(entregaId)) {
        throw new Error("chk_vinculo_exclusivo: um vínculo precisa de exatamente uma predecessora.")
      }
      const existing = link.id ? next.vinculos.find((item) => item.id === link.id) : undefined
      const row: AtividadeVinculoRow = {
        id: link.id ?? newUuid(),
        atividade_id: atividadeId,
        predecessora_id: predecessoraId,
        resultado_entrega_id: entregaId,
        tipo_vinculo: link.tipo_vinculo,
        lag: link.lag,
      }
      if (existing) Object.assign(existing, row)
      else next.vinculos.push(row)
    }

    next.presentation = (next.presentation ?? []).filter((item) => !removedEntregas.has(item.entrega_id))
    for (const item of plan.presentation) {
      const entrega_id = resolveRefs({ $ref: item.ref }, idMap)
      if (typeof entrega_id !== "string" || !next.entregas.some((row) => row.id === entrega_id)) {
        throw new Error("Marco sem entrega correspondente.")
      }
      const { ref: _ref, ...fields } = item
      const existing = next.presentation.find((row) => row.entrega_id === entrega_id)
      if (existing) Object.assign(existing, fields)
      else next.presentation.push({ entrega_id, ...fields })
    }
    this.snapshot = next
    return { idMap }
  }

  async fetchResources() {
    return [...this.people].map(([id, name]) => ({ id, name }))
  }
}
