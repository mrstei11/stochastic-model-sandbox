import { useState, useEffect } from 'react'
import { api } from '../api.js'
import { fmtPct, fmtRound } from '../fmt.js'
import DataTable from '../components/DataTable.jsx'
import DensityChart from '../components/DensityChart.jsx'
import Histogram from '../components/Histogram.jsx'
import Select from '../components/Select.jsx'
import Spinner from '../components/Spinner.jsx'

// Variable options must match the column names Python puts in random_variables
// (Python: capex, capspread — same data R stores as random_capex, random_capspread)
const VAR_OPTIONS = [
  { value: 'random_growth_rev', label: 'Revenue Growth' },
  { value: 'random_growth_exp', label: 'Expense Growth' },
  { value: 'capex',             label: 'CapEx % of NOI (random draw)' },
  { value: 'capspread',         label: 'Cap Rate Spread (random draw)' },
  { value: 'running_cap_rate',  label: 'Running Cap Rate' },
]

const SUMMARY_COLS = [
  { key: 'proptype',      label: 'Property Type' },
  { key: 'mean_IRR',      label: 'Mean IRR',       fmt: v => fmtPct(v, 3), align: 'right' },
  { key: 'sd_IRR',        label: 'Std Dev IRR',    fmt: v => fmtPct(v, 3), align: 'right' },
  { key: 'min_IRR',       label: 'Min IRR',        fmt: v => fmtPct(v, 3), align: 'right' },
  { key: 'max_IRR',       label: 'Max IRR',        fmt: v => fmtPct(v, 3), align: 'right' },
  { key: 'sharpe_ratio',  label: 'Sharpe',         fmt: v => fmtRound(v, 3), align: 'right' },
  { key: 'sortino_ratio', label: 'Sortino',        fmt: v => fmtRound(v, 3), align: 'right' },
]

export default function DashboardTab({ propertyTypes }) {
  const [proptype, setProptype] = useState(propertyTypes[0] ?? '')
  const [variable, setVariable] = useState(VAR_OPTIONS[0].value)
  const [summary,  setSummary]  = useState(null)
  const [kdePts,   setKdePts]   = useState(null)
  const [varBins,  setVarBins]  = useState(null)

  useEffect(() => {
    api.summary().then(setSummary)
  }, [])

  useEffect(() => {
    if (!proptype) return
    setKdePts(null)
    api.irrKde(proptype).then(d => setKdePts(d.points))
  }, [proptype])

  useEffect(() => {
    if (!proptype) return
    setVarBins(null)
    api.variableHistogram(proptype, variable).then(d => setVarBins(d.bins))
  }, [proptype, variable])

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-wrap gap-4">
        <Select label="Property Type" value={proptype}
          options={propertyTypes} onChange={setProptype} className="w-72" />
        <Select label="Random Variable" value={variable}
          options={VAR_OPTIONS} onChange={setVariable} className="w-72" />
      </div>

      {/* Summary table */}
      <section className="card">
        <h3 className="section-heading">Summary Table</h3>
        {summary
          ? <DataTable columns={SUMMARY_COLS} rows={summary} defaultPageSize={25} />
          : <Spinner />}
      </section>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="section-heading">IRR Distribution — {proptype}</h3>
          {kdePts ? <DensityChart points={kdePts} color="#003087" /> : <Spinner />}
        </div>
        <div className="card">
          <h3 className="section-heading">
            {VAR_OPTIONS.find(v => v.value === variable)?.label} — {proptype}
          </h3>
          {varBins
            ? <Histogram bins={varBins}
                xIsPct={variable !== 'capex'}
                color="#0057e7" />
            : <Spinner />}
        </div>
      </div>
    </div>
  )
}
