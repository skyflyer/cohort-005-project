import { UserRole } from "~/db/schema";
import type { WorkflowKey } from "./notifications.server";

// Pure helpers for the Notifications card on Settings. No defaults live here:
// on/off values come from Knock (the person's own, or the environment default).

export const SWITCH_LABELS: Record<WorkflowKey, string> = {
  "refund-request-approved": "Refund Request approved",
  "refund-request-declined": "Refund Request declined",
  "refund-request-opened": "New Open Refund Request",
  "seat-claimed": "Claimed Seat",
  "new-enrollment": "New Enrollment",
  "discussion-question": "Discussion Question",
  "discussion-reply": "Discussion Reply",
};

export function isWorkflowKey(value: string): value is WorkflowKey {
  return value in SWITCH_LABELS;
}

export function visibleWorkflowKeys(roles: {
  role: UserRole;
  isTeamAdmin: boolean;
}): WorkflowKey[] {
  const keys: WorkflowKey[] = [
    "refund-request-approved",
    "refund-request-declined",
    "discussion-reply",
  ];
  if (roles.role === UserRole.Instructor) {
    keys.push("discussion-question", "new-enrollment");
  }
  if (roles.role === UserRole.Admin) {
    keys.push("refund-request-opened");
  }
  if (roles.isTeamAdmin) {
    keys.push("seat-claimed");
  }
  return keys;
}

type KnockPreferenceSet = {
  workflows?: Record<
    string,
    boolean | { channel_types?: { in_app_feed?: unknown } | null } | null
  > | null;
};

// Reads one switch from a Knock preference set. Throws when Knock gave no
// value so callers show the error state instead of a made-up default.
//
// Knock returns a workflow setting as a bare boolean (what we write) or, if it
// was set another way, an object. Every workflow here is in-app-only, so the
// only channel that matters is `in_app_feed`: an explicit `false` there is off,
// anything else (true, absent, or a conditional setting we can't evaluate) is
// on. Opt-outs of other channel types don't affect an in-app-only workflow.
export function readSwitchValue(
  preferenceSet: KnockPreferenceSet,
  key: WorkflowKey
): boolean {
  const value = preferenceSet.workflows?.[key];
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object") {
    return value.channel_types?.in_app_feed !== false;
  }
  throw new Error(`Knock returned no preference for ${key}`);
}
