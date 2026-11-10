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
  getAnalyticsCourses,
  getCourseProgress,
  getDropOffFunnel,
  getCountryRevenue,
  getCourseDetail,
  getQuizPassRates,
} from "./analyticsService";

// ─── Local fixture helpers (Course detail tab) ───
// Kept separate from analyticsService.test.ts so the Overview and Course detail
// suites can grow independently. A course is built as modules of N lessons; a
// student's progress is described by the 1-based lesson numbers they touched.

let counter = 0;
let categoryId: number;

function makeUser(role: schema.UserRole = schema.UserRole.Student) {
  counter += 1;
  return testDb
    .insert(schema.users)
    .values({ name: `User ${counter}`, email: `user${counter}@example.com`, role })
    .returning()
    .get();
}

/**
 * A published course whose modules hold the given number of lessons, e.g.
 * `[3, 2]` → module 1 has lessons 1-3, module 2 has lessons 4-5. Returns the
 * course and its lesson ids in course order, so `lessonIds[n - 1]` is lesson n.
 * Creates a fresh instructor unless one is given.
 */
function makeCourse(
  lessonsPerModule: number[],
  {
    instructor = makeUser(schema.UserRole.Instructor),
    status = schema.CourseStatus.Published,
  }: { instructor?: { id: number }; status?: schema.CourseStatus } = {}
) {
  counter += 1;
  const course = testDb
    .insert(schema.courses)
    .values({
      title: `Course ${counter}`,
      slug: `course-${counter}`,
      description: "A course",
      salesCopy: "Buy it",
      instructorId: instructor.id,
      categoryId,
      status,
      price: 4999,
    })
    .returning()
    .get();

  const lessonIds: number[] = [];
  lessonsPerModule.forEach((lessonCount, moduleIndex) => {
    const mod = testDb
      .insert(schema.modules)
      .values({
        courseId: course.id,
        title: `Module ${moduleIndex + 1}`,
        position: moduleIndex + 1,
      })
      .returning()
      .get();
    for (let i = 1; i <= lessonCount; i++) {
      const lesson = testDb
        .insert(schema.lessons)
        .values({
          moduleId: mod.id,
          title: `Lesson ${lessonIds.length + 1}`,
          position: i,
        })
        .returning()
        .get();
      lessonIds.push(lesson.id);
    }
  });

  return { course, lessonIds, instructor };
}

type Progress = {
  completed?: number[];
  inProgress?: number[];
};

/** Enrols a new student in the course with progress on the given lessons. */
function makeStudent(
  { course, lessonIds }: ReturnType<typeof makeCourse>,
  { completed = [], inProgress = [] }: Progress = {}
) {
  const student = makeUser();
  testDb
    .insert(schema.enrollments)
    .values({ userId: student.id, courseId: course.id })
    .run();
  const rows = [
    ...completed.map((n) => ({
      userId: student.id,
      lessonId: lessonIds[n - 1],
      status: schema.LessonProgressStatus.Completed,
      completedAt: "2026-06-01T00:00:00.000Z",
    })),
    ...inProgress.map((n) => ({
      userId: student.id,
      lessonId: lessonIds[n - 1],
      status: schema.LessonProgressStatus.InProgress,
    })),
  ];
  if (rows.length > 0) testDb.insert(schema.lessonProgress).values(rows).run();
  return student;
}

/** Lessons 1..n, for "completed everything up to n". */
function upTo(n: number) {
  return Array.from({ length: n }, (_, i) => i + 1);
}

/** A quiz on lesson n of the course. */
function makeQuiz(
  { lessonIds }: ReturnType<typeof makeCourse>,
  lessonNumber: number,
  title = `Quiz ${lessonNumber}`
) {
  return testDb
    .insert(schema.quizzes)
    .values({ lessonId: lessonIds[lessonNumber - 1], title, passingScore: 0.7 })
    .returning()
    .get();
}

/** Records attempts by one student, in order: true = passed, false = failed. */
function attempt(
  student: { id: number },
  quiz: { id: number },
  ...results: boolean[]
) {
  for (const passed of results) {
    testDb
      .insert(schema.quizAttempts)
      .values({
        userId: student.id,
        quizId: quiz.id,
        score: passed ? 0.9 : 0.4,
        passed,
      })
      .run();
  }
}

const NOW = new Date("2026-06-15T12:00:00.000Z");

function daysBefore(days: number) {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

/** A purchase of the course by a fresh buyer from `country`. */
function makePurchase(
  { course }: ReturnType<typeof makeCourse>,
  amountPaid: number,
  country: string | null,
  createdAt = daysBefore(1)
) {
  const buyer = makeUser();
  testDb
    .insert(schema.purchases)
    .values({ userId: buyer.id, courseId: course.id, amountPaid, country, createdAt })
    .run();
}

/** A team purchase of `seats` seats by a fresh buyer from `country`. */
function makeTeamPurchase(
  { course }: ReturnType<typeof makeCourse>,
  amountPaid: number,
  country: string | null,
  seats: number
) {
  const buyer = makeUser();
  const purchase = testDb
    .insert(schema.purchases)
    .values({
      userId: buyer.id,
      courseId: course.id,
      amountPaid,
      country,
      createdAt: daysBefore(1),
    })
    .returning()
    .get();
  const team = testDb.insert(schema.teams).values({}).returning().get();
  for (let seat = 0; seat < seats; seat++) {
    counter += 1;
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: course.id,
        code: `SEAT-${counter}`,
        purchaseId: purchase.id,
      })
      .run();
  }
}

function reachedSeries(funnel: ReturnType<typeof getDropOffFunnel>) {
  return funnel.modules.flatMap((m) => m.lessons.map((l) => l.reached));
}

beforeEach(() => {
  testDb = createTestDb();
  categoryId = testDb
    .insert(schema.categories)
    .values({ name: "Programming", slug: "programming" })
    .returning()
    .get().id;
});

describe("getDropOffFunnel", () => {
  it("counts students who reached at least each lesson, descending to a planted cliff", () => {
    const course = makeCourse([5]);
    // 4 students: two finish, one stops after lesson 3, one after lesson 1.
    makeStudent(course, { completed: upTo(5) });
    makeStudent(course, { completed: upTo(5) });
    makeStudent(course, { completed: upTo(3) });
    makeStudent(course, { completed: upTo(1) });

    const funnel = getDropOffFunnel(course.course.id);

    expect(funnel.enrolledCount).toBe(4);
    expect(reachedSeries(funnel)).toEqual([4, 3, 3, 2, 2]);
  });

  it("counts a student who skipped a lesson but continued past it as present at the skipped lesson", () => {
    const course = makeCourse([4]);
    makeStudent(course, { completed: [1, 2, 4] }); // no row at all for lesson 3
    makeStudent(course, { completed: upTo(4) });

    const funnel = getDropOffFunnel(course.course.id);

    expect(reachedSeries(funnel)).toEqual([2, 2, 2, 2]);
  });

  it("counts an in-progress lesson as reached", () => {
    const course = makeCourse([3]);
    makeStudent(course, { completed: [1], inProgress: [2] });
    makeStudent(course, { completed: upTo(3) });

    const funnel = getDropOffFunnel(course.course.id);

    expect(reachedSeries(funnel)).toEqual([2, 2, 1]);
  });

  it("shows each lesson's drop and groups lessons under modules with subtotals", () => {
    const course = makeCourse([2, 3]);
    // 5 enrolled: one never started, one stopped at lesson 2, one at lesson 4.
    makeStudent(course);
    makeStudent(course, { completed: upTo(2) });
    makeStudent(course, { completed: upTo(4) });
    makeStudent(course, { completed: upTo(5) });
    makeStudent(course, { completed: upTo(5) });

    const funnel = getDropOffFunnel(course.course.id);

    expect(funnel.enrolledCount).toBe(5);
    expect(
      funnel.modules.map((m) => ({
        title: m.title,
        reached: m.reached,
        drop: m.drop,
        lessons: m.lessons.map((l) => [l.number, l.reached, l.drop]),
      }))
    ).toEqual([
      {
        title: "Module 1",
        reached: 4,
        drop: 1,
        lessons: [
          [1, 4, 1],
          [2, 4, 0],
        ],
      },
      {
        title: "Module 2",
        reached: 3,
        drop: 2,
        lessons: [
          [3, 3, 1],
          [4, 3, 0],
          [5, 2, 1],
        ],
      },
    ]);
  });

  it("ignores progress from students not enrolled in the course", () => {
    const course = makeCourse([2]);
    makeStudent(course, { completed: upTo(2) });
    const stranger = makeUser();
    testDb
      .insert(schema.lessonProgress)
      .values({
        userId: stranger.id,
        lessonId: course.lessonIds[0],
        status: schema.LessonProgressStatus.Completed,
      })
      .run();

    expect(reachedSeries(getDropOffFunnel(course.course.id))).toEqual([1, 1]);
  });

  it("returns zero counts, not NaN, for a course with no enrollees", () => {
    const course = makeCourse([2]);

    const funnel = getDropOffFunnel(course.course.id);

    expect(funnel.enrolledCount).toBe(0);
    expect(reachedSeries(funnel)).toEqual([0, 0]);
    expect(funnel.modules[0].lessons.map((l) => l.drop)).toEqual([0, 0]);
  });
});

describe("getAnalyticsCourses", () => {
  it("lists only the instructor's courses, or every course for all instructors", () => {
    const a = makeCourse([1]);
    const b = makeCourse([1]);

    expect(getAnalyticsCourses(a.instructor.id).map((c) => c.id)).toEqual([
      a.course.id,
    ]);
    expect(getAnalyticsCourses(null).map((c) => c.id)).toEqual([
      a.course.id,
      b.course.id,
    ]);
  });

  it("returns an empty list for an instructor with no courses", () => {
    const loner = makeUser(schema.UserRole.Instructor);

    expect(getAnalyticsCourses(loner.id)).toEqual([]);
  });
});

describe("getCourseDetail", () => {
  it("selects the requested course when the viewer owns it", () => {
    const first = makeCourse([1]);
    const second = makeCourse([1], { instructor: first.instructor });
    makeStudent(second);
    makePurchase(second, 4999, "US");

    const detail = getCourseDetail(first.instructor.id, second.course.id, "30d", NOW);

    expect(detail.courses.map((c) => c.id)).toEqual([
      first.course.id,
      second.course.id,
    ]);
    expect(detail.selectedCourseId).toBe(second.course.id);
    expect(detail.range).toBe("30d");
    expect(detail.progress?.enrolledCount).toBe(1);
    expect(detail.funnel?.enrolledCount).toBe(1);
    expect(detail.countryRevenue?.grossCents).toBe(4999);
  });

  it("falls back to the first published course when no course is requested", () => {
    const draft = makeCourse([1], { status: schema.CourseStatus.Draft });
    const published = makeCourse([1], { instructor: draft.instructor });

    expect(
      getCourseDetail(draft.instructor.id, null, "30d", NOW).selectedCourseId
    ).toBe(published.course.id);
  });

  it("ignores a course the viewer doesn't own and falls back to their own", () => {
    const mine = makeCourse([1]);
    const theirs = makeCourse([1]);
    makePurchase(theirs, 9999, "US");

    const detail = getCourseDetail(mine.instructor.id, theirs.course.id, "all", NOW);

    expect(detail.selectedCourseId).toBe(mine.course.id);
    expect(detail.countryRevenue?.grossCents).toBe(0);
  });

  it("lets the all-instructors view select any course", () => {
    makeCourse([1]);
    const other = makeCourse([1]);

    expect(getCourseDetail(null, other.course.id, "30d", NOW).selectedCourseId).toBe(
      other.course.id
    );
  });

  it("selects nothing, with empty panels, for an instructor with no courses", () => {
    const loner = makeUser(schema.UserRole.Instructor);

    expect(getCourseDetail(loner.id, null, "30d", NOW)).toEqual({
      courses: [],
      selectedCourseId: null,
      range: "30d",
      progress: null,
      funnel: null,
      quizPassRates: [],
      countryRevenue: null,
    });
  });
});

describe("getCourseProgress", () => {
  it("averages completed-over-total lessons across enrollees and counts finishers separately", () => {
    const course = makeCourse([2, 2]);
    // Progress 4/4, 3/4, 3/4, 2/4 → average 75%, yet only one has finished.
    makeStudent(course, { completed: upTo(4) });
    makeStudent(course, { completed: upTo(3), inProgress: [4] });
    makeStudent(course, { completed: [1, 2, 4] });
    makeStudent(course, { completed: upTo(2) });

    expect(getCourseProgress(course.course.id)).toEqual({
      enrolledCount: 4,
      totalLessons: 4,
      averageProgress: 0.75,
      finishedCount: 1,
    });
  });

  it("counts an enrollee with no progress as 0% rather than leaving them out", () => {
    const course = makeCourse([2]);
    makeStudent(course, { completed: upTo(2) });
    makeStudent(course);

    expect(getCourseProgress(course.course.id).averageProgress).toBe(0.5);
  });

  it("returns zeros, not NaN, for a course with no enrollees", () => {
    const course = makeCourse([3]);

    expect(getCourseProgress(course.course.id)).toEqual({
      enrolledCount: 0,
      totalLessons: 3,
      averageProgress: 0,
      finishedCount: 0,
    });
  });

  it("returns zeros, not NaN, for a course with enrollees but no lessons", () => {
    const course = makeCourse([]);
    makeStudent(course);

    expect(getCourseProgress(course.course.id)).toEqual({
      enrolledCount: 1,
      totalLessons: 0,
      averageProgress: 0,
      finishedCount: 0,
    });
  });
});

describe("getQuizPassRates", () => {
  it("counts a student who failed then passed once, as passed", () => {
    const course = makeCourse([2]);
    const quiz = makeQuiz(course, 1);
    attempt(makeStudent(course), quiz, false, true); // failed, then passed
    attempt(makeStudent(course), quiz, false, false); // never passed
    attempt(makeStudent(course), quiz, true);

    expect(getQuizPassRates(course.course.id)).toEqual([
      {
        quizId: quiz.id,
        title: "Quiz 1",
        lessonTitle: "Lesson 1",
        studentCount: 3,
        passedCount: 2,
        passRate: 2 / 3,
      },
    ]);
  });

  it("lists only this course's quizzes, in course order, including ones nobody has attempted", () => {
    const course = makeCourse([1, 1]);
    makeQuiz(course, 2, "Final quiz");
    const earlier = makeQuiz(course, 1, "First quiz");
    attempt(makeStudent(course), earlier, true);
    const other = makeCourse([1]);
    attempt(makeStudent(other), makeQuiz(other, 1), true);

    expect(
      getQuizPassRates(course.course.id).map((q) => [
        q.title,
        q.studentCount,
        q.passRate,
      ])
    ).toEqual([
      ["First quiz", 1, 1],
      ["Final quiz", 0, 0],
    ]);
  });

  it("returns an empty list for a course with no quizzes", () => {
    const course = makeCourse([2]);
    makeStudent(course, { completed: upTo(2) });

    expect(getQuizPassRates(course.course.id)).toEqual([]);
  });
});

describe("getCountryRevenue", () => {
  it("breaks the course's gross revenue for the range down by country, summing to the total", () => {
    const course = makeCourse([1]);
    makePurchase(course, 4999, "US");
    makePurchase(course, 4999, "US");
    makePurchase(course, 2500, "IN"); // tier 3, 50% off
    makePurchase(course, 1500, "NG"); // tier 4, 70% off
    makePurchase(course, 4999, null); // no country recorded
    makePurchase(course, 4999, "US", daysBefore(45)); // outside 30d
    makePurchase(makeCourse([1]), 9999, "US"); // another course

    const mix = getCountryRevenue(course.course.id, "30d", NOW);

    expect(mix.grossCents).toBe(18997);
    expect(mix.countries.map((c) => [c.country, c.grossCents, c.purchaseCount]))
      .toEqual([
        ["US", 9998, 2],
        [null, 4999, 1],
        ["IN", 2500, 1],
        ["NG", 1500, 1],
      ]);
    expect(mix.countries.reduce((sum, c) => sum + c.grossCents, 0)).toBe(
      mix.grossCents
    );
  });

  it("shows how much revenue came from PPP-discounted countries", () => {
    const course = makeCourse([1]);
    makePurchase(course, 6000, "US");
    makePurchase(course, 3000, "IN");
    makePurchase(course, 1000, "KE");

    const mix = getCountryRevenue(course.course.id, "all", NOW);

    expect(mix.discountedCents).toBe(4000);
    expect(mix.discountedShare).toBe(0.4);
    expect(mix.countries.map((c) => [c.country, c.discount])).toEqual([
      ["US", 0],
      ["IN", 0.5],
      ["KE", 0.7],
    ]);
  });

  it("counts a purchase as discounted only when the buyer paid less than list price", () => {
    // List price is 4999. PPP was off when this Indian buyer bought, so they
    // paid full price: their country's tier alone must not make it discounted.
    const course = makeCourse([1]);
    makePurchase(course, 4999, "IN"); // full price despite a tier-3 country
    makePurchase(course, 2500, "IN"); // PPP price
    makeTeamPurchase(course, 3 * 4999, "BR", 3); // full price for 3 seats
    makeTeamPurchase(course, 3 * 3499, "BR", 3); // PPP price for 3 seats

    const mix = getCountryRevenue(course.course.id, "all", NOW);

    expect(mix.grossCents).toBe(4999 + 2500 + 3 * 4999 + 3 * 3499);
    expect(mix.discountedCents).toBe(2500 + 3 * 3499);
    expect(
      mix.countries.map((c) => [c.country, c.grossCents, c.discountedCents])
    ).toEqual([
      ["BR", 3 * 4999 + 3 * 3499, 3 * 3499],
      ["IN", 4999 + 2500, 2500],
    ]);
  });

  it("returns an empty breakdown, not NaN, for a course with no sales", () => {
    const course = makeCourse([1]);

    expect(getCountryRevenue(course.course.id, "all", NOW)).toEqual({
      grossCents: 0,
      discountedCents: 0,
      discountedShare: 0,
      countries: [],
    });
  });
});
