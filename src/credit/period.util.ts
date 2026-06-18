/**
 * Utilidades de período para el scoring. Los períodos son meses calendario
 * completos en COT; `periodEnd` es EXCLUSIVO (primer día del mes siguiente al
 * último mes a evaluar). Ver DISEÑO_SCORING_CREDITO §3.
 */

const COT_OFFSET_MS = 5 * 60 * 60 * 1000

export function monthIndexOfYmd(ymd: string): number {
  const [year, month] = ymd.split('-').map(Number)
  return year * 12 + (month - 1)
}

export function dayOfYmd(ymd: string): number {
  return Number(ymd.split('-')[2])
}

export function monthStartFromIndex(idx: number): string {
  const year = Math.floor(idx / 12)
  const month = (idx % 12) + 1
  return `${year}-${String(month).padStart(2, '0')}-01`
}

/**
 * Primer día del primer mes COMPLETO en COT a partir de un timestamp ISO. Si el
 * dato cae el día 1, ese mismo mes; si cae a mitad de mes, el mes siguiente
 * (ese mes está incompleto).
 */
export function firstCompleteMonthStart(iso: string): string {
  const cot = new Date(new Date(iso).getTime() - COT_OFFSET_MS)
  const year = cot.getUTCFullYear()
  const month = cot.getUTCMonth() // 0-based
  const day = cot.getUTCDate()
  const idx = year * 12 + month + (day === 1 ? 0 : 1)
  return monthStartFromIndex(idx)
}

/** Índice del mes en curso en COT (su primer día es el tope exclusivo válido). */
export function currentMonthIndexCot(nowMs: number): number {
  const cot = new Date(nowMs - COT_OFFSET_MS)
  return cot.getUTCFullYear() * 12 + cot.getUTCMonth()
}

export interface PeriodValidationError {
  code: string
  message: string
}

/**
 * Valida meses completos + no incluye el mes en curso. Devuelve el error (o
 * null) y el número de meses del período pedido.
 */
export function validateWholeMonths(
  periodStart: string,
  periodEnd: string,
  nowMs: number,
): { error: PeriodValidationError | null, months: number } {
  if (dayOfYmd(periodStart) !== 1 || dayOfYmd(periodEnd) !== 1) {
    return { error: { code: 'periodNotWholeMonths', message: 'El período debe ser meses completos (día 01)' }, months: 0 }
  }
  const startIdx = monthIndexOfYmd(periodStart)
  const endIdx = monthIndexOfYmd(periodEnd)
  if (endIdx <= startIdx) {
    return { error: { code: 'periodEndBeforeStart', message: 'periodEnd debe ser posterior a periodStart' }, months: 0 }
  }
  if (endIdx > currentMonthIndexCot(nowMs)) {
    return { error: { code: 'periodIncludesCurrentMonth', message: 'El período no puede incluir el mes en curso' }, months: 0 }
  }
  return { error: null, months: endIdx - startIdx }
}
