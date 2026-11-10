import { Link } from "react-router";
import { MessageCircleQuestion, Ticket, Users } from "lucide-react";
import type {
  AudienceSummary,
  CourseRating,
  TopBuyer,
} from "~/services/analyticsService";
import { ANALYTICS_RANGE_LABELS, type AnalyticsRange } from "~/lib/analytics";
import { formatPrice } from "~/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { StarRating } from "~/components/star-rating";

// ─── Analytics Overview panels ───
// Everything on the Overview tab below the revenue figures and chart: who is
// buying, who is learning, and what needs the instructor's attention. Each
// panel says which window it covers — the selected range when the data has a
// usable timestamp, "all time" when it is a current snapshot — and carries
// its own empty copy so "nothing yet" never looks like "broken".

export type OverviewPanelsData = {
  audience: AudienceSummary;
  topBuyers: TopBuyer[];
  unredeemedSeats: number;
  unansweredQuestions: number;
  ratings: CourseRating[];
};


export function OverviewPanels({
  data,
  range,
}: {
  data: OverviewPanelsData;
  range: AnalyticsRange;
}) {
  const rangeLabel = ANALYTICS_RANGE_LABELS[range];

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Buyers"
          value={data.audience.buyerCount}
          note={`People who paid · ${rangeLabel.toLowerCase()}`}
          empty="No purchases in this period yet"
        />
        <StatCard
          label="Students"
          value={data.audience.studentCount}
          note={`People who enrolled, seat redeemers included · ${rangeLabel.toLowerCase()}`}
          empty="No new enrolments in this period yet"
        />
        <Card>
          <CardHeader>
            <CardDescription>Revenue per student</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {data.audience.studentCount === 0
                ? "—"
                : formatCents(data.audience.revenuePerStudentCents)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {data.audience.studentCount === 0
              ? "No students in this period to divide by"
              : `Team seats count as their share of the team purchase · ${rangeLabel.toLowerCase()}`}
          </CardContent>
        </Card>
        <AttentionCard
          icon={<Ticket className="size-4" />}
          label="Unredeemed seats"
          value={data.unredeemedSeats}
          note={
            data.unredeemedSeats === 0
              ? "Every purchased team seat has been claimed"
              : "Team seats bought but not yet claimed"
          }
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <TopBuyersPanel
          buyers={data.topBuyers}
          rangeLabel={rangeLabel}
          className="lg:col-span-2"
        />
        <div className="space-y-6">
          <AttentionCard
            icon={<MessageCircleQuestion className="size-4" />}
            label="Unanswered questions"
            value={data.unansweredQuestions}
            note={
              data.unansweredQuestions === 0
                ? "No students are waiting on a reply"
                : "Students waiting on a reply from staff"
            }
            action={
              data.unansweredQuestions > 0 ? (
                <Link
                  to="/instructor/questions"
                  className="text-xs font-medium text-primary hover:underline"
                >
                  Open the question queue
                </Link>
              ) : null
            }
          />
          <RatingsPanel ratings={data.ratings} />
        </div>
      </div>
    </>
  );
}

function StatCard({
  label,
  value,
  note,
  empty,
}: {
  label: string;
  value: number;
  note: string;
  empty: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">
        {value === 0 ? empty : note}
      </CardContent>
    </Card>
  );
}

function AttentionCard({
  icon,
  label,
  value,
  note,
  action,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  note: string;
  action?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription className="flex items-center gap-1.5">
          {icon}
          {label}
        </CardDescription>
        <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-xs text-muted-foreground">
        <p>
          {note} · all time
        </p>
        {action}
      </CardContent>
    </Card>
  );
}

function TopBuyersPanel({
  buyers,
  rangeLabel,
  className,
}: {
  buyers: TopBuyer[];
  rangeLabel: string;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Top buyers</CardTitle>
        <CardDescription>
          Biggest spenders across your courses, up to 10 ·{" "}
          {rangeLabel.toLowerCase()}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {buyers.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center text-center text-sm text-muted-foreground">
            <Users className="mb-2 size-8" />
            No one has bought in this period yet. Try a longer range.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 pr-2 font-medium">#</th>
                  <th className="pb-2 pr-2 font-medium">Buyer</th>
                  <th className="pb-2 pr-2 text-right font-medium">Spent</th>
                  <th className="pb-2 pr-2 text-right font-medium">Seats</th>
                  <th className="pb-2 text-right font-medium">Unredeemed</th>
                </tr>
              </thead>
              <tbody>
                {buyers.map((buyer, index) => (
                  <tr key={buyer.userId} className="border-b last:border-0">
                    <td className="py-2 pr-2 tabular-nums text-muted-foreground">
                      {index + 1}
                    </td>
                    <td className="py-2 pr-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{buyer.name}</span>
                        {buyer.seatCount > 0 && (
                          <Badge>Team · {buyer.seatCount} seats</Badge>
                        )}
                        {!buyer.isEnrolled && <Badge muted>Not enrolled</Badge>}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {buyer.email}
                      </div>
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums">
                      {formatCents(buyer.totalSpentCents)}
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums">
                      {buyer.seatCount > 0 ? buyer.seatCount : "—"}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {buyer.seatCount > 0 ? buyer.unredeemedSeatCount : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RatingsPanel({ ratings }: { ratings: CourseRating[] }) {
  const anyRated = ratings.some((r) => r.ratingCount > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Course ratings</CardTitle>
        <CardDescription>Published courses · all time</CardDescription>
      </CardHeader>
      <CardContent>
        {!anyRated ? (
          <p className="text-sm text-muted-foreground">
            No student has rated your courses yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {ratings.map((course) => (
              <li key={course.courseId} className="space-y-0.5">
                <p className="text-sm font-medium">{course.title}</p>
                <StarRating
                  average={course.averageRating}
                  count={course.ratingCount}
                />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Badge({
  children,
  muted = false,
}: {
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <span
      className={
        muted
          ? "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
          : "rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
      }
    >
      {children}
    </span>
  );
}

/** "$0.00" for zero, rather than formatPrice's "Free". */
function formatCents(cents: number) {
  return cents === 0 ? "$0.00" : formatPrice(cents);
}

/** Mirrors OverviewPanels' layout for the route's HydrateFallback. */
export function OverviewPanelsSkeleton() {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-36 w-full" />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Skeleton className="h-96 w-full lg:col-span-2" />
        <div className="space-y-6">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-52 w-full" />
        </div>
      </div>
    </>
  );
}
