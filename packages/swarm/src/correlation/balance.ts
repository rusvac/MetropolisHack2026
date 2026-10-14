// balance patterns across accounts. ported from spidereum apps/desktop/src/lib/correlation/algorithms/balance.ts.
// changes: a wallet is one account on one chain, dust is a share of the total, and the round-number
// check reads token amounts (5 USDC, 1.2 MON) when it has them, because testnet dollar values are small
import type { CorrelationAlgorithm, Position } from "./types.ts";
import { gini, sumBy } from "./types.ts";

/** coefficient of variation. lower = more similar balances = higher risk */
function cv(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/** a token amount with two significant digits or fewer: 5, 1.2, 0.4, 5000 */
export function isRoundUnits(units: number): boolean {
  if (!(units > 0)) return false;
  const r = Number(units.toPrecision(2));
  return Math.abs(r - units) / units < 1e-9;
}

/** the original's check, on a dollar value */
function isRoundUsd(value: number): boolean {
  for (const t of [1000, 500, 100, 50, 10]) if (value >= t && value % t < t * 0.01) return true;
  return false;
}

function hasRoundHolding(positions: Position[]): boolean {
  return positions.some((p) => (p.units !== undefined ? isRoundUnits(p.units) : isRoundUsd(p.usd)));
}

export const balanceSimilarityAlgorithm: CorrelationAlgorithm = {
  id: "balance-similarity",
  name: "balance similarity",
  category: "balance",
  weight: 0.2,
  analyze({ positions, totalUsd, config }) {
    const byAccount = sumBy(positions, (p) => p.key);
    const dust = totalUsd * config.dustShare;
    const kept = [...byAccount.entries()].filter(([, v]) => v > dust);
    if (kept.length < 2) {
      return { score: 0, confidence: 0.5, explanation: "fewer than 2 accounts hold funds", details: { accounts: kept.length } };
    }
    const values = kept.map(([, v]) => v);
    const c = cv(values);

    let pairs = 0;
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        const a = values[i]!;
        const b = values[j]!;
        if (Math.abs(a - b) / ((a + b) / 2) <= config.balanceSimilarityThreshold) pairs++;
      }
    }
    const maxPairs = (values.length * (values.length - 1)) / 2;
    const round = kept.filter(([key]) => hasRoundHolding(positions.filter((p) => p.key === key))).length;

    let score = 0;
    // factor 1: low variation (0 to 50)
    if (c < 0.1) score += 50;
    else if (c < 0.25) score += 35;
    else if (c < 0.5) score += 20;
    else if (c < 0.75) score += 10;
    // factor 2: similar pairs (0 to 30)
    score += Math.round((pairs / maxPairs) * 30);
    // factor 3: round amounts (0 to 20)
    score += Math.round((round / kept.length) * 20);
    score = Math.min(100, score);

    return {
      score,
      confidence: 0.85,
      explanation: `${pairs} of ${maxPairs} account pairs hold similar balances, ${round} of ${kept.length} accounts hold a round amount`,
      details: { coefficientOfVariation: Math.round(c * 1000) / 1000, similarPairs: pairs, roundAccounts: round },
    };
  },
};

export const walletConcentrationAlgorithm: CorrelationAlgorithm = {
  id: "wallet-concentration",
  name: "account concentration",
  category: "balance",
  weight: 0.15,
  analyze({ positions, totalUsd }) {
    const byAccount = sumBy(positions, (p) => p.key);
    const count = byAccount.size;
    if (count === 0 || totalUsd === 0) {
      return { score: 0, confidence: 0.5, explanation: "no account holds funds", details: { accounts: 0 } };
    }
    const sorted = [...byAccount.entries()].sort((a, b) => b[1] - a[1]);
    const [topKey, topValue] = sorted[0]!;
    const topPct = (topValue / totalUsd) * 100;
    const top3Pct = (sorted.slice(0, 3).reduce((s, [, v]) => s + v, 0) / totalUsd) * 100;
    const g = gini(sorted.map(([, v]) => v));

    let score = 0;
    // factor 1: the top account's share (0 to 40)
    if (topPct >= 80) score += 40;
    else if (topPct >= 60) score += 30;
    else if (topPct >= 40) score += 20;
    else if (topPct >= 25) score += 10;
    // factor 2: the top three accounts' share (0 to 30)
    if (top3Pct >= 95) score += 30;
    else if (top3Pct >= 85) score += 20;
    else if (top3Pct >= 70) score += 10;
    // factor 3: few accounts (0 to 20)
    if (count === 1) score += 20;
    else if (count === 2) score += 15;
    else if (count <= 4) score += 10;
    else if (count <= 6) score += 5;
    // factor 4: inequality (0 to 10)
    score += Math.round(g * 10);
    score = Math.min(100, score);

    return {
      score,
      confidence: 0.9,
      explanation: `account ${topKey} holds ${topPct.toFixed(0)}% of the total, over ${count} accounts`,
      details: { accounts: count, topAccount: topKey, topPct: Math.round(topPct * 10) / 10, top3Pct: Math.round(top3Pct * 10) / 10, gini: Math.round(g * 1000) / 1000 },
    };
  },
};

export const balanceAlgorithms = [balanceSimilarityAlgorithm, walletConcentrationAlgorithm];
