import { useSearchParams } from "react-router";
import { BookOpen, Users } from "lucide-react";
import { CourseStatus } from "~/db/schema";
import type {
  AnalyticsCourse,
  CountryRevenueMix,
  CourseProgress,
  DropOffFunnel,
  FunnelLesson,
  QuizPassRate,
} from "~/services/analyticsService";
import { ANALYTICS_RANGE_LABELS, type AnalyticsRange } from "~/lib/analytics";
import { COUNTRIES } from "~/lib/ppp";
import { formatPrice } from "~/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

// ─── Course detail tab ───
// Pick one course and diagnose it. The picker writes `?course=<id>`; the
// loader resolves it against the courses this viewer may see. Lesson progress
// has no start timestamp, so those panels ignore the range filter and say
// "all time" instead; quiz pass rates are per student on their best attempt,
// also all time. Only the country revenue mix follows the range.

export type CourseDetailData = {
  courses: AnalyticsCourse[];
  selectedCourseId: number | null;
  range: AnalyticsRange;
  progress: CourseProgress | null;
  funnel: DropOffFunnel | null;
  quizPassRates: QuizPassRate[];
  countryRevenue: CountryRevenueMix | null;
};

const ALL_TIME = "All time";

export function CourseDetail({
  courses,
  selectedCourseId,
  range,
  progress,
  funnel,
  quizPassRates,
  countryRevenue,
}: CourseDetailData) {
  if (courses.length === 0 || selectedCourseId === null) {
    return (
      <EmptyCard
        icon={<BookOpen className="mx-auto mb-4 size-12 text-muted-foreground" />}
        title="No courses to analyse yet"
        body="Create a course and its per-lesson drop-off and progress appear here."
      />
    );
  }

  return (
    <div className="space-y-6">
      <CoursePicker courses={courses} selectedCourseId={selectedCourseId} />

      {!progress || !funnel || progress.enrolledCount === 0 ? (
        <EmptyCard
          icon={<Users className="mx-auto mb-4 size-12 text-muted-foreground" />}
          title="No students enrolled yet"
          body="Progress and drop-off show up once students enrol in this course."
        />
      ) : (
        <>
          <ProgressFigures progress={progress} />
          <DropOffFunnelCard funnel={funnel} />
        </>
      )}

      {/* Outside the enrolment check: a team buyer's revenue can exist before
          anyone redeems a seat. */}
      <div className="grid gap-6 lg:grid-cols-2">
        <QuizPassRatesCard quizzes={quizPassRates} />
        {countryRevenue && (
          <CountryRevenueCard mix={countryRevenue} range={range} />
        )}
      </div>
    </div>
  );
}

function CoursePicker({
  courses,
  selectedCourseId,
}: {
  courses: AnalyticsCourse[];
  selectedCourseId: number;
}) {
  const [searchParams, setSearchParams] = useSearchParams();

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm font-medium text-muted-foreground">Course</span>
      <Select
        value={String(selectedCourseId)}
        onValueChange={(value) => {
          const next = new URLSearchParams(searchParams);
          next.set("course", value);
          setSearchParams(next, { preventScrollReset: true });
        }}
      >
        <SelectTrigger className="w-80" aria-label="Course">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {courses.map((course) => (
            <SelectItem key={course.id} value={String(course.id)}>
              {course.title}
              {course.status !== CourseStatus.Published &&
                ` (${course.status})`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ProgressFigures({ progress }: { progress: CourseProgress }) {
  const averagePercent = Math.round(progress.averageProgress * 100);
  const enrolled = `${progress.enrolledCount} enrolled student${progress.enrolledCount === 1 ? "" : "s"}`;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Card>
        <CardHeader>
          <CardDescription>Average progress</CardDescription>
          <CardTitle className="text-3xl tabular-nums">
            {averagePercent}%
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Bar fraction={progress.averageProgress} />
          <p className="text-xs text-muted-foreground">
            Lessons completed out of {progress.totalLessons}, averaged over{" "}
            {enrolled} · {ALL_TIME.toLowerCase()}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardDescription>Finished the course</CardDescription>
          <CardTitle className="text-3xl tabular-nums">
            {progress.finishedCount}
            <span className="ml-1 text-base font-normal text-muted-foreground">
              of {progress.enrolledCount}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Bar fraction={progress.finishedCount / progress.enrolledCount} />
          <p className="text-xs text-muted-foreground">
            Students who completed every lesson · {ALL_TIME.toLowerCase()}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function DropOffFunnelCard({ funnel }: { funnel: DropOffFunnel }) {
  const { enrolledCount } = funnel;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Drop-off by lesson</CardTitle>
        <CardDescription>
          Enrolled students who reached at least each lesson, out of{" "}
          {enrolledCount}. In-progress counts as reached, so a big drop marks
          where students quit · {ALL_TIME.toLowerCase()}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {funnel.modules.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            This course has no lessons yet.
          </p>
        )}
        {funnel.modules.map((mod) => (
          <section key={mod.moduleId} aria-label={mod.title}>
            <div className="mb-2 flex items-baseline justify-between gap-4 border-b pb-1">
              <h3 className="font-semibold">{mod.title}</h3>
              <p className="text-xs text-muted-foreground tabular-nums">
                {mod.reached} started · {formatDrop(mod.drop)} across module
              </p>
            </div>
            <ol className="space-y-1.5">
              {mod.lessons.map((lesson) => (
                <FunnelRow
                  key={lesson.lessonId}
                  lesson={lesson}
                  enrolledCount={enrolledCount}
                />
              ))}
            </ol>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}

function FunnelRow({
  lesson,
  enrolledCount,
}: {
  lesson: FunnelLesson;
  enrolledCount: number;
}) {
  return (
    <li className="grid grid-cols-[minmax(0,14rem)_1fr_3rem_3.5rem] items-center gap-3 text-sm">
      <span className="truncate" title={lesson.title}>
        <span className="mr-1.5 text-muted-foreground tabular-nums">
          {lesson.number}.
        </span>
        {lesson.title}
      </span>
      <Bar fraction={enrolledCount === 0 ? 0 : lesson.reached / enrolledCount} />
      <span className="text-right tabular-nums">{lesson.reached}</span>
      <span
        className={
          lesson.drop > 0
            ? "text-right font-medium text-destructive tabular-nums"
            : "text-right text-muted-foreground tabular-nums"
        }
      >
        {formatDrop(lesson.drop)}
      </span>
    </li>
  );
}

function QuizPassRatesCard({ quizzes }: { quizzes: QuizPassRate[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Quiz pass rates</CardTitle>
        <CardDescription>
          Share of students who passed, counting each student once on their
          best attempt · {ALL_TIME.toLowerCase()}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {quizzes.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            This course has no quizzes yet.
          </p>
        ) : (
          <ul className="space-y-4">
            {quizzes.map((quiz) => (
              <li key={quiz.quizId} className="space-y-1.5 text-sm">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="min-w-0 truncate" title={quiz.title}>
                    <span className="font-medium">{quiz.title}</span>
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {quiz.lessonTitle}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {quiz.studentCount === 0 ? (
                      <span className="text-muted-foreground">
                        No attempts yet
                      </span>
                    ) : (
                      <>
                        <span className="font-medium">
                          {Math.round(quiz.passRate * 100)}%
                        </span>
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          {quiz.passedCount} of {quiz.studentCount}
                        </span>
                      </>
                    )}
                  </span>
                </div>
                <Bar fraction={quiz.passRate} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const COUNTRY_NAMES = new Map(COUNTRIES.map((c) => [c.code, c.name]));

function CountryRevenueCard({
  mix,
  range,
}: {
  mix: CountryRevenueMix;
  range: AnalyticsRange;
}) {
  const rangeLabel = ANALYTICS_RANGE_LABELS[range].toLowerCase();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue by country</CardTitle>
        <CardDescription>
          Gross revenue by buyer country · {rangeLabel}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {mix.countries.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {range === "all"
              ? "No sales of this course yet."
              : "No sales of this course in this period yet. Try a longer range."}
          </p>
        ) : (
          <div className="space-y-5">
            <div className="rounded-md border p-3">
              <p className="text-sm text-muted-foreground">
                From PPP-discounted countries
              </p>
              <p className="text-2xl font-semibold tabular-nums">
                {Math.round(mix.discountedShare * 100)}%
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {formatCents(mix.discountedCents)} of{" "}
                  {formatCents(mix.grossCents)}
                </span>
              </p>
            </div>
            <ul className="space-y-2">
              {mix.countries.map((row) => (
                <li
                  key={row.country ?? "unknown"}
                  className="grid grid-cols-[minmax(0,10rem)_1fr_5.5rem] items-center gap-3 text-sm"
                >
                  <span className="truncate">
                    {row.country
                      ? (COUNTRY_NAMES.get(row.country) ?? row.country)
                      : "Unknown"}
                    {row.discount > 0 && (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {Math.round(row.discount * 100)}% off
                      </span>
                    )}
                  </span>
                  <Bar fraction={row.grossCents / mix.grossCents} />
                  <span className="text-right tabular-nums">
                    {formatCents(row.grossCents)}
                    <span className="block text-xs text-muted-foreground">
                      {row.purchaseCount} sale{row.purchaseCount === 1 ? "" : "s"}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** `formatPrice` renders 0 as "Free", which reads wrong for revenue. */
function formatCents(cents: number) {
  return cents === 0 ? "$0.00" : formatPrice(cents);
}

/** The app's progress-bar idiom: a plain div track and fill. */
function Bar({ fraction }: { fraction: number }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary transition-all"
        style={{ width: `${Math.round(fraction * 100)}%` }}
      />
    </div>
  );
}

function formatDrop(drop: number) {
  return drop === 0 ? "0" : `−${drop}`;
}

function EmptyCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <Card>
      <CardContent className="py-12 text-center">
        {icon}
        <p className="font-medium">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      </CardContent>
    </Card>
  );
}
