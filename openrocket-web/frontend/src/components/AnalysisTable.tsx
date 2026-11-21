/**
 * Per-component analysis (mass, CG, CP, CNα, CD from Analysis.components) as
 * a table under the figure -- what OpenRocket keeps in its separate
 * Component Analysis dialog, in view while editing.
 */
import type { Analysis, RocketDocument } from '../types'
import { useUnits } from '../workbench/units'
import { fmtNumber } from '../lib/units'

export function AnalysisTable({
  doc, analysis, selectedId, onSelect, provenance,
}: {
  doc: RocketDocument
  analysis: Analysis | null
  selectedId: string | null
  onSelect: (id: string) => void
  provenance: string
}) {
  const u = useUnits()
  if (!analysis) return <div style={{ padding: 8 }}>Calculating…</div>
  const a = analysis
  const L = (v: number) => fmtNumber(u.toDisplay('length', v), u.digits('length'))
  const M = (v: number) => fmtNumber(u.toDisplay('mass', v), u.digits('mass'))
  return (
    <table className="orw-table" title={provenance} data-testid="analysis-table">
      <thead>
        <tr>
          <th style={{ textAlign: 'left' }}>Component</th>
          <th>Position ({u.label('length')})</th>
          <th>Length ({u.label('length')})</th>
          <th>Mass ({u.label('mass')})</th>
          <th>CG ({u.label('length')})</th>
          <th>CP ({u.label('length')})</th>
          <th>C<sub>Nα</sub></th>
          <th>C<sub>D</sub></th>
        </tr>
      </thead>
      <tbody>
        {a.components.map((c) => (
          <tr key={c.id} className={c.id === selectedId ? 'sel' : ''} onMouseDown={() => onSelect(c.id)}>
            <td>{c.name}</td>
            <td className="num">{L(c.x)}</td>
            <td className="num">{L(c.length)}</td>
            <td className="num">{M(c.mass)}</td>
            <td className="num">{c.mass > 0 ? L(c.cgx) : ''}</td>
            <td className="num">{c.cna ? L(c.cpx) : ''}</td>
            <td className="num">{c.cna ? fmtNumber(c.cna, 3) : ''}</td>
            <td className="num">{c.cd ? fmtNumber(c.cd, 3) : ''}</td>
          </tr>
        ))}
        <tr style={{ fontWeight: 600, borderTop: '1px solid #ccc' }}>
          <td>{doc.rocket.name} (with motors)</td>
          <td className="num">0</td>
          <td className="num">{L(a.length)}</td>
          <td className="num">{M(a.cg.mass)}</td>
          <td className="num">{L(a.cg.x)}</td>
          <td className="num">{L(a.cp.x)}</td>
          <td className="num">{fmtNumber(a.cp.cna, 3)}</td>
          <td className="num">{fmtNumber(a.cd.total, 3)}</td>
        </tr>
      </tbody>
    </table>
  )
}
