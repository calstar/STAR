import Link from "next/link";

import { PAGE_CONTAINER } from "@/components/EntityRow";
import { ReimbursementForm } from "@/components/finance/ReimbursementForm";
import { getProfileDefaults } from "@/lib/finance/queries";
import { getProjectOptions } from "@/lib/projects";
import { getSubteams } from "@/lib/subteams";
import { getCurrentDbUser } from "@/lib/user";

export const dynamic = "force-dynamic";

export default async function NewReimbursementPage() {
  const user = await getCurrentDbUser();
  const [profile, projects, subteams] = await Promise.all([getProfileDefaults(user), getProjectOptions(), getSubteams()]);

  return (
    <main className={PAGE_CONTAINER}>
      <div className="mx-auto max-w-3xl">
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        <Link href="/reimbursements" className="hover:underline">
          Reimbursements
        </Link>{" "}
        / New reimbursement
      </p>
      <h1 className="mt-2 text-2xl font-semibold">New reimbursement</h1>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        An admin reviews it, then it is filed on CalLink for you. Up to six receipts per request.
      </p>
      <ReimbursementForm
        defaults={profile.values}
        seededFrom={profile.seededFrom}
        accountEmail={user.email}
        projects={projects}
        subteams={subteams.map((s) => ({ id: s.id, name: s.name }))}
      />
      </div>
    </main>
  );
}
