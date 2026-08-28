import { EmailPrefToggle } from "@/components/settings/EmailPrefToggle";
import { ThemeToggle } from "@/components/settings/ThemeToggle";
import { getCurrentSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { settings } = await getCurrentSettings();

  const card = "rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 shadow-sm";

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <section className={`mt-6 ${card}`}>
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
        <p className="mt-4 text-sm text-neutral-400">
          Daily digest (follow projects/subteams + choose what to hear about) —
          coming next.
        </p>
      </section>
    </div>
  );
}
