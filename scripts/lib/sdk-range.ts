// Copied from fyflow-app packages/runtime/src/sdk-range.ts: whether a Host implementing an SDK version admits a
// Plugin's `fyflow-plugin-sdk` peer range. Keep it alike with that file.


type Version = [number, number, number];
/** A version as written: a part is null where it stops or is a wildcard. */
type Parts = [number | null, number | null, number | null];

/** A partial version (`1`, `1.2`, `1.x`) as its numbers, null where it stops or is a wildcard. */
function partsOf(text: string): Parts | null {
  const parts = text.replace(/^v/, "").split(".");
  if (parts.length > 3) return null;
  const numbers: (number | null)[] = [];
  for (const part of parts) {
    if (/^[x*X]$/.test(part)) numbers.push(null);
    else if (/^\d+$/.test(part)) numbers.push(Number(part));
    else return null;
  }
  return [numbers[0] ?? null, numbers[1] ?? null, numbers[2] ?? null];
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

const floor = ([major, minor, patch]: Parts): Version => [major ?? 0, minor ?? 0, patch ?? 0];

/** The half-open interval [low, high) a comparator allows, or null when it cannot be read. */
function interval(
  comparator: string,
): { low: Version | null; high: Version | null; lowOpen?: boolean; highClosed?: boolean } | null {
  const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(comparator);
  if (match === null) return null;
  const [, op = "=", text = ""] = match;
  const parts = partsOf(text);
  if (parts === null) return null;
  const [major, minor, patch] = parts;
  if (major === null) return { low: null, high: null }; // `*`, `x`: any version, whatever the operator
  const low = floor(parts);
  // The version after the last given part (1.2 → 1.3.0, 1 → 2.0.0); null for a full x.y.z.
  const next: Version | null =
    minor === null ? [major + 1, 0, 0] : patch === null ? [major, minor + 1, 0] : null;
  switch (op) {
    case "^":
      if (major > 0 || minor === null) return { low, high: [major + 1, 0, 0] };
      if (minor > 0 || patch === null) return { low, high: [0, minor + 1, 0] };
      return { low, high: [0, 0, patch + 1] };
    case "~":
      return { low, high: minor === null ? [major + 1, 0, 0] : [major, minor + 1, 0] };
    case ">=":
      return { low, high: null };
    case ">":
      return { low: next ?? low, high: null, lowOpen: next === null };
    case "<":
      return { low: null, high: low };
    case "<=":
      return { low: null, high: next ?? low, highClosed: next === null };
    default:
      return { low, high: next ?? low, highClosed: next === null };
  }
}

function satisfiesComparator(version: Version, comparator: string): boolean | null {
  const range = interval(comparator);
  if (range === null) return null;
  const { low, high, lowOpen = false, highClosed = false } = range;
  if (low !== null && (lowOpen ? compare(version, low) <= 0 : compare(version, low) < 0)) return false;
  if (high !== null && (highClosed ? compare(version, high) > 0 : compare(version, high) >= 0)) return false;
  return true;
}

/**
 * Whether `version` (x.y.z) is in `range`; null when the range (or version) cannot be read, such as hyphen or
 * pre-release ranges, which this subset leaves out. A pre-release suffix on `version` is ignored.
 */
export function satisfiesRange(version: string, range: string): boolean | null {
  const parts = partsOf(version.split("-")[0] ?? "");
  if (parts === null || parts.some((p) => p === null)) return null;
  const v = floor(parts);
  const results = range.split("||").map((alternative) => {
    const comparators = alternative
      .trim()
      .replace(/(\^|~|>=|<=|>|<|=)\s+/g, "$1")
      .split(/\s+/)
      .filter(Boolean);
    if (comparators.length === 0) return true; // "" and "||" mean any version
    const each = comparators.map((c) => satisfiesComparator(v, c));
    return each.includes(null) ? null : each.every(Boolean);
  });
  if (results.includes(null)) return null;
  return results.includes(true);
}
