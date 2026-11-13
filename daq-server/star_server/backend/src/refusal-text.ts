/**
 * The sequencer's reply, as an operator should read it.
 *
 * Replies are wire-shaped — "ERR:GN2 High has no fresh calibrated reading". The prefix is there
 * so the caller can branch on it, not so a human reads it in a notification, which is exactly
 * what happened once these started reaching the notification panel.
 *
 * Its own module so a test can exercise the real function: server.ts opens sockets at import, so
 * anything defined inside it can only be tested by copying it, and a copied function passes
 * forever while the original drifts.
 */
export function refusalText(reply: string): string {
    const trimmed = (reply ?? '').trim();
    return trimmed.startsWith('ERR:') ? trimmed.slice(4).trim() : trimmed;
}
