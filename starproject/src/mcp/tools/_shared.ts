import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { ZodError, type z } from "zod";

import { runAsIdentity, type CurrentUser } from "@/lib/auth";

// Shared plumbing for every MCP tool module. A module is a function that
// registers its tools on the server; src/mcp/tools/index.ts lists them.
//
// Conventions (see docs/MCP.md):
//   - mutations call the real server action in src/lib/actions/*; `toFormData`
//     builds the FormData those actions expect
//   - reads mirror the page query they stand in for
//   - handlers return plain JSON-serialisable data; `defineTool` wraps it as a
//     text result and turns any thrown error into an `isError` result

export type ToolModule = (server: McpServer) => void;

type Primitive = string | number | boolean | Date | null | undefined;

/**
 * FormData for a server action. `undefined` keys are omitted (the actions
 * treat presence as "set this field"), `null` becomes "" (how the UI clears a
 * field), arrays join with commas (`assigneeIds`), Dates become YYYY-MM-DD.
 */
export function toFormData(record: Record<string, Primitive | Primitive[]>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      fd.set(key, value.filter((v) => v !== undefined && v !== null).map(String).join(","));
    } else {
      fd.set(key, value === null ? "" : value instanceof Date ? value.toISOString().slice(0, 10) : String(value));
    }
  }
  return fd;
}

function serialise(data: unknown): string {
  return JSON.stringify(
    data === undefined ? null : data,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
}

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: serialise(data) }] };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** A readable one-line reason for whatever an action threw. */
export function describeError(err: unknown): string {
  if (err instanceof ZodError) {
    const f = err.flatten();
    const fields = Object.entries(f.fieldErrors)
      .map(([k, v]) => `${k}: ${(v ?? []).join(", ")}`)
      .join("; ");
    return ["Invalid input", fields, f.formErrors.join("; ")].filter(Boolean).join(" -- ");
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The path a Next `redirect()` error points at, or null if `err` is not one. */
export function redirectTarget(err: unknown): string | null {
  if (!err || typeof err !== "object" || !("digest" in err)) return null;
  const digest = String((err as { digest: unknown }).digest);
  if (!digest.startsWith("NEXT_REDIRECT")) return null;
  // "NEXT_REDIRECT;<type>;<url>;<status>;"
  return digest.split(";")[2] ?? "";
}

type Identity = { identity?: CurrentUser };

/**
 * Register one tool. The handler gets validated args and returns data; errors
 * become `isError` results rather than protocol failures so the client can show
 * them. The bearer identity the route attached as authInfo is re-entered here,
 * so actions see the right user even if the transport ran the handler outside
 * the route's async scope.
 */
export function defineTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  config: { description: string; inputSchema: Shape; annotations?: ToolAnnotations },
  handler: (args: z.objectOutputType<Shape, z.ZodTypeAny>) => Promise<unknown>,
): void {
  const cb = (async (args: z.objectOutputType<Shape, z.ZodTypeAny>, extra: { authInfo?: { extra?: Identity } }) => {
    const run = async () => {
      try {
        return ok(await handler(args));
      } catch (err) {
        const redirected = redirectTarget(err);
        // A server action that redirects after it succeeds (the web form's
        // createProject): the write happened, so this is a success, not an
        // error a client should retry. Modules should still prefer an action
        // that returns the record.
        if (redirected !== null) return ok({ done: true, redirectedTo: redirected });
        return fail(describeError(err));
      }
    };
    const identity = extra.authInfo?.extra?.identity;
    return identity ? runAsIdentity(identity, run) : run();
  }) as unknown as ToolCallback<Shape>;
  server.registerTool(name, config, cb);
}

export const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
export const IDEMPOTENT_WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
