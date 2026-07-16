import { useState, useMemo, useCallback } from 'react'

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100]

/**
 * DT-equivalent sortable/searchable/paginated table.
 *
 * Props:
 *   columns:         [{ key, label, fmt?, align?, cellClass? }]
 *   rows:            array of row objects
 *   rowStyle:        optional (row) => extra className
 *   defaultPageSize: number | Infinity
 *   searchable:      bool (default true)
 *   selectable:      bool (default true)  — click/shift-click row selection
 */
export default function DataTable({
  columns,
  rows,
  rowStyle,
  defaultPageSize = 10,
  // legacy alias so existing callers that pass pageSize= still work
  pageSize: pageSizeProp,
  searchable = true,
  selectable = true,
}) {
  const initSize = pageSizeProp !== undefined ? pageSizeProp : defaultPageSize
  const paginate = initSize !== Infinity

  const [sortKey,   setSortKey]   = useState(null)
  const [sortDir,   setSortDir]   = useState('asc')
  const [query,     setQuery]     = useState('')
  const [page,      setPage]      = useState(1)
  const [pageSize,  setPageSize]  = useState(initSize)
  const [selected,  setSelected]  = useState(new Set())
  const [lastClick, setLastClick] = useState(null)

  // ── filter ───────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (!rows) return []
    if (!query.trim()) return rows
    const q = query.toLowerCase()
    return rows.filter(row =>
      columns.some(col => {
        const v = row[col.key]
        return v != null && String(v).toLowerCase().includes(q)
      })
    )
  }, [rows, query, columns])

  // ── sort ─────────────────────────────────────────────────────────────────
  const sorted = useMemo(() => {
    if (!sortKey) return filtered
    return [...filtered].sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey]
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      const cmp = typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb), undefined, { numeric: true })
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [filtered, sortKey, sortDir])

  // ── pagination ────────────────────────────────────────────────────────────
  const effectiveSize = pageSize === Infinity ? Infinity : pageSize
  const totalPages = effectiveSize === Infinity ? 1 : Math.max(1, Math.ceil(sorted.length / effectiveSize))
  const safePage   = Math.min(page, totalPages)
  const startIdx   = effectiveSize === Infinity ? 0 : (safePage - 1) * effectiveSize
  const visible    = effectiveSize === Infinity
    ? sorted
    : sorted.slice(startIdx, startIdx + effectiveSize)

  // ── handlers ──────────────────────────────────────────────────────────────
  function toggleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
    setPage(1); setSelected(new Set())
  }

  function handleSearch(e) {
    setQuery(e.target.value); setPage(1); setSelected(new Set())
  }

  const handleRowClick = useCallback((globalIdx, e) => {
    if (!selectable) return
    setSelected(prev => {
      const next = new Set(prev)
      if (e.shiftKey && lastClick != null) {
        const lo = Math.min(lastClick, globalIdx)
        const hi = Math.max(lastClick, globalIdx)
        for (let i = lo; i <= hi; i++) next.add(i)
      } else {
        if (next.has(globalIdx)) next.delete(globalIdx)
        else next.add(globalIdx)
      }
      return next
    })
    setLastClick(globalIdx)
  }, [selectable, lastClick])

  if (!rows || rows.length === 0) {
    return <p style={{ color: '#7f8c8d', padding: '12px 0', fontSize: 13 }}>No data.</p>
  }

  const sortIcon = (key) => {
    if (sortKey !== key) return <span className="dt-sort-icon">⇅</span>
    return <span className="dt-sort-icon active">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  return (
    <div className="dt-wrapper">
      {/* Controls row */}
      <div className="dt-controls">
        {paginate ? (
          <label className="dt-show-label">
            Show&nbsp;
            <select
              className="dt-show-select"
              value={effectiveSize === Infinity ? 'all' : effectiveSize}
              onChange={e => {
                const v = e.target.value === 'all' ? Infinity : Number(e.target.value)
                setPageSize(v); setPage(1); setSelected(new Set())
              }}
            >
              {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
              <option value="all">All</option>
            </select>
            &nbsp;entries
          </label>
        ) : <span />}

        {searchable && (
          <label className="dt-search-label">
            Search:&nbsp;
            <input
              className="dt-search-input"
              type="text"
              value={query}
              onChange={handleSearch}
            />
          </label>
        )}
      </div>

      {/* Table */}
      <div className="dt-scroll">
        <table className="dt-table">
          <thead>
            <tr>
              {columns.map(col => (
                <th key={col.key}
                    style={{ textAlign: col.align === 'right' ? 'right' : 'left' }}
                    onClick={() => toggleSort(col.key)}>
                  {col.label}{sortIcon(col.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, i) => {
              const globalIdx = startIdx + i
              const isSel = selected.has(globalIdx)
              const extra = rowStyle ? rowStyle(row) : ''
              return (
                <tr
                  key={i}
                  className={`${isSel ? 'selected' : ''} ${extra}`}
                  onClick={e => handleRowClick(globalIdx, e)}
                >
                  {columns.map(col => {
                    const raw  = row[col.key]
                    const cell = col.fmt ? col.fmt(raw, row) : (raw ?? '—')
                    const cc   = col.cellClass && !isSel ? col.cellClass(raw, row) : ''
                    return (
                      <td key={col.key}
                          className={`${col.align === 'right' ? 'text-right' : ''} ${cc}`}>
                        {cell}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div className="dt-footer">
        <span className="dt-info">
          {sorted.length === 0
            ? 'No matching records found'
            : effectiveSize === Infinity
              ? `Showing all ${sorted.length} entries${filtered.length < (rows?.length ?? 0) ? ` (filtered from ${rows?.length})` : ''}`
              : `Showing ${Math.min(startIdx + 1, sorted.length)} to ${Math.min(startIdx + effectiveSize, sorted.length)} of ${sorted.length} entries${filtered.length < (rows?.length ?? 0) ? ` (filtered from ${rows?.length})` : ''}`}
        </span>

        {paginate && totalPages > 1 && (
          <div className="dt-pagination">
            <button className="dt-page-btn" disabled={safePage === 1}
              onClick={() => setPage(p => p - 1)}>Previous</button>
            {pageWindows(safePage, totalPages).map((p, idx) =>
              p === '…'
                ? <span key={`e${idx}`} style={{ padding: '0 4px', color: '#aaa', fontSize: 13 }}>…</span>
                : <button key={p} className={`dt-page-btn${p === safePage ? ' active' : ''}`}
                    onClick={() => setPage(p)}>{p}</button>
            )}
            <button className="dt-page-btn" disabled={safePage === totalPages}
              onClick={() => setPage(p => p + 1)}>Next</button>
          </div>
        )}
      </div>
    </div>
  )
}

function pageWindows(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const pages = [1]
  if (current > 3) pages.push('…')
  for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) pages.push(i)
  if (current < total - 2) pages.push('…')
  pages.push(total)
  return pages
}


