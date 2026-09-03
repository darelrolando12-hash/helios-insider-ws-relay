/**
 * Shared error-formatting helper.
 *
 * `console.error(\`[Module] message:\`, e)` passes the error as a trailing
 * argument. Several places in this codebase log that way, and the deployed
 * log pipeline only captures the first (string) argument — the error object
 * itself silently disappears, so the log reads as "poll failed:" with
 * nothing after the colon. That looks like a captured error when nothing
 * was actually captured.
 *
 * Fix: interpolate the error into the template string directly, using this
 * helper everywhere a caught value is logged.
 */
export function formatError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
