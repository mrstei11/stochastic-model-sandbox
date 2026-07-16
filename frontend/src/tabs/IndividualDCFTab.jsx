import { useState, useEffect } from 'react'
import { api } from '../api.js'
import { fmtPct, fmtDollar } from '../fmt.js'
import DataTable from '../components/DataTable.jsx'
import MetricCard from '../components/MetricCard.jsx'
import Select from '../components/Select.jsx'
import Spinner from '../components/Spinner.jsx'

const COLS = [
  { key: 't',                 label: 'Year #',           align: 'right' },
  { key: 'year',              label: 'Cal Year',         align: 'right' },
  { key: 'row_type',          label: 'Type' },
  { key: 'revenue',           label: 'Revenue',          fmt: v => fmtDollar(v), align: 'right' },
  { key: 'random_growth_rev', label: 'Rev Growth',       fmt: v => fmtPct(v, 2), align: 'right' },
  { key: 'expense',           label: 'Expense',          fmt: v => fmtDollar(v), align: 'right' },
  { key: 'random_growth_exp', label: 'Exp Growth',       fmt: v => fmtPct(v, 2), align: 'right' },
  { key: 'running_cap_rate',  label: 'Cap Rate',         fmt: v => fmtPct(v, 2), align: 'right' },
  { key: 'noi',               label: 'NOI',              fmt: v => fmtDollar(v), align: 'right' },
  { key: 'totalcf',           label: 'Total CF',         fmt: v => fmtDollar(v), align: 'right' },
]

export default function IndividualDCFTab({ propertyTypes }) {
  const [proptype, setProptype] = useState(propertyTypes[0] ?? '')
  const [simIds,   setSimIds]   = useState([])
  const [simId,    setSimId]    = useState(null)
  const [data,     setData]     = useState(null)

  // Load sim IDs when proptype changes
  useEffect(() => {
    if (!proptype) return
    setSimIds([])
    setSimId(null)
    setData(null)
    api.simIds(proptype).then(ids => {
      setSimIds(ids)
      if (ids.length > 0) setSimId(ids[0])
    })
  }, [proptype])

  // Load DCF when sim ID changes
  useEffect(() => {
    if (!proptype || simId == null) return
    setData(null)
    api.individualDcf(proptype, simId).then(setData)
  }, [proptype, simId])

  const m = data?.metrics

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-wrap items-end gap-4">
        <Select label="Property Type" value={proptype}
          options={propertyTypes} onChange={v => setProptype(v)} className="w-72" />
        <Select label="Simulation ID"
          value={simId ?? ''}
          options={simIds.map(id => ({ value: id, label: String(id) }))}
          onChange={v => setSimId(Number(v))}
          className="w-40" />
      </div>

      {/* Metric cards */}
      {m && (
        <div className="flex flex-wrap gap-3">
          <MetricCard label="Model IRR"            value={fmtPct(m.irr)} />
          <MetricCard label="Starting Cap Rate"    value={fmtPct(m.start_cap)} />
          <MetricCard label="Exit Cap Rate"        value={fmtPct(m.exit_cap)} />
          <MetricCard label="10yr Avg Rev Growth"  value={fmtPct(m.avg_rev_growth)} />
          <MetricCard label="10yr Avg Exp Growth"  value={fmtPct(m.avg_exp_growth)} />
          <MetricCard label="Avg CapEx (yrs 2–10)" value={fmtPct(m.avg_capex)} />
        </div>
      )}

      <section>
        <h3 className="section-heading">Diagnostic Cash Flow Projection</h3>
        {data
          ? <DataTable columns={COLS} rows={data.rows} defaultPageSize={Infinity} searchable={false}
              rowStyle={r => r.row_type === 'Purchase' ? 'font-bold' :
                            r.row_type?.startsWith('Forward') ? 'text-slate-400' : ''} />
          : simId != null ? <Spinner /> : null}
      </section>
    </div>
  )
}
