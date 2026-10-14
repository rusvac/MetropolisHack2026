// beat 7: what an observer can link. the largest single move as a share of the total, the
// correlation score before and after, and the count of direct transfers between swarm accounts
import type { Portfolio, RebalancePlan } from "../../packages/core/src/index.ts";
import { toNumber } from "./format.ts";
import type { Prices } from "./plan-math.ts";
import { movesOf } from "./run.ts";
import { execToken } from "./tokens.ts";

/** holdings on the testnets: a mainnet quote token maps to its testnet twin, so one account is one wallet */
export function onTestnets(p: Portfolio): Portfolio {
  const known = p.holdings.map((h) => h.token);
  return { ...p, holdings: p.holdings.map((h) => ({ ...h, token: execToken(h.token, known) })) };
}

export interface Transfer {
  from: { chainId: number; account: number };
  to: { chainId: number; account: number };
}

/** a correlation score, 0 (nothing to link) to 100 (linked). transfers between swarm accounts are links */
export type CorrelationFn = (p: Portfolio, transfers?: Transfer[]) => number;

/**
 * the stand-in correlation score, 0 (nothing to link) to 90 (one account holds it all). a port of the
 * wallet-concentration algorithm from spidereum's desktop analyzer
 * (apps/desktop/src/lib/correlation/algorithms/balance.ts). an account on base and an account on
 * monad count as two wallets, because they have different addresses
 */
export function walletConcentration(p: Portfolio, _transfers?: Transfer[]): number {
  const byWallet = new Map<string, number>();
  for (const h of p.holdings) {
    if (h.usd <= 0) continue;
    const k = `${h.token.chainId}:${h.account}`;
    byWallet.set(k, (byWallet.get(k) ?? 0) + h.usd);
  }
  const total = [...byWallet.values()].reduce((a, b) => a + b, 0);
  const n = byWallet.size;
  if (n === 0 || total === 0) return 0;
  const sorted = [...byWallet.values()].sort((a, b) => b - a);
  const topPct = (sorted[0]! / total) * 100;
  const top3Pct = (sorted.slice(0, 3).reduce((a, b) => a + b, 0) / total) * 100;
  let gini = 0;
  if (n > 1) {
    let diff = 0;
    for (const a of sorted) for (const b of sorted) diff += Math.abs(a - b);
    gini = diff / (2 * n * total);
  }
  let score = 0;
  score += topPct >= 80 ? 40 : topPct >= 60 ? 30 : topPct >= 40 ? 20 : topPct >= 25 ? 10 : 0;
  score += top3Pct >= 95 ? 30 : top3Pct >= 85 ? 20 : top3Pct >= 70 ? 10 : 0;
  score += n === 1 ? 20 : n === 2 ? 15 : n <= 4 ? 10 : n <= 6 ? 5 : 0;
  score += Math.round(gini * 10);
  return Math.min(100, Math.round(score));
}

/** the naive end state: the base USDC stays in one base account, and one monad account holds the rest */
export function naiveAfter(plan: RebalancePlan): Portfolio {
  const byChain = new Map<number, typeof plan.after.holdings>();
  for (const h of onTestnets(plan.after).holdings) byChain.set(h.token.chainId, [...(byChain.get(h.token.chainId) ?? []), h]);
  const holdings = [...byChain.values()].flatMap((hs) => {
    const bySymbol = new Map<string, (typeof hs)[number]>();
    for (const h of hs) {
      const prev = bySymbol.get(h.token.symbol);
      bySymbol.set(h.token.symbol, prev ? { ...prev, amount: prev.amount + h.amount, usd: prev.usd + h.usd } : { ...h, account: 0 });
    }
    return [...bySymbol.values()];
  });
  return { holdings, totalUsd: plan.after.totalUsd, at: plan.after.at };
}

export interface Linkability {
  largestMove: {
    /** the largest bridge or slice, as a share of the rebalance */
    split: number;
    splitUsd: number;
    /** one bridge and one trade: the whole size in one move */
    naive: number;
    totalUsd: number;
  };
  correlation: { before: number; after: number; naiveAfter: number; source: string };
  directTransfers: {
    /** transfers the plan makes from one swarm account to another. the planner keeps this at 0 */
    planned: number;
    /** monad accounts that send but hold no MON for gas. each needs a top-up from account 0 */
    gasTopUps: number[];
    total: number;
  };
}

export interface LinkOptions {
  prices: Prices;
  /** the portfolio after the run. defaults to the plan's projection */
  after?: Portfolio;
  correlation?: CorrelationFn;
  correlationSource?: string;
  /** gas top-ups the swarm made, when it reports them. otherwise counted from the plan */
  gasTopUps?: number[];
}

export function linkability(plan: RebalancePlan, opts: LinkOptions): Linkability {
  const moves = movesOf(plan).filter((m) => m.kind !== "hedge");
  const usdOf = (symbol: string, amount: bigint, decimals: number) => toNumber(amount, decimals) * (opts.prices[symbol] ?? 0);
  const bridgeUsd = moves.filter((m) => m.kind === "bridge").map((m) => usdOf(m.sell.symbol, m.amountIn, m.sell.decimals));
  const swapUsd = moves.filter((m) => m.kind === "swap").map((m) => usdOf(m.sell.symbol, m.amountIn, m.sell.decimals));
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const totalUsd = Math.max(sum(bridgeUsd), sum(swapUsd));
  const largest = Math.max(0, ...bridgeUsd, ...swapUsd);

  // a monad account that sends a slice or the hedge needs MON for gas. if it held none before
  // and the plan gives it none, account 0 tops it up, and that transfer links the two accounts
  const holdsMon = new Set(plan.before.holdings.filter((h) => h.token.symbol === "MON" && h.amount > 0n).map((h) => h.account));
  const senders = new Set(movesOf(plan).filter((m) => m.kind !== "bridge").map((m) => m.account));
  const gasTopUps = opts.gasTopUps ?? [...senders].filter((a) => !holdsMon.has(a)).sort((a, b) => a - b);

  const score = opts.correlation ?? walletConcentration;
  const topUps: Transfer[] = gasTopUps.map((a) => ({ from: { chainId: 10143, account: 0 }, to: { chainId: 10143, account: a } }));
  return {
    largestMove: { split: totalUsd ? largest / totalUsd : 0, splitUsd: largest, naive: 1, totalUsd },
    correlation: {
      before: score(onTestnets(plan.before)),
      after: score(onTestnets(opts.after ?? plan.after), topUps),
      naiveAfter: score(naiveAfter(plan)),
      source: opts.correlationSource ?? "stand-in: wallet concentration, ported from spidereum's analyzer",
    },
    directTransfers: { planned: plan.directTransfers, gasTopUps, total: plan.directTransfers + gasTopUps.length },
  };
}
