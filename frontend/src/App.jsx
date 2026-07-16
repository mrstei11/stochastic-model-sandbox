import { useState, useEffect } from 'react'
import { api } from './api.js'
import DashboardTab     from './tabs/DashboardTab.jsx'
import CalibrationTab   from './tabs/CalibrationTab.jsx'
import CreditTab        from './tabs/CreditTab.jsx'
import BaseDCFTab       from './tabs/BaseDCFTab.jsx'
import BaseLoanTab      from './tabs/BaseLoanTab.jsx'
import IndividualDCFTab from './tabs/IndividualDCFTab.jsx'

const TABS = [
  { id: 'dashboard',   label: 'Dashboard Summary' },
  { id: 'calibration', label: 'Calibration (Inputs vs Realized)' },
  { id: 'credit',      label: 'Credit Analysis' },
  { id: 'basedcf',     label: 'Base Case DCF' },
  { id: 'baseloan',    label: 'Base Case Loan' },
  { id: 'individual',  label: 'Review Individual DCFs' },
]

export default function App() {
  const [tab, setTab] = useState('dashboard')
  const [propertyTypes, setPropertyTypes] = useState(null)

  useEffect(() => {
    api.propertyTypes().then(setPropertyTypes)
  }, [])

  if (!propertyTypes) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#f5f5f5' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 36, height: 36, border: '4px solid #18bc9c', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px' }} />
          <p style={{ color: '#7f8c8d' }}>Loading model data…</p>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f5f5f5' }}>
      {/* Header */}
      <div className="page-header">MIM Stochastic Real Estate Model</div>

      {/* Tab bar */}
      <div className="tab-bar">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`tab-btn${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="tab-content">
        {tab === 'dashboard'   && <DashboardTab    propertyTypes={propertyTypes} />}
        {tab === 'calibration' && <CalibrationTab />}
        {tab === 'credit'      && <CreditTab />}
        {tab === 'basedcf'     && <BaseDCFTab      propertyTypes={propertyTypes} />}
        {tab === 'baseloan'    && <BaseLoanTab     propertyTypes={propertyTypes} />}
        {tab === 'individual'  && <IndividualDCFTab propertyTypes={propertyTypes} />}
      </div>
    </div>
  )
}

