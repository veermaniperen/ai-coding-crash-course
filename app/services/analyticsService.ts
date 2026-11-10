import { and, eq, gte, sql, type SQL } from "drizzle-orm";
import { db } from "~/db";
import { CourseStatus, courses, purchases } from "~/db/schema";
import { PLATFORM_FEE_RATE, type AnalyticsRange } from "~/lib/analytics";

// ─── Analytics Service ───
// Aggregate queries behind the instructor analytics page. Every figure here is
// grouped SQL over whole tables — never a loop over the per-student helpers —
// so the page doesn't degrade as an instructor's audience grows.
//
// `instructorId: null` means "all instructors" (the admin view), following
// commentService.getUnansweredQuestions.
//
// Uses positional parameters (project convention).

const DAY_MS = 86_400_000;

const RANGE_DAYS: Record<AnalyticsRange, number | null> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
};

/**
 * The earliest timestamp inside the range, as an ISO string, or null for
 * all-time. The boundary is inclusive: a row created exactly at the cutoff is
 * in range. Timestamps are stored as `toISOString()` text, which sorts
 * lexically in time order, so comparing strings is comparing instants.
 */
function resolveCutoff(range: AnalyticsRange, now: Date): string | null {
  const days = RANGE_DAYS[range];
  if (days === null) return null;
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

function purchaseConditions(
  instructorId: number | null,
  range: AnalyticsRange,
  now: Date
): SQL[] {
  const conditions: SQL[] = [];
  if (instructorId !== null) {
    conditions.push(eq(courses.instructorId, instructorId));
  }
  const cutoff = resolveCutoff(range, now);
  if (cutoff !== null) {
    conditions.push(gte(purchases.createdAt, cutoff));
  }
  return conditions;
}

export type RevenueSummary = {
  grossCents: number;
  feeCents: number;
  netCents: number;
  purchaseCount: number;
};

export function getRevenueSummary(
  instructorId: number | null,
  range: AnalyticsRange,
  now: Date = new Date()
): RevenueSummary {
  const row = db
    .select({
      grossCents: sql<number>`coalesce(sum(${purchases.amountPaid}), 0)`,
      purchaseCount: sql<number>`count(*)`,
    })
    .from(purchases)
    .innerJoin(courses, eq(courses.id, purchases.courseId))
    .where(and(...purchaseConditions(instructorId, range, now)))
    .get();

  const grossCents = row?.grossCents ?? 0;
  // Rounded once, on the total, so fee + net always equals gross exactly.
  const feeCents = Math.round(grossCents * PLATFORM_FEE_RATE);

  return {
    grossCents,
    feeCents,
    netCents: grossCents - feeCents,
    purchaseCount: row?.purchaseCount ?? 0,
  };
}

export type RevenuePoint = {
  /** "YYYY-MM-DD" (UTC day) for ranged views, "YYYY-MM" for all-time. */
  period: string;
  grossCents: number;
};

/**
 * Gross revenue per period, for the revenue chart. Ranged views are bucketed
 * by UTC day from the cutoff's day to today; all-time is bucketed by month from
 * the first sale's month. Periods without sales are zero-filled so the chart's
 * x axis is continuous. No sales in range at all → an empty array, so the panel
 * can show its empty copy.
 */
export function getRevenueOverTime(
  instructorId: number | null,
  range: AnalyticsRange,
  now: Date = new Date()
): RevenuePoint[] {
  // ISO timestamps: the first 10 characters are the UTC day, 7 the month.
  const periodLength = range === "all" ? 7 : 10;
  const period = sql<string>`substr(${purchases.createdAt}, 1, ${sql.raw(String(periodLength))})`;

  const rows = db
    .select({
      period,
      grossCents: sql<number>`sum(${purchases.amountPaid})`,
    })
    .from(purchases)
    .innerJoin(courses, eq(courses.id, purchases.courseId))
    .where(and(...purchaseConditions(instructorId, range, now)))
    .groupBy(period)
    .orderBy(period)
    .all();

  if (rows.length === 0) return [];

  const totals = new Map(rows.map((row) => [row.period, row.grossCents]));
  const first = resolveCutoff(range, now)?.slice(0, 10) ?? rows[0].period;
  const periods =
    range === "all" ? monthsBetween(first, now) : daysBetween(first, now);

  return periods.map((p) => ({ period: p, grossCents: totals.get(p) ?? 0 }));
}

/** Every UTC day from `startDay` ("YYYY-MM-DD") to `now`'s day, inclusive. */
function daysBetween(startDay: string, now: Date): string[] {
  const days: string[] = [];
  const end = now.toISOString().slice(0, 10);
  const cursor = new Date(`${startDay}T00:00:00.000Z`);
  for (;;) {
    const day = cursor.toISOString().slice(0, 10);
    days.push(day);
    if (day >= end) break;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** Every month from `startMonth` ("YYYY-MM") to `now`'s month, inclusive. */
function monthsBetween(startMonth: string, now: Date): string[] {
  const months: string[] = [];
  const end = now.toISOString().slice(0, 7);
  const cursor = new Date(`${startMonth.slice(0, 7)}-01T00:00:00.000Z`);
  for (;;) {
    const month = cursor.toISOString().slice(0, 7);
    months.push(month);
    if (month >= end) break;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

/**
 * Drives the "publish your first course" empty state. With the "All
 * instructors" filter (null) it asks whether any course on the platform is
 * published.
 */
export function hasPublishedCourses(instructorId: number | null): boolean {
  const conditions: SQL[] = [eq(courses.status, CourseStatus.Published)];
  if (instructorId !== null) {
    conditions.push(eq(courses.instructorId, instructorId));
  }
  const row = db
    .select({ id: courses.id })
    .from(courses)
    .where(and(...conditions))
    .limit(1)
    .get();
  return row !== undefined;
}
