// a simulated run of a plan in the browser: the same events that POST /execute streams,
// with no transaction behind any of them. every move event says simulated: true
import type { VenueId } from "@spidereum/core";
import { FIXTURE_POOLS, poolOut } from "./fixture.ts";
import { fromUnits } from "./format.ts";
import { planMoves, type Move } from "./moves.ts";
import type { DemoPlan, ExecEvent, ExecuteOptions } from "./types.ts";

export interface RunHandle {
  stop(): void;
  /** turn a venue off now. the queued slices on it re-route to the other venues */
  venueOff(venue: VenueId): void;
}

/** the run plays in about this long, whatever the plan's delays */
const TARGET_MS = 13_000;

export function simulateRun(
  plan: DemoPlan,
  opts: ExecuteOptions,
  emit: (e: ExecEvent) => void,
  targetMs = TARGET_MS,
): RunHandle {
  const moves = planMoves(plan);
  const last = Math.max(1, ...moves.map((m) => m.delayMs));
  const scale = Math.min(1.5, targetMs / last);
  const beat = Math.min(1, targetMs / TARGET_MS);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const venueOf = new Map(moves.map((m) => [m.id, m.venue] as const));
  const outOf = new Map(moves.map((m) => [m.id, m.amountOut] as const));
  const sent = new Set<string>();
  const off = new Set<VenueId>();
  const fills = new Map<VenueId, number>();
  const swaps = moves.filter((m) => m.kind === "swap");
  let stopped = false;
  let finished = 0;

  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      if (!stopped) fn();
    }, ms);
    timers.add(t);
  };

  const base = (m: Move) => ({
    type: "move" as const,
    id: m.id,
    kind: m.kind,
    venue: venueOf.get(m.id) ?? m.venue,
    account: m.account,
    toAccount: m.toAccount,
    chainId: m.chainId,
    amountIn: fromUnits(m.amountIn, m.decimalsIn).toString(),
    amountOut: fromUnits(outOf.get(m.id) ?? m.amountOut, m.decimalsOut).toString(),
    symbolIn: m.symbolIn,
    symbolOut: m.symbolOut,
    decimalsIn: m.decimalsIn,
    decimalsOut: m.decimalsOut,
    usd: m.usd,
    simulated: true,
  });

  const venueOff = (v: VenueId) => {
    if (off.has(v) || stopped) return;
    off.add(v);
    emit({ type: "venue-off", venue: v, at: Date.now() });
    const queued = swaps.filter((m) => !sent.has(m.id) && venueOf.get(m.id) === v);
    const others = [...new Set(swaps.map((m) => venueOf.get(m.id)!))].filter((x) => !off.has(x));
    const pools = FIXTURE_POOLS.filter((p) => others.includes(p.venue));
    const re: { id: string; to: VenueId }[] = [];
    for (const m of queued) {
      let to: VenueId | undefined;
      let out = m.amountOut;
      if (pools.length) {
        let best = -1;
        for (const p of pools) {
          const o = poolOut(p, fills.get(p.venue) ?? 0, m.amountIn);
          if (o > best) {
            best = o;
            to = p.venue;
          }
        }
        out = best;
        fills.set(to!, (fills.get(to!) ?? 0) + m.amountIn);
      } else {
        to = others[re.length % Math.max(1, others.length)];
      }
      if (!to) continue;
      venueOf.set(m.id, to);
      outOf.set(m.id, out);
      re.push({ id: m.id, to });
    }
    emit({
      type: "reroute",
      from: v,
      at: Date.now(),
      moves: re.map((r) => {
        const m = queued.find((q) => q.id === r.id)!;
        return {
          id: r.id,
          to: r.to,
          slice: {
            venue: r.to,
            account: m.account ?? 0,
            amountIn: fromUnits(m.amountIn, m.decimalsIn),
            expectedOut: fromUnits(outOf.get(m.id) ?? m.amountOut, m.decimalsOut),
            delayMs: m.delayMs,
          },
        };
      }),
    });
  };

  const done = () => {
    finished++;
    if (finished === moves.length) later(500 * beat, () => emit({ type: "done", at: Date.now(), after: plan.after, simulated: true }));
  };

  emit({ type: "start", runId: `sim-${Date.now()}`, at: Date.now(), moves: moves.length, simulated: true });
  for (const m of moves) emit({ ...base(m), status: "queued", at: Date.now() });

  const half = Math.ceil(swaps.length / 2);
  let swapsSent = 0;

  for (const m of moves) {
    later(400 * beat + m.delayMs * scale, () => {
      if (m.kind === "bridge") {
        emit({ ...base(m), status: "quoted", at: Date.now(), note: "Aurora Intents quote. Aurora has no testnet" });
        done();
        return;
      }
      if (m.kind === "hedge") {
        emit({ ...base(m), status: "quoted", at: Date.now(), note: "Perpl short, quote only" });
        done();
        return;
      }
      sent.add(m.id);
      const v = venueOf.get(m.id)!;
      if (FIXTURE_POOLS.some((p) => p.venue === v)) fills.set(v, (fills.get(v) ?? 0) + m.amountIn);
      emit({ ...base(m), status: "sent", at: Date.now() });
      swapsSent++;
      if (opts.dropVenue && swapsSent === half) later(250 * beat, () => venueOff(opts.dropVenue!));
      later((350 + Math.random() * 500) * beat, () => {
        emit({ ...base(m), status: "confirmed", at: Date.now() });
        done();
      });
    });
  }

  return {
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
    venueOff,
  };
}
