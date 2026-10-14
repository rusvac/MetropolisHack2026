// chain patterns. ported from spidereum apps/desktop/src/lib/correlation/algorithms/chain.ts.
// changes: no privacy-level multiplier, and the asset count is the count of distinct symbols
import type { CorrelationAlgorithm } from "./types.ts";
import { gini, sumBy } from "./types.ts";

export const chainConcentrationAlgorithm: CorrelationAlgorithm = {
  id: "chain-concentration",
  name: "chain concentration",
  category: "chain",
  weight: 0.2,
  analyze({ positions, totalUsd }) {
    const byChain = sumBy(positions, (p) => p.chainId);
    const used = byChain.size;
    if (used === 0 || totalUsd === 0) {
      return { score: 0, confidence: 0.5, explanation: "no chain holds funds", details: { chains: 0 } };
    }
    let dominant = 0;
    let dominantPct = 0;
    const distribution: Record<number, number> = {};
    for (const [chainId, v] of byChain) {
      const pct = (v / totalUsd) * 100;
      distribution[chainId] = Math.round(pct * 10) / 10;
      if (pct > dominantPct) {
        dominantPct = pct;
        dominant = chainId;
      }
    }
    const g = gini([...byChain.values()]);

    let score = 0;
    // factor 1: the dominant chain's share (0 to 50)
    if (dominantPct >= 90) score += 50;
    else if (dominantPct >= 70) score += 35;
    else if (dominantPct >= 50) score += 20;
    else if (dominantPct >= 30) score += 10;
    // factor 2: few chains (0 to 30)
    if (used === 1) score += 30;
    else if (used === 2) score += 20;
    else if (used === 3) score += 10;
    else if (used <= 5) score += 5;
    // factor 3: inequality (0 to 20)
    score += Math.round(g * 20);
    score = Math.min(100, score);

    return {
      score,
      confidence: 0.9,
      explanation: `chain ${dominant} holds ${dominantPct.toFixed(0)}% of the value, over ${used} chain(s)`,
      details: { distribution, dominantChain: dominant, chains: used, gini: Math.round(g * 1000) / 1000 },
    };
  },
};

export const chainOverlapAlgorithm: CorrelationAlgorithm = {
  id: "chain-overlap",
  name: "chain overlap",
  category: "chain",
  weight: 0.15,
  analyze({ positions }) {
    const chainsBySymbol = new Map<string, Set<number>>();
    for (const p of positions) {
      if (p.usd <= 0) continue;
      const s = chainsBySymbol.get(p.symbol) ?? new Set<number>();
      s.add(p.chainId);
      chainsBySymbol.set(p.symbol, s);
    }
    const overlapping = [...chainsBySymbol.entries()].filter(([, s]) => s.size > 1).map(([sym]) => sym);
    const ratio = chainsBySymbol.size > 0 ? overlapping.length / chainsBySymbol.size : 0;
    const score = Math.min(100, Math.round(ratio * 60) + Math.min(40, overlapping.length * 10));
    return {
      score,
      confidence: 0.85,
      explanation: overlapping.length > 0 ? `${overlapping.join(", ")} sits on more than one chain` : "no token sits on two chains",
      details: { overlapping, assets: chainsBySymbol.size },
    };
  },
};

export const chainAlgorithms = [chainConcentrationAlgorithm, chainOverlapAlgorithm];
