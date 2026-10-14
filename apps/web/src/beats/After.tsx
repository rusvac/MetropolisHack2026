// beat 6: the portfolio after. before and after, per account and in total, against the targets
import { AllocationBar, Legend, symbolColor } from "../components/Bars.tsx";
import { AccountDot, BeatHeader, Card, Label, NetBadge, SimBadge } from "../components/ui.tsx";
import { accountLabel, amount, network, pct, toUnits, usd } from "../lib/format.ts";
import { accountTotals, symbolTotals } from "../lib/moves.ts";
import type { BeatProps } from "./context.ts";

export function AfterBeat(p: BeatProps) {
  const before = p.plan.before;
  const fromRun = !!p.run.after && p.run.status === "done";
  const after = fromRun ? p.run.after! : p.plan.after;
  const b = symbolTotals(before);
  const a = symbolTotals(after);
  const symbols = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const targets = p.plan.intent.targets;
  const monTarget = targets.find((t) => t.symbol === "MON")?.weight;
  const targetParts = Object.fromEntries(targets.map((t) => [t.symbol, t.weight]));

  const bt = accountTotals(before);
  const at = accountTotals(after);
  const keys = [...new Set([...bt, ...at].map((x) => `${x.chainId}:${x.account}`))];
  const rows = keys
    .map((k) => {
      const [c, i] = k.split(":").map(Number) as [number, number];
      return { chainId: c, account: i, before: bt.find((x) => x.chainId === c && x.account === i), after: at.find((x) => x.chainId === c && x.account === i) };
    })
    .filter((r) => (r.before?.usd ?? 0) > 0.005 || (r.after?.usd ?? 0) > 0.005)
    .sort((x, y) => (x.chainId === y.chainId ? x.account - y.account : x.chainId === 10143 ? -1 : 1));
  const max = Math.max(1, ...rows.flatMap((r) => [r.before?.usd ?? 0, r.after?.usd ?? 0]));
  const hedge = p.plan.hedge ?? p.plan.swaps.find((s) => s.hedge)?.hedge;

  return (
    <section>
      <BeatHeader n={6} title="The portfolio after" lede="Before and after, per account and in total, against the targets." />

      <Card tone="accent" className="mb-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Label>in total</Label>
            <NetBadge chainId={10143} />
          </div>
          {fromRun ? (
            <SimBadge simulated={p.balancesSimulated || p.run.simulated !== false} live="after the run" />
          ) : (
            <SimBadge simulated={p.balancesSimulated} live="projected from quotes" />
          )}
        </div>
        <div className="mt-3 space-y-3">
          {[
            { label: "before", parts: b, total: before.totalUsd, value: usd(before.totalUsd, { cents: false }) },
            { label: fromRun ? "after" : "after, projected", parts: a, total: after.totalUsd, value: usd(after.totalUsd, { cents: false }) },
            { label: "target", parts: targetParts, total: 1, value: targets.map((t) => `${pct(t.weight, 0)} ${t.symbol}`).join(" · ") },
          ].map((r) => (
            <div key={r.label}>
              <div className="mb-1 flex justify-between text-xs">
                <span className="text-muted">{r.label}</span>
                <span className="num text-muted">{r.value}</span>
              </div>
              <AllocationBar parts={r.parts} total={r.total} height={16} target={monTarget} />
            </div>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {symbols.map((s) => {
            const w = (a[s] ?? 0) / (after.totalUsd || 1);
            const t = targets.find((x) => x.symbol === s)?.weight;
            const off = t === undefined ? 0 : w - t;
            return (
              <div key={s} className="rounded-xl border border-line bg-raised px-3 py-2">
                <div className="flex items-center gap-1.5 text-xs text-muted">
                  <span className="h-2 w-2 rounded-full" style={{ background: symbolColor(s) }} />
                  {s}
                </div>
                <div className="num mt-0.5 text-lg font-semibold">
                  {pct((b[s] ?? 0) / (before.totalUsd || 1), 0)} → {pct(w, 1)}
                </div>
                {t !== undefined ? (
                  <div className={`num text-[11px] ${Math.abs(off) < 0.02 ? "text-good" : "text-warn"}`}>
                    target {pct(t, 0)} · {off >= 0 ? "+" : ""}
                    {(off * 100).toFixed(1)} pts
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] text-faint">Dollar values at mainnet prices. Price impact and fees leave the result a little under the target.</p>
      </Card>

      {hedge ? (
        <Card className="mb-4">
          <div className="flex items-center justify-between">
            <Label>hedge</Label>
            <div className="flex gap-1.5">
              <NetBadge chainId={143} />
              <SimBadge simulated={hedge.simulated} live="live quote" />
            </div>
          </div>
          <p className="mt-2 text-[15px]">
            Short <span className="num font-semibold text-warn">{amount(toUnits(hedge.size, 18), 0)} MON</span> on Perpl at{" "}
            <span className="num">{usd(hedge.markPrice)}</span>
            {hedge.fundingRate !== undefined ? <span className="text-muted"> · funding {(hedge.fundingRate * 100).toFixed(4)}% per hour</span> : null}.
          </p>
        </Card>
      ) : null}

      <div className="mb-2 flex items-center justify-between">
        <Label>per account</Label>
        <Legend symbols={symbols} />
      </div>
      <Card className="space-y-3">
        {rows.map((r) => (
          <div key={`${r.chainId}:${r.account}`} className="flex items-center gap-3">
            <AccountDot label={accountLabel(r.chainId, r.account)} color={network(r.chainId).color} size={30} />
            <div className="min-w-0 flex-1 space-y-1">
              <AllocationBar parts={r.before?.bySymbol ?? {}} total={r.before?.usd ?? 0} height={6} scale={(r.before?.usd ?? 0) / max} />
              <AllocationBar parts={r.after?.bySymbol ?? {}} total={r.after?.usd ?? 0} height={10} scale={(r.after?.usd ?? 0) / max} />
            </div>
            <div className="num w-[86px] shrink-0 text-right text-xs">
              <div className="text-faint">{usd(r.before?.usd ?? 0, { cents: false })}</div>
              <div className="font-semibold">{usd(r.after?.usd ?? 0, { cents: false })}</div>
            </div>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[11px] text-faint">
          <span>thin bar = before, thick bar = after</span>
          <NetBadge chainId={10143} />
          <NetBadge chainId={84532} />
        </div>
      </Card>
    </section>
  );
}
