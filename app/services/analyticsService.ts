import { and, asc, desc, eq, gte, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "~/db";
import {
  CourseStatus,
  coupons,
  courseRatings,
  courses,
  enrollments,
  purchases,
  users,
} from "~/db/schema";
import { getUnansweredQuestions } from "~/services/commentService";
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

// ─── Overview: buyers, students, team seats, questions, ratings ───
// A team purchase is one purchase row covering several coupons (seats). The
// buyer usually never enrols, and each seat redeemer enrols with no purchase
// row of their own, so buyers and students are counted from different tables
// and never conflated.

/** Instructor and cutoff conditions for `enrollments JOIN courses`. */
function enrollmentConditions(
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
    conditions.push(gte(enrollments.enrolledAt, cutoff));
  }
  return conditions;
}

export type AudienceSummary = {
  /** Distinct people with a purchase in range (team buyers included). */
  buyerCount: number;
  /** Distinct people who enrolled in range (seat redeemers included). */
  studentCount: number;
  /**
   * Revenue traced to those students' enrolments: an individual purchase
   * counts in full; a redeemed seat counts as its team purchase's amount
   * divided by the purchase's seat count. Unredeemed seats belong to nobody.
   */
  attributedRevenueCents: number;
  /** attributedRevenueCents / studentCount, rounded; 0 with no students. */
  revenuePerStudentCents: number;
};

/**
 * Revenue attributable to the outer `enrollments` row. Individual purchases
 * (those without coupons) by the enrollee for that course count in full; a
 * coupon the enrollee redeemed for that course walks back to its originating
 * team purchase and takes one seat's share of it.
 */
const enrollmentRevenue = sql<number>`(
  select coalesce(sum(p.amount_paid), 0)
  from purchases p
  where p.user_id = ${enrollments.userId}
    and p.course_id = ${enrollments.courseId}
    and not exists (select 1 from coupons pc where pc.purchase_id = p.id)
) + (
  select coalesce(sum(
    tp.amount_paid * 1.0 / (select count(*) from coupons s where s.purchase_id = tp.id)
  ), 0)
  from coupons c
  join purchases tp on tp.id = c.purchase_id
  where c.redeemed_by_user_id = ${enrollments.userId}
    and c.course_id = ${enrollments.courseId}
)`;

export function getAudienceSummary(
  instructorId: number | null,
  range: AnalyticsRange,
  now: Date = new Date()
): AudienceSummary {
  const buyers = db
    .select({ count: sql<number>`count(distinct ${purchases.userId})` })
    .from(purchases)
    .innerJoin(courses, eq(courses.id, purchases.courseId))
    .where(and(...purchaseConditions(instructorId, range, now)))
    .get();

  const students = db
    .select({
      count: sql<number>`count(distinct ${enrollments.userId})`,
      revenue: sql<number>`coalesce(sum(${enrollmentRevenue}), 0)`,
    })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .where(and(...enrollmentConditions(instructorId, range, now)))
    .get();

  const studentCount = students?.count ?? 0;
  const attributedRevenueCents = Math.round(students?.revenue ?? 0);

  return {
    buyerCount: buyers?.count ?? 0,
    studentCount,
    attributedRevenueCents,
    revenuePerStudentCents:
      studentCount === 0 ? 0 : Math.round(attributedRevenueCents / studentCount),
  };
}

/**
 * Purchased team seats nobody has redeemed. A current snapshot, not a dated
 * metric — an open seat bought a year ago is still open — so it ignores range
 * and the page labels it "all time".
 */
export function getUnredeemedSeatCount(instructorId: number | null): number {
  const conditions: SQL[] = [isNull(coupons.redeemedByUserId)];
  if (instructorId !== null) {
    conditions.push(eq(courses.instructorId, instructorId));
  }
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(coupons)
    .innerJoin(courses, eq(courses.id, coupons.courseId))
    .where(and(...conditions))
    .get();
  return row?.count ?? 0;
}

export const TOP_BUYER_LIMIT = 10;

export type TopBuyer = {
  userId: number;
  name: string;
  email: string;
  totalSpentCents: number;
  purchaseCount: number;
  /** Seats bought through team purchases; 0 means an individual buyer. */
  seatCount: number;
  unredeemedSeatCount: number;
  /** Enrolled in any of the instructor's courses. False for, e.g., a purchasing manager. */
  isEnrolled: boolean;
};

/**
 * The biggest buyers by spend on purchases in range, at most TOP_BUYER_LIMIT.
 * Driven from purchases, so a buyer who never enrolled still appears.
 */
export function getTopBuyers(
  instructorId: number | null,
  range: AnalyticsRange,
  now: Date = new Date()
): TopBuyer[] {
  const totalSpent = sql<number>`sum(${purchases.amountPaid})`;
  const enrolledIn =
    instructorId === null
      ? sql`select 1 from enrollments e where e.user_id = ${users.id}`
      : sql`select 1 from enrollments e
            join courses ec on ec.id = e.course_id
            where e.user_id = ${users.id} and ec.instructor_id = ${instructorId}`;

  const rows = db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      totalSpentCents: totalSpent,
      purchaseCount: sql<number>`count(*)`,
      seatCount: sql<number>`sum((select count(*) from coupons c where c.purchase_id = ${purchases.id}))`,
      unredeemedSeatCount: sql<number>`sum((select count(*) from coupons c where c.purchase_id = ${purchases.id} and c.redeemed_by_user_id is null))`,
      isEnrolled: sql<number>`exists (${enrolledIn})`,
    })
    .from(purchases)
    .innerJoin(courses, eq(courses.id, purchases.courseId))
    .innerJoin(users, eq(users.id, purchases.userId))
    .where(and(...purchaseConditions(instructorId, range, now)))
    .groupBy(users.id)
    .orderBy(desc(totalSpent), asc(users.name))
    .limit(TOP_BUYER_LIMIT)
    .all();

  return rows.map((row) => ({ ...row, isEnrolled: Boolean(row.isEnrolled) }));
}

/**
 * Student questions still waiting on staff. Delegates to the instructor
 * question queue so "unanswered" has one definition. A current snapshot, so
 * it ignores range.
 */
export function getUnansweredQuestionCount(instructorId: number | null): number {
  return getUnansweredQuestions(instructorId).length;
}

export type CourseRating = {
  courseId: number;
  title: string;
  /** Rounded to 1dp; null when the course has no ratings yet. */
  averageRating: number | null;
  ratingCount: number;
};

/**
 * Rating per published course, unrated courses included. Ratings are
 * cumulative opinions, not events, so this ignores range ("all time").
 */
export function getCourseRatings(instructorId: number | null): CourseRating[] {
  const conditions: SQL[] = [eq(courses.status, CourseStatus.Published)];
  if (instructorId !== null) {
    conditions.push(eq(courses.instructorId, instructorId));
  }
  const rows = db
    .select({
      courseId: courses.id,
      title: courses.title,
      average: sql<number | null>`avg(${courseRatings.rating})`,
      ratingCount: sql<number>`count(${courseRatings.id})`,
    })
    .from(courses)
    .leftJoin(courseRatings, eq(courseRatings.courseId, courses.id))
    .where(and(...conditions))
    .groupBy(courses.id)
    .orderBy(asc(courses.title))
    .all();

  return rows.map(({ average, ...row }) => ({
    ...row,
    averageRating: average === null ? null : Math.round(average * 10) / 10,
  }));
}
