export default function MetricCard({ label, value }) {
  return (
    <div className="metric-box card">
      <div className="metric-title">{label}</div>
      <div className="metric-value">{value ?? '—'}</div>
    </div>
  )
}
