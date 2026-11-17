/**
 * "Flight simulations" (SimulationPanel): the button row and the simulation
 * table with OpenRocket's columns. Running simulations is milestone 2; the
 * document contract carries no simulations yet, so the table is empty.
 */
import { Btn } from './swing'

const COLUMNS: [string, number][] = [
  ['War...', 44], ['Name', 125], ['Configuration', 125], ['Velocity off rod', 100], ['Apogee', 100],
  ['Velocity at dep...', 100], ['Optimum delay', 100], ['Max. velocity', 100], ['Max. accelerat...', 100],
  ['Time to apogee', 100], ['Flight time', 100], ['Ground hit vel...', 100],
]

export function SimulationsTab() {
  const soon = 'Simulation is milestone 2 of openrocket-web.'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '6px 6px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 24, flex: 'none' }}>
        <Btn icon="icons/document-new.png" style={{ width: 149 }} disabled title={soon}>New simulation</Btn>
        <Btn icon="icons/edit-edit.png" style={{ width: 143 }} disabled title={soon}>Edit simulation</Btn>
        <Btn icon="icons/sim-run.png" style={{ width: 151 }} disabled title={soon}>Run simulations</Btn>
        <Btn icon="icons/delete.png" style={{ width: 167 }} disabled title={soon}>Delete simulations</Btn>
        <Btn icon="icons/sim-plot.png" style={{ width: 130 }} disabled title={soon}>Plot / Export</Btn>
      </div>
      <div style={{ flex: 1, minHeight: 0, marginTop: 10, background: 'white', border: '1px solid #c2c2c2', overflow: 'auto' }}>
        <table className="orw-table" style={{ width: 'auto', tableLayout: 'fixed' }}>
          <colgroup>
            {COLUMNS.map(([c, w]) => (
              <col key={c} style={{ width: w }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {COLUMNS.map(([c]) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody />
        </table>
        <div style={{ color: '#888', fontSize: 13, padding: '10px 8px' }}>{soon}</div>
      </div>
    </div>
  )
}
