// ─── Analytics shared constants ───
// Safe to import from both server and client code: the route's range picker
// and the analytics service read the same token list.

/**
 * The platform's cut of every sale, as a fraction. A display calculation only —
 * there is no fee column and no payouts table.
 */
export const PLATFORM_FEE_RATE = 0.2;

export const ANALYTICS_RANGES = ["7d", "30d", "90d", "all"] as const;

export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export const DEFAULT_ANALYTICS_RANGE: AnalyticsRange = "30d";

export const ANALYTICS_RANGE_LABELS: Record<AnalyticsRange, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};

/** Reads a URL search param into a range token, falling back to the default. */
export function parseAnalyticsRange(value: string | null): AnalyticsRange {
  return (
    ANALYTICS_RANGES.find((range) => range === value) ?? DEFAULT_ANALYTICS_RANGE
  );
}
