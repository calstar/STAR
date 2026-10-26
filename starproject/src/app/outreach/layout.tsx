import { PAGE_CONTAINER } from "@/components/EntityRow";
import { OutreachTabs } from "@/components/outreach/OutreachTabs";
import { outreachViewer } from "@/lib/outreach/queries";

export const dynamic = "force-dynamic";

// The outreach CRM is admins only: it holds donors' contact details, home
// addresses and gift amounts. The gate is here for every /outreach page, and
// again on every server action (requireAdmin), so a typed URL or a crafted
// request gets nothing.
export default async function OutreachLayout({ children }: { children: React.ReactNode }) {
  const { admin } = await outreachViewer();
  if (!admin) {
    return (
      <main className={PAGE_CONTAINER}>
        <h1 className="text-2xl font-semibold">Outreach</h1>
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          The outreach CRM is open to admins only, because it holds donors&apos; contact details and gifts. Ask an
          admin (Workspace setup → Admins) if you need access.
        </div>
      </main>
    );
  }
  return (
    <main className={PAGE_CONTAINER}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Outreach</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">Sponsors, donors and mailing lists. Admins only.</p>
      </div>
      <OutreachTabs />
      {children}
    </main>
  );
}
