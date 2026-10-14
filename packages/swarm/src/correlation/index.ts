// the correlation score: how well an observer can link a list of swarm accounts, from 0 (unlinkable) to 1 (linked).
// ported from spidereum apps/desktop/src/lib/correlation/analyzer.ts, cut down to one function.
//
// two parts:
// - links: direct transfers between swarm accounts. a transfer joins two accounts for any observer, so the
//   share of account pairs that transfers join is a floor on the score. new here, the original had no transfers
// - patterns: the original's balance and chain algorithms, as a weighted mean (weight times confidence)
// score = 1 - (1 - links) * (1 - patterns). as a result, accounts that transfers join all score 1
import type { Holding, Portfolio } from "@spidereum/core";
import { formatUnits } from "viem";
import { accountKey } from "../types.ts";
import type { AccountRef } from "../types.ts";
import { balanceAlgorithms } from "./balance.ts";
import { chainAlgorithms } from "./chain.ts";
import { DEFAULT_CONFIG, scoreToRiskLevel } from "./types.ts";
import type { AlgorithmId, AlgorithmScore, CorrelationAlgorithm, CorrelationConfig, CorrelationScore, Position } from "./types.ts";

export * from "./types.ts";
export { balanceAlgorithms, balanceSimilarityAlgorithm, walletConcentrationAlgorithm, isRoundUnits } from "./balance.ts";
export { chainAlgorithms, chainConcentrationAlgorithm, chainOverlapAlgorithm } from "./chain.ts";

export const patternAlgorithms: CorrelationAlgorithm[] = [...chainAlgorithms, ...balanceAlgorithms];

export interface CorrelationInput {
  /** the holdings to score, for example from `loadPortfolio` or a plan's `after` */
  portfolio?: Pick<Portfolio, "holdings">;
  /** accounts to count even when they hold nothing */
  accounts?: AccountRef[];
  /** transfers between swarm accounts. a transfer with the same account at both ends is ignored */
  transfers?: { from: AccountRef; to: AccountRef }[];
  /** weight per algorithm. 0 turns one off. "transfer-links" has no weight, it is the floor */
  weights?: Partial<Record<AlgorithmId, number>>;
  config?: Partial<CorrelationConfig>;
}

function toPosition(h: Holding): Position {
  return {
    key: accountKey({ chainId: h.token.chainId, account: h.account }),
    chainId: h.token.chainId,
    symbol: h.token.symbol,
    usd: h.usd,
    units: Number(formatUnits(h.amount, h.token.decimals)),
  };
}

/** groups of accounts that transfers join (union-find) */
function linkClusters(nodes: Set<string>, edges: [string, string][]): string[][] {
  const parent = new Map<string, string>();
  for (const n of nodes) parent.set(n, n);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const [a, b] of edges) parent.set(find(a), find(b));
  const groups = new Map<string, string[]>();
  for (const n of nodes) {
    const r = find(n);
    groups.set(r, [...(groups.get(r) ?? []), n]);
  }
  return [...groups.values()];
}

const pairs = (n: number) => (n * (n - 1)) / 2;

/** scores a list of accounts and their transfers from 0 (unlinkable) to 1 (linked) */
export function correlationScore(input: CorrelationInput): CorrelationScore {
  const config = { ...DEFAULT_CONFIG, ...input.config };
  const holdings = (input.portfolio?.holdings ?? []).filter((h) => h.amount > 0n);
  const positions = holdings.map(toPosition);
  const totalUsd = positions.reduce((s, p) => s + p.usd, 0);

  // links. a node is an account identity (its derivation path). `refs` keeps one AccountRef per node for the output
  const refs = new Map<string, AccountRef>();
  const add = (ref: AccountRef) => {
    const key = accountKey(ref);
    if (!refs.has(key)) refs.set(key, ref);
    return key;
  };
  for (const h of holdings) if (h.usd > 0) add({ chainId: h.token.chainId, account: h.account });
  for (const a of input.accounts ?? []) add(a);
  const edges: [string, string][] = [];
  for (const t of input.transfers ?? []) {
    const a = add(t.from);
    const b = add(t.to);
    if (a !== b) edges.push([a, b]);
  }
  const nodes = new Set(refs.keys());
  const groups = linkClusters(nodes, edges);
  const n = nodes.size;
  const links = n === 0 ? 0 : n === 1 ? 1 : groups.reduce((s, g) => s + pairs(g.length), 0) / pairs(n);
  const clusters = groups.filter((g) => g.length > 1).map((g) => g.map((key) => refs.get(key)!));

  const linkPart: AlgorithmScore = {
    id: "transfer-links",
    name: "transfer links",
    category: "identity",
    score: links,
    weight: 1,
    confidence: 1,
    explanation:
      n <= 1
        ? `${n} account: nothing to split`
        : `${edges.length} direct transfer(s) join ${clusters.reduce((s, g) => s + g.length, 0)} of ${n} accounts in ${clusters.length} group(s)`,
    details: { directTransfers: edges.length, accounts: n, clusters: clusters.length },
  };

  // patterns
  const parts: AlgorithmScore[] = [linkPart];
  let weighted = 0;
  let totalWeight = 0;
  for (const alg of patternAlgorithms) {
    const weight = input.weights?.[alg.id] ?? alg.weight;
    if (weight <= 0) continue;
    const raw = alg.analyze({ positions, totalUsd, config });
    parts.push({ id: alg.id, name: alg.name, category: alg.category, score: raw.score / 100, weight, confidence: raw.confidence, explanation: raw.explanation, details: raw.details });
    weighted += raw.score * weight * raw.confidence;
    totalWeight += weight * raw.confidence;
  }
  const patterns = positions.length === 0 || totalWeight === 0 ? 0 : weighted / totalWeight / 100;

  const score = n === 0 ? 0 : 1 - (1 - links) * (1 - patterns);
  return {
    score: Math.round(score * 1000) / 1000,
    risk: scoreToRiskLevel(score * 100),
    links: Math.round(links * 1000) / 1000,
    patterns: Math.round(patterns * 1000) / 1000,
    accounts: n,
    directTransfers: edges.length,
    clusters,
    parts,
    explanation: `${linkPart.explanation}. balance and chain patterns score ${patterns.toFixed(2)}`,
  };
}
