// Base URL: empty string so works in both dev (via proxy) and production
const BASE = ''

async function get(path) {
  const res = await fetch(BASE + path)
  if (!res.ok) throw new Error(`API error ${res.status}: ${path}`)
  return res.json()
}

export const api = {
  propertyTypes:        ()               => get('/api/property-types'),
  summary:              ()               => get('/api/summary'),
  irrHistogram:         (proptype)       => get(`/api/irr-histogram?proptype=${enc(proptype)}`),
  irrKde:               (proptype)       => get(`/api/irr-kde?proptype=${enc(proptype)}`),
  variableHistogram:    (proptype, v)    => get(`/api/variable-histogram?proptype=${enc(proptype)}&variable=${enc(v)}`),
  calibration:          ()               => get('/api/calibration'),
  debtSummary:          ()               => get('/api/debt-summary'),
  baseCaseDcf:          (proptype)       => get(`/api/base-case-dcf?proptype=${enc(proptype)}`),
  baseCaseLoan:         (proptype)       => get(`/api/base-case-loan?proptype=${enc(proptype)}`),
  simIds:               (proptype)       => get(`/api/sim-ids?proptype=${enc(proptype)}`),
  individualDcf:        (proptype, simId) => get(`/api/individual-dcf?proptype=${enc(proptype)}&sim_id=${simId}`),
}

function enc(s) { return encodeURIComponent(s) }
