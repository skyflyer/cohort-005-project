import { describe, expect, it } from "vitest";
import {
  badgeLabel,
  notificationDetail,
  notificationSentence,
  relativeTime,
} from "./notification-feed";

describe("badgeLabel", () => {
  it("hides the badge at zero", () => {
    expect(badgeLabel(0)).toBeNull();
  });
  it("shows the count up to 9", () => {
    expect(badgeLabel(1)).toBe("1");
    expect(badgeLabel(9)).toBe("9");
  });
  it("caps at 9+", () => {
    expect(badgeLabel(10)).toBe("9+");
    expect(badgeLabel(250)).toBe("9+");
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-01-10T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  it("formats just now, minutes, hours and days", () => {
    expect(relativeTime(ago(30_000), now)).toBe("just now");
    expect(relativeTime(ago(5 * 60_000), now)).toBe("5m");
    expect(relativeTime(ago(3 * 3_600_000), now)).toBe("3h");
    expect(relativeTime(ago(2 * 86_400_000), now)).toBe("2d");
  });
  it("treats future timestamps as just now", () => {
    expect(relativeTime(ago(-5000), now)).toBe("just now");
  });
});

const common = {
  actorName: "Ada",
  actorAvatar: null,
  courseTitle: "Intro to TS",
  url: "/x",
};

const t = (s: string): [string, boolean] => [s, false];
const b = (s: string): [string, boolean] => [s, true];

describe("notificationSentence", () => {
  it("covers every kind with actor and course or lesson in bold", () => {
    const cases: [any, [string, boolean][]][] = [
      [
        { kind: "refund-request-approved", ...common },
        [t("Your refund for "), b("Intro to TS"), t(" was "), b("approved"), t(".")],
      ],
      [
        { kind: "refund-request-declined", ...common },
        [
          t("Your refund for "),
          b("Intro to TS"),
          t(" was "),
          b("declined"),
          t(". You can ask again."),
        ],
      ],
      [
        { kind: "refund-request-opened", ...common, amountCents: 4900 },
        [
          b("Ada"),
          t(" asked for a "),
          b("$49.00"),
          t(" refund on "),
          b("Intro to TS"),
          t("."),
        ],
      ],
      [
        { kind: "seat-claimed", ...common, seatsLeft: 3 },
        [
          b("Ada"),
          t(" claimed a Seat on "),
          b("Intro to TS"),
          t(". Seats left: "),
          b("3"),
          t("."),
        ],
      ],
      [
        { kind: "new-enrollment", ...common },
        [b("Ada"), t(" enrolled in "), b("Intro to TS"), t(".")],
      ],
      [
        { kind: "discussion-question", ...common, lessonTitle: "Generics" },
        [b("Ada"), t(" asked a question on "), b("Generics"), t(".")],
      ],
      [
        { kind: "discussion-reply", ...common, lessonTitle: "Generics" },
        [b("Ada"), t(" replied to your question on "), b("Generics"), t(".")],
      ],
    ];
    for (const [data, expected] of cases) {
      expect(notificationSentence(data).map((s) => [s.text, s.bold])).toEqual(
        expected
      );
    }
  });

  it("falls back for unknown or missing data", () => {
    expect(
      notificationSentence(undefined)
        .map((s) => s.text)
        .join("")
    ).toBe("New notification");
  });
});

describe("notificationDetail", () => {
  it("uses the excerpt, decision note or reason", () => {
    expect(
      notificationDetail({
        kind: "discussion-reply",
        ...common,
        lessonTitle: "G",
        excerpt: "hello",
      } as any)
    ).toBe("hello");
    expect(
      notificationDetail({
        kind: "refund-request-declined",
        ...common,
        reason: "r",
        decisionNote: "too late",
        amountCents: 1,
      } as any)
    ).toBe("too late");
    expect(
      notificationDetail({
        kind: "refund-request-opened",
        ...common,
        reason: "bad",
        amountCents: 1,
      } as any)
    ).toBe("bad");
    expect(
      notificationDetail({ kind: "new-enrollment", ...common } as any)
    ).toBeNull();
  });
});
