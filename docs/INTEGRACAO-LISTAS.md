# Integrar pessoas, situações, prioridades e tipos

Quatro listas alimentam a interface. Todas vêm do host — o kit não tem tabela própria.

| Lista | De onde vem | Contrato |
|---|---|---|
| Pessoas | `tb_pessoa` | `JornadaTransport.fetchResources` |
| Situações | CHECK das tabelas | `JornadaGanttAdapter.editOptions("status", entidade)` |
| Prioridades | CHECK das tabelas | `JornadaGanttAdapter.editOptions("priority", entidade)` |
| Tipos de entrega | CHECK de `tipo` | `entregaTypes` em `adapters/jornada/catalog.ts` |

## 1. Pessoas

```ts
async fetchResources(ctx: JornadaContext): Promise<GanttResource[]> {
  const { data } = await supabase
    .from("tb_pessoa")
    .select("id, nome")
    .eq("ativo", true)          // não ofereça quem não pode receber atribuição
    .order("nome")
  return (data ?? []).map((row) => ({ id: row.id, name: row.nome }))
}
```

Regras que o kit já aplica:

- A coluna Responsável grava **`pessoa_id`**, nunca o nome. O nome é só exibição.
- Um `pessoa_id` fora da lista é **recusado** antes de entrar na sessão.
- Sem lista, a coluna não abre para edição — em vez de aceitar um valor inválido.
- Depois de gravar, o nome é relido do host: quem manda é `tb_pessoa`.

**Escala.** `fetchResources` carrega a lista inteira. Acima de algumas centenas de
pessoas, restrinja ao escopo do plano (unidade, equipe) — a lista é para escolher um
responsável, não para navegar o cadastro inteiro.

## 2. Situações e prioridades

Já implementadas em `adapters/jornada/status.ts`, espelhando os CHECK:

```
Atividade  Prevista · Não iniciada · Em andamento · Concluída · Bloqueada · Cancelada
Entrega    Nova · Refinada · Pronta · Em Sprint · Concluída · Cancelada
Prioridade 0-Crítica · 1-Muito Alta · 2-Alta · 3-Média · 4-Baixa · 5-Muito Baixa
```

**As listas são diferentes por entidade**, e é isso que o editor precisa respeitar: uma
entrega nunca deve receber a lista da atividade. O normalizador dobra acento, caixa e
apelidos antigos na carga, então dados legados continuam abrindo.

Se as listas passarem a viver no banco (uma tabela de domínio), troque
`statusOptions`/`prioridadeOptions` por uma consulta e mantenha a mesma assinatura.
`editOptions` continua sendo o único ponto que a interface conhece.

## 3. Tipos de entrega

`entregaTypes` alimenta a coluna Tipo e o menu de criação.

> ⚠️ **`Grupo` exige migração antes de gravar em produção.**
>
> O tipo foi adicionado a pedido, para que o agrupador seja reconhecível. Ele **não faz
> parte do CHECK original** de `tb_resultado_entrega.tipo`: sem a migração abaixo, criar
> um grupo passa por toda a validação local e **falha na gravação**.
>
> ```sql
> ALTER TABLE tb_resultado_entrega DROP CONSTRAINT tb_resultado_entrega_tipo_check;
> ALTER TABLE tb_resultado_entrega ADD CONSTRAINT tb_resultado_entrega_tipo_check
>   CHECK (tipo IN ('Resultado','Grupo','Entrega','Sprint Goal','Feature',
>                   'Estoria','Bug','Melhoria','Debito Tecnico'));
> ```
>
> Se preferir não migrar, remova `Grupo` de `entregaTypes` e volte o menu de criação
> para `businessType: "Entrega"` — o agrupamento continua funcionando por `eh_agrupador`.

O mesmo vale para a prioridade acentuada (`0-Crítica`, `3-Média`) na tabela de entregas,
que você já indicou que ajustaria na aplicação.

## 4. Onde ligar tudo

```ts
const transport: JornadaTransport = {
  fetchSnapshot,     // entregas + atividades + vínculos
  applyPlan,         // transação única
  fetchResources,    // pessoas
  presentationSupported: false,
}

<GanttPanel transport={transport} context={{ planoId, pessoaId }} storageKey={`gantt:${planoId}`} />
```

Nada além disso é necessário: a interface descobre as listas pelo adapter, e o adapter
descobre os dados pelo transporte.
