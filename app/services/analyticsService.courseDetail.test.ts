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
 */
function makeCourse(lessonsPerModule: number[]) {
  const instructor = makeUser(schema.UserRole.Instructor);
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
      status: schema.CourseStatus.Published,
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
