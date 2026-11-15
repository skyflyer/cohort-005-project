// PROTOTYPE — throwaway. Answers "How do In-App Notifications look in Cadence?"
// (wayfinder ticket #18). Three structurally different variants on the real app
// layout, switchable via ?variant=A|B|C and the floating bar at the bottom.
// Sample Notifications are in memory, per role, from the v1 event catalogue
// (#15). Nothing is persisted. Delete once a variant has won.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  Bell,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  Receipt,
  UsersRound,
  Shield,
  Check,
  X,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { UserRole } from "~/db/schema";

type Kind =
  | "refund-decided"
  | "refund-opened"
  | "reply"
  | "question"
  | "seat-claimed"
  | "course-status";

type SampleNotification = {
  id: number;
  kind: Kind;
  text: string;
  detail?: string;
  minutesAgo: number;
  href: string;
  read: boolean;
};

const KIND_META: Record<Kind, { label: string; icon: typeof Bell; group: string }> = {
  "refund-decided": { label: "Refund", icon: Receipt, group: "Refunds" },
  "refund-opened": { label: "Refund", icon: Receipt, group: "Refunds" },
  reply: { label: "Reply", icon: MessageSquare, group: "Discussion" },
  question: { label: "Question", icon: MessageSquare, group: "Discussion" },
  "seat-claimed": { label: "Team", icon: UsersRound, group: "Team" },
  "course-status": { label: "Course", icon: Shield, group: "Courses" },
};

function samplesFor(role: UserRole | null, isTeamAdmin: boolean): SampleNotification[] {
  let id = 1;
  const n = (x: Omit<SampleNotification, "id">) => ({ id: id++, ...x });
  if (role === UserRole.Admin) {
    return [
      n({ kind: "refund-opened", text: "Dana Kim raised a Refund Request for React Patterns", detail: "“The course wasn't what I expected.” · $149.00", minutesAgo: 4, href: "/admin/refunds", read: false }),
      n({ kind: "refund-opened", text: "Acme Ltd raised a Refund Request for a Team Licence of TypeScript Fundamentals", detail: "10 Seats, 0 claimed · $990.00", minutesAgo: 95, href: "/admin/refunds", read: false }),
      n({ kind: "reply", text: "Sam Lee replied to your Reply in “Generics in practice”", detail: "“Thanks, that cleared it up!”", minutesAgo: 60 * 26, href: "/courses", read: true }),
    ];
  }
  if (role === UserRole.Instructor) {
    return [
      n({ kind: "question", text: "Ana Novak asked a Question on “Server loaders”", detail: "“Why does the loader run twice in dev?”", minutesAgo: 12, href: "/instructor/questions", read: false }),
      n({ kind: "question", text: "Ben Ortiz asked a Question on “Forms and actions”", detail: "“Can I use useFetcher for file uploads?”", minutesAgo: 140, href: "/instructor/questions", read: false }),
      n({ kind: "course-status", text: "A Platform Admin archived your course Legacy Redux", minutesAgo: 60 * 20, href: "/instructor", read: false }),
      n({ kind: "reply", text: "Ana Novak replied to your Reply in “Server loaders”", detail: "“Got it — StrictMode. Thanks!”", minutesAgo: 60 * 50, href: "/courses", read: true }),
    ];
  }
  const student = [
    n({ kind: "reply", text: "Your Instructor replied to your Question in “Server loaders”", detail: "“It's StrictMode — it double-invokes in dev only.”", minutesAgo: 8, href: "/courses", read: false }),
    n({ kind: "refund-decided", text: "Your Refund Request for React Patterns was approved", detail: "$149.00, the full amount you paid, is on its way back.", minutesAgo: 60 * 5, href: "/settings", read: false }),
    n({ kind: "reply", text: "Ben Ortiz replied to your Question in “Forms and actions”", detail: "“Same question here!”", minutesAgo: 60 * 30, href: "/courses", read: true }),
  ];
  if (isTeamAdmin) {
    return [
      n({ kind: "seat-claimed", text: "Ana Novak claimed a Seat on TypeScript Fundamentals", detail: "4 of 10 Seats claimed", minutesAgo: 2, href: "/team", read: false }),
      n({ kind: "seat-claimed", text: "Ben Ortiz claimed a Seat on TypeScript Fundamentals", detail: "3 of 10 Seats claimed", minutesAgo: 70, href: "/team", read: false }),
      n({ kind: "refund-decided", text: "Your Refund Request for a Team Licence of Legacy Redux was declined", detail: "You still have everything you bought.", minutesAgo: 60 * 28, href: "/settings", read: true }),
      ...student,
    ];
  }
  return student;
}

function ago(min: number) {
  if (min < 60) return `${min}m ago`;
  if (min < 60 * 24) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 60 / 24)}d ago`;
}

type Api = {
  items: SampleNotification[];
  unread: number;
  open: (n: SampleNotification) => void;
  markRead: (id: number) => void;
  markAllRead: () => void;
};

function Badge({ count, className }: { count: number; className?: string }) {
  if (count === 0) return null;
  return (
    <span className={cn("inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-[11px] font-semibold leading-5 text-white", className)}>
      {count}
    </span>
  );
}

// ─── Variant A: bell in the sidebar header, dropdown list ───

function VariantAHeader({ api }: { api: Api }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className="relative rounded-md p-1.5 text-sidebar-foreground/70 hover:bg-sidebar-accent" title="Notifications">
        <Bell className="size-5" />
        <Badge count={api.unread} className="absolute -right-1.5 -top-1.5" />
      </button>
      {open && (
        <div className="absolute left-full top-0 z-50 ml-3 w-96 rounded-lg border bg-popover text-popover-foreground shadow-xl">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <span className="font-semibold">Notifications</span>
            <button onClick={api.markAllRead} className="text-xs text-muted-foreground hover:text-foreground">Mark all read</button>
          </div>
          <ul className="max-h-[28rem] overflow-y-auto">
            {api.items.map((n) => (
              <li key={n.id}>
                <button onClick={() => { setOpen(false); api.open(n); }} className={cn("flex w-full gap-3 border-b px-4 py-3 text-left hover:bg-accent", !n.read && "bg-primary/5")}>
                  <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-primary")} />
                  <span className="min-w-0">
                    <span className={cn("block text-sm", !n.read && "font-medium")}>{n.text}</span>
                    <span className="block text-xs text-muted-foreground">{ago(n.minutesAgo)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Variant B: sidebar nav item, slide-over drawer with Unread/All tabs ───

function VariantBNav({ api, onOpen }: { api: Api; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
      <Bell className="size-4" />
      Notifications
      <Badge count={api.unread} className="ml-auto" />
    </button>
  );
}

function VariantBDrawer({ api, onClose }: { api: Api; onClose: () => void }) {
  const [tab, setTab] = useState<"unread" | "all">("unread");
  const shown = tab === "unread" ? api.items.filter((n) => !n.read) : api.items;
  const today = shown.filter((n) => n.minutesAgo < 60 * 24);
  const earlier = shown.filter((n) => n.minutesAgo >= 60 * 24);
  const Section = ({ title, list }: { title: string; list: SampleNotification[] }) =>
    list.length === 0 ? null : (
      <div>
        <div className="px-5 pb-1 pt-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
        {list.map((n) => {
          const Icon = KIND_META[n.kind].icon;
          return (
            <div key={n.id} className="group flex gap-3 px-5 py-3 hover:bg-accent">
              <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", n.read ? "bg-muted" : "bg-primary/15 text-primary")}>
                <Icon className="size-4" />
              </div>
              <button onClick={() => { onClose(); api.open(n); }} className="min-w-0 flex-1 text-left">
                <div className={cn("text-sm", !n.read && "font-semibold")}>{n.text}</div>
                {n.detail && <div className="mt-0.5 truncate text-sm text-muted-foreground">{n.detail}</div>}
                <div className="mt-1 text-xs text-muted-foreground">{ago(n.minutesAgo)}</div>
              </button>
              {!n.read && (
                <button onClick={() => api.markRead(n.id)} title="Mark read" className="self-start rounded p-1 text-muted-foreground opacity-0 hover:bg-background group-hover:opacity-100">
                  <Check className="size-4" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    );
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <aside className="flex h-full w-[26rem] flex-col bg-background shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 className="text-lg font-semibold">Notifications</h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-accent"><X className="size-5" /></button>
        </div>
        <div className="flex items-center gap-1 border-b px-5 py-2">
          {(["unread", "all"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={cn("rounded-full px-3 py-1 text-sm capitalize", tab === t ? "bg-primary text-primary-foreground" : "hover:bg-accent")}>
              {t}{t === "unread" && api.unread > 0 ? ` (${api.unread})` : ""}
            </button>
          ))}
          <button onClick={api.markAllRead} className="ml-auto text-xs text-muted-foreground hover:text-foreground">Mark all read</button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <Section title="Today" list={today} />
          <Section title="Earlier" list={earlier} />
          {shown.length === 0 && <p className="p-8 text-center text-sm text-muted-foreground">You're all caught up.</p>}
        </div>
      </aside>
    </div>
  );
}

// ─── Variant C: dedicated inbox page in the main area, filtered by kind ───

function VariantCPage({ api, onClose }: { api: Api; onClose: () => void }) {
  const groups = ["All", ...Array.from(new Set(api.items.map((n) => KIND_META[n.kind].group)))];
  const [filter, setFilter] = useState("All");
  const shown = filter === "All" ? api.items : api.items.filter((n) => KIND_META[n.kind].group === filter);
  return (
    <div className="fixed bottom-0 left-56 right-0 top-0 z-30 overflow-y-auto bg-background">
      <div className="mx-auto max-w-4xl p-8">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-bold">Notifications</h1>
            <p className="text-sm text-muted-foreground">{api.unread} unread</p>
          </div>
          <div className="flex gap-2">
            <button onClick={api.markAllRead} className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">Mark all read</button>
            <button onClick={onClose} className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">Close</button>
          </div>
        </div>
        <div className="mb-4 flex gap-2">
          {groups.map((g) => (
            <button key={g} onClick={() => setFilter(g)} className={cn("rounded-md border px-3 py-1 text-sm", filter === g ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent")}>{g}</button>
          ))}
        </div>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="w-6 py-2" />
              <th className="py-2">Type</th>
              <th className="py-2">What happened</th>
              <th className="py-2 text-right">When</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {shown.map((n) => (
              <tr key={n.id} className={cn("border-b align-top", !n.read && "bg-primary/5")}>
                <td className="py-3"><span className={cn("mt-1.5 block size-2 rounded-full", !n.read && "bg-primary")} /></td>
                <td className="py-3 pr-4"><span className="rounded bg-muted px-2 py-0.5 text-xs">{KIND_META[n.kind].label}</span></td>
                <td className="py-3 pr-4">
                  <div className={cn(!n.read && "font-semibold")}>{n.text}</div>
                  {n.detail && <div className="text-muted-foreground">{n.detail}</div>}
                </td>
                <td className="whitespace-nowrap py-3 text-right text-muted-foreground">{ago(n.minutesAgo)}</td>
                <td className="whitespace-nowrap py-3 pl-4 text-right">
                  <button onClick={() => { onClose(); api.open(n); }} className="text-primary hover:underline">Open</button>
                  {!n.read && <button onClick={() => api.markRead(n.id)} className="ml-3 text-muted-foreground hover:text-foreground">Mark read</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Switcher + wiring ───

const VARIANTS = [
  { key: "A", name: "Bell + dropdown" },
  { key: "B", name: "Nav item + drawer" },
  { key: "C", name: "Inbox page" },
];

function PrototypeSwitcher({ current, unread, total }: { current: string; unread: number; total: number }) {
  const [, setParams] = useSearchParams();
  const idx = Math.max(0, VARIANTS.findIndex((v) => v.key === current));
  const go = (d: number) => {
    const next = VARIANTS[(idx + d + VARIANTS.length) % VARIANTS.length].key;
    setParams((p) => { p.set("variant", next); return p; }, { replace: true });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (!import.meta.env.DEV) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-full bg-black px-2 py-1.5 text-sm text-white shadow-2xl">
      <button onClick={() => go(-1)} className="rounded-full p-1 hover:bg-white/20"><ChevronLeft className="size-4" /></button>
      <span className="px-1 font-medium">{VARIANTS[idx].key} ({VARIANTS[idx].name})</span>
      <span className="px-1 text-white/60">· {unread}/{total} unread</span>
      <button onClick={() => go(1)} className="rounded-full p-1 hover:bg-white/20"><ChevronRight className="size-4" /></button>
    </div>
  );
}

export function useNotificationsPrototype(role: UserRole | null, isTeamAdmin: boolean) {
  const [params] = useSearchParams();
  const variant = params.get("variant") ?? "A";
  const navigate = useNavigate();
  const initial = useMemo(() => samplesFor(role, isTeamAdmin), [role, isTeamAdmin]);
  const [items, setItems] = useState(initial);
  useEffect(() => setItems(initial), [initial]);
  const [panelOpen, setPanelOpen] = useState(false);
  useEffect(() => setPanelOpen(false), [variant]);

  const markRead = (id: number) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, read: true } : x)));
  const api: Api = {
    items,
    unread: items.filter((n) => !n.read).length,
    markRead,
    markAllRead: () => setItems((xs) => xs.map((x) => ({ ...x, read: true }))),
    open: (n) => { markRead(n.id); navigate(`${n.href}?variant=${variant}`); },
  };

  if (!role) return { headerSlot: null, navSlot: null, overlay: null };

  return {
    headerSlot: variant === "A" ? <VariantAHeader api={api} /> : null,
    navSlot: variant !== "A" ? <VariantBNav api={api} onOpen={() => setPanelOpen(true)} /> : null,
    overlay: (
      <>
        {variant === "B" && panelOpen && <VariantBDrawer api={api} onClose={() => setPanelOpen(false)} />}
        {variant === "C" && panelOpen && <VariantCPage api={api} onClose={() => setPanelOpen(false)} />}
        <PrototypeSwitcher current={variant} unread={api.unread} total={items.length} />
      </>
    ),
  };
}

