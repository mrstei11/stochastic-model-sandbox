import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { fmtPct } from '../fmt.js'

const pctFormatter = (v) => fmtPct(v)
const countFormatter = (v) => v.toLocaleString()

export default function Histogram({ bins, xIsPct = false, color = '#003087', title }) {
  if (!bins || bins.length === 0) {
    return <p className="text-slate-400 text-sm py-4">No data.</p>
  }

  // Convert bins to recharts-friendly format
  const data = bins.map(b => ({
    midpoint: (b.x0 + b.x1) / 2,
    count: b.count,
    x0: b.x0,
    x1: b.x1,
  }))

  const xFmt = xIsPct ? pctFormatter : (v) => v.toFixed(3)

  return (
    <div>
      {title && <p className="text-sm font-medium text-slate-600 mb-2">{title}</p>}
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 24 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis
            dataKey="midpoint"
            tickFormatter={xFmt}
            tick={{ fontSize: 11, fill: '#64748b' }}
            label={{ value: '', position: 'insideBottom', offset: -12 }}
          />
          <YAxis
            tickFormatter={countFormatter}
            tick={{ fontSize: 11, fill: '#64748b' }}
            width={50}
          />
          <Tooltip
            formatter={(value, _name, props) => [
              countFormatter(value),
              `${xFmt(props.payload.x0)} → ${xFmt(props.payload.x1)}`,
            ]}
            labelFormatter={() => ''}
            contentStyle={{ fontSize: 12, borderRadius: 6 }}
          />
          <Bar dataKey="count" fill={color} radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
