export interface Notice {
  tone: "info" | "warning" | "error" | "success"
  message: string
  details?: string[]
}

/** Never surfaces "[object Object]": digs a readable sentence out of whatever was thrown. */
export function errorMessage(error: unknown): string {
  if (error == null) return "Ocorreu um erro inesperado."
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  if (Array.isArray(error)) {
    const parts = error.map(errorMessage).filter(Boolean)
    return parts.length ? parts.join(" ") : "Ocorreu um erro inesperado."
  }
  if (typeof error === "object") {
    const record = error as Record<string, unknown>
    // Syncfusion's own failureCases array sometimes reaches us as {0: "msg", 1: "msg"},
    // not a real array: Object.assign([...]) into {} keeps the indices but drops the prototype.
    const keys = Object.keys(record)
    if (keys.length && keys.every((key, index) => key === String(index))) {
      return errorMessage(keys.map((key) => record[key]))
    }
    for (const key of ["message", "error", "reason", "statusText", "value"]) {
      const value = record[key]
      if (typeof value === "string" && value.trim()) return value
      if (value && typeof value === "object") {
        const nested = errorMessage(value)
        if (nested && nested !== "Ocorreu um erro inesperado.") return nested
      }
    }
  }
  const text = String(error)
  return text === "[object Object]" ? "Ocorreu um erro inesperado." : text
}

/** Syncfusion's own one-time config self-check, not a data or persistence failure. */
export function tierFormatNotice(message: string): Notice | null {
  const match = /(top|bottom)\s*tier format is invalid/i.exec(message)
  if (!match) return null
  const tier = match[1].toLowerCase() === "top" ? "superior" : "inferior"
  return {
    tone: "warning",
    message: `O componente informou um formato inválido na escala ${tier} do período.`,
    details: [message, "A visualização da escala pode estar incorreta. Os dados do cronograma não foram alterados."],
  }
}

export function errorDetails(message: string): string[] {
  if (/invalid relation|Predecessor field|predecessora/i.test(message)) {
    return [
      "Confira a coluna Predecessoras: use a linha real da tarefa, seguida de FS, SS, FF ou SF e atraso opcional.",
      "Exemplo: 2FS+2 dias. Linhas de marco espelhado não podem ser usadas como predecessoras.",
    ]
  }
  if (message === "Ocorreu um erro inesperado.") {
    return ["Recarregue o cronograma e tente novamente. Se repetir, informe qual célula ou vínculo estava sendo editado."]
  }
  return []
}
