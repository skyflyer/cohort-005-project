import { describe, it, expect } from "vitest";
import { UserRole } from "~/db/schema";
import {
  visibleWorkflowKeys,
  readSwitchValue,
} from "./notification-preferences";

const everyone = [
  "refund-request-approved",
  "refund-request-declined",
  "discussion-reply",
];

describe("visibleWorkflowKeys", () => {
  it("shows a Student the three switches everyone gets", () => {
    expect(
      visibleWorkflowKeys({ role: UserRole.Student, isTeamAdmin: false })
    ).toEqual(everyone);
  });

  it("adds Discussion Question and new Enrollment for an Instructor", () => {
    expect(
      visibleWorkflowKeys({ role: UserRole.Instructor, isTeamAdmin: false })
    ).toEqual([...everyone, "discussion-question", "new-enrollment"]);
  });

  it("adds Open Refund Request for a Platform Admin", () => {
    expect(
      visibleWorkflowKeys({ role: UserRole.Admin, isTeamAdmin: false })
    ).toEqual([...everyone, "refund-request-opened"]);
  });

  it("adds Claimed Seat for a Team Admin and combines roles", () => {
    expect(
      visibleWorkflowKeys({ role: UserRole.Student, isTeamAdmin: true })
    ).toEqual([...everyone, "seat-claimed"]);
    expect(
      visibleWorkflowKeys({ role: UserRole.Instructor, isTeamAdmin: true })
    ).toEqual([
      ...everyone,
      "discussion-question",
      "new-enrollment",
      "seat-claimed",
    ]);
  });
});

describe("readSwitchValue", () => {
  it("reads a boolean workflow preference", () => {
    expect(
      readSwitchValue({ workflows: { "new-enrollment": false } }, "new-enrollment")
    ).toBe(false);
    expect(
      readSwitchValue({ workflows: { "new-enrollment": true } }, "new-enrollment")
    ).toBe(true);
  });

  it("reads an opted-out channel of an object preference", () => {
    expect(
      readSwitchValue(
        { workflows: { "seat-claimed": { channel_types: { in_app_feed: false } } } },
        "seat-claimed"
      )
    ).toBe(false);
  });

  it("treats an object with no channel opt-out as on", () => {
    expect(
      readSwitchValue(
        { workflows: { "seat-claimed": { channel_types: {} } } },
        "seat-claimed"
      )
    ).toBe(true);
  });

  it("throws when Knock returned no value, rather than inventing a default", () => {
    expect(() => readSwitchValue({ workflows: {} }, "seat-claimed")).toThrow();
    expect(() => readSwitchValue({}, "seat-claimed")).toThrow();
  });
});
