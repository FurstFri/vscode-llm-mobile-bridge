/**
 * Providers report "last updated" in whatever shape their storage happens to
 * use: epoch milliseconds, epoch seconds, or an ISO-8601 string. Reading one
 * as another is how a session ends up rendered as 1970 on the phone, so every
 * timestamp entering the gateway goes through here.
 */

/**
 * Anything older than 2001-01-01 is treated as missing. No Claude or Codex
 * transcript predates the tools themselves, so such a value can only come from
 * a zero, an empty string, or a unit mix-up.
 */
const MIN_PLAUSIBLE_MS = 978_307_200_000;

/** Below this a numeric timestamp has to be seconds — 1e12 ms is year 2001. */
const SECONDS_CEILING = 1e12;

/** Guards against a far-future value from a wrong unit, e.g. microseconds. */
const MAX_PLAUSIBLE_MS = 4_102_444_800_000;

export function parseTimestamp(value: unknown): number | undefined {
  const millis = toMillis(value);
  if (millis === undefined) return undefined;
  if (!Number.isFinite(millis)) return undefined;
  if (millis < MIN_PLAUSIBLE_MS || millis > MAX_PLAUSIBLE_MS) return undefined;
  return Math.round(millis);
}

function toMillis(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (value <= 0) return undefined;
    return value < SECONDS_CEILING ? value * 1000 : value;
  }
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  // A numeric string keeps the same seconds-or-milliseconds ambiguity.
  if (/^\d+$/.test(text)) return toMillis(Number(text));
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : parsed;
}
