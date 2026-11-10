import { Link, isRouteErrorResponse, useSearchParams } from "react-router";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { AlertTriangle, BookOpen } from "lucide-react";
import type { Route } from "./+types/instructor.analytics";
import { requireInstructorOrAdmin } from "~/lib/access.server";
import {
  getAnalyticsCourses,
  getCountryRevenue,
  getCourseProgress,
  getDropOffFunnel,
  getQuizPassRates,
  getRevenueOverTime,
  getRevenueSummary,
  hasPublishedCourses,
  type RevenuePoint,
  type RevenueSummary,
} from "~/services/analyticsService";
import { getUsersByRole } from "~/services/userService";
import { CourseStatus, UserRole } from "~/db/schema";
import {
  CourseDetail,
  type CourseDetailData,
} from "~/components/analytics/course-detail";
import {
  ANALYTICS_RANGES,
  ANALYTICS_RANGE_LABELS,
  PLATFORM_FEE_RATE,
  parseAnalyticsRange,
  type AnalyticsRange,
} from "~/lib/analytics";
import { cn, formatPrice } from "~/lib/utils";
import { Button } from "~/components/ui/button";
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
import { Skeleton } from "~/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "~/components/ui/chart";

// ─── Instructor Analytics ───
// "How is my teaching business doing?" — one page, two tabs. All view state
// (tab, range, and the admin's instructor filter) lives in the URL so a view
// can be bookmarked or shared; the loader reads it and calls the analytics
// service, which owns every number including the date cutoff.
//
// URL params:
//   tab        — "overview" (default) | "course"
//   range      — "7d" | "30d" (default) | "90d" | "all"
//   instructor — admins only: an instructor's user id; absent = all instructors
//   course     — Course detail tab: a course id from the viewer's courses;
//                absent or foreign = first published course

const TABS = ["overview", "course"] as const;
type AnalyticsTab = (typeof TABS)[number];

// Radix Select can't use "" as an item value, so "all" stands in for "no param".
const ALL_INSTRUCTORS = "all";

function parseTab(value: string | null): AnalyticsTab {
  return TABS.find((tab) => tab === value) ?? "overview";
}

export function meta() {
  return [{ title: "Analytics — Cadence" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { userId, isAdmin } = await requireInstructorOrAdmin(request);
  const params = new URL(request.url).searchParams;

  const tab = parseTab(params.get("tab"));
  const range = parseAnalyticsRange(params.get("range"));

  // Instructors always see themselves. Admins pick one instructor or, with no
  // param (or one that isn't an instructor), the whole platform.
  const instructors = isAdmin
    ? getUsersByRole(UserRole.Instructor).map(({ id, name }) => ({ id, name }))
    : [];
  const requested = Number(params.get("instructor"));
  const instructorId = isAdmin
    ? (instructors.find((i) => i.id === requested)?.id ?? null)
    : userId;

  return {
    isAdmin,
    tab,
    range,
    instructors,
    instructorId,
    courseDetail:
      tab === "course"
        ? loadCourseDetail(instructorId, params.get("course"), range)
        : null,
    hasPublishedCourses: hasPublishedCourses(instructorId),
    revenue: getRevenueSummary(instructorId, range),
    revenueOverTime: getRevenueOverTime(instructorId, range),
  };
}

/**
 * `?course=<id>` is honoured only if it's one of the viewer's courses;
 * otherwise the first published course (or first course) is selected.
 */
function loadCourseDetail(
  instructorId: number | null,
  courseParam: string | null,
  range: AnalyticsRange
): CourseDetailData {
  const courses = getAnalyticsCourses(instructorId);
  const selected =
    courses.find((c) => c.id === Number(courseParam)) ??
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
    countryRevenue: getCountryRevenue(selected.id, range),
  };
}

export default function InstructorAnalytics({
  loaderData,
}: Route.ComponentProps) {
  const {
    isAdmin,
    tab,
    range,
    instructors,
    instructorId,
    courseDetail,
    hasPublishedCourses,
    revenue,
    revenueOverTime,
  } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();

  function updateParam(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams);
    if (value === null) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    setSearchParams(next, { preventScrollReset: true });
  }

  function rangeHref(value: AnalyticsRange) {
    const next = new URLSearchParams(searchParams);
    next.set("range", value);
    return `?${next.toString()}`;
  }

  const selectedInstructor = instructors.find((i) => i.id === instructorId);

  return (
    <div className="mx-auto max-w-6xl p-6 lg:p-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Analytics</h1>
          <p className="mt-1 text-muted-foreground">
            {isAdmin
              ? selectedInstructor
                ? `${selectedInstructor.name}'s teaching business.`
                : "The whole platform, across every instructor."
              : "How your teaching business is doing."}
          </p>
        </div>

        {isAdmin && (
          <Select
            value={
              instructorId === null ? ALL_INSTRUCTORS : String(instructorId)
            }
            onValueChange={(value) =>
              updateParam(
                "instructor",
                value === ALL_INSTRUCTORS ? null : value
              )
            }
          >
            <SelectTrigger className="w-56" aria-label="Instructor">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_INSTRUCTORS}>All instructors</SelectItem>
              {instructors.map((instructor) => (
                <SelectItem key={instructor.id} value={String(instructor.id)}>
                  {instructor.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {!hasPublishedCourses ? (
        <NoPublishedCourses isAdmin={isAdmin} />
      ) : (
        <Tabs value={tab} onValueChange={(value) => updateParam("tab", value)}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="course">Course detail</TabsTrigger>
            </TabsList>

            <nav
              aria-label="Time range"
              className="inline-flex rounded-lg bg-muted p-1"
            >
              {ANALYTICS_RANGES.map((value) => (
                <Link
                  key={value}
                  to={rangeHref(value)}
                  preventScrollReset
                  aria-current={value === range ? "page" : undefined}
                  className={cn(
                    "rounded-md px-3 py-1 text-sm font-medium transition-colors",
                    value === range
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {ANALYTICS_RANGE_LABELS[value]}
                </Link>
              ))}
            </nav>
          </div>

          <TabsContent value="overview" className="mt-4 space-y-6">
            <RevenueFigures revenue={revenue} range={range} />
            <RevenueChart points={revenueOverTime} range={range} />
          </TabsContent>

          <TabsContent value="course" className="mt-4">
            {courseDetail && <CourseDetail {...courseDetail} />}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function NoPublishedCourses({ isAdmin }: { isAdmin: boolean }) {
  return (
    <Card>
      <CardContent className="py-12 text-center">
        <BookOpen className="mx-auto mb-4 size-12 text-muted-foreground" />
        <p className="font-medium">
          {isAdmin
            ? "No published courses yet"
            : "Publish your first course to see analytics"}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {isAdmin
            ? "Analytics appear here once this instructor publishes a course."
            : "Revenue, students, and drop-off show up here once a course is live."}
        </p>
        {!isAdmin && (
          <Link to="/instructor" className="mt-6 inline-block">
            <Button>Go to My Courses</Button>
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

function RevenueFigures({
  revenue,
  range,
}: {
  revenue: RevenueSummary;
  range: AnalyticsRange;
}) {
  const feePercent = Math.round(PLATFORM_FEE_RATE * 100);
  const figures = [
    {
      label: "Gross revenue",
      value: revenue.grossCents,
      note: `${revenue.purchaseCount} purchase${revenue.purchaseCount === 1 ? "" : "s"}`,
    },
    {
      label: `Platform fee (${feePercent}%)`,
      value: revenue.feeCents,
      note: "Kept by the platform",
    },
    {
      label: "Net earnings",
      value: revenue.netCents,
      note: "Gross minus the platform fee — not a payout",
    },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {figures.map((figure) => (
        <Card key={figure.label}>
          <CardHeader>
            <CardDescription>{figure.label}</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {formatCents(figure.value)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {figure.note} · {ANALYTICS_RANGE_LABELS[range].toLowerCase()}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

const revenueChartConfig = {
  grossCents: { label: "Gross revenue", color: "var(--chart-1)" },
} satisfies ChartConfig;

function RevenueChart({
  points,
  range,
}: {
  points: RevenuePoint[];
  range: AnalyticsRange;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue over time</CardTitle>
        <CardDescription>
          Gross revenue per {range === "all" ? "month" : "day"},{" "}
          {ANALYTICS_RANGE_LABELS[range].toLowerCase()}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {points.length === 0 ? (
          <div className="flex h-64 items-center justify-center text-center text-sm text-muted-foreground">
            No sales in this period yet. Try a longer range.
          </div>
        ) : (
          <ChartContainer
            config={revenueChartConfig}
            className="aspect-auto h-64 w-full"
          >
            <AreaChart data={points} margin={{ left: 8, right: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="period"
                tickLine={false}
                axisLine={false}
                minTickGap={24}
                tickFormatter={formatPeriod}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={(cents: number) => `$${Math.round(cents / 100)}`}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, payload) =>
                      formatPeriod(String(payload?.[0]?.payload?.period ?? ""))
                    }
                    formatter={(value) => (
                      <span className="font-mono font-medium tabular-nums">
                        {formatCents(Number(value))}
                      </span>
                    )}
                  />
                }
              />
              <Area
                dataKey="grossCents"
                type="monotone"
                stroke="var(--color-grossCents)"
                fill="var(--color-grossCents)"
                fillOpacity={0.2}
              />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

/** "$0.00" for zero, rather than formatPrice's "Free". */
function formatCents(cents: number) {
  return cents === 0 ? "$0.00" : formatPrice(cents);
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * "2026-06-13" → "Jun 13", "2026-06" → "Jun 2026". Done by hand rather than
 * with Intl so the server and client render identical labels regardless of
 * locale or time zone.
 */
function formatPeriod(period: string) {
  const [year, month, day] = period.split("-");
  const name = MONTHS[Number(month) - 1] ?? "";
  return day ? `${name} ${Number(day)}` : `${name} ${year}`;
}

export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-6xl p-6 lg:p-8">
      <div className="mb-6">
        <Skeleton className="mb-2 h-9 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-9 w-96" />
      </div>
      <div className="mt-4 space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
        </div>
        <Skeleton className="h-[22rem] w-full" />
      </div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading your analytics.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Not allowed";
      message =
        typeof error.data === "string"
          ? error.data
          : "You don't have access to this page.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/courses">
          <Button>Browse Courses</Button>
        </Link>
      </div>
    </div>
  );
}
