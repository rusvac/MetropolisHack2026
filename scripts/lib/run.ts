// the run: turn a RebalancePlan into a timeline of moves, send each move through an executor,
// and re-route the remaining slices when a venue turns off. the terminal demo and apps/server's
// POST /execute read the same events. the event shapes match apps/web/src/lib/types.ts (ExecEvent),
// with a few extra fields
import type { HedgeQuote, Portfolio, RebalancePlan, Slice, SpotVenue, Token, VenueId } from "../../packages/core/src/index.ts";
import { sleep, toNumber } from "./format.ts";
import { applyMoves, type Applied, type Prices } from "./plan-math.ts";
import type { Replanner } from "./standin.ts";
import { DEMO_MONAD_ACCOUNTS, MON, USDC_BASE, execToken, txUrl } from "./tokens.ts";

export type MoveKind = "bridge" | "swap" | "hedge" | "gas";

export interface Move {
  /** `bridge-<i>`, `swap-<planIndex>-<sliceIndex>`, `hedge`, `gas-<i>`. the same ids as apps/web */
  id: string;
  kind: MoveKind;
  /** the chain the transaction goes to */
  chainId: number;
  /** the swarm account that sends */
  account: number;
  /** the swarm account that receives. the same as `account` for a swap or the hedge */
  toAccount: number;
  toChainId: number;
  venue: VenueId;
  sell: Token;
  buy: Token;
  amountIn: bigint;
  /** expected, from the quote */
  amountOut: bigint;
  /** ms after the run starts, with the wait for the bridges */
  delayMs: number;
  /** the delay in the plan, before the wait for the bridges. a re-route matches slices on it */
  planDelayMs: number;
  /** which entry of plan.swaps a slice belongs to */
  swapIndex?: number;
  /** true when the quote behind the move is simulated */
  quoteSimulated: boolean;
}

/** one transaction of a move, with its explorer link and its receipt status */
export interface TxLink {
  hash: string;
  url: string | null;
  status: string;
  gasUsed?: bigint;
}

export interface SendResult {
  status: "confirmed" | "failed" | "quoted";
  /** every transaction of the move, approvals first. the last one is the swap */
  txs?: TxLink[];
  /** the output the venue quoted just before the send, when the executor quoted again */
  expectedOut?: bigint;
  /** a real transaction hash, or null when nothing went onchain */
  hash: string | null;
  url: string | null;
  note?: string;
  /** the venue cannot fill this slice (for example a thin book). the run re-routes it to the other venues */
  reroute?: boolean;
}

export interface Executor {
  name: string;
  /** true when no move goes onchain */
  simulated: boolean;
  /** `onSent` gets the hash as soon as the transaction is out, before the receipt */
  send(move: Move, runId: string, onSent?: (hash: string) => void): Promise<SendResult>;
}

export type MoveStatus = "queued" | "sent" | "confirmed" | "failed" | "quoted" | "rerouted";

export interface MoveEvent {
  type: "move";
  id: string;
  kind: MoveKind;
  status: MoveStatus;
  venue: VenueId;
  account: number;
  toAccount: number;
  chainId: number;
  toChainId: number;
  /** atomic units. JSON carries them as decimal strings */
  amountIn: bigint;
  amountOut: bigint;
  symbolIn: string;
  symbolOut: string;
  decimalsIn: number;
  decimalsOut: number;
  usd: number;
  hash?: string;
  url?: string;
  txs?: TxLink[];
  /** true when no transaction exists on any chain */
  simulated: boolean;
  /** true when the quote behind the numbers is simulated */
  quoteSimulated: boolean;
  delayMs: number;
  at: number;
  elapsedMs: number;
  note?: string;
}

export type RunEvent =
  | {
      type: "start";
      runId: string;
      at: number;
      moves: number;
      executor: string;
      simulated: boolean;
      dropVenue: VenueId | null;
      /** ms of plan time the swaps wait for the bridges to land */
      transitMs: number;
    }
  | MoveEvent
  | { type: "venue-off"; venue: VenueId; at: number; elapsedMs: number }
  | { type: "reroute"; from: VenueId; at: number; elapsedMs: number; moves: { id: string; to: VenueId; slice: Slice }[] }
  | { type: "done"; runId: string; at: number; elapsedMs: number; confirmed: number; failed: number; quoted: number; simulated: boolean; after: Portfolio }
  | { type: "error"; at: number; message: string };

/** every move of the plan, in time order: bridges, swap slices, then the hedge */
export function movesOf(plan: RebalancePlan): Move[] {
  const moves: Move[] = [];
  const baseUsdc = plan.before.holdings.find((h) => h.token.chainId === 84532 || h.token.chainId === 8453)?.token ?? USDC_BASE;
  plan.bridges.forEach((b, i) => {
    moves.push({
      id: `bridge-${i}`,
      kind: "bridge",
      chainId: execChain(baseUsdc.chainId),
      account: b.fromAccount,
      toAccount: b.toAccount,
      toChainId: execChain(b.quote.to.chainId),
      venue: b.quote.venue,
      sell: baseUsdc,
      buy: b.quote.to,
      amountIn: b.quote.amountIn,
      amountOut: b.quote.amountOut,
      delayMs: b.delayMs,
      planDelayMs: b.delayMs,
      quoteSimulated: b.quote.simulated,
    });
  });
  plan.swaps.forEach((swap, si) => {
    swap.slices.forEach((s, k) => moves.push(sliceMove(swap.intent.sell, swap.intent.buy, s, si, `swap-${si}-${k}`, swap.baseline.simulated)));
  });
  const hedge = plan.hedge ?? plan.swaps.find((p) => p.hedge)?.hedge;
  if (hedge) {
    const last = moves.reduce((m, x) => Math.max(m, x.delayMs), 0);
    const account = plan.swaps[0]?.slices[0]?.account ?? DEMO_MONAD_ACCOUNTS[0]!;
    moves.push(hedgeMove(hedge, account, last + 400));
  }
  return moves.sort((a, b) => a.delayMs - b.delayMs);
}

/** venues named mock- whose quotes still come from a live contract on monad testnet */
export const LIVE_TESTNET_VENUES = new Set<string>(["test-pool", "uniswap-v4-testnet"]);

/** true when a venue's quotes are simulated: a mock pool, not a contract on a chain */
export function isMockVenue(venue: string): boolean {
  return venue.startsWith("mock-") && !LIVE_TESTNET_VENUES.has(venue);
}

/** a mainnet chain maps to its testnet: quotes come from mainnet, execution runs on testnet */
export function execChain(chainId: number): number {
  if (chainId === 143) return 10143;
  if (chainId === 8453) return 84532;
  return chainId;
}

function sliceMove(sell: Token, buy: Token, s: Slice, swapIndex: number, id: string, baselineSimulated: boolean, shiftMs = 0): Move {
  return {
    id,
    kind: "swap",
    chainId: execChain(sell.chainId),
    account: s.account,
    toAccount: s.account,
    toChainId: execChain(sell.chainId),
    venue: s.venue,
    sell,
    buy,
    amountIn: s.amountIn,
    amountOut: s.expectedOut,
    delayMs: s.delayMs + shiftMs,
    planDelayMs: s.delayMs,
    swapIndex,
    quoteSimulated: baselineSimulated || isMockVenue(s.venue),
  };
}

function hedgeMove(h: HedgeQuote, account: number, delayMs: number): Move {
  return {
    id: "hedge",
    kind: "hedge",
    chainId: 10143,
    account,
    toAccount: account,
    toChainId: 10143,
    venue: h.venue,
    sell: MON,
    buy: MON,
    amountIn: h.size,
    amountOut: h.size,
    delayMs,
    planDelayMs: delayMs,
    quoteSimulated: h.simulated,
  };
}

/**
 * gas top-ups: a monad account that sends a slice or the hedge and holds no MON gets MON for gas
 * from account 0. each top-up is a direct transfer between two swarm accounts, and beat 7 counts it
 */
export function gasMoves(plan: RebalancePlan, moves: Move[], perTxWei: bigint): Move[] {
  const holdsMon = new Set(plan.before.holdings.filter((h) => h.token.symbol === "MON" && h.amount > 0n && execChain(h.token.chainId) === 10143).map((h) => h.account));
  const first = new Map<number, { delayMs: number; txs: number }>();
  for (const m of moves) {
    if (m.kind !== "swap" && m.kind !== "hedge") continue;
    if (holdsMon.has(m.account)) continue;
    const f = first.get(m.account) ?? { delayMs: m.delayMs, txs: 0 };
    first.set(m.account, { delayMs: Math.min(f.delayMs, m.delayMs), txs: f.txs + 1 });
  }
  const step = 10n ** 16n; // 0.01 MON
  return [...first.entries()]
    .sort((a, b) => a[1].delayMs - b[1].delayMs)
    .map(([account, f], i) => {
      const raw = perTxWei * BigInt(f.txs) * 2n;
      const amount = ((raw + step - 1n) / step) * step;
      return {
        id: `gas-${i}`,
        kind: "gas" as const,
        chainId: 10143,
        account: 0,
        toAccount: account,
        toChainId: 10143,
        venue: "mock-gas" as VenueId,
        sell: MON,
        buy: MON,
        amountIn: amount,
        amountOut: amount,
        delayMs: Math.max(0, f.delayMs - 300),
        planDelayMs: Math.max(0, f.delayMs - 300),
        quoteSimulated: false,
      };
    });
}

/** the plan's slice behind a move, on the plan's clock */
function toSlice(m: Move): Slice {
  return { venue: m.venue, account: m.account, amountIn: m.amountIn, expectedOut: m.amountOut, delayMs: m.planDelayMs };
}

function asApplied(m: Move, known: Token[]): Applied | null {
  if (m.kind === "hedge") return null;
  return {
    sell: execToken(m.sell, known),
    account: m.account,
    amountIn: m.amountIn,
    buy: execToken(m.buy, known),
    toAccount: m.toAccount,
    amountOut: m.amountOut,
  };
}

/**
 * the plan's delays share one clock, but a bridge takes time to land. every swap and the hedge wait
 * for the slowest bridge, up to `maxMs`. returns the shift in ms
 */
export function transitShift(moves: Move[], plan: RebalancePlan, maxMs: number): number {
  if (plan.bridges.length === 0) return 0;
  const land = Math.max(...plan.bridges.map((b) => b.delayMs + Math.min(maxMs, (b.quote.etaSeconds ?? 20) * 1_000)));
  const firstAfter = Math.min(...moves.filter((m) => m.kind !== "bridge").map((m) => m.delayMs));
  return Number.isFinite(firstAfter) ? Math.max(0, land - firstAfter) : 0;
}

/** an executor that sends nothing. no move gets a hash or an explorer link */
export function simulatedExecutor(): Executor {
  return {
    name: "simulated",
    simulated: true,
    async send(move) {
      if (move.kind === "bridge") return { status: "quoted", hash: null, url: null, note: "bridge quote, simulated" };
      if (move.kind === "hedge") return { status: "quoted", hash: null, url: null, note: "short quote, simulated" };
      return { status: "confirmed", hash: null, url: null, note: "simulated, nothing sent" };
    },
  };
}

/** a real transaction hash, with its explorer link */
export function landed(chainId: number, hash: string): SendResult {
  return { status: "confirmed", hash, url: txUrl(chainId, hash) };
}

/** a handle to turn a venue off while the run is going */
export class RunControl {
  private pending: VenueId[] = [];
  readonly off = new Set<VenueId>();
  venueOff(venue: VenueId): void {
    if (!this.off.has(venue) && !this.pending.includes(venue)) this.pending.push(venue);
  }
  take(): VenueId | undefined {
    const v = this.pending.shift();
    if (v) this.off.add(v);
    return v;
  }
}

export interface RunOptions {
  runId?: string;
  executor: Executor;
  /** the spot venues. the re-route picks from these, without the ones turned off */
  spot: SpotVenue[];
  replan: Replanner;
  /** the venue to turn off halfway through the slices. "auto" picks the venue with the most slices left. null = no drop */
  dropVenue?: VenueId | "auto" | null;
  /** share of the swap slices sent before the drop. default 0.5 */
  dropAt?: number;
  /** delays divide by this. Infinity = no waiting. default 1 */
  speed?: number;
  /** prices for the usd of each move and the portfolio after */
  prices: Prices;
  /** wei of gas per transaction, to size the gas top-ups. 0 = no top-ups */
  gasPerTxWei?: bigint;
  /** emit a queued event for every move at the start, as apps/web expects. default true */
  queued?: boolean;
  /** the longest wait for a bridge to land, in ms of plan time. default 20 000 */
  maxTransitMs?: number;
  control?: RunControl;
  signal?: AbortSignal;
}

function pickDrop(moves: Move[], dropAt: number, spot: SpotVenue[], wanted: RunOptions["dropVenue"]): VenueId | null {
  if (!wanted || spot.length < 2) return null;
  if (wanted !== "auto") return wanted;
  const swaps = moves.filter((m) => m.kind === "swap");
  const late = swaps.slice(Math.ceil(swaps.length * dropAt));
  const count = new Map<VenueId, number>();
  for (const m of late) count.set(m.venue, (count.get(m.venue) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export async function* runPlan(plan: RebalancePlan, opts: RunOptions): AsyncGenerator<RunEvent> {
  const runId = opts.runId ?? `run-${Date.now().toString(36)}`;
  const speed = opts.speed ?? 1;
  const dropAt = opts.dropAt ?? 0.5;
  const control = opts.control ?? new RunControl();
  const planMoves = movesOf(plan);
  const transitMs = transitShift(planMoves, plan, opts.maxTransitMs ?? 20_000);
  for (const m of planMoves) if (m.kind !== "bridge") m.delayMs += transitMs;
  const shift = transitMs;
  const gas = opts.gasPerTxWei ? gasMoves(plan, planMoves, opts.gasPerTxWei) : [];
  let queue = [...gas, ...planMoves].sort((a, b) => a.delayMs - b.delayMs);
  const swapCount = queue.filter((m) => m.kind === "swap").length;
  const autoDrop = pickDrop(queue, dropAt, opts.spot, opts.dropVenue ?? null);
  const t0 = Date.now();
  const usdOf = (m: Move) => toNumber(m.amountIn, m.sell.decimals) * (opts.prices[m.sell.symbol] ?? 0);
  const event = (m: Move, status: MoveStatus, extra: Partial<MoveEvent> = {}): MoveEvent => ({
    type: "move",
    id: m.id,
    kind: m.kind,
    status,
    venue: m.venue,
    account: m.account,
    toAccount: m.toAccount,
    chainId: m.chainId,
    toChainId: m.toChainId,
    amountIn: m.amountIn,
    amountOut: m.amountOut,
    symbolIn: m.sell.symbol,
    symbolOut: m.buy.symbol,
    decimalsIn: m.sell.decimals,
    decimalsOut: m.buy.decimals,
    usd: usdOf(m),
    simulated: true,
    quoteSimulated: m.quoteSimulated,
    delayMs: m.delayMs,
    at: Date.now(),
    elapsedMs: Date.now() - t0,
    ...extra,
  });

  yield { type: "start", runId, at: Date.now(), moves: queue.length, executor: opts.executor.name, simulated: opts.executor.simulated, dropVenue: autoDrop, transitMs };
  if (opts.queued ?? true) for (const m of queue) yield event(m, "queued");

  const sent: Move[] = [];
  const retried = new Set<string>();
  let swapsSent = 0;
  let autoDone = false;
  const tally = { confirmed: 0, failed: 0, quoted: 0 };

  while (queue.length > 0) {
    if (opts.signal?.aborted) {
      yield { type: "error", at: Date.now(), message: "the run stopped: the client went away" };
      return;
    }
    if (!autoDone && autoDrop && queue[0]!.kind === "swap" && swapsSent >= Math.ceil(swapCount * dropAt)) {
      autoDone = true;
      control.venueOff(autoDrop);
    }
    const off = control.take();
    if (off) {
      yield { type: "venue-off", venue: off, at: Date.now(), elapsedMs: Date.now() - t0 };
      const r = await reroute(plan, queue, off, control.off, opts, shift);
      queue = r.queue;
      for (const m of r.removed) yield event(m, "rerouted", { note: `${m.venue} turned off` });
      yield { type: "reroute", from: off, at: Date.now(), elapsedMs: Date.now() - t0, moves: r.moved };
      continue;
    }
    const next = queue.shift()!;
    if (Number.isFinite(speed)) await sleep(t0 + next.delayMs / speed - Date.now(), opts.signal);
    if (opts.signal?.aborted) continue;
    let result: SendResult;
    const live: { hash?: string } = {};
    const sentEvents: MoveEvent[] = [];
    try {
      result = await opts.executor.send(next, runId, (hash) => {
        live.hash = hash;
        sentEvents.push(event(next, "sent", { hash, url: txUrl(next.chainId, hash) ?? undefined, simulated: false }));
      });
    } catch (e) {
      result = { status: "failed", hash: live.hash ?? null, url: null, note: e instanceof Error ? e.message : String(e) };
    }
    for (const e of sentEvents) yield e;
    if (result.status === "failed" && result.reroute && next.kind === "swap" && !retried.has(next.id)) {
      // the venue cannot fill this slice. send the same slice through the other venues
      const r = await rerouteOne(plan, next, control.off, opts, shift);
      if (r.moves.length > 0) {
        for (const m of r.moves) retried.add(m.id);
        queue = [...r.moves, ...queue];
        yield event(next, "rerouted", { note: result.note ?? `${next.venue} cannot fill this slice` });
        yield { type: "reroute", from: next.venue, at: Date.now(), elapsedMs: Date.now() - t0, moves: r.moved };
        continue;
      }
    }
    if (next.kind === "swap") swapsSent++;
    const onchain = result.hash !== null;
    if (result.status === "confirmed" && !onchain) yield event(next, "sent", { note: result.note });
    tally[result.status]++;
    if (result.status !== "failed") sent.push(next);
    if (result.expectedOut !== undefined) next.amountOut = result.expectedOut;
    yield event(next, result.status, {
      ...(result.txs ? { txs: result.txs } : {}),
      ...(result.hash ? { hash: result.hash } : {}),
      ...(result.url ? { url: result.url } : {}),
      simulated: !onchain,
      ...(result.note ? { note: result.note } : {}),
    });
  }

  const known = plan.before.holdings.map((h) => h.token);
  const applied = sent.map((m) => asApplied(m, known)).filter((a): a is Applied => a !== null);
  const after = applyMoves(plan.before, applied, opts.prices);
  yield { type: "done", runId, at: Date.now(), elapsedMs: Date.now() - t0, ...tally, simulated: opts.executor.simulated, after };
}

const sliceKey = (s: Slice) => `${s.account}:${s.amountIn}:${s.delayMs}`;

/** one slice that its venue cannot fill goes to the other venues, with the same account, size, and delay */
async function rerouteOne(plan: RebalancePlan, m: Move, off: Set<VenueId>, opts: RunOptions, shift: number) {
  const si = m.swapIndex ?? 0;
  const swap = plan.swaps[si];
  const venues = opts.spot.filter((v) => !off.has(v.id) && v.id !== m.venue);
  if (!swap || venues.length === 0) return { moves: [] as Move[], moved: [] };
  let next: Slice[] = [];
  try {
    next = await opts.replan({ swap, remaining: [toSlice(m)], dropped: m.venue, venues });
  } catch {
    next = [];
  }
  const moves = next
    .filter((s) => s.venue !== m.venue)
    .map((s, k) => {
      return sliceMove(swap.intent.sell, swap.intent.buy, { ...s, delayMs: m.planDelayMs }, si, k === 0 ? m.id : `${m.id}-r${k}`, swap.baseline.simulated, shift);
    });
  return { moves, moved: moves.map((mv) => ({ id: mv.id, to: mv.venue, slice: toSlice(mv) })) };
}

/**
 * re-route the queued slices of a venue that turned off. a slice that keeps its account, size, and
 * delay keeps its id, so the screens move it from one venue to the other
 */
async function reroute(plan: RebalancePlan, queue: Move[], dropped: VenueId, off: Set<VenueId>, opts: RunOptions, shift: number) {
  const out: Move[] = queue.filter((m) => m.kind !== "swap");
  const moved: { id: string; to: VenueId; slice: Slice }[] = [];
  const removed: Move[] = [];
  const live = opts.spot.filter((v) => !off.has(v.id));
  const swapIndexes = [...new Set(queue.filter((m) => m.kind === "swap").map((m) => m.swapIndex ?? 0))];
  for (const si of swapIndexes) {
    const swap = plan.swaps[si];
    const mine = queue.filter((m) => m.kind === "swap" && (m.swapIndex ?? 0) === si);
    if (!swap || !mine.some((m) => m.venue === dropped)) {
      out.push(...mine);
      continue;
    }
    const remaining = mine.map(toSlice);
    let next: Slice[];
    try {
      next = await opts.replan({ swap, remaining, dropped, venues: live });
    } catch {
      next = remaining.filter((s) => s.venue !== dropped);
    }
    const byKey = new Map(mine.map((m) => [sliceKey(toSlice(m)), m]));
    const used = new Set<string>();
    next.forEach((s, k) => {
      const prev = byKey.get(sliceKey(s));
      const id = prev && !used.has(prev.id) ? prev.id : `swap-${si}-r${k}`;
      used.add(id);
      out.push(sliceMove(swap.intent.sell, swap.intent.buy, s, si, id, swap.baseline.simulated, shift));
      if (!prev || prev.venue !== s.venue) moved.push({ id, to: s.venue, slice: s });
    });
    for (const m of mine) if (m.venue === dropped && !used.has(m.id)) removed.push(m);
  }
  out.sort((a, b) => a.delayMs - b.delayMs);
  return { queue: out, moved, removed };
}
