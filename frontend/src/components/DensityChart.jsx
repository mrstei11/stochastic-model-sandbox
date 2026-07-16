import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine,
} from 'recharts'
import { fmtPct } from '../fmt.js'

/**
 * Smooth Gaussian KDE density chart — mirrors R's geom_density().
 * Props:
 *   points: [{ x, y }] from /api/irr-kde
 *   color:  fill/stroke color
 *   title:  optional label
 */
export default function DensityChart({ points, color = '#003087', title }) {
  if (!points || points.length === 0) {
    return <p className="text-slate-400 text-sm py-4">No data.</p>
  }

  return (
    <div>
      {title && <p className="text-sm font-medium text-slate-600 mb-2">{title}</p>}
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={points} margin={{ top: 4, right: 16, left: 0, bottom: 24 }}>
          <defs>
            <linearGradient id={`kde-fill-${color.replace('#','')}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={color} stopOpacity={0.35} />
              <stop offset="95%" stopColor={color} stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis
            dataKey="x"
            tickFormatter={v => fmtPct(v, 1)}
            tick={{ fontSize: 11, fill: '#64748b' }}
            type="number"
            domain={['auto', 'auto']}
          />
          <YAxis
            tick={{ fontSize: 11, fill: '#64748b' }}
            width={50}
            tickFormatter={v => v.toFixed(1)}
            label={{ value: 'density', angle: -90, position: 'insideLeft', offset: 10, style: { fontSize: 10, fill: '#94a3b8' } }}
          />
          <ReferenceLine x={0} stroke="#94a3b8" strokeDasharray="4 2" />
          <Tooltip
            formatter={(v) => [v.toFixed(4), 'Density']}
            labelFormatter={(x) => `IRR: ${fmtPct(x, 2)}`}
            contentStyle={{ fontSize: 12, borderRadius: 6 }}
          />
          <Area
            type="monotone"
            dataKey="y"
            stroke={color}
            strokeWidth={2}
            fill={`url(#kde-fill-${color.replace('#','')})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
