import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import {
  getRevenueOverTime,
  getRevenueSummary,
  hasPublishedCourses,
} from "./analyticsService";

// ─── Local fixture helpers ───
// Deliberately not added to the shared seedBaseData: analytics needs several
// instructors, buyers, and dated purchases, and the other service tests don't.

const NOW = new Date("2026-06-15T12:00:00.000Z");
const DAY_MS = 86_400_000;

function daysBefore(days: number, from: Date = NOW): string {
  return new Date(from.getTime() - days * DAY_MS).toISOString();
}

let userCounter = 0;

function makeUser(role: schema.UserRole, name?: string) {
  userCounter += 1;
  return testDb
    .insert(schema.users)
    .values({
      name: name ?? `User ${userCounter}`,
      email: `user${userCounter}@example.com`,
      role,
    })
    .returning()
    .get();
}

let categoryId: number;

function makeCourse(
  instructorId: number,
  status: schema.CourseStatus = schema.CourseStatus.Published
) {
  userCounter += 1;
  return testDb
    .insert(schema.courses)
    .values({
      title: `Course ${userCounter}`,
      slug: `course-${userCounter}`,
      description: "A course",
      salesCopy: "Buy it",
      instructorId,
      categoryId,
      status,
      price: 4999,
    })
    .returning()
    .get();
}

function makePurchase(courseId: number, amountPaid: number, createdAt: string) {
  const buyer = makeUser(schema.UserRole.Student);
  return testDb
    .insert(schema.purchases)
    .values({ userId: buyer.id, courseId, amountPaid, createdAt })
    .returning()
    .get();
}

beforeEach(() => {
  testDb = createTestDb();
  categoryId = testDb
    .insert(schema.categories)
    .values({ name: "Programming", slug: "programming" })
    .returning()
    .get().id;
});

describe("getRevenueSummary", () => {
  it("attributes purchases to the instructor who owns the course", () => {
    const sarah = makeUser(schema.UserRole.Instructor, "Sarah");
    const marcus = makeUser(schema.UserRole.Instructor, "Marcus");
    const sarahCourseA = makeCourse(sarah.id);
    const sarahCourseB = makeCourse(sarah.id);
    const marcusCourse = makeCourse(marcus.id);

    makePurchase(sarahCourseA.id, 1000, daysBefore(1));
    makePurchase(sarahCourseB.id, 2000, daysBefore(2));
    makePurchase(marcusCourse.id, 5000, daysBefore(3));

    expect(getRevenueSummary(sarah.id, "all", NOW).grossCents).toBe(3000);
    expect(getRevenueSummary(marcus.id, "all", NOW).grossCents).toBe(5000);
  });

  it("sums every instructor's sales when the filter is null (All instructors)", () => {
    const sarah = makeUser(schema.UserRole.Instructor, "Sarah");
    const marcus = makeUser(schema.UserRole.Instructor, "Marcus");
    makePurchase(makeCourse(sarah.id).id, 1000, daysBefore(1));
    makePurchase(makeCourse(marcus.id).id, 5000, daysBefore(3));

    expect(getRevenueSummary(null, "all", NOW).grossCents).toBe(6000);
  });

  it("splits gross into a 20% platform fee and net, rounding the fee to the nearest cent", () => {
    const sarah = makeUser(schema.UserRole.Instructor);
    const course = makeCourse(sarah.id);
    // 4999 * 20% = 999.8 → fee rounds up to 1000, net takes the remainder.
    makePurchase(course.id, 4999, daysBefore(1));

    expect(getRevenueSummary(sarah.id, "all", NOW)).toMatchObject({
      grossCents: 4999,
      feeCents: 1000,
      netCents: 3999,
    });
  });

  it("rounds the fee down when the fraction is below half a cent, and fee + net always equals gross", () => {
    const sarah = makeUser(schema.UserRole.Instructor);
    const course = makeCourse(sarah.id);
    // 1001 + 1001 = 2002; 2002 * 20% = 400.4 → 400. The fee is rounded once on
    // the total: rounding per purchase would also give 200 + 200 = 400 here,
    // but 2 * 3 = 6 below shows the difference (1.2 → 1, versus 1 + 1 = 2).
    makePurchase(course.id, 1001, daysBefore(1));
    makePurchase(course.id, 1001, daysBefore(1));

    const summary = getRevenueSummary(sarah.id, "all", NOW);
    expect(summary).toMatchObject({
      grossCents: 2002,
      feeCents: 400,
      netCents: 1602,
    });
    expect(summary.feeCents + summary.netCents).toBe(summary.grossCents);
  });

  it("rounds the fee on the total rather than per purchase", () => {
    const sarah = makeUser(schema.UserRole.Instructor);
    const course = makeCourse(sarah.id);
    // Two 3-cent purchases: 6 * 20% = 1.2 → 1. Per purchase it would be
    // 0.6 → 1 each, totalling 2.
    makePurchase(course.id, 3, daysBefore(1));
    makePurchase(course.id, 3, daysBefore(1));

    const summary = getRevenueSummary(sarah.id, "all", NOW);
    expect(summary).toMatchObject({ grossCents: 6, feeCents: 1, netCents: 5 });
  });
});

describe("range filtering", () => {
  it("includes a purchase exactly on the cutoff (inclusive) and excludes one a millisecond earlier", () => {
    const sarah = makeUser(schema.UserRole.Instructor);
    const course = makeCourse(sarah.id);
    const cutoff = NOW.getTime() - 30 * DAY_MS;
    makePurchase(course.id, 29995, new Date(cutoff).toISOString());
    makePurchase(course.id, 100, new Date(cutoff - 1).toISOString());

    // Inclusive: created_at >= now - 30 days. The 29995 sale counts, the 100
    // sale one millisecond older does not.
    expect(getRevenueSummary(sarah.id, "30d", NOW).grossCents).toBe(29995);
  });

  it("returns the right subset for each range token, and everything for all-time", () => {
    const sarah = makeUser(schema.UserRole.Instructor);
    const course = makeCourse(sarah.id);
    makePurchase(course.id, 1, daysBefore(2));
    makePurchase(course.id, 10, daysBefore(20));
    makePurchase(course.id, 100, daysBefore(60));
    makePurchase(course.id, 1000, daysBefore(300));

    expect(getRevenueSummary(sarah.id, "7d", NOW).grossCents).toBe(1);
    expect(getRevenueSummary(sarah.id, "30d", NOW).grossCents).toBe(11);
    expect(getRevenueSummary(sarah.id, "90d", NOW).grossCents).toBe(111);
    expect(getRevenueSummary(sarah.id, "all", NOW).grossCents).toBe(1111);
    expect(getRevenueSummary(sarah.id, "all", NOW).purchaseCount).toBe(4);
  });
});

describe("an instructor with no courses or sales", () => {
  it("gets zeroed figures, not NaN or an exception, and no chart points", () => {
    const priya = makeUser(schema.UserRole.Instructor, "Priya");
    // Someone else's sales must not leak in.
    const sarah = makeUser(schema.UserRole.Instructor, "Sarah");
    makePurchase(makeCourse(sarah.id).id, 4999, daysBefore(1));

    for (const range of ["7d", "30d", "90d", "all"] as const) {
      expect(getRevenueSummary(priya.id, range, NOW)).toEqual({
        grossCents: 0,
        feeCents: 0,
        netCents: 0,
        purchaseCount: 0,
      });
      expect(getRevenueOverTime(priya.id, range, NOW)).toEqual([]);
    }
  });

  it("reports whether the instructor has any published course", () => {
    const priya = makeUser(schema.UserRole.Instructor, "Priya");
    const sarah = makeUser(schema.UserRole.Instructor, "Sarah");
    const marcus = makeUser(schema.UserRole.Instructor, "Marcus");
    makeCourse(sarah.id, schema.CourseStatus.Published);
    makeCourse(marcus.id, schema.CourseStatus.Draft);

    expect(hasPublishedCourses(priya.id)).toBe(false);
    expect(hasPublishedCourses(marcus.id)).toBe(false);
    expect(hasPublishedCourses(sarah.id)).toBe(true);
    expect(hasPublishedCourses(null)).toBe(true);
  });
});

describe("getRevenueOverTime", () => {
  it("buckets a ranged view by UTC day, zero-filling days without sales", () => {
    const sarah = makeUser(schema.UserRole.Instructor);
    const course = makeCourse(sarah.id);
    makePurchase(course.id, 500, "2026-06-13T09:00:00.000Z");
    makePurchase(course.id, 700, "2026-06-13T23:00:00.000Z");
    makePurchase(course.id, 100, "2026-06-15T08:00:00.000Z");
    // Just outside 7d (the cutoff is 2026-06-08T12:00Z).
    makePurchase(course.id, 9999, "2026-06-08T11:59:59.999Z");

    expect(getRevenueOverTime(sarah.id, "7d", NOW)).toEqual([
      { period: "2026-06-08", grossCents: 0 },
      { period: "2026-06-09", grossCents: 0 },
      { period: "2026-06-10", grossCents: 0 },
      { period: "2026-06-11", grossCents: 0 },
      { period: "2026-06-12", grossCents: 0 },
      { period: "2026-06-13", grossCents: 1200 },
      { period: "2026-06-14", grossCents: 0 },
      { period: "2026-06-15", grossCents: 100 },
    ]);
  });

  it("buckets all-time by month, from the first sale's month to now", () => {
    const sarah = makeUser(schema.UserRole.Instructor);
    const course = makeCourse(sarah.id);
    makePurchase(course.id, 300, "2026-03-02T00:00:00.000Z");
    makePurchase(course.id, 200, "2026-03-30T00:00:00.000Z");
    makePurchase(course.id, 50, "2026-05-10T00:00:00.000Z");

    expect(getRevenueOverTime(sarah.id, "all", NOW)).toEqual([
      { period: "2026-03", grossCents: 500 },
      { period: "2026-04", grossCents: 0 },
      { period: "2026-05", grossCents: 50 },
      { period: "2026-06", grossCents: 0 },
    ]);
  });
});
