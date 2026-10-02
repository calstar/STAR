// The admin "Sign in to CalLink" button. An admin asks; callink-worker picks the
// request up within seconds, signs in with the stored CalNet account and Duo sends
// a push to the account owner's phone. A request nobody picked up goes stale rather
// than sending a surprise push later.

export const LOGIN_STATES = ["requested", "running", "waiting_duo", "ok", "failed"] as const;
export type LoginState = (typeof LOGIN_STATES)[number];

/** How long a request waits for the worker to take it up. */
export const LOGIN_PICKUP_MS = 2 * 60_000;
/** How long a sign-in may run (the worker waits 2 min for Duo, plus page loads). */
export const LOGIN_RUN_MS = 4 * 60_000;

export type LoginStatus = { loginState: string | null; loginRequestedAt: Date | null; loginUpdatedAt: Date | null; loginNote: string | null };

export type LoginView =
  | { kind: "idle" }
  | { kind: "busy"; text: string }
  | { kind: "done"; ok: boolean; text: string; at: Date };

/** What the banner shows for the latest sign-in request. */
export function loginView(s: LoginStatus | null, now: number): LoginView {
  if (!s?.loginState || !s.loginRequestedAt) return { kind: "idle" };
  const updated = (s.loginUpdatedAt ?? s.loginRequestedAt).getTime();
  switch (s.loginState) {
    case "requested":
      return now - s.loginRequestedAt.getTime() < LOGIN_PICKUP_MS
        ? { kind: "busy", text: "Waiting for the worker to start signing in…" }
        : { kind: "done", ok: false, text: "The worker didn't pick up the sign-in request. Is it running?", at: s.loginRequestedAt };
    case "running":
    case "waiting_duo":
      if (now - updated >= LOGIN_RUN_MS) return { kind: "done", ok: false, text: "The sign-in stopped reporting.", at: new Date(updated) };
      return { kind: "busy", text: s.loginState === "running" ? "Signing in to CalNet…" : "Duo push sent: approve it on your phone." };
    case "ok":
      return { kind: "done", ok: true, text: "Signed in.", at: new Date(updated) };
    default:
      return { kind: "done", ok: false, text: `Sign-in failed${s.loginNote ? `: ${s.loginNote}` : "."}`, at: new Date(updated) };
  }
}

/** May a new request start now? Not while one is still in flight. */
export function canRequestLogin(s: LoginStatus | null, now: number): boolean {
  return loginView(s, now).kind !== "busy";
}
