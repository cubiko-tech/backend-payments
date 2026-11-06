/** Max characters of one external value inside a log line. */
const LOG_VALUE_MAX = 120

/**
 * Escapes a value that comes from outside (a provider, a request) before it goes into a log line.
 * Control characters become spaces, and `"` and `=` are percent-encoded, so the value can neither
 * start a new line nor close a quoted field and append forged `key=value` pairs (CWE-117).
 * Values longer than {@link LOG_VALUE_MAX} are cut and end in `…`.
 *
 * @param value - Any value; non-strings go through `String()`.
 * @returns The escaped value, safe to interpolate in a log line.
 */
export function escapeLogValue(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value)
  const clean = raw
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/"/g, '%22')
    .replace(/=/g, '%3D')

  return clean.length > LOG_VALUE_MAX ? `${clean.slice(0, LOG_VALUE_MAX)}…` : clean
}
