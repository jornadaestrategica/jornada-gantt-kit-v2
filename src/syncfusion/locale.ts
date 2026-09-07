import { L10n } from "@syncfusion/ej2-base"
import { PT_BR_OFFSET_UNITS, type OffsetUnitLabels } from "../core/dependencies"

/**
 * Must stay identical to the `day`/`days` entries below: Syncfusion writes predecessor
 * offsets with these words and refuses a relation whose unit it cannot read back.
 */
export const OFFSET_UNITS: OffsetUnitLabels = PT_BR_OFFSET_UNITS

let registered = false
export function registerPortuguese(): void {
  if (registered) return
  L10n.load({
    "pt-BR": {
      gantt: {
        emptyRecord: "Nenhum item encontrado", taskName: "Título", startDate: "Início", endDate: "Término",
        duration: "Duração", progress: "Avanço", dependency: "Predecessoras", notes: "Descrição",
        resourceName: "Responsável", resourceID: "Responsável", taskId: "ID",
        generalTab: "Geral", customTab: "Outros campos", dependencyTab: "Predecessoras",
        resourcesTab: "Recursos", notesTab: "Descrição", editDialogTitle: "Detalhes da atividade",
        saveButton: "Salvar", cancelButton: "Cancelar", add: "Adicionar", edit: "Editar", delete: "Excluir",
        update: "Salvar", cancel: "Cancelar", search: "Buscar", expandAll: "Expandir tudo",
        collapseAll: "Recolher tudo", zoomIn: "Aproximar", zoomOut: "Afastar", zoomToFit: "Ajustar ao plano",
        excelExport: "Exportar Excel", pdfExport: "Exportar PDF", indent: "Indentar", outdent: "Desindentar",
        day: OFFSET_UNITS.singular, days: OFFSET_UNITS.plural, hour: "hora", hours: "horas", minute: "minuto", minutes: "minutos",
        taskInformation: "Detalhes da tarefa", addDialogTitle: "Nova tarefa",
        type: "Tipo", offset: "Defasagem", writeNotes: "Escreva uma descrição",
        baselineStartDate: "Início da linha de base", baselineEndDate: "Término da linha de base",
        deleteDependency: "Excluir vínculo", deleteTask: "Excluir tarefa",
        autoFit: "Ajustar esta coluna", autoFitAll: "Ajustar todas as colunas",
        sortAscending: "Ordem crescente", sortDescending: "Ordem decrescente",
        undo: "Desfazer", redo: "Refazer", columnChooser: "Colunas",
        prevTimeSpan: "Período anterior", nextTimeSpan: "Próximo período",
        criticalPath: "Caminho crítico", okText: "OK", confirmDelete: "Excluir o registro selecionado?",
      },
      grid: {
        EmptyRecord: "Nenhum item encontrado", EmptyDataSourceError: "Nenhum item",
        ChooseColumns: "Colunas", Columnchooser: "Colunas", Columns: "Colunas",
        Search: "Buscar", FilterButton: "Filtrar", ClearButton: "Limpar",
        OKButton: "OK", CancelButton: "Cancelar", SaveButton: "Salvar",
        Edit: "Editar", Delete: "Excluir", Add: "Adicionar", Update: "Salvar", Cancel: "Cancelar",
        SortAscending: "Ordem crescente", SortDescending: "Ordem decrescente", ClearSorting: "Limpar ordenação",
        FilterMenu: "Filtro", Filter: "Filtrar", Clear: "Limpar", SelectAll: "Selecionar tudo",
      },
      dropdowns: { noRecordsTemplate: "Nenhuma opção encontrada", actionFailureTemplate: "Não foi possível carregar as opções" },
    },
  })
  registered = true
}
