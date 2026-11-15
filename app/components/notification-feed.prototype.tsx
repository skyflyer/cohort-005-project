// PROTOTYPE — "What does the Notification Feed look like in Cadence?" (#36).
// Three radically different Notification Feed UIs, switchable via ?variant=
// (A / B / C) and the floating bar, mounted in the real app layout against the
// real Knock Development feed. Throwaway; never merge.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Link, NavLink, useFetcher, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  Bell,
  BellDot,
  Check,
  CheckCheck,
  Archive,
  Inbox,
  X,
  Receipt,
  MessageSquare,
  UserPlus,
  Armchair,
  Sparkles,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { UserAvatar } from "~/components/user-avatar";

export const FEED_VARIANTS = [
  { key: "A", name: "Bell popover, unseen badge" },
  { key: "B", name: "Sidebar item → slide-over drawer + toasts" },
  { key: "C", name: "Inbox page, two-pane" },
];

export function useFeedVariant(): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const [stored, setStored] = useState("A");
  useEffect(() => {
    setStored(localStorage.getItem("proto-feed-variant") ?? "A");
  }, []);
  const v = params.get("variant") ?? stored;
  return [
    v,
    (next) => {
      localStorage.setItem("proto-feed-variant", next);
      setStored(next);
      const p = new URLSearchParams(params);
      p.set("variant", next);
      setParams(p, { replace: true, preventScrollReset: true });
    },
  ];
}

// ─── Feed hook ──────────────────────────────────────────────────────────────

type Item = any;
type Feed = {
  items: Item[];
  unread: number;
  unseen: number;
  ready: boolean;
  error: string | null;
  markSeen: (i: Item | Item[]) => void;
  markRead: (i: Item | Item[]) => void;
  markUnread: (i: Item) => void;
  archive: (i: Item) => void;
  markAllSeen: () => void;
  markAllRead: () => void;
  onRealtime: React.MutableRefObject<((items: Item[]) => void) | null>;
};

const FeedCtx = createContext<Feed | null>(null);
export const useFeed = () => useContext(FeedCtx)!;

export function FeedProvider({
  userId,
  auth,
  children,
}: {
  userId: number;
  auth: { token: string; publicKey: string; channelId: string };
  children: React.ReactNode;
}) {
  const [state, setState] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const feedRef = useRef<any>(null);
  const onRealtime = useRef<((items: Item[]) => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    let k: any;
    (async () => {
      try {
        const { default: Knock } = await import("@knocklabs/client");
        if (cancelled) return;
        k = new Knock(auth.publicKey);
        k.authenticate(String(userId), auth.token);
        const feed = k.feeds.initialize(auth.channelId, { archived: "exclude" });
        feedRef.current = feed;
        feed.store.subscribe((s: any) => setState({ ...s }));
        feed.on("items.received.realtime", ({ items }: any) => onRealtime.current?.(items));
        feed.listenForUpdates();
        await feed.fetch();
        setState({ ...feed.store.getState() });
      } catch (e) {
        setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      feedRef.current?.dispose();
      k?.teardown?.();
      feedRef.current = null;
    };
    // Re-init only when the DevUI user changes, not on every re-signed token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const f = () => feedRef.current;
  const value: Feed = {
    items: state?.items ?? [],
    unread: state?.metadata?.unread_count ?? 0,
    unseen: state?.metadata?.unseen_count ?? 0,
    ready: !!state,
    error,
    markSeen: (i) => f()?.markAsSeen(i),
    markRead: (i) => f()?.markAsRead(i),
    markUnread: (i) => f()?.markAsUnread(i),
    archive: (i) => f()?.markAsArchived(i),
    markAllSeen: () => f()?.markAllAsSeen(),
    markAllRead: () => f()?.markAllAsRead(),
    onRealtime,
  };
  return <FeedCtx.Provider value={value}>{children}</FeedCtx.Provider>;
}

// ─── Rendering one Notification from its data ─────────────────────────────

const KIND: Record<string, { icon: React.ReactNode; text: (d: any) => React.ReactNode; tone: string }> = {
  "refund-approved": {
    icon: <Receipt className="size-4" />,
    tone: "text-emerald-600",
    text: (d) => (
      <>
        Your Refund Request for <b>{d.course}</b> was <b>approved</b>.
      </>
    ),
  },
  "refund-declined": {
    icon: <Receipt className="size-4" />,
    tone: "text-rose-600",
    text: (d) => (
      <>
        Your Refund Request for <b>{d.course}</b> was <b>declined</b>.
      </>
    ),
  },
  "open-refund-request": {
    icon: <Receipt className="size-4" />,
    tone: "text-amber-600",
    text: (d) => (
      <>
        <b>{d.actor_name}</b> asked for a refund on <b>{d.course}</b>.
      </>
    ),
  },
  "seat-claimed": {
    icon: <Armchair className="size-4" />,
    tone: "text-sky-600",
    text: (d) => (
      <>
        <b>{d.actor_name}</b> claimed a Seat on <b>{d.course}</b>.
      </>
    ),
  },
  "new-enrollment": {
    icon: <UserPlus className="size-4" />,
    tone: "text-violet-600",
    text: (d) => (
      <>
        <b>{d.actor_name}</b> enrolled in <b>{d.course}</b>.
      </>
    ),
  },
  "discussion-question": {
    icon: <MessageSquare className="size-4" />,
    tone: "text-indigo-600",
    text: (d) => (
      <>
        <b>{d.actor_name}</b> asked a question on <b>{d.lesson}</b>.
      </>
    ),
  },
  "discussion-reply": {
    icon: <MessageSquare className="size-4" />,
    tone: "text-indigo-600",
    text: (d) => (
      <>
        <b>{d.actor_name}</b> replied to your question on <b>{d.lesson}</b>.
      </>
    ),
  },
};

const fallbackKind = {
  icon: <Sparkles className="size-4" />,
  tone: "text-muted-foreground",
  text: (d: any) => <>Notification ({d?.replier_name ? "spike reply" : "unknown kind"})</>,
};

const kindOf = (item: Item) => KIND[item.data?.kind] ?? fallbackKind;
const detailOf = (item: Item): string | undefined => item.data?.excerpt ?? item.data?.reason;
const urlOf = (item: Item): string => item.data?.url ?? "/";

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function SeedButton({ className }: { className?: string }) {
  const fetcher = useFetcher();
  return (
    <fetcher.Form method="post" action="/prototype/notification-feed/seed" className={className}>
      <button className="rounded border border-dashed border-fuchsia-500 px-2 py-1 font-mono text-[11px] text-fuchsia-700 hover:bg-fuchsia-50">
        {fetcher.state !== "idle" ? "sending…" : "PROTO: send 1 of each Notification to me"}
      </button>
    </fetcher.Form>
  );
}

function FeedStatus() {
  const feed = useFeed();
  if (feed.error) return <div className="p-4 text-sm text-rose-600">Feed error: {feed.error}</div>;
  if (!feed.ready) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  return null;
}

// ─── Variant A: bell in the sidebar header, popover, unseen badge ─────────
// Badge = unseen. Opening the popover marks everything seen (badge clears),
// unread rows keep a dot until clicked. Click = mark read + go to the thing.

export function VariantAHeaderBell() {
  const feed = useFeed();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    feed.markAllSeen();
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-md p-1.5 text-sidebar-foreground/70 hover:bg-sidebar-accent"
        title="Notifications"
      >
        <Bell className="size-5" />
        {feed.unseen > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-bold text-white">
            {feed.unseen > 9 ? "9+" : feed.unseen}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute left-0 top-10 z-50 w-96 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <span className="font-semibold">Notifications</span>
            <button
              onClick={feed.markAllRead}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Mark all as read
            </button>
          </div>
          <FeedStatus />
          <ul className="max-h-[28rem] divide-y overflow-y-auto">
            {feed.ready && feed.items.length === 0 && (
              <li className="p-6 text-center text-sm text-muted-foreground">You're all caught up.</li>
            )}
            {feed.items.map((item) => {
              const k = kindOf(item);
              return (
                <li key={item.id}>
                  <button
                    onClick={() => {
                      feed.markRead(item);
                      setOpen(false);
                      navigate(urlOf(item));
                    }}
                    className={cn(
                      "flex w-full gap-3 px-4 py-3 text-left text-sm hover:bg-accent",
                      !item.read_at && "bg-primary/5"
                    )}
                  >
                    <UserAvatar
                      name={item.data?.actor_name ?? "?"}
                      avatarUrl={item.data?.actor_avatar ?? null}
                      className="size-8 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div>{k.text(item.data)}</div>
                      {detailOf(item) && (
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          “{detailOf(item)}”
                        </div>
                      )}
                      <div className="mt-1 text-xs text-muted-foreground">{ago(item.inserted_at)}</div>
                    </div>
                    {!item.read_at && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t p-2">
            <SeedButton />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Variant B: sidebar nav item → right-hand drawer, toasts, tabs ────────
// Count pill = unread (no "seen" concept surfaced). Realtime arrivals toast.
// Drawer groups by day, Unread/All tabs, per-row hover actions.

export function VariantBNavItem() {
  const feed = useFeed();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"unread" | "all">("unread");
  const navigate = useNavigate();

  useEffect(() => {
    feed.onRealtime.current = (items) => {
      for (const item of items) {
        toast(<span>{kindOf(item).text(item.data)}</span>, {
          action: { label: "View", onClick: () => { feed.markRead(item); navigate(urlOf(item)); } },
        });
      }
    };
    return () => {
      feed.onRealtime.current = null;
    };
  });

  const shown = tab === "unread" ? feed.items.filter((i) => !i.read_at) : feed.items;
  const groups: Record<string, Item[]> = {};
  for (const i of shown) {
    const d = new Date(i.inserted_at);
    const today = new Date().toDateString() === d.toDateString();
    (groups[today ? "Today" : "Earlier"] ??= []).push(i);
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <Inbox className="size-4" />
        Notifications
        {feed.unread > 0 && (
          <span className="ml-auto rounded-full bg-primary px-2 text-xs font-semibold text-primary-foreground">
            {feed.unread}
          </span>
        )}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={() => setOpen(false)}>
          <aside
            onClick={(e) => e.stopPropagation()}
            className="flex h-full w-[28rem] flex-col border-l bg-background shadow-2xl"
          >
            <header className="flex items-center gap-2 border-b px-5 py-4">
              <h2 className="text-lg font-semibold">Notifications</h2>
              <div className="ml-4 flex rounded-md bg-muted p-0.5 text-xs">
                {(["unread", "all"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={cn("rounded px-2.5 py-1 capitalize", tab === t && "bg-background shadow")}
                  >
                    {t}
                    {t === "unread" && ` (${feed.unread})`}
                  </button>
                ))}
              </div>
              <button onClick={feed.markAllRead} title="Mark all as read" className="ml-auto rounded p-1.5 hover:bg-accent">
                <CheckCheck className="size-4" />
              </button>
              <button onClick={() => setOpen(false)} className="rounded p-1.5 hover:bg-accent">
                <X className="size-4" />
              </button>
            </header>
            <FeedStatus />
            <div className="flex-1 overflow-y-auto">
              {feed.ready && shown.length === 0 && (
                <div className="p-10 text-center text-sm text-muted-foreground">
                  {tab === "unread" ? "No unread Notifications." : "Nothing here yet."}
                </div>
              )}
              {Object.entries(groups).map(([label, items]) => (
                <section key={label}>
                  <div className="sticky top-0 bg-background/95 px-5 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {label}
                  </div>
                  {items.map((item) => {
                    const k = kindOf(item);
                    return (
                      <div key={item.id} className="group relative flex gap-3 px-5 py-3 hover:bg-accent/60">
                        <div className={cn("mt-0.5 rounded-full bg-muted p-2", k.tone)}>{k.icon}</div>
                        <Link
                          to={urlOf(item)}
                          onClick={() => {
                            feed.markRead(item);
                            setOpen(false);
                          }}
                          className="min-w-0 flex-1 text-sm"
                        >
                          <div className={cn(!item.read_at ? "font-medium" : "text-muted-foreground")}>
                            {k.text(item.data)}
                          </div>
                          {detailOf(item) && (
                            <div className="mt-1 line-clamp-2 border-l-2 pl-2 text-xs text-muted-foreground">
                              {detailOf(item)}
                            </div>
                          )}
                          <div className="mt-1 text-xs text-muted-foreground">{ago(item.inserted_at)}</div>
                        </Link>
                        <div className="absolute right-4 top-3 hidden gap-1 group-hover:flex">
                          <button
                            title={item.read_at ? "Mark unread" : "Mark read"}
                            onClick={() => (item.read_at ? feed.markUnread(item) : feed.markRead(item))}
                            className="rounded border bg-background p-1"
                          >
                            {item.read_at ? <BellDot className="size-3.5" /> : <Check className="size-3.5" />}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </section>
              ))}
            </div>
            <footer className="border-t p-3">
              <SeedButton />
            </footer>
          </aside>
        </div>
      )}
    </>
  );
}

// ─── Variant C: sidebar nav link → full Inbox page, list + detail ─────────
// Count pill = unread. The page is a two-pane inbox: selecting a row marks it
// read and shows detail with a primary "Open" button; rows can be archived.

export function VariantCNavLink() {
  const feed = useFeed();
  return (
    <NavLink
      to="/prototype/notifications?variant=C"
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
          isActive
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        )
      }
    >
      <Bell className="size-4" />
      Inbox
      {feed.unread > 0 && (
        <span className="ml-auto text-xs font-semibold text-primary">{feed.unread} new</span>
      )}
    </NavLink>
  );
}

export function VariantCInboxPage() {
  const feed = useFeed();
  if (!feed) return <div className="p-10">Select a user from the DevUI panel.</div>;
  return <InboxPage feed={feed} />;
}

function InboxPage({ feed }: { feed: Feed }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = feed.items.find((i) => i.id === selectedId) ?? null;

  useEffect(() => {
    feed.markAllSeen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed.ready]);

  return (
    <div className="flex h-full">
      <div className="flex w-[26rem] shrink-0 flex-col border-r">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h1 className="text-xl font-bold">Inbox</h1>
          <button onClick={feed.markAllRead} className="text-xs text-muted-foreground hover:text-foreground">
            Mark all as read
          </button>
        </div>
        <FeedStatus />
        <ul className="flex-1 overflow-y-auto">
          {feed.ready && feed.items.length === 0 && (
            <li className="p-10 text-center text-sm text-muted-foreground">Inbox zero.</li>
          )}
          {feed.items.map((item) => {
            const k = kindOf(item);
            return (
              <li key={item.id}>
                <button
                  onClick={() => {
                    setSelectedId(item.id);
                    if (!item.read_at) feed.markRead(item);
                  }}
                  className={cn(
                    "flex w-full items-start gap-3 border-b px-5 py-3 text-left text-sm",
                    selectedId === item.id ? "bg-accent" : "hover:bg-accent/50",
                    !item.read_at && "border-l-4 border-l-primary"
                  )}
                >
                  <span className={cn("mt-0.5", k.tone)}>{k.icon}</span>
                  <span className={cn("min-w-0 flex-1 truncate", !item.read_at && "font-semibold")}>
                    {k.text(item.data)}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{ago(item.inserted_at)}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="border-t p-3">
          <SeedButton />
        </div>
      </div>
      <div className="flex-1 p-10">
        {!selected ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            Select a Notification
          </div>
        ) : (
          <div className="max-w-xl space-y-5">
            <div className="flex items-center gap-3">
              <UserAvatar name={selected.data?.actor_name ?? "?"} avatarUrl={selected.data?.actor_avatar ?? null} className="size-10" />
              <div>
                <div className="font-medium">{selected.data?.actor_name}</div>
                <div className="text-xs text-muted-foreground">
                  {new Date(selected.inserted_at).toLocaleString()} · {selected.data?.course}
                </div>
              </div>
            </div>
            <p className="text-lg">{kindOf(selected).text(selected.data)}</p>
            {detailOf(selected) && (
              <blockquote className="rounded-md border-l-4 bg-muted/50 p-4 text-sm">{detailOf(selected)}</blockquote>
            )}
            <div className="flex gap-2">
              <Link
                to={urlOf(selected)}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              >
                Open
              </Link>
              <button onClick={() => feed.markUnread(selected)} className="rounded-md border px-4 py-2 text-sm">
                Mark unread
              </button>
              <button
                onClick={() => {
                  feed.archive(selected);
                  setSelectedId(null);
                }}
                className="flex items-center gap-1.5 rounded-md border px-4 py-2 text-sm"
              >
                <Archive className="size-4" /> Archive
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
