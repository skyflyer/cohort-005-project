import { and, eq } from "drizzle-orm";
import type { Knock } from "@knocklabs/node";
import "~/lib/env.server";
import { createKnockClient } from "~/lib/knock.server";
import { knockUserId } from "~/lib/knock-user-id";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { teamMembers, TeamMemberRole, users } from "~/db/schema";
import type { WorkflowKey } from "./notifications.server";
import {
  readSwitchValue,
  visibleWorkflowKeys,
} from "./notification-preferences";

// Notification Preferences live only in Knock and are only touched from the
// server. The browser never writes them (browser writes stored {} in the
// prototype instead of true).

type Db = BetterSQLite3Database<typeof schema>;

// `enabled` is null when Knock could not be read: the value is unknown.
export type PreferenceSwitch = { key: WorkflowKey; enabled: boolean | null };

export type PreferencesResult = { ok: boolean; switches: PreferenceSwitch[] };

function knockClient(): Knock {
  const secretKey = process.env.KNOCK_SECRET_API_KEY;
  if (!secretKey) throw new Error("KNOCK_SECRET_API_KEY is not set");
  return createKnockClient(secretKey);
}

export function visibleKeysForUser(db: Db, userId: number): WorkflowKey[] {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) return [];
  const isTeamAdmin =
    db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.userId, userId),
          eq(teamMembers.role, TeamMemberRole.Admin)
        )
      )
      .get() !== undefined;
  return visibleWorkflowKeys({ role: user.role, isTeamAdmin });
}

// On failure returns ok:false with every value unknown (null); the card
// disables the switches and shows an error, it never presents defaults.
export async function loadPreferences(
  db: Db,
  userId: number
): Promise<PreferencesResult> {
  const keys = visibleKeysForUser(db, userId);
  try {
    const set = await knockClient().users.getPreferences(knockUserId(userId), "default");
    return {
      ok: true,
      switches: keys.map((key) => ({ key, enabled: readSwitchValue(set, key) })),
    };
  } catch (error) {
    console.error("[notification-preferences] load failed", error);
    return {
      ok: false,
      switches: keys.map((key) => ({ key, enabled: null })),
    };
  }
}

// Writes every visible switch in one call. Knock upserts the user.
export async function savePreferences(
  db: Db,
  userId: number,
  enabledKeys: ReadonlySet<string>
): Promise<{ ok: boolean }> {
  const workflows: Record<string, boolean> = {};
  for (const key of visibleKeysForUser(db, userId)) {
    workflows[key] = enabledKeys.has(key);
  }
  try {
    await knockClient().users.setPreferences(knockUserId(userId), "default", {
      workflows,
    });
    return { ok: true };
  } catch (error) {
    console.error("[notification-preferences] save failed", error);
    return { ok: false };
  }
}
