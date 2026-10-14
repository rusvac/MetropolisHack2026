// stacked allocation bars, for the portfolio now and the portfolio after
export const SYMBOL_COLOR: Record<string, string> = {
  MON: "#8b7bff",
  USDC: "#9fb4cc",
  AUSD: "#f472b6",
};

export function symbolColor(sym: string): string {
  return SYMBOL_COLOR[sym] ?? "#6c6c82";
}

export function AllocationBar({
  parts,
  total,
  height = 14,
  target,
  scale = 1,
}: {
  parts: Record<string, number>;
  total: number;
  height?: number;
  /** a marker at this share of the bar, for the target weight of the first symbol */
  target?: number;
  /** the width of the whole bar as a share of the row, for bars that compare sizes */
  scale?: number;
}) {
  const entries = Object.entries(parts).filter(([, v]) => v > 0).sort(([a], [b]) => (a === "MON" ? -1 : b === "MON" ? 1 : a.localeCompare(b)));
  return (
    <div className="relative w-full">
      <div className="flex overflow-hidden rounded-full bg-line" style={{ height, width: `${Math.max(0, Math.min(1, scale)) * 100}%` }}>
        {entries.map(([sym, v]) => (
          <div
            key={sym}
            className="h-full transition-all duration-700"
            style={{ width: `${total > 0 ? (v / total) * 100 : 0}%`, background: symbolColor(sym) }}
            title={`${sym}`}
          />
        ))}
      </div>
      {target !== undefined ? (
        <div className="absolute -top-1 bottom-[-4px] w-0.5 rounded bg-white" style={{ left: `calc(${target * 100}% - 1px)` }} title="target" />
      ) : null}
    </div>
  );
}

export function Legend({ symbols }: { symbols: string[] }) {
  return (
    <div className="flex flex-wrap gap-3 text-[11px] text-muted">
      {symbols.map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: symbolColor(s) }} />
          {s}
        </span>
      ))}
    </div>
  );
}
