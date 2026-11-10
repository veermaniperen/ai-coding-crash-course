import { useSearchParams } from "react-router";
import { BookOpen, Users } from "lucide-react";
import { CourseStatus } from "~/db/schema";
import type {
  AnalyticsCourse,
  CourseProgress,
  DropOffFunnel,
  FunnelLesson,
} from "~/services/analyticsService";
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
// has no start timestamp, so these panels ignore the range filter and say
// "all time" instead.

export type CourseDetailData = {
  courses: AnalyticsCourse[];
  selectedCourseId: number | null;
  progress: CourseProgress | null;
  funnel: DropOffFunnel | null;
};

const ALL_TIME = "All time";

export function CourseDetail({
  courses,
  selectedCourseId,
  progress,
  funnel,
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
