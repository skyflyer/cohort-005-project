import { data, isRouteErrorResponse, Link, useFetcher } from "react-router";
import { useEffect } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { AlertTriangle, RotateCcw } from "lucide-react";
import type { Route } from "./+types/admin.refunds";
import { requireAdmin } from "~/lib/access.server";
import { parseFormData } from "~/lib/validation";
import {
  declineRefundRequest,
  getOpenRefundRequests,
} from "~/lib/refund-requests.server";
import { MAX_WATCHED_HOURS } from "~/lib/refund-rules.server";
import { formatPrice } from "~/lib/utils";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";

const adminRefundActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("decline"),
    refundId: z.coerce.number().int(),
    declineMessage: z
      .string()
      .trim()
      .min(1, "Write a decline message so the learner knows why.")
      .max(1000, "Please keep the decline message under 1000 characters."),
  }),
]);

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Review open refund requests" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);

  return { refundRequests: getOpenRefundRequests() };
}

export async function action({ request }: Route.ActionArgs) {
  const { userId } = await requireAdmin(request);

  const formData = await request.formData();
  const parsed = parseFormData(formData, adminRefundActionSchema);

  if (!parsed.success) {
    return data(
      { error: Object.values(parsed.errors)[0] ?? "Invalid input." },
      { status: 400 }
    );
  }

  const { email } = declineRefundRequest({
    refundId: parsed.data.refundId,
    adminId: userId,
    declineMessage: parsed.data.declineMessage,
  });

  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);

  return { success: true, message: "Refund request declined." };
}

function formatWatchTime(seconds: number): string {
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

type RefundRequest = Route.ComponentProps["loaderData"]["refundRequests"][number];

function RefundRequestCard({ request }: { request: RefundRequest }) {
  const fetcher = useFetcher<typeof action>();

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if ("success" in fetcher.data) toast.success(fetcher.data.message);
      if ("error" in fetcher.data) toast.error(fetcher.data.error);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">{request.courseTitle}</h2>
            <p className="text-sm text-muted-foreground">
              {request.learnerName} ({request.learnerEmail})
            </p>
          </div>
          <div className="text-right">
            <p className="text-lg font-semibold">
              {formatPrice(request.refundableAmount)}
            </p>
            <p className="text-xs text-muted-foreground">refundable</p>
          </div>
        </div>

        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Purchased</dt>
            <dd>{formatDate(request.purchasedAt)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Watched at request time</dt>
            <dd>{formatWatchTime(request.watchedSecondsAtRequest)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Watched now</dt>
            <dd>{formatWatchTime(request.watchedSecondsNow)}</dd>
          </div>
        </dl>

        {request.watchedTooMuchNow && (
          <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            <AlertTriangle className="size-4 shrink-0 text-amber-600" />
            <span>
              This learner has now watched {MAX_WATCHED_HOURS} hours or more of
              the course.
            </span>
          </div>
        )}

        <div>
          <p className="text-sm text-muted-foreground">
            Reason ({formatDate(request.requestedAt)})
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm">{request.reason}</p>
        </div>

        <fetcher.Form method="post" className="space-y-2">
          <input type="hidden" name="intent" value="decline" />
          <input type="hidden" name="refundId" value={request.id} />
          <label
            htmlFor={`decline-message-${request.id}`}
            className="text-sm font-medium"
          >
            Decline message
          </label>
          <Textarea
            id={`decline-message-${request.id}`}
            name="declineMessage"
            required
            maxLength={1000}
            placeholder="Tell the learner why the request was declined. They will receive this by email."
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={fetcher.state !== "idle"}
          >
            Decline request
          </Button>
        </fetcher.Form>
      </CardContent>
    </Card>
  );
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { refundRequests } = loaderData;

  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refund Requests</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Review open refund requests. You decide each one; nothing is declined
          automatically.
        </p>
      </div>

      {refundRequests.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <RotateCcw className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="text-muted-foreground">No open refund requests.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {refundRequests.map((request) => (
            <RefundRequestCard key={request.id} request={request} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading refund requests.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message =
        typeof error.data === "string"
          ? error.data
          : "Only admins can access this page.";
    } else {
      title = `Error ${error.status}`;
      message =
        typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
