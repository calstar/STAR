/**
 * One plain sentence for a failed request, whatever shape the server sent.
 *
 * Backend errors are `{"detail": "<sentence>"}`, but not all of them: FastAPI's own validation
 * failures send `detail` as a list of `{loc, msg, type}` objects, and a proxy in front can answer
 * with no JSON at all. Handed straight to the page, a list rendered as "[object Object]" (or threw
 * inside React), and a fetch that never reached the server said "Failed to fetch". Every error
 * message the API client returns comes through here.
 */

interface ValidationItem {
  loc?: (string | number)[];
  msg?: string;
}

function sentence(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  if (!t) return t;
  const first = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(first) ? first : `${first}.`;
}

/** The field a validation item points at, as a person would name it ("lox pressure psi"). */
function fieldOf(item: ValidationItem): string {
  const loc = (item.loc ?? []).filter((p) => p !== 'body' && p !== 'query' && p !== 'path');
  const last = loc[loc.length - 1];
  return last === undefined ? '' : String(last).replace(/_/g, ' ');
}

const BY_STATUS: Record<number, string> = {
  400: 'The server could not use that request.',
  401: 'Sign in again to continue.',
  403: 'You do not have access to that.',
  404: 'That was not found on the server.',
  409: 'Someone changed this design since you opened it. Reload to see their version.',
  413: 'That file is too large.',
  422: 'Some of the values were not accepted.',
  423: 'Someone else is editing this design.',
  500: 'The server hit an error.',
  502: 'The engine design server is not answering.',
  503: 'The engine design server is busy or starting up. Try again in a moment.',
  504: 'The engine design server took too long to answer.',
};

/** `detail` from an error response (any shape), as one sentence. */
export function errorText(detail: unknown, status?: number): string {
  if (typeof detail === 'string' && detail.trim()) return sentence(detail);
  if (Array.isArray(detail) && detail.length > 0) {
    const items = detail as ValidationItem[];
    const first = items[0];
    const field = fieldOf(first);
    const msg = typeof first?.msg === 'string' ? first.msg : 'is not valid';
    const more = items.length > 1 ? ` (and ${items.length - 1} more)` : '';
    return sentence(field ? `${field}: ${msg}${more}` : `${msg}${more}`);
  }
  if (detail && typeof detail === 'object') {
    const o = detail as Record<string, unknown>;
    for (const k of ['message', 'detail', 'msg', 'error']) {
      if (o[k] !== undefined && o[k] !== detail) return errorText(o[k], status);
    }
  }
  if (status !== undefined) return BY_STATUS[status] ?? (status >= 500 ? BY_STATUS[500] : `The request failed (${status}).`);
  return 'Something went wrong.';
}

/** A thrown error from fetch or a parser, as one sentence. */
export function thrownText(err: unknown, fallback = 'Something went wrong.'): string {
  // fetch() rejects with a TypeError ("Failed to fetch", "Load failed", "NetworkError ...") when
  // the request never reached a server.
  if (err instanceof TypeError) return 'Could not reach the engine design server.';
  if (err instanceof Error && err.message) return sentence(err.message);
  return fallback;
}
