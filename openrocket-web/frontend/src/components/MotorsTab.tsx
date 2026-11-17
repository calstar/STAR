/**
 * "Motors & Configuration" (FlightConfigurationPanel): configuration buttons,
 * the Motors / Recovery / Stages sub-tabs, the motor-mount check list and the
 * configuration x mount table with Select motor / Delete motor. Kept minimal:
 * ignition per configuration is shown, not edited (Select ignition is off).
 */
import { useEffect, useState } from 'react'
import type { Api } from '../api/client'
import type { Component, MotorConfig, MotorSearchResult, Params, RocketDocument } from '../types'
import { Btn, Check, Group, Tabs, Window } from './swing'
import { configLabel, motorLabel, motorMounts } from '../workbench/configs'
import { canMountMotor } from '../lib/rules'
import { walk, newId } from '../lib/tree'
import { motorMount, num, str } from '../lib/params'
import { useUnits } from '../workbench/units'
import { fmtNumber } from '../lib/units'

type Sub = 'motors' | 'recovery' | 'stages'

export function MotorsTab({
  api, doc, apply, onParams, analysisInner,
}: {
  api: Api
  doc: RocketDocument
  apply: (fn: (d: RocketDocument) => RocketDocument, label: string) => void
  onParams: (id: string, fn: (p: Params) => Params, key: string) => void
  /** Inner diameter per mount id, for the motor search's diameter filter. */
  analysisInner: (mount: Component) => number | null
}) {
  const [sub, setSub] = useState<Sub>('motors')
  // OpenRocket opens with the selected configuration's first mount cell selected.
  const [cell, setCell] = useState<{ cfg: string; mount: string } | null>(() => {
    const m = motorMounts(doc)[0]
    return m && doc.selectedConfig ? { cfg: doc.selectedConfig, mount: m.id } : null
  })
  const [choosing, setChoosing] = useState<{ cfg: string; mount: Component } | null>(null)
  const [renaming, setRenaming] = useState<MotorConfig | null>(null)
  const mounts = motorMounts(doc)
  const candidates: Component[] = []
  walk(doc.rocket, (c) => {
    if (canMountMotor(c.type)) candidates.push(c)
  })
  const selCfg = cell?.cfg ?? doc.selectedConfig

  const setCfgs = (fn: (cs: MotorConfig[]) => MotorConfig[], label: string, selected?: string | null) =>
    apply((d) => ({ ...d, motorConfigs: fn(d.motorConfigs), selectedConfig: selected === undefined ? d.selectedConfig : selected }), label)

  const recovery: Component[] = []
  walk(doc.rocket, (c) => {
    if (c.type === 'parachute' || c.type === 'streamer') recovery.push(c)
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '6px 6px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 24, flex: 'none' }}>
        <Btn
          icon="icons/document-new.png"
          style={{ width: 172 }}
          onClick={() => {
            const id = newId()
            setCfgs((cs) => [...cs, { id, name: '', stages: { '0': true }, motors: {} }], 'New configuration', id)
            setCell(null)
          }}
        >
          New Configuration
        </Btn>
        <Btn icon="icons/edit-rename.png" style={{ width: 192 }} disabled={!selCfg} onClick={() => setRenaming(doc.motorConfigs.find((c) => c.id === selCfg) ?? null)}>
          Rename Configuration
        </Btn>
        <Btn
          icon="icons/delete.png"
          style={{ width: 183 }}
          disabled={!selCfg || doc.motorConfigs.length <= 1}
          onClick={() => {
            const rest = doc.motorConfigs.filter((c) => c.id !== selCfg)
            setCfgs(() => rest, 'Delete configuration', rest[0]?.id ?? null)
            setCell(null)
          }}
        >
          Delete Configuration
        </Btn>
        <Btn
          icon="icons/edit-copy.png"
          style={{ width: 200 }}
          disabled={!selCfg}
          onClick={() => {
            const src = doc.motorConfigs.find((c) => c.id === selCfg)
            if (!src) return
            const id = newId()
            setCfgs((cs) => [...cs, { ...structuredClone(src), id, default: false }], 'Duplicate configuration', id)
          }}
        >
          Duplicate Configuration
        </Btn>
      </div>
      <Tabs
        tabs={[
          { id: 'motors', label: 'Motors' },
          { id: 'recovery', label: 'Recovery' },
          { id: 'stages', label: 'Stages', disabled: doc.rocket.children.length <= 1 },
        ]}
        active={sub}
        onChange={setSub}
        className="small"
        style={{ marginTop: 8, borderBottomColor: '#d6d6d6' }}
      />
      {sub === 'motors' && (
        <div style={{ display: 'flex', gap: 24, padding: '10px 8px 0', flex: 1, minHeight: 0 }}>
          <Group title="Motor mounts" bold style={{ width: 218, flex: 'none', padding: '4px 8px 8px' }}>
            <div style={{ background: 'white', border: '1px solid #d6d6d6', height: 180, overflow: 'auto', fontSize: 13, padding: '2px 4px' }}>
              {candidates.map((c) => (
                <div key={c.id} style={{ height: 20, display: 'flex', alignItems: 'center' }}>
                  <Check
                    label={c.name}
                    checked={!!motorMount(c.params)}
                    onChange={(on) =>
                      onParams(c.id, (p) => {
                        const n = { ...p }
                        if (on) n.motormount = { ignitionevent: 'automatic', ignitiondelay: 0, overhang: 0 }
                        else delete n.motormount
                        return n
                      }, 'motormount')
                    }
                  />
                </div>
              ))}
            </div>
          </Group>
          <Group title="Motor configurations" bold style={{ flex: 1, padding: '4px 8px 8px', minWidth: 0 }}>
            <div style={{ background: 'white', border: '1px solid #d6d6d6', height: 146, overflow: 'auto' }}>
              <table className="orw-table" data-testid="config-table">
                <thead>
                  <tr>
                    <th>Configuration</th>
                    {mounts.map((m) => (
                      <th key={m.id}>{m.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {doc.motorConfigs.map((cfg) => (
                    <tr key={cfg.id}>
                      <td
                        className={cell == null && cfg.id === doc.selectedConfig ? '' : ''}
                        onMouseDown={() => {
                          setCell(null)
                          apply((d) => ({ ...d, selectedConfig: cfg.id }), 'Select configuration')
                        }}
                        style={{ fontWeight: cfg.id === doc.selectedConfig ? 600 : 400 }}
                      >
                        {configLabel(doc, cfg)}
                      </td>
                      {mounts.map((m) => {
                        const mc = cfg.motors[m.id]
                        const sel = cell?.cfg === cfg.id && cell.mount === m.id
                        const ign = mc?.ignitionEvent ?? str((motorMount(m.params) ?? {}) as Params, 'ignitionevent', 'automatic')
                        return (
                          <td
                            key={m.id}
                            style={sel ? { background: 'var(--or-select)', color: 'white' } : undefined}
                            onMouseDown={() => {
                              setCell({ cfg: cfg.id, mount: m.id })
                              if (cfg.id !== doc.selectedConfig) apply((d) => ({ ...d, selectedConfig: cfg.id }), 'Select configuration')
                            }}
                            onDoubleClick={() => setChoosing({ cfg: cfg.id, mount: m })}
                          >
                            {mc ? (
                              <>
                                {motorLabel(mc)}&nbsp;&nbsp; {ign === 'automatic' ? 'Automatic' : ign[0].toUpperCase() + ign.slice(1)}
                              </>
                            ) : (
                              <span style={{ color: sel ? 'white' : '#999' }}>None</span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 8 }}>
              <Btn style={{ width: 116 }} disabled={!cell} onClick={() => cell && setChoosing({ cfg: cell.cfg, mount: mounts.find((m) => m.id === cell.mount)! })}>
                Select motor
              </Btn>
              <Btn
                style={{ width: 116 }}
                disabled={!cell || !doc.motorConfigs.find((c) => c.id === cell.cfg)?.motors[cell.mount]}
                onClick={() =>
                  cell &&
                  setCfgs(
                    (cs) =>
                      cs.map((c) => {
                        if (c.id !== cell.cfg) return c
                        const motors = { ...c.motors }
                        delete motors[cell.mount]
                        return { ...c, motors }
                      }),
                    'Delete motor',
                  )
                }
              >
                Delete motor
              </Btn>
              <Btn style={{ width: 116 }} disabled title="Not in this milestone">
                Select ignition
              </Btn>
              <Btn style={{ width: 116 }} disabled title="Not in this milestone">
                Reset ignition
              </Btn>
            </div>
          </Group>
        </div>
      )}
      {sub === 'recovery' && (
        <div style={{ padding: '10px 8px 0' }}>
          <div style={{ background: 'white', border: '1px solid #d6d6d6', height: 200, overflow: 'auto' }}>
            <table className="orw-table">
              <thead>
                <tr>
                  <th>Configuration</th>
                  {recovery.map((r) => (
                    <th key={r.id}>{r.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {doc.motorConfigs.map((cfg) => (
                  <tr key={cfg.id}>
                    <td>{configLabel(doc, cfg)}</td>
                    {recovery.map((r) => (
                      <td key={r.id}>
                        {deployLabel(str(r.params, 'deployevent', 'ejection'))}
                        {num(r.params, 'deploydelay') ? ` + ${fmtNumber(num(r.params, 'deploydelay'), 1)}s` : ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {sub === 'stages' && <div style={{ padding: 12, color: '#666' }}>A single-stage design has no separation to configure.</div>}

      {choosing && (
        <MotorChooser
          api={api}
          mount={choosing.mount}
          diameter={analysisInner(choosing.mount)}
          current={doc.motorConfigs.find((c) => c.id === choosing.cfg)?.motors[choosing.mount.id] ?? null}
          onCancel={() => setChoosing(null)}
          onChoose={(m, delay) => {
            setCfgs(
              (cs) =>
                cs.map((c) =>
                  c.id === choosing.cfg
                    ? {
                        ...c,
                        motors: {
                          ...c.motors,
                          [choosing.mount.id]: {
                            designation: m.designation, manufacturer: m.manufacturer, digest: m.digest, delay,
                            ignitionEvent: 'automatic', ignitionDelay: 0,
                          },
                        },
                      }
                    : c,
                ),
              'Select motor',
            )
            setChoosing(null)
          }}
        />
      )}
      {renaming && (
        <Window title="Rename configuration" onClose={() => setRenaming(null)} initial={{ x: 480, y: 160 }} width={420} modal zIndex={70}>
          <RenameForm
            initial={renaming.name}
            onCancel={() => setRenaming(null)}
            onOk={(name) => {
              setCfgs((cs) => cs.map((c) => (c.id === renaming.id ? { ...c, name } : c)), 'Rename configuration')
              setRenaming(null)
            }}
          />
        </Window>
      )}
    </div>
  )
}

function deployLabel(ev: string): string {
  return (
    {
      launch: 'Launch', ejection: 'Ejection charge', apogee: 'Apogee', altitude: 'Altitude',
      current_stage_separation: 'Current stage separation', lower_stage_separation: 'Lower stage separation', never: 'Never',
    }[ev] ?? ev
  )
}

function RenameForm({ initial, onOk, onCancel }: { initial: string; onOk: (s: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial)
  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span>Name (leave empty to name it after its motors):</span>
      <input className="orw-field" autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onOk(v)} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <Btn onClick={onCancel}>Cancel</Btn>
        <Btn isDefault onClick={() => onOk(v)}>
          OK
        </Btn>
      </div>
    </div>
  )
}

/** "Select a rocket motor" -- a minimal ThrustCurve search over GET /api/motors/search. */
function MotorChooser({
  api, mount, diameter, current, onChoose, onCancel,
}: {
  api: Api
  mount: Component
  diameter: number | null
  current: { designation: string; delay?: number } | null
  onChoose: (m: MotorSearchResult, delay: number) => void
  onCancel: () => void
}) {
  const u = useUnits()
  const [q, setQ] = useState(current?.designation ?? '')
  const [matchDia, setMatchDia] = useState(diameter != null)
  const [rows, setRows] = useState<MotorSearchResult[]>([])
  const [sel, setSel] = useState<MotorSearchResult | null>(null)
  const [delay, setDelay] = useState(String(current?.delay ?? 5))
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      api
        .searchMotors(q, matchDia ? diameter : null)
        .then((r) => {
          if (!live) return
          setRows(r)
          setErr(null)
          setSel((s) => r.find((x) => x.digest === s?.digest) ?? r.find((x) => x.designation === current?.designation) ?? null)
        })
        .catch((e) => live && setErr(String(e?.message ?? e)))
    }, 150)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [api, q, matchDia, diameter, current?.designation])
  const d = Number(delay)
  return (
    <Window title={`Select a rocket motor — ${mount.name}`} onClose={onCancel} initial={{ x: 220, y: 90 }} width={900} modal zIndex={70}>
      <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span>Search:</span>
          <input className="orw-field" style={{ width: 260 }} autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. C6, Estes, AeroTech G" aria-label="Motor search" />
          <Check
            label={diameter != null ? `Limit motor to mount diameter (${u.fmt('length', diameter * 2)})` : 'Limit motor to mount diameter'}
            checked={matchDia}
            disabled={diameter == null}
            onChange={setMatchDia}
          />
        </div>
        <div style={{ height: 300, overflow: 'auto', background: 'white', border: '1px solid #c2c2c2' }}>
          <table className="orw-table">
            <thead>
              <tr>
                <th>Manufacturer</th>
                <th>Designation</th>
                <th>Diameter</th>
                <th>Length</th>
                <th>Total impulse</th>
                <th>Avg. thrust</th>
                <th>Burn time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.digest + m.designation} className={sel?.digest === m.digest ? 'sel' : ''} onMouseDown={() => setSel(m)} onDoubleClick={() => Number.isFinite(d) && onChoose(m, d)}>
                  <td>{m.manufacturer}</td>
                  <td>{m.designation}</td>
                  <td className="num">{u.fmt('length', m.diameter)}</td>
                  <td className="num">{u.fmt('length', m.length)}</td>
                  <td className="num">{fmtNumber(m.totalImpulse, 1)} Ns</td>
                  <td className="num">{fmtNumber(m.avgThrust, 1)} N</td>
                  <td className="num">{fmtNumber(m.burnTime, 2)} s</td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={7} style={{ color: '#888', padding: 8 }}>
                    {err ?? 'No motors match.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>Ejection charge delay:</span>
          <input className="orw-field" style={{ width: 70 }} value={delay} onChange={(e) => setDelay(e.target.value)} aria-invalid={!Number.isFinite(d) || undefined} aria-label="Delay" />
          <span>seconds</span>
          <span style={{ flex: 1 }} />
          <Btn onClick={onCancel}>Cancel</Btn>
          <Btn isDefault disabled={!sel || !Number.isFinite(d)} onClick={() => sel && onChoose(sel, d)}>
            OK
          </Btn>
        </div>
      </div>
    </Window>
  )
}
