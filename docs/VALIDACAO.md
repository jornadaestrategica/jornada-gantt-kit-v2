# Resultado da validação — v11

- **133 testes aprovados.**
- **Verificação de tipos sem erros** com `npm run typecheck`.

## Correções funcionais desta rodada

- Escala **Geral**: seleciona o ajuste ao projeto e chama `fitToProject()` após o bind.
- Agendamento **manual por padrão**, com modos **Manual**, **Automático** e
  **Por atividade** usando `taskFields.manual`.
- Conexões criadas em modo Automático/Por atividade capturam o próximo cálculo nativo
  do Syncfusion.
- `recordClick` foi removido; edição em clique único usa o evento documentado
  `cellSelected`.
- A coluna de predecessoras aceita valor nulo sem quebrar a renderização.
- Comandos de edição da toolbar nativa aparecem apenas durante a edição.
- Exclusão exige confirmação no banner do wrapper.
- Mensagens redundantes de salvar foram removidas.
- Erros genéricos e erros de predecessora agora trazem uma orientação de próximo passo.
- PDF e Excel são chamados explicitamente pelo wrapper.
- Predecessoras exibem EAP/relação compactos, mantendo o valor nativo editável.
- O seletor de colunas expõe colunas ocultas como **ID origem** e **Manual**.
- Atividades atrasadas ficam destacadas e a cor da atividade chega à barra.

## Erros de compilação corrigidos nesta rodada

- `contextMenuItems`: a propriedade é união de arrays; a lista mista exige cast.
- `onClick={save}`: além do erro de tipo, entregava o evento do React ao parâmetro de
  continuação — quebraria em execução após uma gravação bem-sucedida.
- `SyncfusionTask` importado de um módulo que não o exporta.
- Lista de feriados montada com predicado incompatível.

Cada um virou teste de regressão, incluindo uma verificação genérica que reprova
qualquer manipulador com argumento ligado diretamente a `onClick`.

## Mantido das rodadas anteriores

Trocar apenas o responsável não altera nenhuma data ou duração; semana de sete dias
alinhada ao núcleo; feriados fora do cálculo; grupo automático ao indentar; ciclo de
vida local; gravações sucessivas; rótulos; marcas por campo; ícones padrão.

## Validação executada

```sh
npm test
npm run typecheck
```
