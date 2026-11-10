import { and, asc, desc, eq, gte, isNull, ne, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { db } from "~/db";
import {
  CourseStatus,
  LessonProgressStatus,
  coupons,
  courseRatings,
  courses,
  enrollments,
  lessonProgress,
  lessons,
  modules,
  purchases,
  quizAttempts,
  quizzes,
  users,
} from "~/db/schema";
import { countUnansweredQuestions } from "~/services/commentService";
import { PLATFORM_FEE_RATE, type AnalyticsRange } from "~/lib/analytics";
import { getDiscountForCountry } from "~/lib/ppp";

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

/**
 * `column >= cutoff` for the range, or undefined for all-time (drizzle's
 * `and()` skips undefined, so callers can spread it in unconditionally).
 */
function cutoffCondition(
  column: SQLiteColumn,
  range: AnalyticsRange,
  now: Date
): SQL | undefined {
  const cutoff = resolveCutoff(range, now);
  return cutoff === null ? undefined : gte(column, cutoff);
}

/** Scopes a query joined to `courses` to one instructor; null = everyone. */
function instructorCondition(instructorId: number | null): SQL | undefined {
  return instructorId === null
    ? undefined
    : eq(courses.instructorId, instructorId);
}

/**
 * The instructor and range conditions every dated metric applies: the query
 * must join `courses`, and `dateColumn` is the timestamp the range filters on.
 */
function scopeConditions(
  instructorId: number | null,
  dateColumn: SQLiteColumn,
  range: AnalyticsRange,
  now: Date
): (SQL | undefined)[] {
  return [
    instructorCondition(instructorId),
    cutoffCondition(dateColumn, range, now),
  ];
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
    .where(and(...scopeConditions(instructorId, purchases.createdAt, range, now)))
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
    .where(and(...scopeConditions(instructorId, purchases.createdAt, range, now)))
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
  const row = db
    .select({ id: courses.id })
    .from(courses)
    .where(
      and(
        eq(courses.status, CourseStatus.Published),
        instructorCondition(instructorId)
      )
    )
    .limit(1)
    .get();
  return row !== undefined;
}

// ─── Course detail ───
// Per-course diagnostics: drop-off funnel, average progress, finished count.
// Lesson progress rows have no start timestamp (and only completed rows carry
// a completion time), so none of these can honour the range filter. They are
// all-time figures, and the page labels them that way.

export type AnalyticsCourse = {
  id: number;
  title: string;
  status: CourseStatus;
};

/**
 * The courses the Course detail picker offers: the instructor's own, or every
 * course for "All instructors" (null). `getCourseDetail` picks the selected
 * course from this list, so it doubles as the ownership check on `?course=`.
 */
export function getAnalyticsCourses(
  instructorId: number | null
): AnalyticsCourse[] {
  return db
    .select({ id: courses.id, title: courses.title, status: courses.status })
    .from(courses)
    .where(instructorCondition(instructorId))
    .orderBy(courses.id)
    .all();
}

/** Sorts lessons in course order: module position first, then lesson position. */
const lessonOrderKey = sql<number>`${modules.position} * 100000 + ${lessons.position}`;

type CourseLesson = {
  lessonId: number;
  title: string;
  moduleId: number;
  moduleTitle: string;
  orderKey: number;
};

function getCourseLessons(courseId: number): CourseLesson[] {
  return db
    .select({
      lessonId: lessons.id,
      title: lessons.title,
      moduleId: modules.id,
      moduleTitle: modules.title,
      orderKey: lessonOrderKey,
    })
    .from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(eq(modules.courseId, courseId))
    .orderBy(modules.position, lessons.position)
    .all();
}

function countEnrolled(courseId: number): number {
  const row = db
    .select({ count: sql<number>`count(distinct ${enrollments.userId})` })
    .from(enrollments)
    .where(eq(enrollments.courseId, courseId))
    .get();
  return row?.count ?? 0;
}

export type FunnelLesson = {
  lessonId: number;
  title: string;
  /** 1-based position in course order, across modules. */
  number: number;
  /** Enrolled students who reached at least this lesson. */
  reached: number;
  /** Students lost since the previous lesson (or since enrolling, for lesson 1). */
  drop: number;
};

export type FunnelModule = {
  moduleId: number;
  title: string;
  /** Students who reached at least the module's first lesson. */
  reached: number;
  /** Students lost across the module: the sum of its lessons' drops. */
  drop: number;
  lessons: FunnelLesson[];
};

export type DropOffFunnel = {
  enrolledCount: number;
  modules: FunnelModule[];
};

/**
 * Per-lesson drop-off, all time. Each lesson counts the enrolled students
 * whose furthest lesson (any progress row, in-progress included) is at or
 * beyond it. The series therefore only ever descends: a skipped lesson doesn't
 * dip, and a gap between neighbours is where students quit.
 */
export function getDropOffFunnel(courseId: number): DropOffFunnel {
  const courseLessons = getCourseLessons(courseId);
  const enrolledCount = countEnrolled(courseId);

  // Each enrolled student's furthest lesson, then how many students stopped
  // at each. One grouped query, at most one row per lesson.
  const furthestPerStudent = db
    .select({
      userId: lessonProgress.userId,
      furthest: sql<number>`max(${lessonOrderKey})`.as("furthest"),
    })
    .from(lessonProgress)
    .innerJoin(lessons, eq(lessons.id, lessonProgress.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.userId, lessonProgress.userId),
        eq(enrollments.courseId, modules.courseId)
      )
    )
    .where(
      and(
        eq(modules.courseId, courseId),
        ne(lessonProgress.status, LessonProgressStatus.NotStarted)
      )
    )
    .groupBy(lessonProgress.userId)
    .as("furthest_per_student");

  const stoppedAt = new Map(
    db
      .select({
        furthest: furthestPerStudent.furthest,
        students: sql<number>`count(*)`,
      })
      .from(furthestPerStudent)
      .groupBy(sql`${furthestPerStudent.furthest}`)
      .all()
      .map((row) => [row.furthest, row.students])
  );

  // reached(lesson) = students whose furthest lesson is this one or later.
  const reachedByLesson = new Map<number, number>();
  let reached = 0;
  for (let i = courseLessons.length - 1; i >= 0; i--) {
    reached += stoppedAt.get(courseLessons[i].orderKey) ?? 0;
    reachedByLesson.set(courseLessons[i].lessonId, reached);
  }

  const funnelModules: FunnelModule[] = [];
  let previous = enrolledCount;
  courseLessons.forEach((lesson, index) => {
    const lessonReached = reachedByLesson.get(lesson.lessonId) ?? 0;
    const row: FunnelLesson = {
      lessonId: lesson.lessonId,
      title: lesson.title,
      number: index + 1,
      reached: lessonReached,
      drop: previous - lessonReached,
    };
    previous = lessonReached;

    let mod = funnelModules.at(-1);
    if (mod?.moduleId !== lesson.moduleId) {
      mod = {
        moduleId: lesson.moduleId,
        title: lesson.moduleTitle,
        reached: lessonReached,
        drop: 0,
        lessons: [],
      };
      funnelModules.push(mod);
    }
    mod.lessons.push(row);
    mod.drop += row.drop;
  });

  return { enrolledCount, modules: funnelModules };
}

export type CourseProgress = {
  enrolledCount: number;
  totalLessons: number;
  /** Mean of completed lessons / total lessons over enrollees, 0–1. */
  averageProgress: number;
  /** Enrollees who have completed every lesson. */
  finishedCount: number;
};

/**
 * Average progress and finished count, all time. Progress is lessons
 * completed over total lessons — deliberately not duration-weighted, because
 * a short lesson that sends the student off to an exercise is more work, not
 * less. Enrollees with no progress count as 0%.
 */
export function getCourseProgress(courseId: number): CourseProgress {
  const totalLessons = getCourseLessons(courseId).length;

  const completedPerStudent = db
    .select({
      userId: lessonProgress.userId,
      completed: sql<number>`count(distinct ${lessonProgress.lessonId})`.as(
        "completed"
      ),
    })
    .from(lessonProgress)
    .innerJoin(lessons, eq(lessons.id, lessonProgress.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(
      and(
        eq(modules.courseId, courseId),
        eq(lessonProgress.status, LessonProgressStatus.Completed)
      )
    )
    .groupBy(lessonProgress.userId)
    .as("completed_per_student");

  const row = db
    .select({
      enrolledCount: sql<number>`count(*)`,
      completedLessons: sql<number>`coalesce(sum(${completedPerStudent.completed}), 0)`,
      finishedCount: sql<number>`coalesce(sum(case when ${completedPerStudent.completed} >= ${totalLessons} then 1 else 0 end), 0)`,
    })
    .from(enrollments)
    .leftJoin(
      completedPerStudent,
      eq(completedPerStudent.userId, enrollments.userId)
    )
    .where(eq(enrollments.courseId, courseId))
    .get();

  const enrolledCount = row?.enrolledCount ?? 0;
  const possible = enrolledCount * totalLessons;

  return {
    enrolledCount,
    totalLessons,
    averageProgress: possible === 0 ? 0 : (row?.completedLessons ?? 0) / possible,
    finishedCount: totalLessons === 0 ? 0 : (row?.finishedCount ?? 0),
  };
}

export type QuizPassRate = {
  quizId: number;
  title: string;
  lessonTitle: string;
  /** Distinct students who attempted the quiz at least once. */
  studentCount: number;
  /** Students whose best attempt passed. */
  passedCount: number;
  /** passedCount / studentCount, 0–1; 0 when nobody has attempted it. */
  passRate: number;
};

/**
 * Pass rate per quiz in the course, in course order, all time. Counted per
 * student on their best attempt — a student who failed and then passed counts
 * once, as passed — so retries don't drag the rate down. Quizzes nobody has
 * attempted are still listed, with zero students.
 */
export function getQuizPassRates(courseId: number): QuizPassRate[] {
  const bestPerStudent = db
    .select({
      quizId: quizAttempts.quizId,
      userId: quizAttempts.userId,
      passed: sql<number>`max(${quizAttempts.passed})`.as("best_passed"),
    })
    .from(quizAttempts)
    .groupBy(quizAttempts.quizId, quizAttempts.userId)
    .as("best_per_student");

  const rows = db
    .select({
      quizId: quizzes.id,
      title: quizzes.title,
      lessonTitle: lessons.title,
      studentCount: sql<number>`count(${bestPerStudent.userId})`,
      passedCount: sql<number>`coalesce(sum(${bestPerStudent.passed}), 0)`,
    })
    .from(quizzes)
    .innerJoin(lessons, eq(lessons.id, quizzes.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .leftJoin(bestPerStudent, eq(bestPerStudent.quizId, quizzes.id))
    .where(eq(modules.courseId, courseId))
    .groupBy(quizzes.id)
    .orderBy(lessonOrderKey, quizzes.id)
    .all();

  return rows.map((row) => ({
    ...row,
    passRate: row.studentCount === 0 ? 0 : row.passedCount / row.studentCount,
  }));
}

export type CountryRevenue = {
  /** ISO country code, or null when the purchase recorded no country. */
  country: string | null;
  grossCents: number;
  /** The part of grossCents from purchases sold below list price. */
  discountedCents: number;
  purchaseCount: number;
  /** The country's current PPP tier discount, 0–1 (0 = full price). */
  discount: number;
};

export type CountryRevenueMix = {
  grossCents: number;
  /** Revenue from purchases sold below list price (PPP-discounted). */
  discountedCents: number;
  /** discountedCents / grossCents, 0–1; 0 when there are no sales. */
  discountedShare: number;
  /** Highest-grossing country first. */
  countries: CountryRevenue[];
};

/**
 * Whether the outer purchase was sold below list price: the amount paid is
 * under the course's price times the seats bought (1 for an individual
 * purchase, the coupon count for a team purchase). Purchases don't record the
 * discount they were sold at, so this is judged from what the buyer actually
 * paid rather than their country's tier — a buyer from a PPP country who paid
 * full price (PPP switched off for the course) is not discounted. The caveat:
 * it compares against today's list price, so a later price rise would make
 * earlier full-price sales read as discounted.
 */
const soldBelowListPrice = sql<boolean>`${purchases.amountPaid} < ${courses.price} * max(1, (
  select count(*) from coupons c where c.purchase_id = ${purchases.id}
))`;

/**
 * The course's gross revenue in the range, broken down by buyer country, with
 * the share that was sold at a PPP-discounted price (see soldBelowListPrice).
 */
export function getCountryRevenue(
  courseId: number,
  range: AnalyticsRange,
  now: Date = new Date()
): CountryRevenueMix {
  const grossCents = sql<number>`sum(${purchases.amountPaid})`;
  const rows = db
    .select({
      country: purchases.country,
      grossCents,
      discountedCents: sql<number>`coalesce(sum(case when ${soldBelowListPrice} then ${purchases.amountPaid} else 0 end), 0)`,
      purchaseCount: sql<number>`count(*)`,
    })
    .from(purchases)
    .innerJoin(courses, eq(courses.id, purchases.courseId))
    .where(
      and(
        eq(purchases.courseId, courseId),
        cutoffCondition(purchases.createdAt, range, now)
      )
    )
    .groupBy(purchases.country)
    .orderBy(sql`${grossCents} desc`, sql`${purchases.country} is null`, purchases.country)
    .all();

  const countries = rows.map((row) => ({
    ...row,
    discount: getDiscountForCountry(row.country),
  }));
  const total = countries.reduce((sum, c) => sum + c.grossCents, 0);
  const discountedCents = countries.reduce(
    (sum, c) => sum + c.discountedCents,
    0
  );

  return {
    grossCents: total,
    discountedCents,
    discountedShare: total === 0 ? 0 : discountedCents / total,
    countries,
  };
}

export type CourseDetailData = {
  /** The courses the picker offers: the viewer's own, or all for null. */
  courses: AnalyticsCourse[];
  /** null only when there are no courses to pick from. */
  selectedCourseId: number | null;
  range: AnalyticsRange;
  progress: CourseProgress | null;
  funnel: DropOffFunnel | null;
  quizPassRates: QuizPassRate[];
  countryRevenue: CountryRevenueMix | null;
};

/**
 * Everything the Course detail tab shows. The requested course is honoured
 * only if it's among the viewer's courses (so a foreign id falls back rather
 * than leaking another instructor's figures); otherwise the first published
 * course is selected, or failing that the first course.
 */
export function getCourseDetail(
  instructorId: number | null,
  requestedCourseId: number | null,
  range: AnalyticsRange,
  now: Date = new Date()
): CourseDetailData {
  const courses = getAnalyticsCourses(instructorId);
  const selected =
    courses.find((c) => c.id === requestedCourseId) ??
    courses.find((c) => c.status === CourseStatus.Published) ??
    courses[0];

  if (!selected) {
    return {
      courses,
      selectedCourseId: null,
      range,
      progress: null,
      funnel: null,
      quizPassRates: [],
      countryRevenue: null,
    };
  }
  return {
    courses,
    selectedCourseId: selected.id,
    range,
    progress: getCourseProgress(selected.id),
    funnel: getDropOffFunnel(selected.id),
    quizPassRates: getQuizPassRates(selected.id),
    countryRevenue: getCountryRevenue(selected.id, range, now),
  };
}

// ─── Overview: buyers, students, team seats, questions, ratings ───
// A team purchase is one purchase row covering several coupons (seats). The
// buyer usually never enrols, and each seat redeemer enrols with no purchase
// row of their own, so buyers and students are counted from different tables
// and never conflated.

export type AudienceSummary = {
  /** Distinct people with a purchase in range (team buyers included). */
  buyerCount: number;
  /** Distinct people who enrolled in range (seat redeemers included). */
  studentCount: number;
};

export function getAudienceSummary(
  instructorId: number | null,
  range: AnalyticsRange,
  now: Date = new Date()
): AudienceSummary {
  const buyers = db
    .select({ count: sql<number>`count(distinct ${purchases.userId})` })
    .from(purchases)
    .innerJoin(courses, eq(courses.id, purchases.courseId))
    .where(and(...scopeConditions(instructorId, purchases.createdAt, range, now)))
    .get();

  const students = db
    .select({ count: sql<number>`count(distinct ${enrollments.userId})` })
    .from(enrollments)
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .where(and(...scopeConditions(instructorId, enrollments.enrolledAt, range, now)))
    .get();

  return {
    buyerCount: buyers?.count ?? 0,
    studentCount: students?.count ?? 0,
  };
}

/**
 * Team seats bought in the range (by coupon creation time) that nobody has
 * redeemed yet.
 */
export function getUnredeemedSeatCount(
  instructorId: number | null,
  range: AnalyticsRange,
  now: Date = new Date()
): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(coupons)
    .innerJoin(courses, eq(courses.id, coupons.courseId))
    .where(
      and(
        isNull(coupons.redeemedByUserId),
        ...scopeConditions(instructorId, coupons.createdAt, range, now)
      )
    )
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
    .where(and(...scopeConditions(instructorId, purchases.createdAt, range, now)))
    .groupBy(users.id)
    .orderBy(desc(totalSpent), asc(users.name))
    .limit(TOP_BUYER_LIMIT)
    .all();

  return rows.map((row) => ({ ...row, isEnrolled: Boolean(row.isEnrolled) }));
}

/**
 * Student questions still waiting on staff, counted in SQL with the question
 * queue's own definition of "unanswered" (commentService). A current
 * snapshot, so it ignores range.
 */
export function getUnansweredQuestionCount(instructorId: number | null): number {
  return countUnansweredQuestions(instructorId);
}

export type CourseRating = {
  courseId: number;
  title: string;
  /** Rounded to 1dp; null when the course has no ratings yet. */
  averageRating: number | null;
  ratingCount: number;
};

/**
 * Rating per published course from ratings left in the range (by
 * `created_at`). Courses with no ratings in range are still listed, unrated.
 */
export function getCourseRatings(
  instructorId: number | null,
  range: AnalyticsRange,
  now: Date = new Date()
): CourseRating[] {
  const rows = db
    .select({
      courseId: courses.id,
      title: courses.title,
      average: sql<number | null>`avg(${courseRatings.rating})`,
      ratingCount: sql<number>`count(${courseRatings.id})`,
    })
    .from(courses)
    // The cutoff sits in the join, not the WHERE, so a course with no ratings
    // in range stays in the list.
    .leftJoin(
      courseRatings,
      and(
        eq(courseRatings.courseId, courses.id),
        cutoffCondition(courseRatings.createdAt, range, now)
      )
    )
    .where(
      and(
        eq(courses.status, CourseStatus.Published),
        instructorCondition(instructorId)
      )
    )
    .groupBy(courses.id)
    .orderBy(asc(courses.title))
    .all();

  return rows.map(({ average, ...row }) => ({
    ...row,
    averageRating: average === null ? null : Math.round(average * 10) / 10,
  }));
}
