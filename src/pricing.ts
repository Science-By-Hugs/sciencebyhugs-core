// Vendor pricing & profit (2026-10-27). Shared math for Core (never used by Nexus).
// Margin = profit / customer price. Markup = profit / vendor cost.

export type ProfitFigures = {
  profit: number | null
  marginPct: number | null
  markupPct: number | null
}

const round1 = (value: number) => Math.round(value * 10) / 10

export function profitFigures(price: number | string | null | undefined, cost: number | string | null | undefined): ProfitFigures {
  const p = price === null || price === undefined || price === '' ? NaN : Number(price)
  const c = cost === null || cost === undefined || cost === '' ? NaN : Number(cost)
  if (!Number.isFinite(p) || !Number.isFinite(c)) return { profit: null, marginPct: null, markupPct: null }
  const profit = Math.round((p - c) * 100) / 100
  return {
    profit,
    marginPct: p > 0 ? round1((profit / p) * 100) : null,
    markupPct: c > 0 ? round1((profit / c) * 100) : null,
  }
}

export const pct = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(1) + '%'
