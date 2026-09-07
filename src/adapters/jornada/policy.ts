import { ALLOW, deny, type GanttDomainPolicy, type PolicyContext, type PolicyDecision } from "../../core/policy"
import type { DependencyType, GanttTask } from "../../core/types"
import { ENTITY_ATIVIDADE, ENTITY_ENTREGA, entityOf, type JornadaEntity } from "./ids"

export interface JornadaPolicyOptions {
  /**
   * When an activity is indented under another activity — impossible in the schema,
   * because tb_atividade has no parent_id — silently adopt the target's deliverable
   * instead of refusing. Off by default: a refusal the user can read beats a move
   * they did not ask for.
   */
  redirectActivityIndent?: boolean
  /** Maximum deliverable nesting depth (Entrega -> Feature -> Estória is 3). */
  maxDeliverableDepth?: number
  /** Allow a deliverable to be a predecessor. The schema supports it; some plans forbid it. */
  allowDeliverablePredecessor?: boolean
}

function entityFor(task: GanttTask): JornadaEntity {
  return (task.entityType as JornadaEntity | undefined) ?? entityOf(task.id) ?? ENTITY_ATIVIDADE
}

/**
 * Encodes the three foreign keys that actually constrain the Jornada Gantt:
 *
 *  - tb_atividade.resultado_entrega_id  -> an activity's only possible parent is a
 *    deliverable; tb_atividade has no parent_id, so activities never nest.
 *  - tb_resultado_entrega.parent_id     -> a deliverable nests only under a deliverable.
 *  - tb_atividade_vinculo.atividade_id  -> NOT NULL, so the successor of a link is
 *    always an activity; a deliverable may only ever be a predecessor, and the
 *    chk_vinculo_exclusivo check means exactly one predecessor column is populated.
 *
 * Enforcing this in the renderer is what stops the user from composing a plan the
 * database will reject halfway through a save.
 */
export function createJornadaPolicy(options: JornadaPolicyOptions = {}): GanttDomainPolicy {
  const maxDeliverableDepth = options.maxDeliverableDepth ?? 10
  const allowDeliverablePredecessor = options.allowDeliverablePredecessor ?? true

  return {
    name: "jornada",
    defaultDependencyType: "FS",
    maxDepth: maxDeliverableDepth,

    canBeChildOf(task: GanttTask, parent: GanttTask | null, context: PolicyContext): PolicyDecision {
      const child = entityFor(task)

      if (parent == null) {
        // Both tables allow a null parent: a root deliverable, or a personal-kanban
        // activity with resultado_entrega_id = null.
        return ALLOW
      }

      const parentEntity = entityFor(parent)

      // A milestone marks a moment, not a container: nothing hangs beneath it. Checked
      // before the entity rules, which would otherwise let an activity in.
      if (parent.kind === "milestone" || (parent.showMilestone === true && parent.isSummary === false)) {
        return deny("PARENT_IS_MILESTONE", `"${parent.title}" é um marco e não agrupa outros itens.`)
      }

      if (child === ENTITY_ATIVIDADE) {
        if (parentEntity === ENTITY_ENTREGA) return ALLOW
        if (options.redirectActivityIndent) {
          const grandParentId = parent.parentId
          const grandParent = grandParentId ? context.index.byId.get(grandParentId) : undefined
          if (grandParent && entityFor(grandParent) === ENTITY_ENTREGA) {
            return { allowed: true, redirectParentId: grandParent.id }
          }
          return { allowed: true, redirectParentId: null }
        }
        return deny(
          "ACTIVITY_UNDER_ACTIVITY",
          `"${task.title}" só pode ficar sob uma entrega: no Jornada a atividade é sempre folha e não recebe itens aninhados.`,
        )
      }

      if (parentEntity === ENTITY_ATIVIDADE) {
        return deny(
          "DELIVERABLE_UNDER_ACTIVITY",
          `"${task.title}" é uma entrega e não pode ficar sob a atividade "${parent.title}". Atividades são sempre folhas.`,
        )
      }

      const depth = (context.index.depth.get(parent.id) ?? 0) + 1
      if (depth >= maxDeliverableDepth) {
        return deny(
          "MAX_DELIVERABLE_DEPTH",
          `A hierarquia de entregas aceita no máximo ${maxDeliverableDepth} níveis.`,
        )
      }
      return ALLOW
    },

    canLink(predecessor: GanttTask, successor: GanttTask, _type: DependencyType): PolicyDecision {
      if (entityFor(successor) !== ENTITY_ATIVIDADE) {
        return deny(
          "SUCCESSOR_MUST_BE_ACTIVITY",
          `"${successor.title}" é uma entrega. No Jornada o vínculo é gravado em tb_atividade_vinculo.atividade_id, que só aceita atividades como sucessoras — inverta o sentido da ligação.`,
        )
      }
      if (entityFor(predecessor) === ENTITY_ENTREGA && !allowDeliverablePredecessor) {
        return deny(
          "DELIVERABLE_PREDECESSOR_DISABLED",
          `Vínculos a partir de entregas estão desativados neste plano.`,
        )
      }
      return ALLOW
    },

    canDelete(task: GanttTask, context: PolicyContext): PolicyDecision {
      if (entityFor(task) === ENTITY_ENTREGA) {
        const children = context.index.childrenOf.get(task.id) ?? []
        const activities = children.filter((child) => entityFor(child) === ENTITY_ATIVIDADE)
        if (activities.length) {
          return deny(
            "DELIVERABLE_HAS_ACTIVITIES",
            `"${task.title}" ainda tem ${activities.length} atividade(s) vinculada(s). Mova ou exclua as atividades antes de remover a entrega.`,
          )
        }
      }
      return ALLOW
    },

    lockedFieldsFor(task: GanttTask, _context: PolicyContext): string[] {
      const entity = entityFor(task)
      if (entity === ENTITY_ENTREGA) {
        // Deliverables carry no date columns; their bar is a rollup of the activities
        // beneath them, and wsjf_score is GENERATED ALWAYS in the database.
        const locked = ["wsjf_score", "startDate", "endDate", "duration", "progress"]
        return locked
      }
      return ["businessType", "isSummary", "showMilestone", "milestoneDate", "milestoneLabel"]
    },
  }
}

export const jornadaPolicy = createJornadaPolicy()
