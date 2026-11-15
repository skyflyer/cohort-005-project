import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router";
import { Bell } from "lucide-react";
import { cn } from "~/lib/utils";
import { UserAvatar } from "~/components/user-avatar";
import type { FeedAuth } from "~/lib/knock-feed-auth.server";
import type { NotificationData } from "~/lib/notifications.server";
import {
  badgeLabel,
  notificationDetail,
  notificationSentence,
  relativeTime,
} from "~/lib/notification-feed";

// Headless Knock feed client. One client per user id: recreated only when the
// user id changes, never when the token string changes on revalidation.

type FeedItem = {
  id: string;
  read_at: string | null;
  inserted_at: string;
  data?: NotificationData;
};

type Feed = {
  items: FeedItem[];
  unseen: number;
  ready: boolean;
  error: boolean;
  markAllAsSeen: () => void;
  markAllAsRead: () => void;
  markAsRead: (item: FeedItem) => void;
};

const FeedContext = createContext<Feed | null>(null);

function useFeed() {
  const feed = useContext(FeedContext);
  if (!feed) throw new Error("useFeed must be used inside FeedProvider");
  return feed;
}

export function FeedProvider({
  userId,
  auth,
  children,
}: {
  userId: number;
  auth: FeedAuth | null;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<any>(null);
  const [error, setError] = useState(false);
  const feedRef = useRef<any>(null);
  // Latest auth, read when (re)creating the client for a new user id.
  const authRef = useRef(auth);
  authRef.current = auth;

  useEffect(() => {
    setState(null);
    setError(false);
    const current = authRef.current;
    if (!current) {
      setError(true);
      return;
    }
    let cancelled = false;
    let knock: any;
    (async () => {
      try {
        const { default: Knock } = await import("@knocklabs/client");
        if (cancelled) return;
        knock = new Knock(current.publicKey);
        knock.authenticate(String(userId), current.token);
        const feed = knock.feeds.initialize(current.channelId, {
          archived: "exclude",
        });
        feedRef.current = feed;
        feed.store.subscribe((s: any) => setState({ ...s }));
        feed.listenForUpdates();
        await feed.fetch();
        if (cancelled) return;
        const fetched = feed.store.getState();
        if (fetched.networkStatus === "error") setError(true);
        else setState({ ...fetched });
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
      feedRef.current?.dispose();
      knock?.teardown?.();
      feedRef.current = null;
    };
  }, [userId]);

  const value: Feed = {
    items: state?.items ?? [],
    unseen: error ? 0 : (state?.metadata?.unseen_count ?? 0),
    ready: !!state,
    error,
    markAllAsSeen: () => feedRef.current?.markAllAsSeen(),
    markAllAsRead: () => feedRef.current?.markAllAsRead(),
    markAsRead: (item) => feedRef.current?.markAsRead(item),
  };
  return <FeedContext.Provider value={value}>{children}</FeedContext.Provider>;
}

export function NotificationBell() {
  const feed = useFeed();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    feed.markAllAsSeen();
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const badge = badgeLabel(feed.unseen);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-md p-1.5 text-sidebar-foreground/70 hover:bg-sidebar-accent"
        title="Notifications"
        aria-label="Notifications"
      >
        <Bell className="size-5" />
        {badge && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-bold text-white">
            {badge}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute left-0 top-10 z-50 w-96 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-xl">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <span className="font-semibold">Notifications</span>
            <button
              type="button"
              onClick={feed.markAllAsRead}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Mark all as read
            </button>
          </div>
          {feed.error ? (
            <div className="p-4 text-sm text-rose-600">
              Couldn't load notifications
            </div>
          ) : !feed.ready ? (
            <div className="p-4 text-sm text-muted-foreground">Loading…</div>
          ) : (
            <ul className="max-h-[28rem] divide-y overflow-y-auto">
              {feed.items.length === 0 && (
                <li className="p-6 text-center text-sm text-muted-foreground">
                  You're all caught up.
                </li>
              )}
              {feed.items.map((item) => {
                const detail = notificationDetail(item.data);
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => {
                        feed.markAsRead(item);
                        setOpen(false);
                        navigate(item.data?.url ?? "/");
                      }}
                      className={cn(
                        "flex w-full gap-3 px-4 py-3 text-left text-sm hover:bg-accent",
                        !item.read_at && "bg-primary/5"
                      )}
                    >
                      <UserAvatar
                        name={item.data?.actorName ?? "?"}
                        avatarUrl={item.data?.actorAvatar ?? null}
                        className="size-8 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div>
                          {notificationSentence(item.data).map((s, i) =>
                            s.bold ? <b key={i}>{s.text}</b> : s.text
                          )}
                        </div>
                        {detail && (
                          <div className="mt-0.5 truncate text-xs text-muted-foreground">
                            “{detail}”
                          </div>
                        )}
                        <div className="mt-1 text-xs text-muted-foreground">
                          {relativeTime(item.inserted_at)}
                        </div>
                      </div>
                      {!item.read_at && (
                        <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
