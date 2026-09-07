# Integração, carga e sincronização

## 1. Contrato do transporte

O kit não conhece Supabase, SQL nem HTTP. O host implementa uma interface:

```ts
interface JornadaTransport {
  fetchSnapshot(ctx): Promise<JornadaSnapshot>
  applyPlan(ctx, plan): Promise<{ idMap: Record<string, string> }>
  fetchResources?(ctx): Promise<GanttResource[]>
  readonly presentationSupported?: boolean
}
```

`InMemoryJornadaTransport` implementa esse contrato aplicando o plano na mesma ordem e
cobrando os mesmos `NOT NULL` e `CHECK` do banco. É o que permite testar a ida e volta
completa sem conexão.

## 2. Carga

`fetchSnapshot` devolve as três tabelas, mais o que for opcional:

```ts
interface JornadaSnapshot {
  entregas: ResultadoEntregaRow[]      // tb_resultado_entrega
  atividades: AtividadeRow[]           // tb_atividade
  vinculos: AtividadeVinculoRow[]      // tb_atividade_vinculo
  sprints?: SprintRow[]                // viram marcadores de início/fim
  feriados?: Array<{ data, descricao }>
  annotations?: Array<{ date, label, cssClass }>   // qualquer anotação temporal
  presentation?: Array<{ entrega_id, milestoneLabel, milestoneDate }>
}
```

O mapeamento produz uma lista plana de linhas:

| Origem | Vira |
|---|---|
| `tb_resultado_entrega.parent_id` | `parentId` de uma entrega |
| `tb_atividade.resultado_entrega_id` | `parentId` de uma atividade |
| `tb_atividade_vinculo` | dependências |
| `eh_agrupador` / `exibir_marco` | `isSummary` / `showMilestone` |
| `tipo` | `businessType` |

`resolveResources` alimenta a lista de responsáveis; sem ela a coluna não abre para edição.

### Dados fora do padrão

Nada derruba o gráfico; tudo vira diagnóstico visível na carga:

| Situação | Tratamento |
|---|---|
| `parent_id` inexistente | linha vai para a raiz · `ORPHAN_ENTREGA` |
| `resultado_entrega_id` inexistente | atividade vai para a raiz · `ORPHAN_ATIVIDADE` |
| ciclo em `parent_id` | ciclo quebrado, linhas preservadas |
| vínculo com as duas predecessoras | ignorado · `VINCULO_EXCLUSIVO_VIOLADO` |
| vínculo apontando para fora do plano | ignorado · `DANGLING_VINCULO` |
| status ou prioridade fora do `CHECK` | normalizado · `STATUS_NORMALIZED` |
| anotação sem data válida | ignorada · `INVALID_ANNOTATION_DATE` |

## 3. Identidades

Três identidades que não se misturam:

1. **Banco** — a chave primária.
2. **Sessão** — `entrega:<pk>`, `atividade:<pk>`; linhas novas usam `new:entrega:<local>`.
3. **Renderer** — número visual usado na coluna Predecessoras. O marco visual tem chave
   própria e nunca é ponta de vínculo.

O `idMap` devolvido pelo `applyPlan` deve usar a forma qualificada (`entrega:<uuid>`).

## 4. Ordem de gravação

`buildSyncPlan` devolve o plano já ordenado. Executar fora dessa ordem produz FK órfã:

```
1. deleteVinculos
2. deleteAtividades
3. deleteEntregas        mais profundas primeiro
4. insertEntregas        pais antes dos filhos
5. insertAtividades
6. updateEntregas / updateAtividades
7. reorder
8. upsertVinculos        as duas pontas já existem
```

Referências a linhas criadas no mesmo plano viajam como `{ "$ref": "new:entrega:x" }` e
são resolvidas após os inserts. Sem a chave definitiva, o kit **lança** em vez de gravar
`NULL`. `applyPlan` **precisa ser atômico**.

## 5. Ciclo de vida na sessão

| Na sessão | No plano de gravação |
|---|---|
| Criado + alterado | uma criação, com os valores finais |
| Criado + excluído | nada, nem seus vínculos locais |
| Existente + alterado + excluído | apenas a exclusão |
| Alterado e depois cancelado | nada |

Cancelar não conversa com o servidor: volta ao último estado carregado ou salvo.

## 6. Gravar várias vezes

Depois de cada gravação o adapter **relê** o plano e a sessão adota esse estado. Isso
importa porque o host tem colunas geradas, gatilhos e o fechamento automático de estória.
A releitura zera pendências, identificadores temporários e histórico de desfazer,
preservando seleção e expansão. Uma gravação que falha não altera a sessão.

## 7. Concorrência

Cada linha carrega `rowVersion` (`updated_at`). O transporte compara antes de escrever e
recusa quando a linha mudou nesse intervalo, em vez de sobrescrever. Um `idMap` incompleto
indica resultado incerto: o kit não afirma que houve reversão sem confirmação do transporte.

## 8. Marco e data adicional

O marco visual é derivado de `exibir_marco`; a entrega continua sendo **um** registro.
Rótulo e data específicos do marco só são gravados quando o transporte declara
`presentationSupported = true`, através de `plan.presentation`. Sem isso, os campos ficam
bloqueados e uma tentativa de gravá-los é recusada — não há nome de coluna presumido.

## 9. Regras validadas antes da gravação

- Atividade é folha; nada se aninha sob ela nem sob um marco.
- Até 10 níveis de agrupamento, recusado já na criação.
- Sucessora de vínculo é sempre atividade; predecessora pode ser entrega.
- Prioridade padronizada com acento nas duas tabelas; valores antigos são normalizados.
- Datas civis: leitura pelo dia de calendário, gravação ao meio-dia UTC na simulação.
  O transporte real deve confirmar essa convenção com o Jornada.

## 10. Transporte real

```ts
export class SupabaseJornadaTransport implements JornadaTransport {
  readonly presentationSupported = false   // true quando houver onde guardar

  async fetchSnapshot(ctx) { /* SELECT nas três tabelas por ctx.planoId */ }

  async applyPlan(ctx, plan) {
    // Preferência: uma RPC única, ex. func_gantt_apply_plan(plan jsonb)
    // -> atomicidade
    // -> resolve o reorder N+1 registrado no backlog
    // -> devolve { idMap: { "new:entrega:x": "entrega:<uuid>" } }
  }

  async fetchResources(ctx) { /* SELECT em tb_pessoa */ }
}
```
