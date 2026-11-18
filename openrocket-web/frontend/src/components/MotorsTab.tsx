/**
 * "Motors & Configuration" (FlightConfigurationPanel): the configuration
 * buttons and three sub-tabs, each a configuration x component table --
 * Motors (MotorConfigurationPanel: motor + ignition per mount), Recovery
 * (RecoveryConfigurationPanel: deployment per device) and Stages
 * (SeparationConfigurationPanel: separation per stage above the sustainer) --
 * with OpenRocket's select / reset buttons, double-click to open the
 * selection dialog, and the dialogs' "all configurations / this configuration
 * only" choice, which decides whether the default or the override is edited.
 * The document logic is lib/flightconfig.ts.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { Api } from '../api/client'
import type { Component, MotorConfig, MotorSearchResult, Params, RocketDocument } from '../types'
import { Btn, Check, Combo, Group, Radio, Spinner, Tabs, Window } from './swing'
import { configLabel, motorLabel, motorMounts } from '../workbench/configs'
import { canMountMotor } from '../lib/rules'
import { walk, newId } from '../lib/tree'
import { motorMount } from '../lib/params'
import { useUnits } from '../workbench/units'
import { fmtNumber } from '../lib/units'
import {
  DEPLOY_EVENTS, IGNITION_EVENTS, SEPARATION_EVENTS, applyDeployment, applyIgnition, applySeparation, deleteConfig, deployEventsFor,
  duplicateConfig, eventOption, initialIgnitionScope, initialScope, motorIgnition, mountIgnition, newConfig,
  recoveryDevices, resetEvent, resetIgnition, resolveEvent, separableStages, stageList,
  type EventKind, type EventSetting, type IgnitionSetting, type Scope,
} from '../lib/flightconfig'

type Sub = 'motors' | 'recovery' | 'stages'
type Cell = { cfg: string; col: string } | null
type Dialog =
  | { kind: 'motor'; cfg: string; mount: Component }
  | { kind: 'ignition'; cfg: string; mount: Component }
  | { kind: 'deployment'; cfg: string; device: Component }
  | { kind: 'separation'; cfg: string; stage: Component }
  | { kind: 'rename'; cfg: MotorConfig }
  | null

type Apply = (fn: (d: RocketDocument) => RocketDocument, label: string) => void

export function MotorsTab({
  api, doc, apply, onParams, analysisInner,
}: {
  api: Api
  doc: RocketDocument
  apply: Apply
  onParams: (id: string, fn: (p: Params) => Params, key: string) => void
  /** Inner diameter per mount id, for the motor search's diameter filter. */
  analysisInner: (mount: Component) => number | null
}) {
  const u = useUnits()
  const [sub, setSub] = useState<Sub>('motors')
  const mounts = motorMounts(doc)
  const devices = recoveryDevices(doc)
  const stages = separableStages(doc)
  // OpenRocket opens with the selected configuration's first mount cell selected.
  const [motorCell, setMotorCell] = useState<Cell>(() => (mounts[0] && doc.selectedConfig ? { cfg: doc.selectedConfig, col: mounts[0].id } : null))
  const [recCell, setRecCell] = useState<Cell>(() => (devices[0] && doc.selectedConfig ? { cfg: doc.selectedConfig, col: devices[0].id } : null))
  const [sepCell, setSepCell] = useState<Cell>(() => (stages[0] && doc.selectedConfig ? { cfg: doc.selectedConfig, col: stages[0].id } : null))
  const [dialog, setDialog] = useState<Dialog>(null)
  const candidates: Component[] = []
  walk(doc.rocket, (c) => {
    if (canMountMotor(c.type)) candidates.push(c)
  })
  const hasCfg = (id: string | null | undefined) => !!id && doc.motorConfigs.some((c) => c.id === id)
  const live = (c: Cell, cols: Component[]): Cell => (c && hasCfg(c.cfg) && cols.some((x) => x.id === c.col) ? c : null)
  const mCell = live(motorCell, mounts)
  const rCell = live(recCell, devices)
  const sCell = live(sepCell, stages)
  const selCfg = hasCfg(doc.selectedConfig) ? doc.selectedConfig : null

  // FlightConfigurationPanel.updateButtonState: tabs need a motor mount (and a device / a second stage).
  const recoveryOk = mounts.length > 0 && devices.length > 0
  const stagesOk = mounts.length > 0 && stageList(doc).length > 1
  useEffect(() => {
    if ((sub === 'recovery' && !recoveryOk) || (sub === 'stages' && !stagesOk)) setSub('motors')
  }, [sub, recoveryOk, stagesOk])

  const selectConfig = (id: string) => {
    if (id !== doc.selectedConfig) apply((d) => ({ ...d, selectedConfig: id }), 'Select configuration')
  }
  const label = (id: string) => {
    const c = doc.motorConfigs.find((x) => x.id === id)
    return c ? configLabel(doc, c) : ''
  }

  const openFor = (s: Sub, cfg: string, col: string | undefined) => {
    if (s === 'motors') {
      const m = mounts.find((x) => x.id === col) ?? mounts[0]
      if (m) setDialog({ kind: 'motor', cfg, mount: m })
    } else if (s === 'recovery') {
      const r = devices.find((x) => x.id === col) ?? devices[0]
      if (r) setDialog({ kind: 'deployment', cfg, device: r })
    } else {
      const st = stages.find((x) => x.id === col) ?? stages[0]
      if (st) setDialog({ kind: 'separation', cfg, stage: st })
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '6px 6px 0' }} data-testid="motors-tab">
      <div style={{ display: 'flex', justifyContent: 'center', gap: 24, flex: 'none' }}>
        <Btn
          icon="icons/document-new.png"
          style={{ width: 172 }}
          disabled={mounts.length === 0}
          onClick={() => {
            // FlightConfigurationPanel.newOrDuplicateConfigAction: add, select, then open the
            // current sub-tab's selection dialog for it.
            const id = newId()
            apply((d) => ({ ...d, motorConfigs: [...d.motorConfigs, newConfig(d, id)], selectedConfig: id }), 'New configuration')
            const col = sub === 'motors' ? mCell?.col : sub === 'recovery' ? rCell?.col : sCell?.col
            if (sub === 'motors') setMotorCell({ cfg: id, col: col ?? mounts[0]?.id })
            if (sub === 'recovery') setRecCell({ cfg: id, col: col ?? devices[0]?.id })
            if (sub === 'stages') setSepCell({ cfg: id, col: col ?? stages[0]?.id })
            openFor(sub, id, col)
          }}
        >
          New Configuration
        </Btn>
        <Btn icon="icons/edit-rename.png" style={{ width: 192 }} disabled={!selCfg} onClick={() => {
          const c = doc.motorConfigs.find((x) => x.id === selCfg)
          if (c) setDialog({ kind: 'rename', cfg: c })
        }}>
          Rename Configuration
        </Btn>
        <Btn icon="icons/delete.png" style={{ width: 183 }} disabled={!selCfg} onClick={() => selCfg && apply((d) => deleteConfig(d, selCfg), 'Remove configuration(s)')}>
          Delete Configuration
        </Btn>
        <Btn icon="icons/edit-copy.png" style={{ width: 200 }} disabled={!selCfg} onClick={() => selCfg && apply((d) => duplicateConfig(d, selCfg, newId()), 'Duplicate configuration')}>
          Duplicate Configuration
        </Btn>
      </div>
      <Tabs
        tabs={[
          { id: 'motors', label: 'Motors' },
          { id: 'recovery', label: 'Recovery', disabled: !recoveryOk },
          { id: 'stages', label: 'Stages', disabled: !stagesOk },
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
            {mounts.length === 0 ? (
              <div style={{ padding: 8 }}>No motor mounts defined. Select one or more tubes from the list on the left as motor mounts.</div>
            ) : (
              <>
                <ConfigTable
                  testId="config-table"
                  height={146}
                  doc={doc}
                  cols={mounts}
                  cell={mCell}
                  onCell={(c) => {
                    setMotorCell(c)
                    selectConfig(c.cfg)
                  }}
                  onConfig={selectConfig}
                  onOpen={(c) => setDialog({ kind: 'motor', cfg: c.cfg, mount: mounts.find((m) => m.id === c.col)! })}
                  render={(cfg, m, sel) => <MotorCellView doc={doc} cfg={cfg} mount={m} sel={sel} />}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 8 }}>
                  <Btn style={{ width: 116 }} disabled={!mCell} onClick={() => mCell && setDialog({ kind: 'motor', cfg: mCell.cfg, mount: mounts.find((m) => m.id === mCell.col)! })}>
                    Select motor
                  </Btn>
                  <Btn
                    style={{ width: 116 }}
                    disabled={!mCell}
                    onClick={() =>
                      mCell &&
                      apply(
                        (d) => ({
                          ...d,
                          motorConfigs: d.motorConfigs.map((c) => {
                            if (c.id !== mCell.cfg || !c.motors[mCell.col]) return c
                            const motors = { ...c.motors }
                            delete motors[mCell.col]
                            return { ...c, motors }
                          }),
                        }),
                        'Delete motor(s)',
                      )
                    }
                  >
                    Delete motor
                  </Btn>
                  <Btn style={{ width: 116, marginLeft: 12 }} disabled={!mCell} onClick={() => mCell && setDialog({ kind: 'ignition', cfg: mCell.cfg, mount: mounts.find((m) => m.id === mCell.col)! })}>
                    Select ignition
                  </Btn>
                  <Btn style={{ width: 116 }} disabled={!mCell} onClick={() => mCell && apply((d) => resetIgnition(d, mCell.col, mCell.cfg), 'Reset ignition')}>
                    Reset ignition
                  </Btn>
                </div>
              </>
            )}
          </Group>
        </div>
      )}
      {sub === 'recovery' && (
        <EventPane
          testId="recovery-table"
          doc={doc}
          cols={devices}
          cell={rCell}
          setCell={(c) => {
            setRecCell(c)
            selectConfig(c.cfg)
          }}
          onConfig={selectConfig}
          onOpen={(c) => setDialog({ kind: 'deployment', cfg: c.cfg, device: devices.find((x) => x.id === c.col)! })}
          onReset={(c) => apply((d) => resetEvent(d, 'deployment', c.col, c.cfg), 'Reset deployment')}
          render={(cfg, c) => deploymentText(resolveEvent(c, 'deployment', cfg.id), u.fmt)}
          isDefault={(cfg, c) => resolveEvent(c, 'deployment', cfg.id).isDefault}
          selectLabel="Select deployment"
          resetLabel="Reset deployment"
          buttonWidth={144}
        />
      )}
      {sub === 'stages' && (
        <EventPane
          testId="separation-table"
          doc={doc}
          cols={stages}
          cell={sCell}
          setCell={(c) => {
            setSepCell(c)
            selectConfig(c.cfg)
          }}
          onConfig={selectConfig}
          onOpen={(c) => setDialog({ kind: 'separation', cfg: c.cfg, stage: stages.find((x) => x.id === c.col)! })}
          onReset={(c) => apply((d) => resetEvent(d, 'separation', c.col, c.cfg), 'Reset separation')}
          render={(cfg, c) => separationText(resolveEvent(c, 'separation', cfg.id), u.fmt)}
          isDefault={(cfg, c) => resolveEvent(c, 'separation', cfg.id).isDefault}
          selectLabel="Select separation"
          resetLabel="Reset separation"
          buttonWidth={136}
        />
      )}

      {dialog?.kind === 'motor' && (
        <MotorChooser
          api={api}
          mount={dialog.mount}
          diameter={analysisInner(dialog.mount)}
          current={doc.motorConfigs.find((c) => c.id === dialog.cfg)?.motors[dialog.mount.id] ?? null}
          onCancel={() => setDialog(null)}
          onChoose={(m, delay) => {
            const { cfg, mount } = dialog
            apply(
              (d) => ({
                ...d,
                motorConfigs: d.motorConfigs.map((c) => {
                  if (c.id !== cfg) return c
                  // MotorConfigurationPanel.selectMotor: a new MotorConfiguration from the cell's
                  // current one, so an existing motor keeps its ignition; an empty cell takes the mount's.
                  const prev = c.motors[mount.id]
                  const ign = prev ? { event: prev.ignitionEvent ?? 'automatic', delay: prev.ignitionDelay ?? 0 } : mountIgnition(mount)
                  return {
                    ...c,
                    motors: {
                      ...c.motors,
                      [mount.id]: {
                        designation: m.designation, manufacturer: m.manufacturer, digest: m.digest, delay,
                        ignitionEvent: ign.event, ignitionDelay: ign.delay,
                      },
                    },
                  }
                }),
              }),
              'Select motor',
            )
            setDialog(null)
          }}
        />
      )}
      {dialog?.kind === 'ignition' && (
        <IgnitionDialog
          configName={label(dialog.cfg)}
          initial={motorIgnition(doc, dialog.cfg, dialog.mount) ?? mountIgnition(dialog.mount)}
          scope={initialIgnitionScope(doc, dialog.mount.id, dialog.cfg)}
          onCancel={() => setDialog(null)}
          onOk={(s, scope) => {
            const { cfg, mount } = dialog
            apply((d) => applyIgnition(d, mount.id, cfg, s, scope), 'Select ignition')
            setDialog(null)
          }}
        />
      )}
      {dialog?.kind === 'deployment' && (
        <EventDialog
          kind="deployment"
          title="Select Deployment Configuration"
          eventLabel="Deploys at:"
          options={deployEventsFor(doc, dialog.device.id)}
          configName={label(dialog.cfg)}
          initial={resolveEvent(dialog.device, 'deployment', dialog.cfg)}
          scope={initialScope(dialog.device, 'deployment', dialog.cfg)}
          onCancel={() => setDialog(null)}
          onOk={(s, scope) => {
            const { cfg, device } = dialog
            apply((d) => applyDeployment(d, device.id, cfg, s, scope), 'Select deployment')
            setDialog(null)
          }}
        />
      )}
      {dialog?.kind === 'separation' && (
        <EventDialog
          kind="separation"
          title="Select Separation Configuration"
          eventLabel="Upper stage separates at:"
          options={SEPARATION_EVENTS}
          configName={label(dialog.cfg)}
          initial={resolveEvent(dialog.stage, 'separation', dialog.cfg)}
          scope={initialScope(dialog.stage, 'separation', dialog.cfg)}
          onCancel={() => setDialog(null)}
          onOk={(s, scope) => {
            const { cfg, stage } = dialog
            apply((d) => applySeparation(d, stage.id, cfg, s, scope), 'Select separation')
            setDialog(null)
          }}
        />
      )}
      {dialog?.kind === 'rename' && (
        <Window title="Rename Configuration" onClose={() => setDialog(null)} initial={{ x: 480, y: 160 }} width={470} modal zIndex={70}>
          <RenameForm
            initial={dialog.cfg.name}
            onCancel={() => setDialog(null)}
            onOk={(name) => {
              const id = dialog.cfg.id
              apply((d) => ({ ...d, motorConfigs: d.motorConfigs.map((c) => (c.id === id ? { ...c, name } : c)) }), 'Rename configuration(s)')
              setDialog(null)
            }}
          />
        </Window>
      )}
    </div>
  )
}

type Fmt = (kind: 'altitude' | 'time', si: number) => string

/** RecoveryTableCellRenderer.getDeploymentSpecification. */
export function deploymentText(s: EventSetting, fmt: Fmt): string {
  let str = eventOption(DEPLOY_EVENTS, s.event).short
  if (s.event === 'altitude') str += ` ${fmt('altitude', s.altitude)}`
  if (s.delay > 0.001) str += ` + ${fmt('time', s.delay)}`
  return str
}
/** SeparationTableCellRenderer.getSeparationSpecification: the event's full name, no altitude. */
export function separationText(s: EventSetting, fmt: Fmt): string {
  let str = eventOption(SEPARATION_EVENTS, s.event).label
  if (s.delay > 0.001) str += ` + ${fmt('time', s.delay)}`
  return str
}

/** MotorTableCellRenderer.getIgnitionEventString (without the "Default (...)" wrapper). */
export function ignitionText(s: IgnitionSetting, fmt: Fmt): string {
  let str = eventOption(IGNITION_EVENTS, s.event).short
  if (s.event !== 'never' && s.delay > 0.001) str += ` + ${fmt('time', s.delay)}`
  return str
}

function MotorCellView({ doc, cfg, mount, sel }: { doc: RocketDocument; cfg: MotorConfig; mount: Component; sel: boolean }) {
  const u = useUnits()
  const mc = cfg.motors[mount.id]
  const ign = motorIgnition(doc, cfg.id, mount)
  if (mc && ign) {
    return (
      <>
        {motorLabel(mc)}
        <span style={{ display: 'inline-block', width: 12 }} />
        {ignitionText(ign, u.fmt)}
      </>
    )
  }
  // An empty cell shows the mount's default ignition, shaded: "None   Default (Automatic)".
  return (
    <>
      None
      <span style={{ display: 'inline-block', width: 12 }} />
      <span style={{ fontStyle: 'italic', color: sel ? '#f4f4f4' : 'var(--or-text-dim)' }}>Default ({ignitionText(mountIgnition(mount), u.fmt)})</span>
    </>
  )
}

/** FlightConfigurableTableModel in a scroll pane: Configuration + one column per component. */
function ConfigTable({
  testId, height, doc, cols, cell, onCell, onConfig, onOpen, render, shaded,
}: {
  testId: string
  height: number | string
  doc: RocketDocument
  cols: Component[]
  cell: Cell
  onCell: (c: { cfg: string; col: string }) => void
  onConfig: (id: string) => void
  onOpen: (c: { cfg: string; col: string }) => void
  render: (cfg: MotorConfig, col: Component, sel: boolean) => ReactNode
  shaded?: (cfg: MotorConfig, col: Component) => boolean
}) {
  return (
    <div style={{ background: 'white', border: '1px solid #d6d6d6', height, overflow: 'auto' }}>
      <table className="orw-table orw-cfgtable" data-testid={testId} style={{ tableLayout: 'fixed' }}>
        <thead>
          <tr>
            <th>Configuration</th>
            {cols.map((m) => (
              <th key={m.id}>{m.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {doc.motorConfigs.map((cfg) => (
            <tr key={cfg.id}>
              <td onMouseDown={() => onConfig(cfg.id)}>
                {configLabel(doc, cfg)}
              </td>
              {cols.map((m) => {
                const sel = cell?.cfg === cfg.id && cell.col === m.id
                const dim = !sel && shaded?.(cfg, m)
                return (
                  <td
                    key={m.id}
                    data-cfg={cfg.id}
                    data-col={m.id}
                    style={sel ? { background: 'var(--or-select)', color: 'white' } : dim ? { color: 'var(--or-text-dim)' } : undefined}
                    onMouseDown={() => onCell({ cfg: cfg.id, col: m.id })}
                    onDoubleClick={() => onOpen({ cfg: cfg.id, col: m.id })}
                  >
                    {render(cfg, m, sel)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The Recovery and Stages sub-tabs: the table, then Select / Reset at the right. */
function EventPane({
  testId, doc, cols, cell, setCell, onConfig, onOpen, onReset, render, isDefault, selectLabel, resetLabel, buttonWidth,
}: {
  testId: string
  doc: RocketDocument
  cols: Component[]
  cell: Cell
  setCell: (c: { cfg: string; col: string }) => void
  onConfig: (id: string) => void
  onOpen: (c: { cfg: string; col: string }) => void
  onReset: (c: { cfg: string; col: string }) => void
  render: (cfg: MotorConfig, c: Component) => string
  isDefault: (cfg: MotorConfig, c: Component) => boolean
  selectLabel: string
  resetLabel: string
  buttonWidth: number
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', padding: '6px 6px 0', flex: 1, minHeight: 0 }}>
      <ConfigTable
        testId={testId}
        height={188}
        doc={doc}
        cols={cols}
        cell={cell}
        onCell={setCell}
        onConfig={onConfig}
        onOpen={onOpen}
        render={(cfg, c) => render(cfg, c)}
        shaded={isDefault}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
        <Btn style={{ width: buttonWidth }} disabled={!cell} onClick={() => cell && onOpen(cell)}>
          {selectLabel}
        </Btn>
        <Btn style={{ width: buttonWidth }} disabled={!cell} onClick={() => cell && onReset(cell)}>
          {resetLabel}
        </Btn>
      </div>
    </div>
  )
}

function ScopeRadios({ what, configName, scope, setScope }: { what: string; configName: string; scope: Scope; setScope: (s: Scope) => void }) {
  return (
    <>
      <div>Which flight configurations are affected:</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 20, margin: '8px 0 14px' }}>
        <Radio name="scope" label={`Change all configurations using the default ${what} event`} checked={scope === 'all'} onChange={() => setScope('all')} />
        <Radio name="scope" label={`Override for the ${configName} flight configuration only`} checked={scope === 'config'} onChange={() => setScope('config')} />
      </div>
    </>
  )
}

function OkCancel({ onOk, onCancel }: { onOk: () => void; onCancel: () => void }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 16 }}>
      <Btn isDefault style={{ width: 72 }} onClick={onOk}>
        OK
      </Btn>
      <Btn style={{ width: 72 }} onClick={onCancel}>
        Cancel
      </Btn>
    </div>
  )
}

/** IgnitionSelectionDialog. */
function IgnitionDialog({ configName, initial, scope: scope0, onOk, onCancel }: {
  configName: string
  initial: IgnitionSetting
  scope: Scope
  onOk: (s: IgnitionSetting, scope: Scope) => void
  onCancel: () => void
}) {
  const [scope, setScope] = useState<Scope>(scope0)
  const [s, setS] = useState<IgnitionSetting>(initial)
  return (
    <Window title="Select Ignition Configuration" onClose={onCancel} initial={{ x: 700, y: 420 }} width={450} modal zIndex={70}>
      <div style={{ padding: '6px 6px 8px' }} data-testid="ignition-dialog">
        <ScopeRadios what="ignition" configName={configName} scope={scope} setScope={setScope} />
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', alignItems: 'center', columnGap: 6, rowGap: 6 }}>
          <span>Ignition at:</span>
          <Combo value={s.event} options={IGNITION_EVENTS.map(({ value, label }) => ({ value, label }))} onChange={(v) => setS({ ...s, event: v })} style={{ width: '100%' }} />
          <span />
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 10 }}>
            plus
            <Spinner value={s.delay} kind="none" min={0} width={66} onChange={(v) => setS({ ...s, delay: v })} ariaLabel="Ignition delay" />
            seconds
          </span>
        </div>
        <OkCancel onOk={() => onOk(s, scope)} onCancel={onCancel} />
      </div>
    </Window>
  )
}

/** DeploymentSelectionDialog / SeparationSelectionDialog. */
function EventDialog({ kind, title, eventLabel, options, configName, initial, scope: scope0, onOk, onCancel }: {
  kind: EventKind
  title: string
  eventLabel: string
  options: { value: string; label: string }[]
  configName: string
  initial: EventSetting
  scope: Scope
  onOk: (s: EventSetting, scope: Scope) => void
  onCancel: () => void
}) {
  const [scope, setScope] = useState<Scope>(scope0)
  const [s, setS] = useState<EventSetting>({ event: initial.event, altitude: initial.altitude, delay: initial.delay })
  const altOn = kind === 'deployment' ? s.event === 'altitude' : s.event === 'altitudeascending' || s.event === 'altitudedescending'
  return (
    <Window title={title} onClose={onCancel} initial={{ x: 700, y: 420 }} width={kind === 'deployment' ? 456 : 450} modal zIndex={70}>
      <div style={{ padding: '6px 6px 8px' }} data-testid={`${kind}-dialog`}>
        <ScopeRadios what={kind} configName={configName} scope={scope} setScope={setScope} />
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', alignItems: 'center', columnGap: 6, rowGap: 6 }}>
          <span>{eventLabel}</span>
          <Combo value={s.event} options={options.map(({ value, label }) => ({ value, label }))} onChange={(v) => setS({ ...s, event: v })} style={{ width: '100%' }} />
          <span style={{ color: altOn ? undefined : 'var(--or-disabled-text)' }}>Altitude:</span>
          <Spinner value={s.altitude} kind="altitude" min={0} width={60} disabled={!altOn} slider={[100, 1000]} sliderWidth={80} onChange={(v) => setS({ ...s, altitude: v })} ariaLabel="Altitude" />
          <span style={{ textAlign: 'right' }}>plus</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Spinner value={s.delay} kind="none" min={0} width={66} onChange={(v) => setS({ ...s, delay: v })} ariaLabel="Delay" />
            seconds
          </span>
        </div>
        <OkCancel onOk={() => onOk(s, scope)} onCancel={onCancel} />
      </div>
    </Window>
  )
}

/** RenameConfigDialog. */
function RenameForm({ initial, onOk, onCancel }: { initial: string; onOk: (s: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial)
  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span>Name for flight configuration:</span>
      <input className="orw-field" autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onOk(v)} aria-label="Configuration name" />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <Btn isDefault onClick={() => onOk(v)}>
          OK
        </Btn>
        <Btn onClick={() => onOk('')} title="Name it after its motors again">
          Reset to default
        </Btn>
        <Btn onClick={onCancel}>Cancel</Btn>
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
