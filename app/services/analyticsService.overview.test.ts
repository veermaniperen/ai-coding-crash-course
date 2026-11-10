import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "~/test/setup";
import * as schema from "~/db/schema";
import { eq } from "drizzle-orm";

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
import { getUnansweredQuestions } from "./commentService";

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
        createdAt: at,
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

    expect(getUnredeemedSeatCount(sarah.id, "all", NOW)).toBe(3);
    expect(getUnredeemedSeatCount(null, "all", NOW)).toBe(7);
  });

  it("only counts seats bought inside the range, the cutoff itself included", () => {
    const sarah = makeUser(schema.UserRole.Instructor, "Sarah");
    const course = makeCourse(sarah.id);

    teamPurchase(makeStudent().id, course.id, 9000, 2, [], daysBefore(5));
    teamPurchase(makeStudent().id, course.id, 4500, 1, [], daysBefore(30)); // exactly at the cutoff
    teamPurchase(makeStudent().id, course.id, 13500, 3, [], daysBefore(31));

    expect(getUnredeemedSeatCount(sarah.id, "7d", NOW)).toBe(2);
    expect(getUnredeemedSeatCount(sarah.id, "30d", NOW)).toBe(3);
    expect(getUnredeemedSeatCount(sarah.id, "all", NOW)).toBe(6);
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

function rate(
  userId: number,
  courseId: number,
  rating: number,
  createdAt = daysBefore(1)
) {
  testDb
    .insert(schema.courseRatings)
    .values({ userId, courseId, rating, createdAt, updatedAt: createdAt })
    .run();
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

  it("matches the instructor question queue across every unanswered rule", () => {
    const sarah = makeUser(schema.UserRole.Instructor, "Sarah");
    const admin = makeUser(schema.UserRole.Admin, "Admin");
    const lesson = makeLesson(makeCourse(sarah.id).id);
    const [a, b] = [makeStudent(), makeStudent()];

    comment(lesson.id, a.id); // waiting
    const answeredByAdmin = comment(lesson.id, a.id);
    comment(lesson.id, admin.id, answeredByAdmin.id);
    const studentReplyOnly = comment(lesson.id, b.id); // still waiting
    comment(lesson.id, a.id, studentReplyOnly.id);
    const deletedReply = comment(lesson.id, b.id); // still waiting
    const reply = comment(lesson.id, sarah.id, deletedReply.id);
    testDb
      .update(schema.comments)
      .set({ deletedAt: daysBefore(1) })
      .where(eq(schema.comments.id, reply.id))
      .run();
    const deletedQuestion = comment(lesson.id, b.id);
    testDb
      .update(schema.comments)
      .set({ deletedAt: daysBefore(1) })
      .where(eq(schema.comments.id, deletedQuestion.id))
      .run();
    comment(lesson.id, sarah.id); // staff's own question
    comment(lesson.id, admin.id);

    expect(getUnansweredQuestions(sarah.id)).toHaveLength(3);
    expect(getUnansweredQuestionCount(sarah.id)).toBe(
      getUnansweredQuestions(sarah.id).length
    );
    expect(getUnansweredQuestionCount(null)).toBe(
      getUnansweredQuestions(null).length
    );
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

    expect(getCourseRatings(sarah.id, "all", NOW)).toEqual([
      { courseId: alpha.id, title: "Alpha", averageRating: 4.3, ratingCount: 3 },
      { courseId: beta.id, title: "Beta", averageRating: null, ratingCount: 0 },
    ]);
  });

  it("only counts ratings left inside the range, the cutoff itself included", () => {
    const sarah = makeUser(schema.UserRole.Instructor, "Sarah");
    const alpha = makeCourse(sarah.id, "Alpha");
    const [a, b, c] = [makeStudent(), makeStudent(), makeStudent()];

    rate(a.id, alpha.id, 5, daysBefore(2));
    rate(b.id, alpha.id, 3, daysBefore(30)); // exactly at the cutoff
    rate(c.id, alpha.id, 1, daysBefore(31));

    expect(getCourseRatings(sarah.id, "7d", NOW)).toEqual([
      { courseId: alpha.id, title: "Alpha", averageRating: 5, ratingCount: 1 },
    ]);
    expect(getCourseRatings(sarah.id, "30d", NOW)).toEqual([
      { courseId: alpha.id, title: "Alpha", averageRating: 4, ratingCount: 2 },
    ]);
    expect(getCourseRatings(sarah.id, "all", NOW)).toEqual([
      { courseId: alpha.id, title: "Alpha", averageRating: 3, ratingCount: 3 },
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
    });
    expect(getTopBuyers(priya.id, "all", NOW)).toEqual([]);
    expect(getUnredeemedSeatCount(priya.id, "all", NOW)).toBe(0);
    expect(getUnansweredQuestionCount(priya.id)).toBe(0);
    expect(getCourseRatings(priya.id, "all", NOW)).toEqual([]);
  });
});
