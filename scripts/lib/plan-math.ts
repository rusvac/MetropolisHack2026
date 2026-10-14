// math the demo shares between the stand-in planner, the run, and the beats:
// the mid price, applying moves to a portfolio, and the cost of a plan in dollars
import type {
  BridgeVenue,
  Holding,
  PerpVenue,
  Portfolio,
  RebalancePlan,
  SpotVenue,
  Token,
} from "../../packages/core/src/index.ts";
import { toNumber } from "./format.ts";
import { MON_MAINNET, USDC_MAINNET, execToken } from "./tokens.ts";

export interface VenueSet {
  spot: SpotVenue[];
  perp?: PerpVenue;
  bridge?: BridgeVenue;
}

export interface GasInfo {
  /** monad gas price, in wei */
  monadWei: bigint;
  simulated: boolean;
  /** where the number comes from */
  source: string;
}

/** dollars per whole token, by symbol */
export type Prices = Record<string, number>;

export interface MidPrice {
  /** dollars per MON */
  monUsd: number;
  /** the venue with the best probe quote */
  venue: string;
  simulated: boolean;
  /** gas units per swap, by venue id */
  gasUnits: Record<string, bigint>;
}

/**
 * the MON price from a small probe quote on every spot venue. the probe adds the venue fee back,
 * so the price is close to the mid
 */
export async function midPrice(spot: SpotVenue[], usdc: Token = USDC_MAINNET, mon: Token = MON_MAINNET): Promise<MidPrice> {
  const probe = 10n * 10n ** BigInt(usdc.decimals);
  const results = await Promise.allSettled(spot.map((v) => v.quote({ sell: usdc, buy: mon, amountIn: probe })));
  let best: MidPrice | null = null;
  const gasUnits: Record<string, bigint> = {};
  results.forEach((r, i) => {
    if (r.status !== "fulfilled" || r.value.amountOut <= 0n) return;
    const q = r.value;
    gasUnits[spot[i]!.id] = q.gasUnits;
    const fee = (q.feeBps ?? 0) / 10_000;
    const monUsd = (toNumber(q.amountIn, usdc.decimals) * (1 - fee)) / toNumber(q.amountOut, mon.decimals);
    if (!best || monUsd < best.monUsd) best = { monUsd, venue: q.venue, simulated: q.simulated, gasUnits };
  });
  if (!best) throw new Error("no spot venue returned a MON quote");
  return best;
}

/** one change to a portfolio: take amountIn of `sell` from one account, give amountOut of `buy` to another */
export interface Applied {
  sell: Token;
  account: number;
  amountIn: bigint;
  buy: Token;
  toAccount: number;
  amountOut: bigint;
}

function key(chainId: number, account: number, symbol: string): string {
  return `${chainId}:${account}:${symbol}`;
}

/** the portfolio after the moves, valued at `prices` */
export function applyMoves(before: Portfolio, moves: Applied[], prices: Prices): Portfolio {
  const book = new Map<string, Holding>();
  for (const h of before.holdings) {
    const k = key(h.token.chainId, h.account, h.token.symbol);
    const prev = book.get(k);
    book.set(k, prev ? { ...prev, amount: prev.amount + h.amount } : { ...h });
  }
  const add = (token: Token, account: number, delta: bigint) => {
    const k = key(token.chainId, account, token.symbol);
    const prev = book.get(k) ?? { account, token, amount: 0n, usd: 0 };
    book.set(k, { ...prev, amount: prev.amount + delta });
  };
  for (const m of moves) {
    add(m.sell, m.account, -m.amountIn);
    add(m.buy, m.toAccount, m.amountOut);
  }
  const holdings = [...book.values()]
    .map((h) => ({ ...h, usd: toNumber(h.amount, h.token.decimals) * (prices[h.token.symbol] ?? 0) }))
    .filter((h) => h.amount > 0n)
    .sort((a, b) => a.token.chainId - b.token.chainId || a.account - b.account || a.token.symbol.localeCompare(b.token.symbol));
  return { holdings, totalUsd: holdings.reduce((s, h) => s + h.usd, 0), at: Date.now() };
}

/** the moves of a plan as portfolio changes on the testnets: bridges first, then every swap slice */
export function planAsApplied(plan: RebalancePlan): Applied[] {
  const out: Applied[] = [];
  const known = plan.before.holdings.map((h) => h.token);
  const baseUsdc = known.find((t) => (t.chainId === 84532 || t.chainId === 8453) && t.symbol === "USDC");
  for (const b of plan.bridges) {
    out.push({
      sell: execToken(baseUsdc ?? { ...b.quote.to, chainId: 84532 }, known),
      account: b.fromAccount,
      amountIn: b.quote.amountIn,
      buy: execToken(b.quote.to, known),
      toAccount: b.toAccount,
      amountOut: b.quote.amountOut,
    });
  }
  for (const swap of plan.swaps) {
    const sell = execToken(swap.intent.sell, known);
    const buy = execToken(swap.intent.buy, known);
    for (const s of swap.slices) out.push({ sell, account: s.account, amountIn: s.amountIn, buy, toAccount: s.account, amountOut: s.expectedOut });
  }
  return out;
}

export interface CostBreakdown {
  bridgeUsd: number;
  swapUsd: number;
  gasUsd: number;
  totalUsd: number;
  txCount: number;
}

/** dollars of gas for `units` on monad */
export function gasUsd(units: bigint, gas: GasInfo, monUsd: number): number {
  return toNumber(units * gas.monadWei, 18) * monUsd;
}

const HEDGE_GAS = 300_000n;

/**
 * the split plan's cost, and the naive version's: one account, one bridge, one trade per asset.
 * swap cost = value in minus value out at the mid price. bridge cost = USDC in minus USDC out
 */
export function costBreakdown(plan: RebalancePlan, prices: Prices, gas: GasInfo): { split: CostBreakdown; naive: CostBreakdown } {
  const monUsd = prices.MON ?? 0;
  const value = (t: Token, amount: bigint) => toNumber(amount, t.decimals) * (prices[t.symbol] ?? 0);

  const bridgeIn = plan.bridges.reduce((s, b) => s + b.quote.amountIn, 0n);
  const bridgeUsd = plan.bridges.reduce((s, b) => s + value(b.quote.to, b.quote.amountIn) - value(b.quote.to, b.quote.amountOut), 0);
  let swapUsd = 0;
  let naiveSwapUsd = 0;
  let units = 0n;
  let naiveUnits = 0n;
  let txCount = plan.bridges.length;
  for (const swap of plan.swaps) {
    for (const s of swap.slices) swapUsd += value(swap.intent.sell, s.amountIn) - value(swap.intent.buy, s.expectedOut);
    units += swap.gasUnits;
    txCount += swap.slices.length;
    naiveSwapUsd += value(swap.intent.sell, swap.baseline.amountIn) - value(swap.intent.buy, swap.baseline.amountOut);
    naiveUnits += swap.baseline.gasUnits;
  }
  if (plan.hedge) {
    units += HEDGE_GAS;
    naiveUnits += HEDGE_GAS;
    txCount += 1;
  }
  const split: CostBreakdown = { bridgeUsd, swapUsd, gasUsd: gasUsd(units, gas, monUsd), totalUsd: 0, txCount };
  split.totalUsd = split.bridgeUsd + split.swapUsd + split.gasUsd;

  // the naive bridge: one move of the same total. use the planner's own naive cost for the rest
  const naiveGas = gasUsd(naiveUnits, gas, monUsd);
  const naiveBridge = Math.max(0, plan.naiveCostUsd - naiveSwapUsd - naiveGas);
  const naive: CostBreakdown = {
    bridgeUsd: bridgeIn > 0n ? naiveBridge : 0,
    swapUsd: naiveSwapUsd,
    gasUsd: naiveGas,
    totalUsd: 0,
    txCount: (bridgeIn > 0n ? 1 : 0) + plan.swaps.length + (plan.hedge ? 1 : 0),
  };
  naive.totalUsd = naive.bridgeUsd + naive.swapUsd + naive.gasUsd;
  return { split, naive };
}

/** a holding's chain family, for display */
export function isMonad(chainId: number): boolean {
  return chainId === 10143 || chainId === 143;
}
