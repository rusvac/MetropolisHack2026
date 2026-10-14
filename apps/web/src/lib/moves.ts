// one flat list of moves from a RebalancePlan: bridges, swap slices, and the hedge.
// the plan screen, the timeline, and the observer screen all read this list
import type { Holding, Portfolio, RebalancePlan, Token, VenueId } from "@spidereum/core";
import { chainIdFromName, toUnits } from "./format.ts";
import type { DemoPlan, MoveKind } from "./types.ts";

export interface Move {
  /** `bridge-<i>`, `swap-<planIndex>-<sliceIndex>`, `hedge` */
  id: string;
  kind: MoveKind;
  venue: VenueId;
  /** the sending account, on `chainId`. undefined for the hedge when the plan does not name one */
  account?: number;
  /** the chain the move executes on */
  chainId: number;
  /** bridges: the receiving monad account */
  toAccount?: number;
  toChainId?: number;
  /** the chain the quote came from */
  quoteChainId: number;
  symbolIn: string;
  symbolOut: string;
  amountIn: number;
  amountOut: number;
  decimalsIn: number;
  decimalsOut: number;
  usd: number;
  delayMs: number;
  simulated: boolean;
}

/** usd per unit for each symbol: the server's prices, else from the balances, else from the quotes */
export function prices(plan: DemoPlan): Record<string, number> {
  const out: Record<string, number> = { USDC: 1, AUSD: 1, ...(plan.prices ?? {}) };
  const sums = new Map<string, { usd: number; units: number }>();
  for (const h of plan.before.holdings) {
    const units = toUnits(h.amount, h.token.decimals);
    if (units <= 0 || h.usd <= 0) continue;
    const s = sums.get(h.token.symbol) ?? { usd: 0, units: 0 };
    s.usd += h.usd;
    s.units += units;
    sums.set(h.token.symbol, s);
  }
  for (const [sym, s] of sums) if (out[sym] === undefined) out[sym] = s.usd / s.units;
  for (const p of plan.swaps) {
    const buy = p.intent.buy.symbol;
    const sell = p.intent.sell.symbol;
    const outUnits = toUnits(p.baseline.amountOut, p.baseline.buy.decimals);
    const inUnits = toUnits(p.baseline.amountIn, p.baseline.sell.decimals);
    if (out[buy] === undefined && out[sell] !== undefined && outUnits > 0) out[buy] = (inUnits * out[sell]!) / outUnits;
    if (out[sell] === undefined && out[buy] !== undefined && inUnits > 0) out[sell] = (outUnits * out[buy]!) / inUnits;
  }
  return out;
}

export function usdOf(sym: string, units: number, px: Record<string, number>): number {
  return units * (px[sym] ?? 0);
}

/** the execution chain for a swap plan: the token's chain, with mainnet mapped to its testnet */
export function execChain(t: Token): number {
  if (t.chainId === 143) return 10143;
  if (t.chainId === 8453) return 84532;
  return t.chainId;
}

export function planMoves(plan: DemoPlan): Move[] {
  const px = prices(plan);
  const moves: Move[] = [];

  plan.bridges.forEach((b, i) => {
    const q = b.quote;
    const amountIn = toUnits(q.amountIn, q.to.decimals);
    const amountOut = toUnits(q.amountOut, q.to.decimals);
    const quoteFrom = chainIdFromName(q.fromChain) ?? 8453;
    moves.push({
      id: `bridge-${i}`,
      kind: "bridge",
      venue: q.venue,
      account: b.fromAccount,
      chainId: quoteFrom === 8453 ? 84532 : quoteFrom,
      toAccount: b.toAccount,
      toChainId: execChain(q.to),
      quoteChainId: quoteFrom,
      symbolIn: q.fromToken,
      symbolOut: q.to.symbol,
      amountIn,
      amountOut,
      decimalsIn: q.to.decimals,
      decimalsOut: q.to.decimals,
      usd: usdOf(q.fromToken, amountIn, px),
      delayMs: b.delayMs,
      simulated: q.simulated,
    });
  });

  plan.swaps.forEach((p, s) => {
    const sell = p.intent.sell;
    const buy = p.intent.buy;
    p.slices.forEach((sl, k) => {
      const amountIn = toUnits(sl.amountIn, sell.decimals);
      moves.push({
        id: `swap-${s}-${k}`,
        kind: "swap",
        venue: sl.venue,
        account: sl.account,
        chainId: execChain(sell),
        quoteChainId: p.baseline.sell.chainId,
        symbolIn: sell.symbol,
        symbolOut: buy.symbol,
        amountIn,
        amountOut: toUnits(sl.expectedOut, buy.decimals),
        decimalsIn: sell.decimals,
        decimalsOut: buy.decimals,
        usd: usdOf(sell.symbol, amountIn, px),
        delayMs: sl.delayMs,
        simulated: p.baseline.simulated,
      });
    });
  });

  const hedge = plan.hedge ?? plan.swaps.find((p) => p.hedge)?.hedge;
  if (hedge) {
    const sym = hedge.market.split(/[-/]/)[0] || "MON";
    const units = toUnits(hedge.size, 18);
    const lastSlice = Math.max(0, ...moves.map((m) => m.delayMs));
    moves.push({
      id: "hedge",
      kind: "hedge",
      venue: hedge.venue,
      chainId: 10143,
      quoteChainId: 143,
      symbolIn: sym,
      symbolOut: sym,
      amountIn: units,
      amountOut: units,
      decimalsIn: 18,
      decimalsOut: 18,
      usd: units * hedge.markPrice,
      delayMs: lastSlice + 400,
      simulated: hedge.simulated,
    });
  }

  return moves.sort((a, b) => a.delayMs - b.delayMs);
}

export interface AccountTotal {
  chainId: number;
  account: number;
  usd: number;
  bySymbol: Record<string, number>;
}

/** usd per account and chain, in a stable order: monad accounts first, then base */
export function accountTotals(p: Portfolio): AccountTotal[] {
  const map = new Map<string, AccountTotal>();
  for (const h of p.holdings) {
    // a mainnet token in a projection lives in the same testnet account
    const chainId = execChain(h.token);
    const key = `${chainId}:${h.account}`;
    const t = map.get(key) ?? { chainId, account: h.account, usd: 0, bySymbol: {} };
    t.usd += h.usd;
    t.bySymbol[h.token.symbol] = (t.bySymbol[h.token.symbol] ?? 0) + h.usd;
    map.set(key, t);
  }
  return [...map.values()].sort((a, b) => order(a.chainId) - order(b.chainId) || a.account - b.account);
}

function order(chainId: number): number {
  return chainId === 10143 || chainId === 143 ? 0 : 1;
}

export function symbolTotals(p: Portfolio): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of p.holdings) out[h.token.symbol] = (out[h.token.symbol] ?? 0) + h.usd;
  return out;
}

export function chainTotals(p: Portfolio): Record<number, number> {
  const out: Record<number, number> = {};
  for (const h of p.holdings) out[execChain(h.token)] = (out[execChain(h.token)] ?? 0) + h.usd;
  return out;
}

export function holdingUnits(h: Holding): number {
  return toUnits(h.amount, h.token.decimals);
}

export function targetWeight(plan: RebalancePlan, symbol: string): number | undefined {
  return plan.intent.targets.find((t) => t.symbol === symbol)?.weight;
}
