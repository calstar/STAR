import { PAGE_CONTAINER } from "@/components/EntityRow";
import { CallinkLoginButton } from "@/components/finance/CallinkLoginButton";
import { FinanceWorkspace, NewReimbursementButton } from "@/components/finance/FinanceWorkspace";
import { prisma } from "@/lib/db";
import { formatWhen } from "@/lib/finance/dates";
import { loginView, type LoginStatus } from "@/lib/finance/login";
import { listFinanceRows, getViewer } from "@/lib/finance/queries";

export const dynamic = "force-dynamic";

export default async function FinancePage() {
  const viewer = await getViewer();
  const rows = await listFinanceRows(viewer);
  const worker = viewer.isAdmin ? await prisma.workerStatus.findUnique({ where: { id: "callink" } }) : null;
  const now = Date.now();
  const queued = rows.filter((r) => r.status.key === "approved").length;

  return (
    <main className={PAGE_CONTAINER}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Finance</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Reimbursements filed on CalLink for STAR, past and pending.
          </p>
        </div>
        <NewReimbursementButton />
      </div>
      {viewer.isAdmin && <WorkerBanner worker={worker} queued={queued} now={now} />}
      <FinanceWorkspace rows={rows} admin={viewer.isAdmin} />
    </main>
  );
}

const STALE_MS = 30 * 60_000;
const SOON_MS = 2 * 3600_000;

type Worker = LoginStatus & { session: string; sessionExpiresAt: Date | null; lastSeenAt: Date; lastScrapeAt: Date | null };

const TONE = {
  ok: "border-green-200 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950 dark:text-green-200",
  warn: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
  bad: "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
};

// Admins only: whether callink-worker has a live CalLink session. Logins last a
// fixed 24 h from sign-in, so this says when it runs out, and the button renews it
// (the worker signs in and Duo pushes to the CalNet account owner's phone).
function WorkerBanner({ worker, queued, now }: { worker: Worker | null; queued: number; now: number }) {
  let tone: keyof typeof TONE;
  let text: string;
  let renew = false;
  const expires = worker?.sessionExpiresAt?.getTime() ?? null;
  if (!worker) {
    tone = "warn";
    text = "The CalLink worker hasn't reported in yet.";
  } else if (now - worker.lastSeenAt.getTime() > STALE_MS) {
    tone = "warn";
    text = `The CalLink worker was last seen ${formatWhen(worker.lastSeenAt)}; its session status may be out of date.`;
  } else if (worker.session !== "ok" || (expires != null && expires <= now)) {
    tone = "bad";
    text = "CalLink session: needs a new login.";
    renew = true;
  } else if (expires != null && expires - now < SOON_MS) {
    tone = "warn";
    text = `CalLink session: signed in, but it runs out at ${formatWhen(new Date(expires))}.`;
    renew = true;
  } else {
    tone = "ok";
    text = expires != null ? `CalLink session: signed in until ${formatWhen(new Date(expires))}.` : "CalLink session: signed in.";
  }
  const login = loginView(worker, now);
  if (login.kind === "busy") tone = "warn";
  // A sign-in that finished in the last 10 minutes is worth mentioning.
  const recent = login.kind === "done" && now - login.at.getTime() < 10 * 60_000;
  return (
    <div className={`mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm ${TONE[tone]}`}>
      <div>
        <p>
          {text}
          {queued > 0 && ` ${queued} approved request${queued > 1 ? "s" : ""} waiting to be filed.`}
        </p>
        {login.kind === "busy" && <p className="mt-1 font-medium">{login.text}</p>}
        {recent && <p className="mt-1 text-xs">Last sign-in ({formatWhen(login.at)}): {login.text}</p>}
      </div>
      {worker && <CallinkLoginButton busy={login.kind === "busy"} label={renew ? "Sign in to CalLink" : "Renew CalLink login"} />}
    </div>
  );
}
