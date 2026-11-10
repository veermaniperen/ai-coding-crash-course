import { and, eq, gte, ne, sql, type SQL } from "drizzle-orm";
import { db } from "~/db";
import {
  CourseStatus,
  LessonProgressStatus,
  courses,
  enrollments,
  lessonProgress,
  lessons,
  modules,
  purchases,
} from "~/db/schema";
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
 * course for "All instructors" (null). The loader picks the selected course
 * from this list, so it doubles as the ownership check on `?course=`.
 */
export function getAnalyticsCourses(
  instructorId: number | null
): AnalyticsCourse[] {
  return db
    .select({ id: courses.id, title: courses.title, status: courses.status })
    .from(courses)
    .where(
      instructorId === null ? undefined : eq(courses.instructorId, instructorId)
    )
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
      .groupBy(furthestPerStudent.furthest)
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
