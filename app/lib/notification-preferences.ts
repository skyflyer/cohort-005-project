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
    boolean | { channel_types?: object | null } | null
  > | null;
};

// Reads one switch from a Knock preference set. Throws when Knock gave no
// value so callers show the error state instead of a made-up default.
export function readSwitchValue(
  preferenceSet: KnockPreferenceSet,
  key: WorkflowKey
): boolean {
  const value = preferenceSet.workflows?.[key];
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object") {
    return !Object.values(value.channel_types ?? {}).some((enabled) => enabled === false);
  }
  throw new Error(`Knock returned no preference for ${key}`);
}
