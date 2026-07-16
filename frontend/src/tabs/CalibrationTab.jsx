import { useState, useEffect } from 'react'
import { api } from '../api.js'
import { fmtPct, fmtRound } from '../fmt.js'
import DataTable from '../components/DataTable.jsx'
import Spinner from '../components/Spinner.jsx'

// Python column names (drevenue, dexpense, capex, caprate, capspread, stdev*)
// match the Shiny calibration_table which uses (input_drev, input_dexp, …)
const diff = (v) => {
  if (v == null) return ''
  if (v < -0.0005) return 'text-red-600 font-medium'
  if (v >  0.0005) return 'text-green-700 font-medium'
  return ''
}

const COLS = [
  { key: 'proptype',            label: 'Property Type' },

  // ── Revenue ──────────────────────────────────────────────────────────────
  { key: 'drevenue',            label: 'Input Rev CAGR',       fmt: v => fmtPct(v, 2), align: 'right' },
  { key: 'realized_rev_cagr',   label: 'Realized Rev CAGR',   fmt: v => fmtPct(v, 2), align: 'right' },
  { key: 'rev_cagr_diff',       label: 'Rev Δ',                fmt: v => fmtPct(v, 2), align: 'right',
    cellClass: diff },

  // ── Expense ───────────────────────────────────────────────────────────────
  { key: 'dexpense',            label: 'Input Exp CAGR',       fmt: v => fmtPct(v, 2), align: 'right' },
  { key: 'realized_exp_cagr',   label: 'Realized Exp CAGR',   fmt: v => fmtPct(v, 2), align: 'right' },
  { key: 'exp_cagr_diff',       label: 'Exp Δ',                fmt: v => fmtPct(v, 2), align: 'right',
    cellClass: diff },

  // ── CapEx ─────────────────────────────────────────────────────────────────
  { key: 'capex',               label: 'Input CapEx',          fmt: v => fmtPct(v, 2), align: 'right' },
  { key: 'realized_capex',      label: 'Realized CapEx',      fmt: v => fmtPct(v, 2), align: 'right' },
  { key: 'capex_diff',          label: 'CapEx Δ',              fmt: v => fmtPct(v, 2), align: 'right',
    cellClass: diff },

  // ── Cap Rate ──────────────────────────────────────────────────────────────
  { key: 'caprate',             label: 'Input Cap Rate',       fmt: v => fmtPct(v, 2), align: 'right' },
  { key: 'realized_start_cap',  label: 'Realized Start Cap',  fmt: v => fmtPct(v, 2), align: 'right' },
  { key: 'realized_exit_cap',   label: 'Realized Exit Cap',   fmt: v => fmtPct(v, 2), align: 'right' },
  { key: 'exit_cap_diff',       label: 'Exit Cap Δ',           fmt: v => fmtPct(v, 2), align: 'right',
    cellClass: diff },

  // ── Volatility inputs ─────────────────────────────────────────────────────
  { key: 'stdevrev',            label: 'SD Rev',               fmt: v => fmtRound(v, 3), align: 'right' },
  { key: 'stdevexpense',        label: 'SD Exp',               fmt: v => fmtRound(v, 3), align: 'right' },
  { key: 'stdevcapex',          label: 'SD CapEx',             fmt: v => fmtRound(v, 3), align: 'right' },
  { key: 'stdevcapspread',      label: 'SD Cap Spread',        fmt: v => fmtRound(v, 3), align: 'right' },
]

export default function CalibrationTab() {
  const [rows, setRows] = useState(null)

  useEffect(() => {
    api.calibration().then(setRows)
  }, [])

  return (
    <div className="space-y-4">
      <div>
        <h3 className="section-heading">Calibration: Inputs vs Realized</h3>
        <p className="text-sm text-slate-500 mb-4">
          Compares key input assumptions against averages realized across all simulations.
          Δ columns highlight divergences &gt; 5 bps.
        </p>
      </div>
      {rows ? <DataTable columns={COLS} rows={rows} defaultPageSize={25} /> : <Spinner />}
    </div>
  )
}

