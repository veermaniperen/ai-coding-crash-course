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
  getAudienceSummary,
  getCourseRatings,
  getTopBuyers,
  getUnansweredQuestionCount,
  getUnredeemedSeatCount,
} from "./analyticsService";

// ─── Overview tests: buyers, students, team seats, leaderboard, questions, ratings ───
// Separate from analyticsService.test.ts so the fixtures for team purchases
// and coupons stay next to the cases that need them.

const NOW = new Date("2026-06-15T12:00:00.000Z");
const DAY_MS = 86_400_000;

function daysBefore(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

let counter = 0;

function makeUser(role: schema.UserRole, name?: string) {
  counter += 1;
  return testDb
    .insert(schema.users)
    .values({
      name: name ?? `User ${counter}`,
      email: `user${counter}@example.com`,
      role,
    })
    .returning()
    .get();
}

function makeStudent(name?: string) {
  return makeUser(schema.UserRole.Student, name);
}

let categoryId: number;

function makeCourse(instructorId: number, title?: string) {
  counter += 1;
  return testDb
    .insert(schema.courses)
    .values({
      title: title ?? `Course ${counter}`,
      slug: `course-${counter}`,
      description: "A course",
      salesCopy: "Buy it",
      instructorId,
      categoryId,
      status: schema.CourseStatus.Published,
      price: 4999,
    })
    .returning()
    .get();
}

function enrol(userId: number, courseId: number, enrolledAt: string) {
  testDb
    .insert(schema.enrollments)
    .values({ userId, courseId, enrolledAt })
    .run();
}

/** An individual purchase: the buyer pays and enrols. */
function buyAndEnrol(
  userId: number,
  courseId: number,
  amountPaid: number,
  at: string
) {
  testDb
    .insert(schema.purchases)
    .values({ userId, courseId, amountPaid, createdAt: at })
    .run();
  enrol(userId, courseId, at);
}

/**
 * A team purchase: one purchase row covering `seats` coupons. The buyer does
 * not enrol. Each redeemer enrols with no purchase row of their own.
 */
function teamPurchase(
  buyerId: number,
  courseId: number,
  amountPaid: number,
  seats: number,
  redeemerIds: number[],
  at: string
) {
  const purchase = testDb
    .insert(schema.purchases)
    .values({ userId: buyerId, courseId, amountPaid, createdAt: at })
    .returning()
    .get();
  const team = testDb.insert(schema.teams).values({}).returning().get();
  for (let seat = 0; seat < seats; seat++) {
    const redeemer = redeemerIds[seat];
    counter += 1;
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId,
        code: `SEAT-${counter}`,
        purchaseId: purchase.id,
        redeemedByUserId: redeemer ?? null,
        redeemedAt: redeemer === undefined ? null : at,
      })
      .run();
    if (redeemer !== undefined) enrol(redeemer, courseId, at);
  }
  return purchase;
}

beforeEach(() => {
  testDb = createTestDb();
  categoryId = testDb
    .insert(schema.categories)
    .values({ name: "Programming", slug: "programming" })
    .returning()
    .get().id;
});

describe("getAudienceSummary", () => {
  it("counts buyers and students separately when a team purchase exists", () => {
    const sarah = makeUser(schema.UserRole.Instructor, "Sarah");
    const course = makeCourse(sarah.id);
    const manager = makeStudent("Manager");
    const [a, b, c] = [makeStudent(), makeStudent(), makeStudent()];
    const solo = makeStudent("Solo");

    // 1 team purchase (3 seats, all redeemed) + 1 individual purchase:
    // 2 buyers (manager, solo), 4 students (a, b, c, solo).
    teamPurchase(manager.id, course.id, 15000, 3, [a.id, b.id, c.id], daysBefore(5));
    buyAndEnrol(solo.id, course.id, 4999, daysBefore(5));

    const audience = getAudienceSummary(sarah.id, "30d", NOW);

    expect(audience.buyerCount).toBe(2);
    expect(audience.studentCount).toBe(4);
  });

  it("attributes a team purchase to its redeemers through their coupons", () => {
    const sarah = makeUser(schema.UserRole.Instructor, "Sarah");
    const course = makeCourse(sarah.id);
    const manager = makeStudent("Manager");
    const [a, b] = [makeStudent(), makeStudent()];
    const solo = makeStudent("Solo");

    // $150 for 3 seats is $50 a seat. Two seats redeemed, one not.
    teamPurchase(manager.id, course.id, 15000, 3, [a.id, b.id], daysBefore(5));
    buyAndEnrol(solo.id, course.id, 6000, daysBefore(5));

    const audience = getAudienceSummary(sarah.id, "30d", NOW);

    // a $50 + b $50 + solo $60 = $160 over 3 students. The unredeemed seat's
    // $50 belongs to nobody yet.
    expect(audience.studentCount).toBe(3);
    expect(audience.attributedRevenueCents).toBe(16000);
    expect(audience.revenuePerStudentCents).toBe(5333);
  });
});

describe("getUnredeemedSeatCount", () => {
  it("counts purchased seats nobody has redeemed, for this instructor only", () => {
    const sarah = makeUser(schema.UserRole.Instructor, "Sarah");
    const marcus = makeUser(schema.UserRole.Instructor, "Marcus");
    const sarahCourse = makeCourse(sarah.id);
    const marcusCourse = makeCourse(marcus.id);
    const [a, b] = [makeStudent(), makeStudent()];

    // Sarah: 3 seats, 2 redeemed → 1 open; 2 seats, none redeemed → 2 open.
    teamPurchase(makeStudent().id, sarahCourse.id, 15000, 3, [a.id, b.id], daysBefore(5));
    teamPurchase(makeStudent().id, sarahCourse.id, 9000, 2, [], daysBefore(200));
    // Marcus: 4 open seats that must not leak into Sarah's count.
    teamPurchase(makeStudent().id, marcusCourse.id, 20000, 4, [], daysBefore(5));

    expect(getUnredeemedSeatCount(sarah.id)).toBe(3);
    expect(getUnredeemedSeatCount(null)).toBe(7);
  });
});

describe("getTopBuyers", () => {
  it("ranks buyers by spend, including a team buyer who never enrolled", () => {
    const sarah = makeUser(schema.UserRole.Instructor, "Sarah");
    const intro = makeCourse(sarah.id);
    const advanced = makeCourse(sarah.id);
    const manager = makeStudent("Manager");
    const keen = makeStudent("Keen");
    const casual = makeStudent("Casual");
    const [a, b] = [makeStudent(), makeStudent()];

    teamPurchase(manager.id, intro.id, 20000, 4, [a.id, b.id], daysBefore(5));
    buyAndEnrol(keen.id, intro.id, 4999, daysBefore(5));
    buyAndEnrol(keen.id, advanced.id, 7999, daysBefore(4));
    buyAndEnrol(casual.id, intro.id, 2500, daysBefore(3));

    const leaders = getTopBuyers(sarah.id, "30d", NOW);

    expect(leaders.map((l) => l.name)).toEqual(["Manager", "Keen", "Casual"]);
    expect(leaders[0]).toMatchObject({
      totalSpentCents: 20000,
      purchaseCount: 1,
      seatCount: 4,
      unredeemedSeatCount: 2,
      isEnrolled: false,
    });
    expect(leaders[1]).toMatchObject({
      totalSpentCents: 12998,
      purchaseCount: 2,
      seatCount: 0,
      unredeemedSeatCount: 0,
      isEnrolled: true,
    });
  });

  it("returns at most 10 buyers, the biggest spenders", () => {
    const sarah = makeUser(schema.UserRole.Instructor, "Sarah");
    const course = makeCourse(sarah.id);
    for (let i = 1; i <= 12; i++) {
      buyAndEnrol(makeStudent(`Buyer ${i}`).id, course.id, i * 1000, daysBefore(2));
    }

    const leaders = getTopBuyers(sarah.id, "30d", NOW);

    expect(leaders).toHaveLength(10);
    expect(leaders[0].name).toBe("Buyer 12");
    expect(leaders[9].name).toBe("Buyer 3");
  });

  it("only counts purchases inside the range", () => {
    const sarah = makeUser(schema.UserRole.Instructor, "Sarah");
    const course = makeCourse(sarah.id);
    buyAndEnrol(makeStudent("Recent").id, course.id, 1000, daysBefore(2));
    buyAndEnrol(makeStudent("Old").id, course.id, 9000, daysBefore(60));

    expect(getTopBuyers(sarah.id, "30d", NOW).map((l) => l.name)).toEqual([
      "Recent",
    ]);
    expect(getTopBuyers(sarah.id, "all", NOW).map((l) => l.name)).toEqual([
      "Old",
      "Recent",
    ]);
  });
});

function makeLesson(courseId: number) {
  counter += 1;
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title: `Module ${counter}`, position: 1 })
    .returning()
    .get();
  return testDb
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title: `Lesson ${counter}`, position: 1 })
    .returning()
    .get();
}

function comment(lessonId: number, userId: number, parentId?: number) {
  return testDb
    .insert(schema.comments)
    .values({ lessonId, userId, parentId: parentId ?? null, body: "Hi" })
    .returning()
    .get();
}

function rate(userId: number, courseId: number, rating: number) {
  testDb.insert(schema.courseRatings).values({ userId, courseId, rating }).run();
}

describe("getUnansweredQuestionCount", () => {
  it("counts student questions with no staff reply, for this instructor only", () => {
    const sarah = makeUser(schema.UserRole.Instructor, "Sarah");
    const marcus = makeUser(schema.UserRole.Instructor, "Marcus");
    const sarahLesson = makeLesson(makeCourse(sarah.id).id);
    const marcusLesson = makeLesson(makeCourse(marcus.id).id);
    const student = makeStudent();

    comment(sarahLesson.id, student.id); // waiting
    const answered = comment(sarahLesson.id, student.id);
    comment(sarahLesson.id, sarah.id, answered.id); // answered by Sarah
    comment(marcusLesson.id, student.id); // Marcus's, not Sarah's

    expect(getUnansweredQuestionCount(sarah.id)).toBe(1);
    expect(getUnansweredQuestionCount(null)).toBe(2);
  });
});

describe("getCourseRatings", () => {
  it("averages ratings per published course, including unrated ones", () => {
    const sarah = makeUser(schema.UserRole.Instructor, "Sarah");
    const marcus = makeUser(schema.UserRole.Instructor, "Marcus");
    const alpha = makeCourse(sarah.id, "Alpha");
    const beta = makeCourse(sarah.id, "Beta");
    const other = makeCourse(marcus.id, "Gamma");
    const [a, b, c] = [makeStudent(), makeStudent(), makeStudent()];

    rate(a.id, alpha.id, 5);
    rate(b.id, alpha.id, 4);
    rate(c.id, alpha.id, 4);
    rate(a.id, other.id, 1);

    expect(getCourseRatings(sarah.id)).toEqual([
      { courseId: alpha.id, title: "Alpha", averageRating: 4.3, ratingCount: 3 },
      { courseId: beta.id, title: "Beta", averageRating: null, ratingCount: 0 },
    ]);
  });
});

describe("an instructor with no data", () => {
  it("gets empty results, not errors or NaN, while others have data", () => {
    const sarah = makeUser(schema.UserRole.Instructor, "Sarah");
    const priya = makeUser(schema.UserRole.Instructor, "Priya");
    const course = makeCourse(sarah.id);
    const student = makeStudent();
    teamPurchase(makeStudent().id, course.id, 15000, 3, [student.id], daysBefore(5));
    rate(student.id, course.id, 5);
    comment(makeLesson(course.id).id, student.id);

    expect(getAudienceSummary(priya.id, "all", NOW)).toEqual({
      buyerCount: 0,
      studentCount: 0,
      attributedRevenueCents: 0,
      revenuePerStudentCents: 0,
    });
    expect(getTopBuyers(priya.id, "all", NOW)).toEqual([]);
    expect(getUnredeemedSeatCount(priya.id)).toBe(0);
    expect(getUnansweredQuestionCount(priya.id)).toBe(0);
    expect(getCourseRatings(priya.id)).toEqual([]);
  });
});
