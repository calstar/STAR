import { useCallback, useEffect, useState } from 'react';
import { useControlMode } from '@/lib/control-mode';
import { commandSettled, commandView, newCommandId, type PendingCommand } from '@/lib/switch-command';
import { MessageType } from '@/lib/types';
import { getApiBaseUrl, getWebSocketClient } from '@/lib/websocket';
import { useSensorValue } from '@/lib/store';
import { resetReasonName, switchVerdict, FLAG_RESTORED, type VerdictLevel } from '@/lib/switch-verdict';

/** One [switch_roles.<key>] from config.toml. */
export interface SwitchRoleConfig { key: string; role: number; name: string; mac: string }

/** The switch list the DAQ sends the environmental board, sorted by role. */
export function switchRolesFromConfig(config: unknown): SwitchRoleConfig[] {
  const c = config as { switch_service?: { enabled?: unknown }; switch_roles?: Record<string, unknown> } | null;
  if (!c || c.switch_service?.enabled !== true || !c.switch_roles) return [];
  return Object.entries(c.switch_roles)
    .map(([key, raw]) => {
      const r = raw as { role?: unknown; name?: unknown; mac?: unknown };
      return { key, role: Number(r.role), name: typeof r.name === 'string' ? r.name : key, mac: String(r.mac ?? '') };
    })
    .filter((r) => Number.isInteger(r.role) && r.role >= 0 && r.role <= 4)
    .sort((a, b) => a.role - b.role);
}

function useSwitchRoles(): SwitchRoleConfig[] | null {
  const ws = getWebSocketClient();
  const [roles, setRoles] = useState<SwitchRoleConfig[] | null>(null);
  const load = useCallback(() => {
    fetch(`${getApiBaseUrl()}/api/config/running`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { config?: unknown } | null) => setRoles(switchRolesFromConfig(data?.config)))
      .catch(() => setRoles([]));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const unsub = ws.on(MessageType.CONFIG_UPDATED, load);
    return () => { unsub(); };
  }, [ws, load]);
  return roles;
}

const LEVEL_STYLE: Record<VerdictLevel, string> = {
  ok: 'border-green-600 bg-green-900/30 text-green-300',
  warn: 'border-amber-500 bg-amber-900/30 text-amber-200',
  bad: 'border-red-600 bg-red-700 text-white',
};

// A status older than this is shown as stale: the switch has said nothing new for a while
// (it notifies at least every 3 s, every 2 s while a central is connected).
const STALE_AGE_MS = 7000;

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </div>
  );
}

/** Arm / Disarm, with a confirm step. Needs control unlocked; the backend enforces it too. */
function SwitchControls({ sw, connected, output }: { sw: SwitchRoleConfig; connected: boolean; output: number | null }) {
  const { controlEnabled } = useControlMode();
  const [confirm, setConfirm] = useState<0 | 1 | null>(null);
  const [pending, setPending] = useState<PendingCommand | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const cmdId = useSensorValue(`SW${sw.role}`, 'cmd_id');
  const cmdResult = useSensorValue(`SW${sw.role}`, 'cmd_result');

  // The env board's answer to *this* command (it echoes our id).
  useEffect(() => {
    if (pending && pending.result == null && cmdId === pending.id && cmdResult != null) {
      setPending({ ...pending, result: cmdResult });
    }
  }, [pending, cmdId, cmdResult]);

  useEffect(() => {
    if (!pending) return;
    if (commandSettled(pending, output)) { setPending(null); return; }
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [pending, output]);

  const send = (o: 0 | 1) => {
    const id = newCommandId();
    setConfirm(null);
    setNow(Date.now());
    setPending({ id, output: o, sentAt: Date.now(), result: null });
    getWebSocketClient().sendCommand({ commandType: 'switch', data: { switchRole: sw.role, switchOutput: o, switchCommandId: id } });
  };

  const view = commandView(pending, output, now);
  const busy = view.kind === 'waiting';
  const disabled = !controlEnabled || !connected || busy;
  const why = !controlEnabled ? 'Unlock control as an approved operator to arm or disarm.'
    : !connected ? 'Not connected: a command would not be sent.' : null;

  return (
    <div className="mt-4 border-t border-gray-700 pt-3">
      {confirm === null ? (
        <div className="flex gap-2">
          <button type="button" disabled={disabled} onClick={() => setConfirm(1)}
            className="rounded bg-red-700 px-4 py-2 font-semibold text-white disabled:opacity-40">Arm</button>
          <button type="button" disabled={disabled} onClick={() => setConfirm(0)}
            className="rounded bg-gray-600 px-4 py-2 font-semibold text-white disabled:opacity-40">Disarm</button>
        </div>
      ) : (
        <div role="alertdialog" aria-label={`Confirm ${confirm ? 'arm' : 'disarm'}`} className="rounded border border-amber-500 p-3">
          <p className="mb-2 text-sm">
            {confirm
              ? `Arm ${sw.name}? This powers the altimeter. It stays armed until someone disarms it; losing the link does not disarm.`
              : `Disarm ${sw.name}? This cuts the altimeter's power.`}
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={() => send(confirm)}
              className="rounded bg-red-700 px-4 py-2 font-semibold text-white">{confirm ? 'Arm' : 'Disarm'} {sw.name}</button>
            <button type="button" onClick={() => setConfirm(null)} className="rounded bg-gray-600 px-4 py-2 text-white">Cancel</button>
          </div>
        </div>
      )}
      {why && <p className="mt-2 text-xs text-text-muted">{why}</p>}
      {view.kind === 'waiting' && <p className="mt-2 text-sm text-amber-300">{view.text}</p>}
      {view.kind === 'refused' && <p className="mt-2 text-sm text-amber-300">{view.text}</p>}
      {view.kind === 'fault' && <p className="mt-2 rounded bg-red-700 px-3 py-2 text-sm text-white">{view.text}</p>}
    </div>
  );
}

export function SwitchCard({ sw }: { sw: SwitchRoleConfig }) {
  const entity = `SW${sw.role}`;
  const link = useSensorValue(entity, 'link');
  const rssi = useSensorValue(entity, 'rssi');
  const age = useSensorValue(entity, 'age_ms');
  const valid = useSensorValue(entity, 'status_valid');
  const output = useSensorValue(entity, 'output');
  const sense = useSensorValue(entity, 'sense');
  const flags = useSensorValue(entity, 'flags');
  const supply = useSensorValue(entity, 'supply_mv');
  const current = useSensorValue(entity, 'current_ma');
  const uptime = useSensorValue(entity, 'uptime_s');
  const reset = useSensorValue(entity, 'reset_reason');

  const relayed = link != null;  // the env board is reporting this role
  const up = link === 1;
  const haveStatus = valid === 1 && output != null && sense != null && flags != null;
  const stale = !haveStatus || age == null || age >= STALE_AGE_MS;
  const verdict = haveStatus ? switchVerdict({ output: output!, sense: sense!, flags: flags! }) : null;

  return (
    <section className="rounded-lg border border-gray-700 bg-card p-4" aria-label={sw.name}>
      <header className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="text-lg font-semibold">{sw.name}</h2>
        <span className="font-mono text-xs text-text-muted">role {sw.role} · {sw.mac}</span>
      </header>

      <p className="mb-3 text-sm">
        {!relayed ? (
          <span className="text-text-muted">No report from the environmental board</span>
        ) : up ? (
          <span className="text-green-400">Connected{rssi != null && rssi !== 0 ? ` · ${rssi} dBm` : ''}</span>
        ) : (
          <span className="text-red-400">Not connected: the environmental board is looking for it</span>
        )}
      </p>

      <p className="mb-2 font-mono text-3xl font-semibold">
        {haveStatus ? (output ? 'ARMED' : 'DISARMED') : '—'}
        {haveStatus && stale && <span className="ml-3 align-middle text-sm font-normal text-amber-300">last known, {Math.round((age ?? 0) / 1000)} s old</span>}
      </p>

      {verdict && (
        <p className={`mb-3 rounded border px-3 py-2 text-sm ${LEVEL_STYLE[verdict.level]}`}>{verdict.text}</p>
      )}
      {relayed && valid === 0 && (
        <p className="mb-3 text-sm text-amber-300">No status from this switch yet (or a status version this DAQ can't read).</p>
      )}

      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Field label="Supply" value={supply != null && haveStatus ? `${(supply / 1000).toFixed(2)} V` : '—'} />
        <Field label="Current" value={current != null && haveStatus ? `${current} mA` : '—'} />
        <Field label="Uptime" value={uptime != null && haveStatus ? `${uptime} s` : '—'} />
        <Field label="Last reset" value={reset != null && haveStatus ? resetReasonName(reset) : '—'} />
      </dl>
      {haveStatus && (flags! & FLAG_RESTORED) !== 0 && (
        <p className="mt-3 text-sm text-amber-300">Output restored after an MCU reset.</p>
      )}
      <SwitchControls sw={sw} connected={up} output={haveStatus ? output : null} />
    </section>
  );
}

/** 0x58cf7901abcd -> "58:cf:79:01:ab:cd" */
export function formatMac(mac: number): string {
  return mac.toString(16).padStart(12, '0').match(/../g)!.join(':');
}

function SeenSlot({ slot, onSeen }: { slot: number; onSeen: (mac: number, rssi: number) => void }) {
  const mac = useSensorValue(`SWSEEN${slot}`, 'mac');
  const rssi = useSensorValue(`SWSEEN${slot}`, 'rssi');
  useEffect(() => {
    if (mac != null && rssi != null) onSeen(mac, rssi);
  }, [mac, rssi, onSeen]);
  return null;
}

const SCAN_MS = 10_000;

/** "Find switches": a 10 s scan on the env board for STAR switches not on the list, to bind one. */
function FindSwitches({ roles }: { roles: SwitchRoleConfig[] }) {
  const [scanUntil, setScanUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [found, setFound] = useState<Map<number, number>>(new Map());
  const scanning = now < scanUntil;
  useEffect(() => {
    if (!scanning) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [scanning]);
  const onSeen = useCallback((mac: number, rssi: number) => {
    setFound((prev) => (prev.get(mac) === rssi ? prev : new Map(prev).set(mac, rssi)));
  }, []);
  const listed = new Set(roles.map((r) => r.mac.toLowerCase()));
  const rows = [...found].filter(([mac]) => !listed.has(formatMac(mac)));

  const start = () => {
    setFound(new Map());
    setNow(Date.now());
    setScanUntil(Date.now() + SCAN_MS);
    getWebSocketClient().sendCommand({ commandType: 'switch_discover', data: {} });
  };

  return (
    <section className="mt-8 rounded-lg border border-gray-700 bg-card p-4" aria-label="Find switches">
      <div className="flex items-center gap-4">
        <button type="button" onClick={start} disabled={scanning}
          className="rounded bg-gray-600 px-4 py-2 text-white disabled:opacity-40">Find switches</button>
        <span className="text-sm text-text-muted">
          {scanning ? `Scanning… ${Math.ceil((scanUntil - now) / 1000)} s`
            : 'Lists STAR switches in range that are not configured. It connects to none of them.'}
        </span>
      </div>
      {[0, 1, 2, 3, 4, 5, 6, 7].map((slot) => <SeenSlot key={slot} slot={slot} onSeen={onSeen} />)}
      {rows.length > 0 && (
        <table className="mt-4 w-full text-sm">
          <thead><tr className="text-left text-text-muted"><th>Name</th><th>MAC</th><th>Signal</th></tr></thead>
          <tbody>
            {rows.map(([mac, rssi]) => (
              <tr key={mac}>
                <td className="font-mono">STAR-Switch-{formatMac(mac).slice(12, 14).toUpperCase()}{formatMac(mac).slice(15).toUpperCase()}</td>
                <td className="font-mono">{formatMac(mac)}</td>
                <td>{rssi} dBm</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > 0 && (
        <p className="mt-3 text-xs text-text-muted">
          To bind one, add it to config.toml: [switch_roles.&lt;key&gt;] with role, name and mac = &quot;{formatMac(rows[0][0])}&quot;.
        </p>
      )}
      {!scanning && scanUntil > 0 && rows.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">No unconfigured switches heard.</p>
      )}
    </section>
  );
}

export default function SwitchesPage() {
  const roles = useSwitchRoles();
  return (
    <main className="flex-1 overflow-auto bg-background p-6 text-text md:p-10">
      <h1 className="mb-2 font-mono text-[15px] font-semibold uppercase tracking-[0.32em] text-ink">Switches</h1>
      <p className="mb-6 text-text-muted">
        Bluetooth altimeter switches, relayed by the environmental board. What a card says is what the switch last reported.
      </p>
      {roles !== null && roles.length === 0 && (
        <p className="rounded-lg border border-gray-700 bg-card p-6">
          No switches configured. Turn on [switch_service] and add [switch_roles.*] in config.toml.
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {(roles ?? []).map((sw) => <SwitchCard key={sw.role} sw={sw} />)}
      </div>
      {roles !== null && roles.length > 0 && <FindSwitches roles={roles} />}
    </main>
  );
}
