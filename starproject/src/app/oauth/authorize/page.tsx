import { redirect } from "next/navigation";

import { decideAuthorization } from "@/lib/actions/oauth";
import { SCOPE_LABELS, checkAuthorize, describeRedirect, type AuthorizeParams } from "@/lib/oauth";
import { getCurrentDbUser } from "@/lib/user";

// OAuth consent for MCP clients (src/lib/oauth.ts). Cookie-gated like every page,
// so the person here has already passed the STAR login, and that login -- not
// whatever account the client is signed in with -- is who the token is for.

export const dynamic = "force-dynamic";

const FIELDS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
] as const;

export default async function Authorize({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const p: AuthorizeParams = {};
  for (const k of FIELDS) {
    const v = raw[k];
    if (typeof v === "string" && v !== "") p[k] = v;
  }

  const checked = await checkAuthorize(p);
  if (!checked.ok && "redirect" in checked) redirect(checked.redirect);

  const card = "rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 shadow-sm";
  if (!checked.ok) {
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-6 px-4 sm:px-6 py-6 sm:py-10">
        <h1 className="text-xl font-semibold">Can&apos;t connect</h1>
        <section className={card}>
          <p>{checked.fatal}</p>
        </section>
      </main>
    );
  }

  const { req } = checked;
  const user = await getCurrentDbUser();
  const access = SCOPE_LABELS[req.scope];

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 px-4 sm:px-6 py-6 sm:py-10">
      <h1 className="text-xl font-semibold">Connect {req.client.name}?</h1>

      <section className={card}>
        <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400">It will get</h2>
        <p className="mt-1 text-lg font-medium">{access.title}</p>
        <p className="text-neutral-600 dark:text-neutral-300">{access.detail}</p>
      </section>

      <section className={card}>
        <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400">As</h2>
        <p className="mt-1 text-lg font-medium">{user.email}</p>
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          The access goes back to <strong>{describeRedirect(req.redirectUri)}</strong>. It shows under Settings → API
          tokens, and revoking it there disconnects it.
        </p>
      </section>

      <form action={decideAuthorization} className="flex gap-3">
        {FIELDS.map((k) => (p[k] ? <input key={k} type="hidden" name={k} value={p[k]} /> : null))}
        <button
          type="submit"
          name="decision"
          value="allow"
          className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
        >
          Allow
        </button>
        <button
          type="submit"
          name="decision"
          value="deny"
          className="rounded-lg border border-neutral-300 px-4 py-2 font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          Deny
        </button>
      </form>
    </main>
  );
}
