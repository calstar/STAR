import { type HostSummary, type Series, usePoll } from "../api";
import { Badge, UpBadge } from "../components/Badge";
import { Meter } from "../components/Meter";
import { Sparkline } from "../components/Sparkline";
import { ago, bytes, duration, pct, rate } from "../format";
import { linkClick } from "../router";
import { CARD, MUTED, PAGE_CONTAINER } from "../ui";

function HostCard({ h }: { h: HostSummary }) {
  const { data: s } = usePoll<Series>(`/api/hosts/${encodeURIComponent(h.host)}/series?range=1h`);
  const l = h.latest;
  const memPct = l && l.mem_total ? (100 * l.mem_used) / l.mem_total : null;
  const diskPct = l && l.disk_total ? (100 * l.disk_used) / l.disk_total : null;
  const swapPct = l && l.swap_total ? (100 * l.swap_used) / l.swap_total : null;
  const cpu = (s?.series.cpu ?? []) as (number | null)[];
  const mem = (s?.series.mem_used ?? []) as (number | null)[];

  return (
    <a href={`/hosts/${encodeURIComponent(h.host)}`} onClick={linkClick} className={`${CARD} block transition hover:border-neutral-300 dark:hover:border-neutral-700`}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{h.host}</h2>
        <UpBadge up={h.up} />
      </div>
      <dl className={`mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs ${MUTED}`}>
        <div>
          up <span className="text-neutral-700 dark:text-neutral-300">{duration(l?.uptime)}</span>
        </div>
        <div>last push {ago(h.last_seen)}</div>
        {h.deploy_commit && (
          <div title={h.deploy_at ?? ""}>
            deployed <code className="text-neutral-700 dark:text-neutral-300">{h.deploy_commit.slice(0, 7)}</code>
            {h.deploy_at && <> {ago(Date.parse(h.deploy_at))}</>}
          </div>
        )}
      </dl>

      <div className="mt-4 grid gap-3">
        <Meter label="CPU" value={l?.cpu ?? null} detail={`${pct(l?.cpu)} of ${l?.cores ?? "?"} cores · load ${l?.load1.toFixed(2) ?? "—"}`} />
        <Meter label="Memory" value={memPct} detail={`${bytes(l?.mem_used)} / ${bytes(l?.mem_total)}`} />
        <Meter label="Disk" value={diskPct} detail={`${bytes(l?.disk_used)} / ${bytes(l?.disk_total)}`} />
        {l && l.swap_total > 0 && <Meter label="Swap" value={swapPct} detail={`${bytes(l.swap_used)} / ${bytes(l.swap_total)}`} />}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className={MUTED}>CPU, last hour</div>
          <Sparkline values={cpu} max={100} width={160} height={32} fluid />
        </div>
        <div>
          <div className={MUTED}>Memory, last hour</div>
          <Sparkline values={mem} max={l?.mem_total} width={160} height={32} fluid />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-3 text-xs dark:border-neutral-800">
        <span>
          {h.containers.running}/{h.containers.total} containers running
        </span>
        {h.containers.unhealthy > 0 && <Badge tone="red">{h.containers.unhealthy} unhealthy</Badge>}
        <span className={`ml-auto ${MUTED}`}>
          ↓ {rate(l?.net_rx)} · ↑ {rate(l?.net_tx)}
        </span>
      </div>
    </a>
  );
}

export function Overview() {
  const { data, error } = usePoll<HostSummary[]>("/api/hosts");
  return (
    <main className={PAGE_CONTAINER}>
      <h1 className="text-2xl font-semibold">Servers</h1>
      <p className={`mt-1 text-sm ${MUTED}`}>Each box's agent pushes every 30 s; a box is down after 2 minutes of silence.</p>
      {error && <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {data && data.length === 0 && (
        <p className={`mt-6 text-sm ${MUTED}`}>No agent has reported yet. See server-analytics/README.md to start one.</p>
      )}
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {data?.map((h) => <HostCard key={h.host} h={h} />)}
      </div>
    </main>
  );
}
