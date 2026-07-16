// Shared number formatting helpers
export const fmtPct = (v, digits = 2) =>
  v == null ? '—' : `${(v * 100).toFixed(digits)}%`

export const fmtDollar = (v) =>
  v == null ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const fmtBps = (v, digits = 1) =>
  v == null ? '—' : Number(v).toFixed(digits)

export const fmtRound = (v, digits = 2) =>
  v == null ? '—' : Number(v).toFixed(digits)

export const fmtAuto = (v) => {
  if (v == null) return '—'
  if (typeof v === 'string') return v
  return Number(v).toFixed(3)
}
