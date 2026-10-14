// beat 7: what an observer can link. the largest single move, the correlation score, and the
// direct transfers between swarm accounts. the server's score wins. without it, the browser
// estimates one from the plan and labels it simulated
import type { Portfolio } from "@spidereum/core";
import type { Move } from "./moves.ts";
import { accountTotals } from "./moves.ts";
import type { DemoPlan } from "./types.ts";

export type RiskLevel = "low" | "medium" | "high" | "critical";

/** the thresholds of the original analyzer (spidereum desktop, lib/correlation/types.ts) */
export function riskLevel(score: number): RiskLevel {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 40) return "medium";
  return "low";
}

export const RISK_COLOR: Record<RiskLevel, string> = {
  low: "#34d399",
  medium: "#fbbf24",
  high: "#fb923c",
  critical: "#f87171",
};

/** the largest account's share of the portfolio */
export function concentration(p: Portfolio): number {
  if (p.totalUsd <= 0) return 0;
  const max = Math.max(0, ...accountTotals(p).map((a) => a.usd));
  return max / p.totalUsd;
}

export interface ScoreInput {
  concentration: number;
  largestMoveShare: number;
  accounts: number;
  directTransfers: number;
}

/** a rough score, 0 to 100, higher = easier to link. only for when the server sends none */
export function estimateScore(i: ScoreInput): number {
  const accounts = Math.max(1, i.accounts);
  const transfers = Math.min(1, i.directTransfers / Math.max(1, accounts - 1));
  const raw = 0.4 * i.concentration + 0.3 * i.largestMoveShare + 0.15 * transfers + 0.15 * (1 / accounts);
  return Math.round(Math.min(1, Math.max(0, raw)) * 100);
}

export interface Linkability {
  /** the denominator of the shares */
  total: number;
  totalLabel: string;
  largest: { move?: Move; usd: number; share: number };
  naiveLargest: { usd: number; share: number; label: string };
  accounts: number;
  venues: number;
  transactions: number;
  directTransfers: number;
  /** monad accounts that got MON for gas from account 0 */
  gasTopUps: number[];
  scores: { label: string; score: number }[];
  scoreSimulated: boolean;
  scoreSource?: string;
}

export function linkability(plan: DemoPlan, moves: Move[]): Linkability {
  const server = plan.linkability;
  const sized = moves.filter((m) => m.kind === "bridge" || m.kind === "swap");
  let largest: Move | undefined;
  for (const m of sized) if (!largest || m.usd > largest.usd) largest = m;

  const bridgeUsd = moves.filter((m) => m.kind === "bridge").reduce((s, m) => s + m.usd, 0);
  const swapUsd = moves.filter((m) => m.kind === "swap").reduce((s, m) => s + m.usd, 0);
  const naive = bridgeUsd >= swapUsd ? { usd: bridgeUsd, label: "one bridge" } : { usd: swapUsd, label: "one trade" };

  const accountKeys = new Set<string>();
  for (const m of moves) {
    if (m.account !== undefined) accountKeys.add(`${m.chainId}:${m.account}`);
    if (m.toAccount !== undefined) accountKeys.add(`${m.toChainId}:${m.toAccount}`);
  }
  const venues = new Set(moves.map((m) => m.venue)).size;

  // the rebalance's size: everything that moves, counted once (bridged dollars are then swapped)
  const total = server?.largestMove.totalUsd || Math.max(bridgeUsd, swapUsd) || plan.before.totalUsd || 1;
  const largestUsd = server?.largestMove.splitUsd ?? largest?.usd ?? 0;
  const largestShare = server?.largestMove.split ?? largestUsd / total;
  const naiveShare = server?.largestMove.naive ?? naive.usd / total;

  let scores: Linkability["scores"];
  let scoreSimulated: boolean;
  if (server) {
    scores = [
      { label: "now", score: server.correlation.before },
      { label: "after, one trade", score: server.correlation.naiveAfter },
      { label: "after, split over the swarm", score: server.correlation.after },
    ];
    scoreSimulated = plan.correlation?.simulated ?? false;
  } else if (plan.correlation) {
    scores = [
      { label: "before", score: plan.correlation.before },
      ...(plan.correlation.naive !== undefined ? [{ label: "after, one trade", score: plan.correlation.naive }] : []),
      { label: "after, split over the swarm", score: plan.correlation.after },
    ];
    scoreSimulated = plan.correlation.simulated ?? false;
  } else {
    scores = [
      { label: "now", score: estimateScore({ concentration: concentration(plan.before), largestMoveShare: 0, accounts: accountTotals(plan.before).length, directTransfers: 0 }) },
      { label: "after, one trade", score: estimateScore({ concentration: 1, largestMoveShare: naiveShare, accounts: 1, directTransfers: 0 }) },
      {
        label: "after, split over the swarm",
        score: estimateScore({ concentration: concentration(plan.after), largestMoveShare: largestShare, accounts: accountKeys.size, directTransfers: plan.directTransfers }),
      },
    ];
    scoreSimulated = true;
  }

  return {
    total,
    totalLabel: "rebalance",
    largest: { move: largest, usd: largestUsd, share: largestShare },
    naiveLargest: { usd: naiveShare * total, share: naiveShare, label: naive.label },
    accounts: accountKeys.size,
    venues,
    transactions: moves.length,
    directTransfers: server?.directTransfers.total ?? plan.directTransfers,
    gasTopUps: server?.directTransfers.gasTopUps ?? [],
    scores,
    scoreSimulated,
    scoreSource: server?.correlation.source,
  };
}
