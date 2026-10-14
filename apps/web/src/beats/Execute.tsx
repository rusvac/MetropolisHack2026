// beat 5: execute. a live timeline, one row per move, each linked to its explorer.
// halfway through, one venue turns off, and its queued slices re-route to the others
import { useEffect, useMemo, useState } from "react";
import type { VenueId } from "@spidereum/core";
import { FanOut } from "../components/FanOut.tsx";
import { BeatHeader, Button, Card, Label, NetBadge, SimBadge, VenueChip } from "../components/ui.tsx";
import { accountLabel, addressUrl, amount, clock, network, seconds, txUrl, usdCompact, venue } from "../lib/format.ts";
import type { Move } from "../lib/moves.ts";
import { counts, venueShares, type RunRow, type RunState } from "../lib/run.ts";
import type { MoveStatus } from "../lib/types.ts";
import type { BeatProps } from "./context.ts";

const STATUS: Record<MoveStatus, { text: string; color: string }> = {
  queued: { text: "queued", color: "#6c6c82" },
  sent: { text: "sent", color: "#8b7bff" },
  confirmed: { text: "confirmed", color: "#34d399" },
  failed: { text: "failed", color: "#f87171" },
  quoted: { text: "quote", color: "#fbbf24" },
  rerouted: { text: "re-routed", color: "#fbbf24" },
};

function Row({ r, addressOf }: { r: RunRow; addressOf: BeatProps["addressOf"] }) {
  const v = venue(r.venue);
  const st = STATUS[r.status];
  const from = r.account === undefined ? "" : accountLabel(r.chainId, r.account);
  const to = r.toAccount === undefined || r.kind === "swap" || r.kind === "hedge" ? "" : ` → ${accountLabel(10143, r.toAccount)}`;
  const tx = r.url ?? (r.hash ? txUrl(r.chainId, r.hash) : undefined);
  const addr = r.account !== undefined ? addressOf(r.chainId, r.account) : undefined;
  const acctUrl = addr ? addressUrl(r.chainId, addr) : undefined;
  const moved = r.plannedVenue && r.plannedVenue !== r.venue;
  const gone = r.status === "rerouted";
  return (
    <li className={`row-in py-2.5 ${gone ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 whitespace-nowrap font-mono text-xs font-semibold">{r.kind === "hedge" ? `short` : `${from}${to}`}</span>
        {moved ? (
          <>
            <VenueChip name={venue(r.plannedVenue!).name} color={venue(r.plannedVenue!).color} struck />
            <span className="text-xs text-warn">→</span>
          </>
        ) : null}
        <VenueChip name={v.name} color={v.color} struck={gone} />
        <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] font-medium" style={{ color: st.color }}>
          {r.status === "sent" ? <span className="pulse-dot h-1.5 w-1.5 rounded-full" style={{ background: st.color }} /> : null}
          {st.text}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs">
        <span className="num truncate text-muted">
          {r.kind === "hedge" || r.kind === "gas"
            ? `${amount(r.amountIn ?? 0)} ${r.symbolIn ?? ""}`
            : `${amount(r.amountIn ?? 0)} ${r.symbolIn ?? ""} → ${amount(r.amountOut ?? 0)} ${r.symbolOut ?? ""}`}
        </span>
        <span className="ml-auto shrink-0">
          {tx ? (
            <a href={tx} target="_blank" rel="noreferrer" className="font-mono text-accent underline underline-offset-2">
              {r.hash ? `${r.hash.slice(0, 8)}…` : "explorer"} ↗
            </a>
          ) : r.status === "quoted" ? (
            <span className={r.simulated ? "text-warn" : "text-faint"}>{r.simulated ? "quote, simulated" : "live quote, no tx"}</span>
          ) : r.simulated && r.status !== "queued" ? (
            acctUrl ? (
              <a href={acctUrl} target="_blank" rel="noreferrer" className="text-warn underline decoration-warn/40 underline-offset-2">
                simulated ↗
              </a>
            ) : (
              <span className="text-warn">simulated</span>
            )
          ) : null}
        </span>
      </div>
      <div className="mt-0.5 flex gap-2 font-mono text-[10.5px] text-faint">
        <span>{r.at ? clock(r.sentAt ?? r.at) : ""}</span>
        <span className="whitespace-nowrap font-sans">{network(r.chainId).short}</span>
        {r.note ? <span className="truncate font-sans">{r.note}</span> : null}
      </div>
    </li>
  );
}

/** the moves as they stand in the run: re-routed venues, new slices, gas top-ups */
function liveMoves(planned: Move[], run: RunState): Move[] {
  if (run.status === "idle") return planned;
  const byId = new Map(planned.map((m) => [m.id, m]));
  const start = run.startedAt ?? 0;
  const out: Move[] = [];
  for (const id of run.order) {
    const r = run.rows[id];
    if (!r || r.status === "rerouted") continue;
    const p = byId.get(id);
    if (p) {
      out.push({ ...p, venue: r.venue });
      continue;
    }
    out.push({
      id,
      kind: r.kind,
      venue: r.venue,
      account: r.account,
      chainId: r.chainId,
      toAccount: r.toAccount,
      toChainId: 10143,
      quoteChainId: 143,
      symbolIn: r.symbolIn ?? "",
      symbolOut: r.symbolOut ?? "",
      amountIn: r.amountIn ?? 0,
      amountOut: r.amountOut ?? 0,
      decimalsIn: r.decimalsIn ?? 18,
      decimalsOut: r.decimalsOut ?? 18,
      usd: r.usd ?? 0,
      delayMs: Math.max(0, (r.at ?? start) - start),
      simulated: r.simulated,
    });
  }
  return out;
}

function VenueSplit({ shares, planned }: { shares: Map<VenueId, number>; planned: Map<VenueId, number> }) {
  const total = [...planned.values()].reduce((a, b) => a + b, 0) || 1;
  const bar = (m: Map<VenueId, number>) => (
    <div className="flex h-3 overflow-hidden rounded-full bg-line">
      {[...m.entries()].map(([v, usd]) => (
        <div key={v} className="h-full transition-all duration-700" style={{ width: `${(usd / total) * 100}%`, background: venue(v).color }} />
      ))}
    </div>
  );
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[52px_1fr] items-center gap-2 text-[11px] text-faint">
        <span>planned</span>
        {bar(planned)}
        <span>now</span>
        {bar(shares)}
      </div>
      <div className="flex flex-wrap gap-2">
        {[...shares.entries()].map(([v, usd]) => (
          <span key={v} className="num text-[11px] text-muted">
            <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: venue(v).color }} />
            {venue(v).name} {usdCompact(usd)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function ExecuteBeat(p: BeatProps) {
  const { run, moves } = p;
  const spot = useMemo(() => {
    const m = new Map<VenueId, number>();
    for (const x of moves) if (x.kind === "swap") m.set(x.venue, (m.get(x.venue) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
  }, [moves]);
  const [drop, setDrop] = useState<VenueId | "none">(spot[0] ?? "none");
  useEffect(() => {
    if (drop !== "none" && !spot.includes(drop)) setDrop(spot[0] ?? "none");
  }, [spot, drop]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (run.status !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [run.status]);

  const c = counts(run);
  const done = c.confirmed + c.quoted + c.failed;
  const live: Move[] = useMemo(() => liveMoves(moves, run), [moves, run]);
  const status = useMemo(() => {
    const s: Record<string, MoveStatus | undefined> = {};
    for (const id of run.order) s[id] = run.rows[id]?.status;
    return s;
  }, [run.rows, run.order]);
  const planned = useMemo(() => {
    const m = new Map<VenueId, number>();
    for (const x of moves) if (x.kind === "swap") m.set(x.venue, (m.get(x.venue) ?? 0) + x.usd);
    return m;
  }, [moves]);
  const rows = run.order
    .map((id) => run.rows[id]!)
    .filter((r) => r && r.status !== "queued")
    .sort((a, b) => (b.sentAt ?? b.doneAt ?? b.at ?? 0) - (a.sentAt ?? a.doneAt ?? a.at ?? 0));
  const reroute = run.reroutes[run.reroutes.length - 1];
  const rerouteCounts = new Map<VenueId, number>();
  for (const m of reroute?.moves ?? []) rerouteCounts.set(m.to, (rerouteCounts.get(m.to) ?? 0) + 1);
  const anySim = rows.some((r) => r.simulated) || (run.status === "idle" && moves.some((m) => m.simulated));
  const elapsed = run.startedAt ? (run.endedAt ?? now) - run.startedAt : 0;
  const offVenue = run.venueOff?.venue;
  const canDrop = drop !== "none" ? drop : spot[0];

  return (
    <section>
      <BeatHeader
        n={5}
        title="Execute"
        lede="Each move runs from its own account on Monad testnet and links to the explorer. Turn one venue off halfway, and the slices still queued re-route to the others."
      />

      {run.status === "idle" ? (
        <Card className="mb-4">
          <Label>turn a venue off halfway</Label>
          <div className="mt-2 flex flex-wrap gap-2">
            {(["none", ...spot] as const).map((v) => {
              const on = drop === v;
              const info = v === "none" ? null : venue(v);
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => setDrop(v)}
                  className={`h-9 rounded-full border px-3 text-sm transition ${on ? "border-warn bg-warn/10 text-warn" : "border-line bg-raised text-muted"}`}
                >
                  {info ? info.name : "none"}
                </button>
              );
            })}
          </div>
          <Button className="mt-4 w-full" onClick={() => p.startRun(drop === "none" ? undefined : drop)}>
            Execute {moves.length} moves
          </Button>
        </Card>
      ) : (
        <Card className="mb-4" tone={run.status === "done" ? "good" : "accent"}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {run.status === "running" ? <span className="pulse-dot h-2 w-2 rounded-full bg-accent" /> : <span className="h-2 w-2 rounded-full bg-good" />}
              <span className="font-semibold">{run.status === "running" ? "Running" : run.status === "done" ? "Done" : "Stopped"}</span>
              <span className="num font-mono text-xs text-faint">{seconds(elapsed)}</span>
            </div>
            <div className="flex gap-1.5">
              <NetBadge chainId={10143} />
              <SimBadge simulated={anySim} live="testnet" />
            </div>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${c.total ? (done / c.total) * 100 : 0}%` }} />
          </div>
          <div className="num mt-2 flex justify-between text-xs text-muted">
            <span>
              {c.confirmed} confirmed · {c.quoted} quotes · {c.sent} in flight{c.failed ? ` · ${c.failed} failed` : ""}
            </span>
            <span>{c.queued} queued</span>
          </div>
          <div className="mt-3 flex gap-2">
            {run.status === "running" && !offVenue && canDrop ? (
              <Button variant="danger" className="h-10 flex-1 text-sm" onClick={() => p.venueOffNow(canDrop)}>
                Turn {venue(canDrop).name} off now
              </Button>
            ) : null}
            {run.status === "running" ? (
              <Button variant="ghost" className="h-10 text-sm" onClick={p.stopRun}>
                Stop
              </Button>
            ) : (
              <Button variant="ghost" className="h-10 flex-1 text-sm" onClick={p.stopRun}>
                Reset
              </Button>
            )}
            {run.status === "done" ? (
              <Button className="h-10 flex-1 text-sm" onClick={() => p.go(6)}>
                See the portfolio after
              </Button>
            ) : null}
          </div>
        </Card>
      )}

      {run.errors.length ? (
        <Card tone="warn" className="mb-4 text-sm text-warn">
          {run.errors[run.errors.length - 1]}
        </Card>
      ) : null}

      {run.venueOff ? (
        <Card tone="warn" className="flash mb-4">
          <div className="flex items-center justify-between">
            <Label className="text-warn">re-route</Label>
            <span className="font-mono text-[11px] text-faint">{clock(run.venueOff.at)}</span>
          </div>
          <p className="mt-2 text-[15px]">
            <span className="font-semibold">{venue(run.venueOff.venue).name}</span> turned off.{" "}
            {reroute ? (
              <>
                {reroute.moves.length} queued {reroute.moves.length === 1 ? "slice" : "slices"} re-routed:{" "}
                {[...rerouteCounts.entries()].map(([v, n], i) => (
                  <span key={v}>
                    {i ? ", " : ""}
                    <span className="font-semibold" style={{ color: venue(v).color }}>
                      {n} to {venue(v).name}
                    </span>
                  </span>
                ))}
                .
              </>
            ) : (
              "Waiting for the re-route."
            )}
          </p>
        </Card>
      ) : null}

      {run.status !== "idle" ? (
        <Card className="mb-4">
          <Label>dollars per venue</Label>
          <div className="mt-2">
            <VenueSplit shares={venueShares(run)} planned={planned} />
          </div>
        </Card>
      ) : null}

      <Card className="mb-4 px-2 pt-3 pb-3">
        <div className="mb-1 px-2">
          <Label>{run.status === "idle" ? "the plan" : "live"}</Label>
        </div>
        <FanOut moves={live} status={run.status === "idle" ? undefined : status} off={offVenue ? [offVenue] : []} animate />
      </Card>

      {rows.length ? (
        <Card>
          <Label>timeline</Label>
          <ul className="mt-1 divide-y divide-line">
            {rows.map((r) => (
              <Row key={r.id} r={r} addressOf={p.addressOf} />
            ))}
          </ul>
        </Card>
      ) : null}
    </section>
  );
}
