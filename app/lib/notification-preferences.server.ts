import { and, eq } from "drizzle-orm";
import { Knock } from "@knocklabs/node";
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

// React Router dev doesn't load .env into process.env, so do it here too.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env: loading preferences shows the error state
}

type Db = BetterSQLite3Database<typeof schema>;

export type PreferenceSwitch = { key: WorkflowKey; enabled: boolean };

export type PreferencesResult =
  | { ok: true; switches: PreferenceSwitch[] }
  | { ok: false; switches: PreferenceSwitch[] };

function client(): Knock {
  const secretKey = process.env.KNOCK_SECRET_API_KEY;
  if (!secretKey) throw new Error("KNOCK_SECRET_API_KEY is not set");
  return new Knock({ apiKey: secretKey, timeout: 3000, maxRetries: 1 });
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

// On failure returns ok:false with every switch off; the card disables them
// and shows an error, it never presents defaults.
export async function loadPreferences(
  db: Db,
  userId: number
): Promise<PreferencesResult> {
  const keys = visibleKeysForUser(db, userId);
  try {
    const set = await client().users.getPreferences(String(userId), "default");
    return {
      ok: true,
      switches: keys.map((key) => ({ key, enabled: readSwitchValue(set, key) })),
    };
  } catch (error) {
    console.error("[notification-preferences] load failed", error);
    return {
      ok: false,
      switches: keys.map((key) => ({ key, enabled: false })),
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
    await client().users.setPreferences(String(userId), "default", {
      workflows,
    });
    return { ok: true };
  } catch (error) {
    console.error("[notification-preferences] save failed", error);
    return { ok: false };
  }
}
