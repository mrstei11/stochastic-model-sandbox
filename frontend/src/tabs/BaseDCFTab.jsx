import { useState, useEffect } from 'react'
import { api } from '../api.js'
import { fmtPct, fmtDollar, fmtRound } from '../fmt.js'
import DataTable from '../components/DataTable.jsx'
import MetricCard from '../components/MetricCard.jsx'
import Select from '../components/Select.jsx'
import Spinner from '../components/Spinner.jsx'

const COLS = [
  { key: 't',                label: 'Year #',         align: 'right' },
  { key: 'year',             label: 'Cal Year',       align: 'right' },
  { key: 'row_type',         label: 'Type' },
  { key: 'revenue',          label: 'Revenue',        fmt: v => fmtDollar(v), align: 'right' },
  { key: 'expense',          label: 'Expense',        fmt: v => fmtDollar(v), align: 'right' },
  { key: 'noi',              label: 'NOI',            fmt: v => fmtDollar(v), align: 'right' },
  { key: 'capex',            label: 'CapEx (% NOI)',  fmt: v => fmtPct(v, 2), align: 'right' },
  { key: 'capspread',        label: 'Cap Spread',     fmt: v => fmtPct(v, 2), align: 'right' },
  { key: 'running_cap_rate', label: 'Cap Rate',       fmt: v => fmtPct(v, 2), align: 'right' },
  { key: 'totalcf',          label: 'Total CF',       fmt: v => fmtDollar(v), align: 'right' },
]

export default function BaseDCFTab({ propertyTypes }) {
  const [proptype, setProptype] = useState(propertyTypes[0] ?? '')
  const [data, setData] = useState(null)

  useEffect(() => {
    if (!proptype) return
    setData(null)
    api.baseCaseDcf(proptype).then(setData)
  }, [proptype])

  const m = data?.metrics

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4">
        <Select label="Property Type" value={proptype}
          options={propertyTypes} onChange={setProptype} className="w-72" />
      </div>

      {/* Metric cards */}
      {m && (
        <div className="flex flex-wrap gap-3">
          <MetricCard label="Base Case IRR"        value={fmtPct(m.irr)} />
          <MetricCard label="Starting Cap Rate"    value={fmtPct(m.start_cap)} />
          <MetricCard label="Exit Cap Rate"        value={fmtPct(m.exit_cap)} />
          <MetricCard label="10yr Avg Rev Growth"  value={fmtPct(m.avg_rev_growth)} />
          <MetricCard label="10yr Avg Exp Growth"  value={fmtPct(m.avg_exp_growth)} />
          <MetricCard label="Avg CapEx (yrs 2–10)" value={fmtPct(m.avg_capex)} />
        </div>
      )}

      <section>
        <h3 className="section-heading">Base Case Cash Flow Projection</h3>
        {data
          ? <DataTable columns={COLS} rows={data.rows} defaultPageSize={Infinity} searchable={false}
              rowStyle={r => r.row_type === 'Purchase' ? 'font-bold' :
                            r.row_type?.startsWith('Forward') ? 'text-slate-400' : ''} />
          : <Spinner />}
      </section>
    </div>
  )
}
