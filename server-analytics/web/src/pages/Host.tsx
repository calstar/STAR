import { useMemo, useState } from "react";

import { type Container, type HostSummary, RANGE_MS, RANGES, type Range, type Series, usePoll } from "../api";
import { StateBadge, UpBadge } from "../components/Badge";
import { Chart, type Line } from "../components/Chart";
import { Sparkline } from "../components/Sparkline";
import { bytes, duration, pct, rate } from "../format";
import { linkClick } from "../router";
import { BUTTON, MUTED, PAGE_CONTAINER, TABLE_WRAP, TD, TH } from "../ui";

const pctFmt = (v: number) => `${v.toFixed(0)}%`;
const loadFmt = (v: number) => v.toFixed(2);

function RangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded border border-neutral-300 text-sm dark:border-neutral-700">
      {RANGES.map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={`px-2.5 py-1 ${
            r === value
              ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
              : "bg-white hover:bg-neutral-50 dark:bg-neutral-900 dark:hover:bg-neutral-800"
          }`}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

const nums = (c: (number | null)[] | undefined) => (c ?? []) as (number | null)[];

function ContainerChart({ host, name, range }: { host: string; name: string; range: Range }) {
  const { data } = usePoll<Series>(`/api/hosts/${encodeURIComponent(host)}/containers/${encodeURIComponent(name)}/series?range=${range}`);
  const ts = (data?.series.ts ?? []) as number[];
  const cpu = useMemo<Line[]>(() => [{ label: "CPU", values: nums(data?.series.cpu), slot: 1 }], [data]);
  const mem = useMemo<Line[]>(() => [{ label: "Memory", values: nums(data?.series.mem_used), slot: 1 }], [data]);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Chart title={`${name} · CPU (100% = one core)`} ts={ts} lines={cpu} fmt={pctFmt} span={RANGE_MS[range]} height={150} />
      <Chart title={`${name} · Memory`} ts={ts} lines={mem} fmt={bytes} span={RANGE_MS[range]} height={150} />
    </div>
  );
}

export function Host({ host }: { host: string }) {
  const [range, setRange] = useState<Range>("6h");
  const [picked, setPicked] = useState<string | null>(null);
  const enc = encodeURIComponent(host);
  const { data: hosts } = usePoll<HostSummary[]>("/api/hosts");
  const { data: s, error } = usePoll<Series>(`/api/hosts/${enc}/series?range=${range}`);
  const { data: cts } = usePoll<Container[]>(`/api/hosts/${enc}/containers`);
  const h = hosts?.find((x) => x.host === host);
  const l = h?.latest;

  const ts = (s?.series.ts ?? []) as number[];
  const span = RANGE_MS[range];
  const lines = useMemo(() => {
    const c = s?.series;
    return {
      cpu: [
        { label: "Average", values: nums(c?.cpu), slot: 1 },
        { label: "Peak", values: nums(c?.cpu_max), slot: 2 },
      ] as Line[],
      mem: [
        { label: "Used", values: nums(c?.mem_used), slot: 1 },
        { label: "Swap", values: nums(c?.swap_used), slot: 2 },
      ] as Line[],
      load: [
        { label: "1 min", values: nums(c?.load1), slot: 1 },
        { label: "5 min", values: nums(c?.load5), slot: 2 },
        { label: "15 min", values: nums(c?.load15), slot: 3 },
      ] as Line[],
      disk: [{ label: "Used", values: nums(c?.disk_used), slot: 1 }] as Line[],
      net: [
        { label: "Received", values: nums(c?.net_rx), slot: 1 },
        { label: "Sent", values: nums(c?.net_tx), slot: 2 },
      ] as Line[],
    };
  }, [s]);

  return (
    <main className={PAGE_CONTAINER}>
      <a href="/" onClick={linkClick} className={`text-sm ${MUTED} hover:underline`}>
        ← Servers
      </a>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{host}</h1>
          {h && <UpBadge up={h.up} />}
          <span className={`text-sm ${MUTED}`}>
            up {duration(l?.uptime)} · {l?.cores ?? "?"} cores · {bytes(l?.mem_total)} RAM
          </span>
        </div>
        <RangePicker value={range} onChange={setRange} />
      </div>
      {error && <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {s && (
        <p className={`mt-1 text-xs ${MUTED}`}>
          Each point is a {s.bucket_ms >= 60000 ? `${s.bucket_ms / 60000}-minute` : `${s.bucket_ms / 1000}-second`} average
          {range === "1h" || range === "6h" || range === "24h" ? "" : " of 5-minute rollups"}.
        </p>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Chart title="CPU" ts={ts} lines={lines.cpu} fmt={pctFmt} yMax={100} span={span} />
        <Chart title="Memory" ts={ts} lines={lines.mem} fmt={bytes} yMax={l?.mem_total || undefined} span={span} />
        <Chart title="Load average" ts={ts} lines={lines.load} fmt={loadFmt} span={span} />
        <Chart title="Network" ts={ts} lines={lines.net} fmt={rate} span={span} />
        <Chart title="Disk used" ts={ts} lines={lines.disk} fmt={bytes} yMax={l?.disk_total || undefined} span={span} />
      </div>

      <h2 className="mt-8 text-lg font-semibold">Containers</h2>
      <p className={`text-xs ${MUTED}`}>CPU is percent of one core, as docker stats reports it. Sparklines cover the last hour. Click a row for its history.</p>
      <div className={`${TABLE_WRAP} mt-3`}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-200 dark:border-neutral-800">
              <th className={TH}>Name</th>
              <th className={TH}>State</th>
              <th className={`${TH} text-right`}>Restarts</th>
              <th className={`${TH} text-right`}>CPU</th>
              <th className={TH}>CPU, 1h</th>
              <th className={`${TH} text-right`}>Memory</th>
              <th className={TH}>Memory, 1h</th>
            </tr>
          </thead>
          <tbody>
            {cts?.map((c) => (
              <tr
                key={c.name}
                onClick={() => setPicked(picked === c.name ? null : c.name)}
                className={`cursor-pointer border-b border-neutral-100 last:border-0 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800/60 ${
                  picked === c.name ? "bg-neutral-50 dark:bg-neutral-800/60" : ""
                }`}
              >
                <td className={TD}>
                  <div className="font-medium">{c.name}</div>
                  <div className={`max-w-[18rem] truncate text-xs ${MUTED}`} title={c.image}>
                    {c.image}
                  </div>
                </td>
                <td className={TD}>
                  <StateBadge state={c.state} health={c.health} />
                </td>
                <td className={`${TD} text-right tabular-nums`}>{c.restarts}</td>
                <td className={`${TD} text-right tabular-nums`}>{c.state === "running" ? pct(c.cpu, 1) : "—"}</td>
                <td className={TD}>
                  <Sparkline values={nums(c.spark.cpu)} floor={10} />
                </td>
                <td className={`${TD} text-right tabular-nums`}>
                  {c.state === "running" ? bytes(c.mem_used) : "—"}
                  {c.mem_limit > 0 && <span className={MUTED}> / {bytes(c.mem_limit)}</span>}
                </td>
                <td className={TD}>
                  <Sparkline values={nums(c.spark.mem_used)} max={c.mem_limit || undefined} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {cts && cts.length === 0 && <p className={`p-4 text-sm ${MUTED}`}>No containers reported.</p>}
      </div>

      {picked && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium">{picked}</h3>
            <div className="flex gap-2">
              <a href={`/logs?host=${enc}&source=${encodeURIComponent("docker:" + picked)}`} onClick={linkClick} className={BUTTON}>
                Logs
              </a>
              <button onClick={() => setPicked(null)} className={BUTTON}>
                Close
              </button>
            </div>
          </div>
          <ContainerChart host={host} name={picked} range={range} />
        </div>
      )}
    </main>
  );
}
