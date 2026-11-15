import type { NotificationData } from "~/lib/notifications.server";

// Pure helpers for rendering the Notification Feed. Rows are built from an
// item's `data` only, never from Knock template blocks.

export type Segment = { text: string; bold: boolean };

export function badgeLabel(unseen: number): string | null {
  if (unseen <= 0) return null;
  return unseen > 9 ? "9+" : String(unseen);
}

export function relativeTime(iso: string, now: Date = new Date()): string {
  const seconds = (now.getTime() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

const t = (text: string): Segment => ({ text, bold: false });
const b = (text: string): Segment => ({ text, bold: true });

// `data` comes from Knock at runtime, so it may be missing or of an unknown kind.
export function notificationSentence(
  data: NotificationData | undefined
): Segment[] {
  if (!data) return [t("New notification")];
  switch (data.kind) {
    case "refund-request-approved":
      return [t("Your refund for "), b(data.courseTitle), t(" was "), b("approved"), t(".")];
    case "refund-request-declined":
      return [t("Your refund for "), b(data.courseTitle), t(" was "), b("declined"), t(".")];
    case "refund-request-opened":
      return [b(data.actorName), t(" asked for a refund on "), b(data.courseTitle), t(".")];
    case "seat-claimed":
      return [b(data.actorName), t(" claimed a Seat on "), b(data.courseTitle), t(".")];
    case "new-enrollment":
      return [b(data.actorName), t(" enrolled in "), b(data.courseTitle), t(".")];
    case "discussion-question":
      return [b(data.actorName), t(" asked a question on "), b(data.lessonTitle), t(".")];
    case "discussion-reply":
      return [b(data.actorName), t(" replied to your question on "), b(data.lessonTitle), t(".")];
    default:
      return [t("New notification")];
  }
}

export function notificationDetail(
  data: NotificationData | undefined
): string | null {
  if (!data) return null;
  switch (data.kind) {
    case "discussion-question":
    case "discussion-reply":
      return data.excerpt || null;
    case "refund-request-approved":
    case "refund-request-declined":
      return data.decisionNote || null;
    case "refund-request-opened":
      return data.reason || null;
    default:
      return null;
  }
}
