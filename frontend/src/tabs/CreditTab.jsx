import { useState, useEffect } from 'react'
import { api } from '../api.js'
import { fmtPct, fmtBps } from '../fmt.js'
import DataTable from '../components/DataTable.jsx'
import Spinner from '../components/Spinner.jsx'

// Moody's rating → badge CSS class
const ratingBadgeClass = (r) => {
  if (!r) return 'badge badge-sub'
  const base = r.replace(/[0-9]/g, '') // strip numeric modifier
  if (base === 'Aaa') return 'badge badge-aaa'
  if (base === 'Aa')  return 'badge badge-aa'
  if (base === 'A')   return 'badge badge-a'
  if (base === 'Baa') return 'badge badge-baa'
  return 'badge badge-sub'
}

const COLS = [
  { key: 'proptype',                    label: 'Property Type' },
  { key: 'Spread_bps',                  label: 'Spread (bps)',              fmt: v => fmtBps(v, 1), align: 'right' },
  { key: 'PD',                          label: 'PD',                        fmt: v => fmtPct(v, 3), align: 'right' },
  { key: 'Avg_LGD',                     label: 'Avg LGD',                   fmt: v => fmtPct(v, 3), align: 'right' },
  { key: 'Total_EL',                    label: 'Total EL',                  fmt: v => fmtPct(v, 3), align: 'right' },
  { key: 'Ann_EL',                      label: 'Ann EL',                    fmt: v => fmtPct(v, 3), align: 'right' },
  { key: 'Ann_EL_bps',                  label: 'Ann EL (bps)',              fmt: v => fmtBps(v, 1), align: 'right' },
  { key: 'Loss_Adjusted_Spread_bps',    label: 'Loss-Adj Spread (bps)',     fmt: v => fmtBps(v, 1), align: 'right',
    cellClass: (v) => v != null && v < 0 ? 'text-red-600 font-semibold' : '' },
  { key: 'Rating',                      label: 'Rating',
    fmt: (v) => v ? <span className={ratingBadgeClass(v)}>{v}</span> : '—' },
]

export default function CreditTab() {
  const [rows, setRows] = useState(null)

  useEffect(() => {
    api.debtSummary().then(setRows)
  }, [])

  return (
    <div className="space-y-4">
      <div>
        <h3 className="section-heading">Credit Analysis</h3>
        <p className="text-sm text-slate-500 mb-4">
          LTV from survey inputs · 5% liquidation haircut on exit value · 10-year hold period.
        </p>
      </div>
      {rows ? <DataTable columns={COLS} rows={rows} defaultPageSize={25} /> : <Spinner />}
    </div>
  )
}
