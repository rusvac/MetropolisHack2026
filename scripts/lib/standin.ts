// a stand-in for @spidereum/router's rebalance and replan, so the demo runs before lane L5 lands.
// like the router, it quotes with the monad mainnet tokens. the run maps them to the testnet tokens.
// config.ts switches to the router as soon as it exports a working rebalance.
// it plans for a two-asset target (MON and USDC). it never plans a direct transfer between swarm accounts
import type {
  BridgeMove,
  BridgeQuote,
  HedgeQuote,
  Holding,
  Intent,
  Plan,
  Portfolio,
  Quote,
  RebalanceIntent,
  RebalancePlan,
  Slice,
  SpotVenue,
  Token,
  VenueId,
} from "../../packages/core/src/index.ts";
import { rng, toNumber } from "./format.ts";
import { applyMoves, costBreakdown, midPrice, planAsApplied, type GasInfo, type Prices, type VenueSet } from "./plan-math.ts";
import { MON_MAINNET as MON, USDC_MAINNET as USDC_MONAD } from "./tokens.ts";

export interface PlannerOptions {
  /** monad accounts the plan may send from or deliver to */
  monadAccounts: number[];
  gas: GasInfo;
  /** seeds the delays and the slice sizes, so a plan repeats */
  seed?: number;
}

export type Planner = (before: Portfolio, intent: RebalanceIntent, venues: VenueSet, opts: PlannerOptions) => Promise<RebalancePlan>;

export interface ReplanArgs {
  swap: Plan;
  /** slices of `swap` that have not run yet */
  remaining: Slice[];
  dropped: VenueId;
  venues: SpotVenue[];
}

/** returns the new slices for the remaining part of the swap, without the dropped venue */
export type Replanner = (args: ReplanArgs) => Promise<Slice[]>;

const isMonadChain = (id: number) => id === 10143 || id === 143;

/**
 * split `total` over the venues: give each chunk to the venue with the best next output.
 * a quote cache keeps the cost near one quote per chunk
 */
export async function splitAcrossVenues(
  venues: SpotVenue[],
  sell: Token,
  buy: Token,
  total: bigint,
  chunks = 24,
): Promise<Map<VenueId, { amountIn: bigint; amountOut: bigint }>> {
  const alloc = new Map<VenueId, { amountIn: bigint; amountOut: bigint }>();
  for (const v of venues) alloc.set(v.id, { amountIn: 0n, amountOut: 0n });
  if (total <= 0n || venues.length === 0) return alloc;
  const cache = new Map<string, bigint | null>();
  const quoteOut = async (v: SpotVenue, amountIn: bigint): Promise<bigint | null> => {
    const k = `${v.id}:${amountIn}`;
    if (cache.has(k)) return cache.get(k)!;
    const out = await v.quote({ sell, buy, amountIn }).then((q) => q.amountOut).catch(() => null);
    cache.set(k, out);
    return out;
  };
  const chunk = total / BigInt(chunks) || total;
  let left = total;
  while (left > 0n) {
    const amount = left < chunk * 2n ? left : chunk;
    const gains = await Promise.all(
      venues.map(async (v) => {
        const cur = alloc.get(v.id)!;
        const next = await quoteOut(v, cur.amountIn + amount);
        return next === null ? null : { v, next, gain: next - cur.amountOut };
      }),
    );
    const best = gains.filter((g) => g !== null).sort((a, b) => (b.gain > a.gain ? 1 : b.gain < a.gain ? -1 : 0))[0];
    if (!best) throw new Error(`no venue quotes ${sell.symbol} to ${buy.symbol}`);
    const cur = alloc.get(best.v.id)!;
    alloc.set(best.v.id, { amountIn: cur.amountIn + amount, amountOut: best.next });
    left -= amount;
  }
  return alloc;
}

/** split `amount` into `parts` with sizes that vary by ±20%, so no two slices look alike */
function jitterSplit(amount: bigint, parts: number, rand: () => number): bigint[] {
  if (parts <= 1) return [amount];
  const weights = Array.from({ length: parts }, () => 0.8 + rand() * 0.4);
  const sum = weights.reduce((a, b) => a + b, 0);
  const out: bigint[] = [];
  let used = 0n;
  for (let i = 0; i < parts - 1; i++) {
    const p = (amount * BigInt(Math.round((weights[i]! / sum) * 1_000_000))) / 1_000_000n;
    out.push(p);
    used += p;
  }
  out.push(amount - used);
  return out;
}

async function bestSingle(venues: SpotVenue[], sell: Token, buy: Token, amountIn: bigint): Promise<Quote> {
  const qs = await Promise.allSettled(venues.map((v) => v.quote({ sell, buy, amountIn })));
  const ok = qs.filter((q): q is PromiseFulfilledResult<Quote> => q.status === "fulfilled").map((q) => q.value);
  if (ok.length === 0) throw new Error("no venue quotes the baseline trade");
  return ok.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0))[0]!;
}

interface Source {
  account: number;
  amount: bigint;
  /** ms after the start when the funds are on monad */
  readyMs: number;
}

/** turn the venue split into slices: per source account, per venue, capped at a share of the total */
function slicesFor(
  sources: Source[],
  alloc: Map<VenueId, { amountIn: bigint; amountOut: bigint }>,
  total: bigint,
  privacyWeight: number,
  rand: () => number,
): Slice[] {
  const used = [...alloc.entries()].filter(([, a]) => a.amountIn > 0n);
  const maxShare = Math.max(0.04, 0.25 - 0.2 * privacyWeight);
  const cap = BigInt(Math.max(1, Math.floor(Number(total) * maxShare)));
  const slices: Slice[] = [];
  for (const src of sources) {
    let t = src.readyMs + 600 + Math.round(rand() * 1_200);
    let given = 0n;
    used.forEach(([venue, a], i) => {
      const part = i === used.length - 1 ? src.amount - given : (src.amount * a.amountIn) / total;
      given += part;
      if (part <= 0n) return;
      const parts = Number((part + cap - 1n) / cap);
      for (const amountIn of jitterSplit(part, parts, rand)) {
        slices.push({ venue, account: src.account, amountIn, expectedOut: (a.amountOut * amountIn) / a.amountIn, delayMs: t });
        t += 500 + Math.round(rand() * 2_000);
      }
    });
  }
  return slices.sort((a, b) => a.delayMs - b.delayMs);
}

/**
 * the stand-in rebalance. bridges the USDC that the MON target needs from base into separate monad
 * accounts, swaps it to MON in slices across the spot venues, and quotes the hedge
 */
export const standInRebalance: Planner = async (before, intent, venues, opts) => {
  const rand = rng(opts.seed ?? 7);
  const mid = await midPrice(venues.spot);
  const prices: Prices = { USDC: 1, MON: mid.monUsd };
  const value = (h: Holding) => toNumber(h.amount, h.token.decimals) * (prices[h.token.symbol] ?? 0);
  const totalUsd = before.holdings.reduce((s, h) => s + value(h), 0);
  const monWeight = intent.targets.find((t) => t.symbol === "MON")?.weight ?? 0;
  const monNowUsd = before.holdings.filter((h) => h.token.symbol === "MON").reduce((s, h) => s + value(h), 0);
  const needUsd = monWeight * totalUsd - monNowUsd;

  const bridges: BridgeMove[] = [];
  const sources: Source[] = [];
  let sell: Token = USDC_MONAD;
  let buy: Token = MON;
  let bridgeTotal = 0n;

  if (needUsd > 0) {
    // buy MON with USDC. USDC already on monad goes first, then the bridge from base
    const monadUsdc = before.holdings.filter((h) => isMonadChain(h.token.chainId) && h.token.symbol === "USDC" && h.amount > 0n);
    const baseUsdc = before.holdings.filter((h) => !isMonadChain(h.token.chainId) && h.token.symbol === "USDC" && h.amount > 0n);
    let need = BigInt(Math.round(needUsd * 1e6));
    for (const h of monadUsdc) {
      const take = h.amount < need ? h.amount : need;
      if (take <= 0n) break;
      sources.push({ account: h.account, amount: take, readyMs: 0 });
      need -= take;
    }
    const baseTotal = baseUsdc.reduce((s, h) => s + h.amount, 0n);
    if (need > 0n && baseTotal > 0n && venues.bridge) {
      // gross up for the bridge fee, then spread the bridge over the base accounts by balance
      const gross = (need * 10_020n) / 10_000n + 300_000n * BigInt(baseUsdc.length);
      bridgeTotal = gross < baseTotal ? gross : baseTotal;
      const partsPerAccount = intent.privacyWeight >= 0.5 ? 2 : 1;
      const holdsMon = new Set(before.holdings.filter((h) => h.token.symbol === "MON" && h.amount > 0n).map((h) => h.account));
      const receivers = [
        ...opts.monadAccounts.filter((a) => holdsMon.has(a)),
        ...opts.monadAccounts.filter((a) => !holdsMon.has(a) && !sources.some((s) => s.account === a)),
      ];
      let given = 0n;
      let t = 0;
      let r = 0;
      for (const [i, h] of baseUsdc.entries()) {
        const share = i === baseUsdc.length - 1 ? bridgeTotal - given : (bridgeTotal * h.amount) / baseTotal;
        given += share;
        for (const amount of jitterSplit(share, partsPerAccount, rand)) {
          if (amount <= 0n) continue;
          const toAccount = receivers[r % Math.max(1, receivers.length)] ?? opts.monadAccounts[0] ?? 0;
          r++;
          const quote = await venues.bridge.quoteBridge({ fromChain: "base", fromToken: "USDC", amount }, USDC_MONAD);
          bridges.push({ quote, fromAccount: h.account, toAccount, delayMs: t });
          // like the router, the plan's clock leaves out bridge transit. the run waits for the bridges to land
          sources.push({ account: toAccount, amount: quote.amountOut, readyMs: t });
          t += 800 + Math.round(rand() * 1_700);
        }
      }
    }
  } else if (needUsd < 0) {
    // sell MON for USDC from the accounts that hold it
    sell = MON;
    buy = USDC_MONAD;
    let left = BigInt(Math.round((-needUsd / mid.monUsd) * 1e6)) * 10n ** 12n;
    for (const h of before.holdings.filter((x) => isMonadChain(x.token.chainId) && x.token.symbol === "MON")) {
      const take = h.amount < left ? h.amount : left;
      if (take <= 0n) break;
      sources.push({ account: h.account, amount: take, readyMs: 0 });
      left -= take;
    }
  }

  const total = sources.reduce((s, x) => s + x.amount, 0n);
  const swaps: Plan[] = [];
  if (total > 0n) {
    const alloc = await splitAcrossVenues(venues.spot, sell, buy, total);
    const slices = slicesFor(sources, alloc, total, intent.privacyWeight, rand);
    const baseline = await bestSingle(venues.spot, sell, buy, total);
    const gasUnits = slices.reduce((s, x) => s + (mid.gasUnits[x.venue] ?? 150_000n), 0n);
    const bridgeAgg: BridgeQuote | undefined = bridges[0]
      ? {
          ...bridges[0].quote,
          amountIn: bridges.reduce((s, b) => s + b.quote.amountIn, 0n),
          amountOut: bridges.reduce((s, b) => s + b.quote.amountOut, 0n),
          simulated: bridges.some((b) => b.quote.simulated),
        }
      : undefined;
    const swapIntent: Intent = {
      id: `${intent.id}-swap-0`,
      sell,
      buy,
      amountIn: total,
      maxSlippageBps: 100,
      ...(intent.hedgeRatio ? { hedge: { ratio: intent.hedgeRatio } } : {}),
      ...(bridgeTotal > 0n ? { bridgeIn: { fromChain: "base", fromToken: "USDC", amount: bridgeTotal } } : {}),
      privacyWeight: intent.privacyWeight,
    };
    swaps.push({
      intent: swapIntent,
      slices,
      baseline,
      expectedOut: slices.reduce((s, x) => s + x.expectedOut, 0n),
      gasUnits,
      ...(bridgeAgg ? { bridge: bridgeAgg } : {}),
      largestSliceShare: slices.reduce((m, x) => Math.max(m, Number(x.amountIn) / Number(total)), 0),
    });
  }

  let hedge: HedgeQuote | undefined;
  if (intent.hedgeRatio && venues.perp) {
    const monTarget = (monWeight * totalUsd) / mid.monUsd;
    const size = BigInt(Math.round(monTarget * intent.hedgeRatio * 1e6)) * 10n ** 12n;
    hedge = await venues.perp.quoteHedge(MON, size);
    if (swaps[0]) swaps[0].hedge = hedge;
  }

  const draft: RebalancePlan = {
    intent,
    before,
    bridges,
    swaps,
    ...(hedge ? { hedge } : {}),
    after: before,
    costUsd: 0,
    naiveCostUsd: 0,
    directTransfers: 0,
  };
  draft.after = applyMoves(before, planAsApplied(draft), prices);

  // the naive version: one bridge of the same total from one account, one trade at the best venue
  let naiveBridgeUsd = 0;
  if (bridgeTotal > 0n && venues.bridge) {
    const one = await venues.bridge.quoteBridge({ fromChain: "base", fromToken: "USDC", amount: bridgeTotal }, USDC_MONAD);
    naiveBridgeUsd = toNumber(one.amountIn - one.amountOut, 6);
  }
  const zero = { ...draft, naiveCostUsd: 0 };
  const parts = costBreakdown(zero, prices, opts.gas);
  draft.costUsd = parts.split.totalUsd;
  draft.naiveCostUsd = naiveBridgeUsd + parts.naive.swapUsd + parts.naive.gasUsd;
  return draft;
};

/** the stand-in replan: the dropped venue's remaining slices go to the remaining venues, same account and delay */
export const standInReplan: Replanner = async ({ swap, remaining, dropped, venues }) => {
  const live = venues.filter((v) => v.id !== dropped);
  const keep = remaining.filter((s) => s.venue !== dropped);
  const move = remaining.filter((s) => s.venue === dropped);
  if (move.length === 0 || live.length === 0) return remaining;
  const total = move.reduce((s, x) => s + x.amountIn, 0n);
  const alloc = await splitAcrossVenues(live, swap.intent.sell, swap.intent.buy, total, Math.min(24, move.length * 4));
  const used = [...alloc.entries()].filter(([, a]) => a.amountIn > 0n);
  // hand each moved slice, largest first, to the venue furthest below its share of the new split
  const assigned = new Map<VenueId, bigint>(used.map(([v]) => [v, 0n]));
  const moved: Slice[] = [];
  for (const s of [...move].sort((a, b) => (b.amountIn > a.amountIn ? 1 : -1))) {
    const pick = used.reduce((best, cur) =>
      cur[1].amountIn - assigned.get(cur[0])! > best[1].amountIn - assigned.get(best[0])! ? cur : best,
    );
    const [venue, a] = pick;
    assigned.set(venue, assigned.get(venue)! + s.amountIn);
    moved.push({ ...s, venue, expectedOut: (a.amountOut * s.amountIn) / a.amountIn });
  }
  return [...keep, ...moved].sort((a, b) => a.delayMs - b.delayMs);
};
