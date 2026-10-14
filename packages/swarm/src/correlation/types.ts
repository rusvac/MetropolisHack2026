// the correlation score's shapes. ported from spidereum apps/desktop/src/lib/correlation/types.ts,
// cut down: no registry class, no recommendations, no privacy level. scores leave the module as 0 to 1
import type { AccountRef } from "../types.ts";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type AlgorithmId =
  | "transfer-links"
  | "balance-similarity"
  | "wallet-concentration"
  | "chain-concentration"
  | "chain-overlap";

export type AlgorithmCategory = "identity" | "balance" | "chain";

/** one holding as the algorithms see it */
export interface Position {
  /** `chainId:account` */
  key: string;
  chainId: number;
  symbol: string;
  usd: number;
  /** amount in whole tokens, when known. the round-number check reads it */
  units?: number;
}

export interface CorrelationConfig {
  /** two accounts are "similar" when their balances differ by this share or less. original: 0.1 */
  balanceSimilarityThreshold: number;
  /** accounts below this share of the total are dust and skip the similarity check. the original used $10, too big for testnet sizes */
  dustShare: number;
}

export const DEFAULT_CONFIG: CorrelationConfig = {
  balanceSimilarityThreshold: 0.1,
  dustShare: 0.005,
};

export interface AnalysisInput {
  positions: Position[];
  totalUsd: number;
  config: CorrelationConfig;
}

/** an algorithm's raw result. the score runs 0 to 100, as in the original */
export interface RawScore {
  score: number;
  confidence: number;
  explanation: string;
  details: Record<string, unknown>;
}

export interface CorrelationAlgorithm {
  id: AlgorithmId;
  name: string;
  category: AlgorithmCategory;
  weight: number;
  analyze(input: AnalysisInput): RawScore;
}

export interface AlgorithmScore {
  id: AlgorithmId;
  name: string;
  category: AlgorithmCategory;
  /** 0 = no pattern, 1 = a strong pattern */
  score: number;
  weight: number;
  confidence: number;
  explanation: string;
  details: Record<string, unknown>;
}

export interface CorrelationScore {
  /** 0 = unlinkable, 1 = linked. 1 - (1 - links) * (1 - patterns) */
  score: number;
  risk: RiskLevel;
  /** share of account pairs that direct transfers join, 0 to 1. one account alone counts as 1 */
  links: number;
  /** weighted mean of the balance and chain algorithms, 0 to 1 */
  patterns: number;
  /** accounts in the analysis: holders, listed accounts, and transfer ends */
  accounts: number;
  /** count of transfers between two different swarm accounts */
  directTransfers: number;
  /** each group of two or more accounts that transfers join */
  clusters: AccountRef[][];
  parts: AlgorithmScore[];
  explanation: string;
}

export function scoreToRiskLevel(score100: number): RiskLevel {
  if (score100 >= 80) return "critical";
  if (score100 >= 60) return "high";
  if (score100 >= 40) return "medium";
  return "low";
}

/** gini coefficient of a distribution, 0 = equal, near 1 = one holder */
export function gini(values: number[]): number {
  const n = values.length;
  const total = values.reduce((s, v) => s + v, 0);
  if (n === 0 || total === 0) return 0;
  let sum = 0;
  for (const a of values) for (const b of values) sum += Math.abs(a - b);
  return sum / (2 * n * total);
}

export function sumBy<K>(positions: Position[], key: (p: Position) => K): Map<K, number> {
  const m = new Map<K, number>();
  for (const p of positions) m.set(key(p), (m.get(key(p)) ?? 0) + p.usd);
  return m;
}
