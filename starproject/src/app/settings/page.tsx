import { DigestSettings } from "@/components/settings/DigestSettings";
import { DisplayNameInput } from "@/components/settings/DisplayNameInput";
import { EmailPrefToggle } from "@/components/settings/EmailPrefToggle";
import { ThemeToggle } from "@/components/settings/ThemeToggle";
import { prisma } from "@/lib/db";
import { DIGEST_KINDS } from "@/lib/digest";
import { shortName } from "@/lib/names";
import { getCurrentSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { user, settings } = await getCurrentSettings();

  const [projects, subteams, subs] = await Promise.all([
    prisma.project.findMany({
      where: { archived: false },
      select: { id: true, name: true, parent: { select: { name: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.subteam.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.digestSubscription.findMany({
      where: { userId: user.id },
      select: { projectId: true, subteamId: true },
    }),
  ]);

  const projectOptions = projects.map((p) => ({
    id: p.id,
    label: p.parent ? `${p.parent.name} › ${p.name}` : p.name,
  }));
  const followedProjects = subs
    .map((s) => s.projectId)
    .filter((x): x is string => !!x);
  const followedSubteams = subs
    .map((s) => s.subteamId)
    .filter((x): x is string => !!x);

  const card = "rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 shadow-sm";

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <section className={`mt-6 ${card}`}>
        <h2 className="font-medium">Profile</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Display name — shown wherever your name appears. Defaults to your first
          name + last initial.
        </p>
        <div className="mt-3">
          <DisplayNameInput
            value={user.displayName ?? ""}
            placeholder={shortName(user.name, user.email)}
          />
        </div>
      </section>

      <section className={`mt-4 ${card}`}>
        <h2 className="font-medium">Appearance</h2>
        <div className="mt-3">
          <ThemeToggle theme={settings.theme} />
        </div>
      </section>

      <section className={`mt-4 ${card}`}>
        <h2 className="font-medium">Notifications</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">Email me when…</p>
        <div className="mt-3 space-y-3">
          <EmailPrefToggle
            field="emailAssignments"
            label="I'm assigned a task"
            value={settings.emailAssignments}
          />
          <EmailPrefToggle
            field="emailDueSoon"
            label="A task assigned to me is due soon"
            value={settings.emailDueSoon}
          />
          <EmailPrefToggle
            field="emailOverdue"
            label="A task assigned to me is overdue"
            value={settings.emailOverdue}
          />
        </div>
      </section>

      <section className={`mt-4 ${card}`}>
        <h2 className="font-medium">Daily digest</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          A nightly summary of what happened in the work you care about.
        </p>
        <div className="mt-3">
          <DigestSettings
            projects={projectOptions}
            subteams={subteams}
            followedProjects={followedProjects}
            followedSubteams={followedSubteams}
            kinds={settings.digestKinds}
            kindOptions={DIGEST_KINDS}
          />
        </div>
      </section>
    </div>
  );
}
