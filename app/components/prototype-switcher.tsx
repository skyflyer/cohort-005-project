// PROTOTYPE — floating variant switcher for throwaway UI prototypes.
// Lives only on prototype/* branches. Never merge.
import { useEffect } from "react";

export function PrototypeSwitcher({
  variants,
  current,
  onChange,
}: {
  variants: { key: string; name: string }[];
  current: string;
  onChange: (key: string) => void;
}) {
  const idx = Math.max(
    0,
    variants.findIndex((v) => v.key === current)
  );
  const go = (d: number) =>
    onChange(variants[(idx + d + variants.length) % variants.length].key);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (process.env.NODE_ENV === "production") return null;

  const v = variants[idx];
  return (
    <div className="fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-3 rounded-full bg-fuchsia-700 px-4 py-2 font-mono text-sm text-white shadow-2xl ring-2 ring-fuchsia-300">
      <button onClick={() => go(-1)} className="px-1 hover:opacity-70">
        ←
      </button>
      <span>
        PROTOTYPE {v.key} ({v.name})
      </span>
      <button onClick={() => go(1)} className="px-1 hover:opacity-70">
        →
      </button>
    </div>
  );
}
