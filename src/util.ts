/** Shared small helpers (no dependencies). */

export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Truncate a string to `max` chars, noting how long the original was. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}… [truncated, ${s.length} chars total]`;
}

/** Collapse whitespace so a value fits on one console/report line. */
export function toSingleLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
