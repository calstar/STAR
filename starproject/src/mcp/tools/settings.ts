import { z } from "zod";

import {
  setDigestKind,
  setDisplayName,
  setEmailPref,
  setTheme,
  toggleDigestProject,
  toggleDigestSubteam,
} from "@/lib/actions/settings";
import { prisma } from "@/lib/db";
import { DIGEST_KINDS } from "@/lib/digest";
import { displayNameOf, shortName } from "@/lib/names";
import { getProjectOptions } from "@/lib/projects";
import { getCurrentSettings } from "@/lib/settings";

import { IDEMPOTENT_WRITE, READ, WRITE, defineTool, type ToolModule } from "./_shared";

// The caller's own Settings page (src/app/settings/page.tsx): profile name,
// theme, email preferences and the nightly digest. Every setter goes through
// the server action the page's controls call and hands back the refreshed
// settings, so a client never has to follow a write with a read.

type Named = { id: string; name: string };
export type DigestFollows = { projects: Named[]; subteams: Named[] };

/**
 * A user's DigestSubscription rows, each joined to its project or subteam,
 * split into the two followed lists the page shows. A row whose target has
 * gone (null join) is dropped; each list is sorted by name for stable output.
 */
export function splitFollows(rows: { project: Named | null; subteam: Named | null }[]): DigestFollows {
  const byName = (a: Named, b: Named) => a.name.localeCompare(b.name);
  const projects: Named[] = [];
  const subteams: Named[] = [];
  for (const row of rows) {
    if (row.project) projects.push({ id: row.project.id, name: row.project.name });
    else if (row.subteam) subteams.push({ id: row.subteam.id, name: row.subteam.name });
  }
  return { projects: projects.sort(byName), subteams: subteams.sort(byName) };
}

/** The digest kind keys (`created`, `status`, …) as a zod enum, from DIGEST_KINDS. */
export const digestKindSchema = z.enum(DIGEST_KINDS.map(([kind]) => kind) as [string, ...string[]]);

const emailPrefSchema = z.enum(["emailAssignments", "emailDueSoon", "emailOverdue"]);

async function mySettings() {
  const { user, settings } = await getCurrentSettings();
  const [subs, projects, subteams] = await Promise.all([
    prisma.digestSubscription.findMany({
      where: { userId: user.id },
      select: {
        project: { select: { id: true, name: true } },
        subteam: { select: { id: true, name: true } },
      },
    }),
    getProjectOptions(),
    prisma.subteam.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      // The override set here; null means the default "First L." is in use.
      displayName: user.displayName,
      shownAs: displayNameOf(user),
      defaultName: shortName(user.name, user.email),
    },
    theme: settings.theme,
    emailAssignments: settings.emailAssignments,
    emailDueSoon: settings.emailDueSoon,
    emailOverdue: settings.emailOverdue,
    digestKinds: settings.digestKinds,
    digestKindOptions: DIGEST_KINDS,
    digestSubscription: splitFollows(subs),
    // What toggle_digest_project / toggle_digest_subteam accept, keyed by id. A
    // project's name here is its full path ("Parent / Sub"), as the page lists it.
    followable: { projects: projects.map(({ id, label }) => ({ id, name: label })), subteams },
  };
}

export const settingsTools: ToolModule = (server) => {
  defineTool(
    server,
    "get_my_settings",
    {
      description:
        "Your own settings, as on the Settings page: display name, theme, email preferences, digest kinds, " +
        "and the projects and subteams you follow for the nightly digest (plus the followable ones and the kind options).",
      inputSchema: {},
      annotations: READ,
    },
    async () => mySettings(),
  );

  defineTool(
    server,
    "set_theme",
    {
      description: "Set your theme to light or dark (Settings → Appearance). Returns the refreshed settings.",
      inputSchema: { theme: z.enum(["light", "dark"]) },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ theme }) => {
      await setTheme(theme);
      return mySettings();
    },
  );

  defineTool(
    server,
    "set_display_name",
    {
      description:
        "Set the name shown wherever yours appears (Settings → Profile). Up to 60 characters; " +
        "an empty string clears the override back to the default 'First L.'. Returns the refreshed settings.",
      inputSchema: { name: z.string().trim().max(60).describe("The display name, or '' to clear") },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ name }) => {
      await setDisplayName(name);
      return mySettings();
    },
  );

  defineTool(
    server,
    "set_email_pref",
    {
      description:
        "Turn one of your email notifications on or off (Settings → Notifications): emailAssignments " +
        "(I'm assigned a task), emailDueSoon, emailOverdue. Returns the refreshed settings.",
      inputSchema: { field: emailPrefSchema, value: z.boolean() },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ field, value }) => {
      await setEmailPref(field, value);
      return mySettings();
    },
  );

  defineTool(
    server,
    "set_digest_kind",
    {
      description:
        "Include or exclude one activity kind from your nightly digest (Settings → Daily digest → What to include). " +
        `Kinds: ${DIGEST_KINDS.map(([kind, label]) => `${kind} (${label})`).join(", ")}. Returns the refreshed settings.`,
      inputSchema: { kind: digestKindSchema, on: z.boolean() },
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ kind, on }) => {
      await setDigestKind(kind, on);
      return mySettings();
    },
  );

  defineTool(
    server,
    "toggle_digest_project",
    {
      description:
        "Follow or unfollow a project for your nightly digest (Settings → Daily digest → Follow projects). " +
        "A toggle: calling it twice restores the previous state. Returns whether you now follow it, plus the refreshed settings.",
      inputSchema: { projectId: z.string().min(1) },
      annotations: WRITE,
    },
    async ({ projectId }) => {
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
      if (!project) throw new Error("No such project");
      await toggleDigestProject(projectId);
      const settings = await mySettings();
      const following = settings.digestSubscription.projects.some((p) => p.id === projectId);
      return { projectId, following, settings };
    },
  );

  defineTool(
    server,
    "toggle_digest_subteam",
    {
      description:
        "Follow or unfollow a subteam for your nightly digest (Settings → Daily digest → Follow subteams). " +
        "A toggle: calling it twice restores the previous state. Returns whether you now follow it, plus the refreshed settings.",
      inputSchema: { subteamId: z.string().min(1) },
      annotations: WRITE,
    },
    async ({ subteamId }) => {
      const subteam = await prisma.subteam.findUnique({ where: { id: subteamId }, select: { id: true } });
      if (!subteam) throw new Error("No such subteam");
      await toggleDigestSubteam(subteamId);
      const settings = await mySettings();
      const following = settings.digestSubscription.subteams.some((s) => s.id === subteamId);
      return { subteamId, following, settings };
    },
  );
};
