/**
 * Every date in the Gantt is a CIVIL date: a calendar day with no time and no zone.
 * The host stores timestamptz, so the boundary is the single place where an
 * off-by-one day can appear. Parsing and serialising both go through here.
 */

const DAY_MS = 86_400_000
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/

/** Canonical numeric key of a civil date. Local wall-clock fields only. */
export function civilKey(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
}

/** Local midnight of the same wall-clock day. */
export function startOfCivilDay(date: Date): Date {
  const next = new Date(date.getTime())
  next.setHours(0, 0, 0, 0)
  return next
}

export function addCivilDays(date: Date, days: number): Date {
  const next = startOfCivilDay(date)
  next.setDate(next.getDate() + days)
  return next
}

export function sameDate(a: Date | null | undefined, b: Date | null | undefined): boolean {
  if (!a || !b) return a == null && b == null
  return civilKey(a) === civilKey(b)
}

/**
 * Inclusive duration in days: a task that starts and ends on the same day lasts 1 day.
 * Milestones (duration 0) are handled by the caller, not here.
 */
export function inclusiveDuration(startDate: Date | null, endDate: Date | null): number | null {
  if (!startDate || !endDate) return null
  return Math.max(1, Math.round((civilKey(endDate) - civilKey(startDate)) / DAY_MS) + 1)
}

export function endFromDuration(startDate: Date, duration: number): Date {
  return addCivilDays(startDate, Math.max(1, Math.round(duration)) - 1)
}

/**
 * Reads a host value into a civil date without ever shifting the day.
 *
 * A bare `new Date("2026-04-08T00:00:00+00:00")` rendered in America/Sao_Paulo
 * yields 2026-04-07 — the exact defect the legacy Gantt worked around with
 * `String(value).slice(0, 10)`. We take the leading calendar day from the string
 * and rebuild it as a local civil date, so what the database says is what the
 * user sees.
 */
export function parseCivilDate(value: unknown): Date | null {
  if (value == null || value === "") return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : startOfCivilDay(value)
  if (typeof value === "number") return startOfCivilDay(new Date(value))
  if (typeof value !== "string") return null
  const match = ISO_DATE.exec(value.trim())
  if (!match) {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : startOfCivilDay(parsed)
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0)
}

/** Serialises a civil date as `YYYY-MM-DD`, which timestamptz columns accept safely. */
export function formatCivilDate(date: Date | null | undefined): string | null {
  if (!date) return null
  const year = String(date.getFullYear()).padStart(4, "0")
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

/**
 * Serialises at 12:00Z. Any client timezone from UTC-11 to UTC+12 renders the same
 * calendar day, so a round trip through timestamptz cannot drift.
 */
export function formatCivilTimestamp(date: Date | null | undefined): string | null {
  const iso = formatCivilDate(date)
  return iso ? `${iso}T12:00:00.000Z` : null
}

export interface WorkCalendar {
  /** Working weekday indexes, 0 = Sunday. Defaults to Monday..Friday. */
  workingDays?: number[]
  /** Non-working calendar days. */
  holidays?: Date[]
}

const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5]

export function isWorkingDay(date: Date, calendar: WorkCalendar = {}): boolean {
  const workingDays = calendar.workingDays ?? DEFAULT_WORKING_DAYS
  if (!workingDays.includes(date.getDay())) return false
  const key = civilKey(date)
  return !(calendar.holidays ?? []).some((holiday) => civilKey(holiday) === key)
}

export function nextWorkingDay(date: Date, calendar: WorkCalendar = {}): Date {
  let cursor = startOfCivilDay(date)
  for (let guard = 0; guard < 3650 && !isWorkingDay(cursor, calendar); guard += 1) {
    cursor = addCivilDays(cursor, 1)
  }
  return cursor
}

/** Inclusive count of working days between two civil dates. */
export function workingDaysBetween(start: Date, end: Date, calendar: WorkCalendar = {}): number {
  if (civilKey(end) < civilKey(start)) return 0
  let count = 0
  let cursor = startOfCivilDay(start)
  const last = civilKey(end)
  for (let guard = 0; guard < 36_500 && civilKey(cursor) <= last; guard += 1) {
    if (isWorkingDay(cursor, calendar)) count += 1
    cursor = addCivilDays(cursor, 1)
  }
  return count
}

/** Adds `days` working days, counting the start day itself as the first. */
export function addWorkingDays(start: Date, days: number, calendar: WorkCalendar = {}): Date {
  let cursor = nextWorkingDay(start, calendar)
  let remaining = Math.max(1, Math.round(days)) - 1
  for (let guard = 0; guard < 36_500 && remaining > 0; guard += 1) {
    cursor = nextWorkingDay(addCivilDays(cursor, 1), calendar)
    remaining -= 1
  }
  return cursor
}

export function minDate(dates: Array<Date | null | undefined>): Date | null {
  const valid = dates.filter((date): date is Date => date instanceof Date)
  if (!valid.length) return null
  return valid.reduce((best, current) => (civilKey(current) < civilKey(best) ? current : best))
}

export function maxDate(dates: Array<Date | null | undefined>): Date | null {
  const valid = dates.filter((date): date is Date => date instanceof Date)
  if (!valid.length) return null
  return valid.reduce((best, current) => (civilKey(current) > civilKey(best) ? current : best))
}
