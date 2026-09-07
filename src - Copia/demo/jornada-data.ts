import type { JornadaSnapshot } from "../adapters/jornada/schema"

const PLANO = "00000000-0000-4000-8000-00000000p001"
const PESSOA_ANA = "00000000-0000-4000-8000-0000000pe01"
const PESSOA_BRUNO = "00000000-0000-4000-8000-0000000pe02"
const PESSOA_CARLA = "00000000-0000-4000-8000-0000000pe03"

const E = (suffix: string): string => `00000000-0000-4000-8000-00000000e${suffix}`
const A = (suffix: string): string => `00000000-0000-4000-8000-00000000a${suffix}`
const V = (suffix: string): string => `00000000-0000-4000-8000-00000000v${suffix}`

/**
 * A plan shaped exactly like Jornada stores one: deliverables nested through
 * `parent_id`, activities attached through `resultado_entrega_id`, and links held in
 * tb_atividade_vinculo with one predecessor column populated at a time.
 *
 * It includes the awkward cases on purpose — an activity with no deliverable, a
 * deliverable used as a predecessor, an accented status that needs folding, and a
 * deliverable rendered as a milestone — so the demo exercises the real edge cases
 * rather than a happy path.
 */
export const jornadaDemoSnapshot: JornadaSnapshot = {
  entregas: [
    {
      id: E("001"),
      plano_id: PLANO,
      titulo: "Plataforma de Governança de TI",
      tipo: "Resultado",
      parent_id: null,
      status: "Em Sprint",
      prioridade: "0-Critica",
      ordem: 0,
      eh_agrupador: true,
      pessoa_id: PESSOA_ANA,
      pessoa_nome: "Ana Ribeiro",
      updated_at: "2026-08-20T13:00:00.000Z",
    },
    {
      id: E("002"),
      plano_id: PLANO,
      titulo: "Módulo de Cadastro Unificado",
      tipo: "Entrega",
      parent_id: E("001"),
      status: "Pronta",
      prioridade: "1-Muito Alta",
      ordem: 0,
      eh_agrupador: true,
      story_points: 21,
      pessoa_id: PESSOA_BRUNO,
      pessoa_nome: "Bruno Antunes",
      criterios_aceite: "Cadastro validado com dados do sistema legado e trilha de auditoria ativa.",
      updated_at: "2026-08-21T09:30:00.000Z",
    },
    {
      id: E("003"),
      plano_id: PLANO,
      titulo: "Autenticação e Perfis de Acesso",
      tipo: "Feature",
      parent_id: E("002"),
      status: "Refinada",
      prioridade: "2-Alta",
      ordem: 1,
      story_points: 8,
      pessoa_id: PESSOA_CARLA,
      pessoa_nome: "Carla Menezes",
      updated_at: "2026-08-21T09:31:00.000Z",
    },
    {
      id: E("004"),
      plano_id: PLANO,
      titulo: "Publicação em produção",
      tipo: "Entrega",
      parent_id: E("001"),
      status: "Nova",
      prioridade: "1-Muito Alta",
      ordem: 1,
      exibir_marco: true,
      pessoa_id: PESSOA_ANA,
      pessoa_nome: "Ana Ribeiro",
      updated_at: "2026-08-21T09:32:00.000Z",
    },
  ],

  atividades: [
    {
      id: A("001"),
      titulo: "Levantar regras do cadastro legado",
      plano_id: PLANO,
      resultado_entrega_id: E("002"),
      pessoa_id: PESSOA_BRUNO,
      pessoa_nome: "Bruno Antunes",
      // Deliberately mis-accented, to prove the normalizer folds it on load.
      status: "Concluido",
      prioridade: "2-Alta",
      avanco: 100,
      peso: 1,
      esforco: 24,
      dtinicio_previsto: "2026-09-01T00:00:00+00:00",
      dttermino_previsto: "2026-09-05T00:00:00+00:00",
      dtinicio: "2026-09-01T00:00:00+00:00",
      dttermino: "2026-09-08T00:00:00+00:00",
      updated_at: "2026-09-08T18:00:00.000Z",
    },
    {
      id: A("002"),
      titulo: "Modelar tabelas do cadastro unificado",
      plano_id: PLANO,
      resultado_entrega_id: E("002"),
      pessoa_id: PESSOA_CARLA,
      pessoa_nome: "Carla Menezes",
      status: "Em andamento",
      prioridade: "1-Muito Alta",
      avanco: 60,
      peso: 2,
      esforco: 40,
      dtinicio_previsto: "2026-09-08T00:00:00+00:00",
      dttermino_previsto: "2026-09-18T00:00:00+00:00",
      updated_at: "2026-09-02T11:00:00.000Z",
    },
    {
      id: A("003"),
      titulo: "Implementar tela de perfis",
      plano_id: PLANO,
      resultado_entrega_id: E("003"),
      pessoa_id: PESSOA_CARLA,
      pessoa_nome: "Carla Menezes",
      status: "Não iniciada",
      prioridade: "2-Alta",
      avanco: 0,
      peso: 1,
      esforco: 32,
      dtinicio_previsto: "2026-09-21T00:00:00+00:00",
      dttermino_previsto: "2026-10-02T00:00:00+00:00",
      updated_at: "2026-09-02T11:05:00.000Z",
    },
    {
      id: A("004"),
      titulo: "Testes integrados de acesso",
      plano_id: PLANO,
      resultado_entrega_id: E("003"),
      pessoa_id: PESSOA_BRUNO,
      pessoa_nome: "Bruno Antunes",
      status: "Prevista",
      prioridade: "3-Média",
      avanco: 0,
      peso: 1,
      esforco: 16,
      dtinicio_previsto: "2026-10-05T00:00:00+00:00",
      dttermino_previsto: "2026-10-09T00:00:00+00:00",
      updated_at: "2026-09-02T11:06:00.000Z",
    },
    {
      id: A("005"),
      titulo: "Preparar plano de implantação",
      plano_id: PLANO,
      resultado_entrega_id: E("004"),
      pessoa_id: PESSOA_ANA,
      pessoa_nome: "Ana Ribeiro",
      status: "Prevista",
      prioridade: "1-Muito Alta",
      avanco: 0,
      peso: 1,
      esforco: 8,
      dtinicio_previsto: "2026-10-12T00:00:00+00:00",
      dttermino_previsto: "2026-10-16T00:00:00+00:00",
      updated_at: "2026-09-02T11:07:00.000Z",
    },
    {
      // Personal-kanban activity: plano_id and resultado_entrega_id are both null,
      // which the schema allows and the Gantt must render at the root.
      id: A("006"),
      titulo: "Revisar contrato de suporte da ferramenta",
      plano_id: null,
      resultado_entrega_id: null,
      pessoa_id: PESSOA_ANA,
      pessoa_nome: "Ana Ribeiro",
      status: "Em andamento",
      prioridade: "4-Baixa",
      avanco: 30,
      esforco: 4,
      dtinicio_previsto: "2026-09-14T00:00:00+00:00",
      dttermino_previsto: "2026-09-16T00:00:00+00:00",
      updated_at: "2026-09-02T11:08:00.000Z",
    },
  ],

  vinculos: [
    { id: V("001"), atividade_id: A("002"), predecessora_id: A("001"), resultado_entrega_id: null, tipo_vinculo: "FS", lag: 0 },
    { id: V("002"), atividade_id: A("003"), predecessora_id: A("002"), resultado_entrega_id: null, tipo_vinculo: "FS", lag: 2 },
    { id: V("003"), atividade_id: A("004"), predecessora_id: A("003"), resultado_entrega_id: null, tipo_vinculo: "FS", lag: 0 },
    // A deliverable as predecessor: resultado_entrega_id is populated instead.
    { id: V("004"), atividade_id: A("005"), predecessora_id: null, resultado_entrega_id: E("003"), tipo_vinculo: "FS", lag: 1 },
  ],

  sprints: [
    { id: "sprint-24", titulo: "Sprint 24", dtinicio: "2026-09-01", dttermino: "2026-09-12" },
    { id: "sprint-25", titulo: "Sprint 25", dtinicio: "2026-09-15", dttermino: "2026-09-26" },
    { id: "sprint-26", titulo: "Sprint 26", dtinicio: "2026-09-29", dttermino: "2026-10-10" },
  ],

  feriados: [
    { data: "2026-09-07", descricao: "Independência" },
    { data: "2026-10-12", descricao: "Padroeira do Brasil" },
  ],
}

export const demoContext = { planoId: PLANO, pessoaId: PESSOA_ANA }
