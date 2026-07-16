import { useState, useEffect } from 'react'
import { api } from '../api.js'
import { fmtPct, fmtDollar, fmtRound } from '../fmt.js'
import DataTable from '../components/DataTable.jsx'
import Select from '../components/Select.jsx'
import Spinner from '../components/Spinner.jsx'

const COLS = [
  { key: 'year',              label: 'Year',            align: 'right' },
  { key: 'noi',               label: 'NOI',             fmt: v => fmtDollar(v), align: 'right' },
  { key: 'annual_interest',   label: 'Annual Interest', fmt: v => fmtDollar(v), align: 'right' },
  { key: 'DSCR',              label: 'DSCR',            fmt: v => fmtRound(v, 2), align: 'right',
    cellClass: (v) => v != null && v < 1.0 ? 'text-red-600 font-semibold' : v < 1.20 ? 'text-orange-600 font-medium' : '' },
  { key: 'Debt_Yield',        label: 'Debt Yield',      fmt: v => fmtPct(v, 2), align: 'right' },
  { key: 'running_cap_rate',  label: 'Cap Rate',        fmt: v => fmtPct(v, 2), align: 'right' },
  { key: 'LTV',               label: 'LTV',             fmt: v => fmtPct(v, 2), align: 'right',
    cellClass: (v) => v != null && v > 0.75 ? 'text-red-600 font-semibold' : v > 0.65 ? 'text-orange-500 font-medium' : '' },
  { key: 'Exit_Value',        label: 'Exit Value',      fmt: v => fmtDollar(v), align: 'right' },
  { key: 'Exit_LTV',          label: 'Exit LTV',        fmt: v => fmtPct(v, 2), align: 'right' },
]

export default function BaseLoanTab({ propertyTypes }) {
  const [proptype, setProptype] = useState(propertyTypes[0] ?? '')
  const [rows, setRows] = useState(null)

  useEffect(() => {
    if (!proptype) return
    setRows(null)
    api.baseCaseLoan(proptype).then(setRows)
  }, [proptype])

  return (
    <div className="space-y-6">
      <Select label="Property Type" value={proptype}
        options={propertyTypes} onChange={setProptype} className="w-72" />

      <section>
        <h3 className="section-heading">Base Case Loan Pro Forma</h3>
        <p className="text-sm text-slate-500 mb-4">
          DSCR &lt; 1.20 shown in orange · LTV &gt; 65% shown in orange.
        </p>
        {rows ? <DataTable columns={COLS} rows={rows} defaultPageSize={Infinity} searchable={false} /> : <Spinner />}
      </section>
    </div>
  )
}
