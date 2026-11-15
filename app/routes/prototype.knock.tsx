// PROTOTYPE — throwaway spike for "Does Knock hold up against Cadence?" (#38).
// Runs the four checks against the real Knock Development environment for
// whichever user the DevUI switcher selects. Not production code.
import { useEffect, useRef, useState } from "react";
import { data, useFetcher } from "react-router";
import { eq, and, isNull, ne } from "drizzle-orm";
import type { Route } from "./+types/prototype.knock";
import { db } from "~/db";
import { comments, users, UserRole } from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";
import {
  knock,
  signTokenFor,
  KNOCK_PUBLIC_API_KEY,
  KNOCK_FEED_CHANNEL_ID,
  WORKFLOW_DISCUSSION_REPLY,
  WORKFLOW_NEW_ENROLLMENT,
} from "~/lib/knock-prototype.server";

function getUser(id: number) {
  return db.select().from(users).where(eq(users.id, id)).get();
}

async function requireUser(request: Request) {
  const id = await getCurrentUserId(request);
  if (!id) throw data("Select a user from the DevUI panel.", { status: 401 });
  const user = getUser(id);
  if (!user) throw data("User not found.", { status: 404 });
  return user;
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  // User sync: upsert the Cadence user as a Knock recipient.
  await knock.users.update(String(user.id), {
    name: user.name,
    email: user.email,
    role: user.role,
  } as never);
  const token = await signTokenFor(user.id);
  const prefs = await knock.users
    .getPreferences(String(user.id), "default")
    .catch((e: Error) => ({ error: e.message }));
  return {
    user: { id: user.id, name: user.name, role: user.role },
    token,
    publicKey: KNOCK_PUBLIC_API_KEY,
    channelId: KNOCK_FEED_CHANNEL_ID,
    serverPrefs: prefs,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireUser(request);
  const form = await request.formData();
  const intent = form.get("intent");

  try {
    if (intent === "trigger-reply") {
      // Discussion Reply → question author. The current user is the author;
      // the replier is some other user. Use one of their real questions if any.
      const question = db
        .select()
        .from(comments)
        .where(and(eq(comments.userId, user.id), isNull(comments.parentId)))
        .get();
      const replier = db.select().from(users).where(ne(users.id, user.id)).get()!;
      const res = await knock.workflows.trigger(WORKFLOW_DISCUSSION_REPLY, {
        recipients: [String(user.id)],
        actor: { id: String(replier.id), name: replier.name, email: replier.email } as never,
        data: {
          comment_id: question?.id ?? null,
          lesson_id: question?.lessonId ?? null,
          question_excerpt: question?.body.slice(0, 80) ?? "(no real question — fake data)",
          replier_name: replier.name,
          reply_excerpt: `Prototype reply at ${new Date().toLocaleTimeString()}`,
        },
      });
      return { ok: true, intent, res };
    }

    if (intent === "trigger-enrollment") {
      const student = db.select().from(users).where(eq(users.role, UserRole.Student)).get()!;
      const res = await knock.workflows.trigger(WORKFLOW_NEW_ENROLLMENT, {
        recipients: [String(user.id)],
        actor: { id: String(student.id), name: student.name, email: student.email } as never,
        data: {
          student_name: student.name,
          course_title: "Prototype Course",
          at: new Date().toLocaleTimeString(),
        },
      });
      return { ok: true, intent, res };
    }

    if (intent === "reset-prefs") {
      await knock.users.unsetPreferences(String(user.id), "default").catch(() => {});
      return { ok: true, intent, res: "user preference set removed" };
    }
  } catch (e) {
    return { ok: false, intent, error: (e as Error).message };
  }
  return { ok: false, intent, error: "unknown intent" };
}

type Log = { at: string; label: string; detail: unknown };

export default function KnockPrototype({ loaderData }: Route.ComponentProps) {
  const { user, token, publicKey, channelId, serverPrefs } = loaderData;
  const fetcher = useFetcher<typeof action>();
  const [feedState, setFeedState] = useState<any>(null);
  const [prefs, setPrefs] = useState<any>(null);
  const [isolation, setIsolation] = useState<string>("not run");
  const [log, setLog] = useState<Log[]>([]);
  const feedRef = useRef<any>(null);
  const knockRef = useRef<any>(null);

  const push = (label: string, detail: unknown) =>
    setLog((l) => [{ at: new Date().toLocaleTimeString(), label, detail }, ...l].slice(0, 30));

  // Check 1 + 3: authenticate the headless client with the signed token, open the feed.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        push("init: importing @knocklabs/client", null);
        const { default: Knock } = await import("@knocklabs/client");
        if (cancelled) return;
        const k = new Knock(publicKey);
        k.authenticate(String(user.id), token);
        push("init: authenticated", { userId: String(user.id), channelId });
        const feed = k.feeds.initialize(channelId);
        feed.listenForUpdates();
        const refresh = () => setFeedState({ ...feed.getState() });
        feed.on("items.received.realtime", () => {
          push("realtime: new item", null);
          refresh();
        });
        feed.on("items.received.page", refresh);
        knockRef.current = k;
        feedRef.current = feed;
        const res = await feed.fetch();
        refresh();
        push("feed.fetch()", { status: (res as any)?.status, meta: feed.getState().metadata, items: feed.getState().items.length });
        setPrefs(await k.preferences.get());
      } catch (e) {
        console.error(e);
        push("init FAILED", (e as Error)?.message ?? String(e));
      }
    })();
    return () => {
      cancelled = true;
      feedRef.current?.dispose();
      knockRef.current?.teardown?.();
      feedRef.current = null;
      knockRef.current = null;
    };
    // Only re-init when the DevUI user changes — not when revalidation re-signs the token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);

  useEffect(() => {
    if (fetcher.data) {
      push(`action: ${fetcher.data.intent}`, fetcher.data);
      // Give Knock a moment, then refetch in case realtime is slow.
      setTimeout(async () => {
        try {
          if (!feedRef.current) return push("refetch skipped: feed not initialised", null);
          await feedRef.current.fetch();
          setFeedState({ ...feedRef.current.getState() });
          push("refetch after action", feedRef.current.getState().metadata);
          setPrefs(await knockRef.current?.preferences.get());
        } catch (e) {
          push("refetch FAILED", (e as Error)?.message ?? String(e));
        }
      }, 2500);
    }
  }, [fetcher.data]);

  async function run(label: string, fn: () => Promise<unknown>) {
    try {
      const r = await fn();
      push(label, r ?? "ok");
    } catch (e) {
      push(`${label} FAILED`, (e as Error).message);
    }
    setFeedState({ ...feedRef.current?.getState() });
  }

  // Security: try to read another user's feed with *my* token. Must be rejected.
  async function checkIsolation() {
    const otherId = user.id === 1 ? 2 : 1;
    const r = await fetch(
      `https://api.knock.app/v1/users/${otherId}/feeds/${channelId}`,
      { headers: { Authorization: `Bearer ${publicKey}`, "X-Knock-User-Token": token } }
    );
    const verdict = r.ok ? `LEAK: got ${r.status} reading user ${otherId}'s feed` : `rejected (${r.status}) ✓`;
    setIsolation(verdict);
    push("isolation check", { status: r.status, body: await r.text() });
  }

  const items: any[] = feedState?.items ?? [];
  const meta = feedState?.metadata;
  const optedIn = prefs?.workflows?.[WORKFLOW_NEW_ENROLLMENT_CLIENT];

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6 font-mono text-sm">
      <div className="rounded border-2 border-dashed border-amber-500 bg-amber-50 p-3">
        PROTOTYPE — Knock spike (#38). Throwaway. User: <b>{user.name}</b> (id {user.id}, {user.role})
      </div>

      <section className="space-y-2">
        <h2 className="font-bold">1. Signed user token</h2>
        <div className="break-all text-xs">token: {token.slice(0, 60)}…</div>
        <div>
          Feed auth: {meta ? "authenticated ✓" : "pending / failed"} · Isolation: {isolation}{" "}
          <button className="rounded border px-2" onClick={checkIsolation}>
            try reading another user's feed
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-bold">2. Trigger (Node SDK)</h2>
        <div className="flex gap-2">
          {[
            ["trigger-reply", "Trigger Discussion Reply → me"],
            ["trigger-enrollment", "Trigger new Enrollment → me"],
            ["reset-prefs", "Reset my preferences"],
          ].map(([intent, label]) => (
            <fetcher.Form method="post" key={intent}>
              <button className="rounded border px-2 py-1" name="intent" value={intent}>
                {label}
              </button>
            </fetcher.Form>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-bold">3. Headless feed API</h2>
        <div>
          total {meta?.total_count ?? "?"} · unread {meta?.unread_count ?? "?"} · unseen{" "}
          {meta?.unseen_count ?? "?"}
        </div>
        <div className="flex gap-2">
          <button className="rounded border px-2" onClick={() => run("markAllAsSeen", () => feedRef.current.markAllAsSeen())}>
            mark all seen
          </button>
          <button className="rounded border px-2" onClick={() => run("markAllAsRead", () => feedRef.current.markAllAsRead())}>
            mark all read
          </button>
          <button className="rounded border px-2" onClick={() => run("fetch", () => feedRef.current.fetch())}>
            refetch
          </button>
        </div>
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item.id} className="rounded border p-2">
              <div>
                [{item.source?.key}] {item.read_at ? "read" : "UNREAD"} · {item.seen_at ? "seen" : "UNSEEN"} ·{" "}
                {item.inserted_at}
              </div>
              <div
                className="text-xs"
                dangerouslySetInnerHTML={{ __html: item.blocks?.[0]?.rendered ?? "" }}
              />
              <div className="text-xs text-gray-500">data: {JSON.stringify(item.data)}</div>
              <div className="flex gap-2">
                <button className="rounded border px-2" onClick={() => run("markAsSeen", () => feedRef.current.markAsSeen(item))}>
                  seen
                </button>
                <button className="rounded border px-2" onClick={() => run("markAsRead", () => feedRef.current.markAsRead(item))}>
                  read
                </button>
                <button className="rounded border px-2" onClick={() => run("markAsUnread", () => feedRef.current.markAsUnread(item))}>
                  unread
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="font-bold">4. Preferences (new Enrollment off by default, opt-in)</h2>
        <div>new-enrollment opted in (client view): {String(optedIn)}</div>
        <div className="flex gap-2">
          <button
            className="rounded border px-2"
            onClick={() =>
              run("opt in", async () => setPrefs(await knockRef.current.preferences.setWorkflow(WORKFLOW_NEW_ENROLLMENT_CLIENT, true)))
            }
          >
            opt in
          </button>
          <button
            className="rounded border px-2"
            onClick={() =>
              run("opt out", async () => setPrefs(await knockRef.current.preferences.setWorkflow(WORKFLOW_NEW_ENROLLMENT_CLIENT, false)))
            }
          >
            opt out
          </button>
        </div>
        <pre className="max-h-48 overflow-auto bg-gray-100 p-2 text-xs">client: {JSON.stringify(prefs, null, 2)}</pre>
        <pre className="max-h-48 overflow-auto bg-gray-100 p-2 text-xs">server (at load): {JSON.stringify(serverPrefs, null, 2)}</pre>
      </section>

      <section>
        <h2 className="font-bold">Log</h2>
        <pre className="max-h-96 overflow-auto bg-gray-900 p-2 text-xs text-green-300">
          {log.map((l) => `${l.at} ${l.label} ${JSON.stringify(l.detail)}`).join("\n")}
        </pre>
      </section>
    </div>
  );
}

const WORKFLOW_NEW_ENROLLMENT_CLIENT = "new-enrollment";
