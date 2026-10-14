import { describe, expect, test } from "bun:test";
import { parseUnits } from "viem";
import type { Holding, Token } from "@spidereum/core";
import { correlationScore, isRoundUnits } from "./index.ts";

const MON: Token = { chainId: 10143, symbol: "MON", address: "0x0000000000000000000000000000000000000000", decimals: 18 };
const USDC_M: Token = { chainId: 10143, symbol: "USDC", address: "0x534b2f3a21130d7a60830c2df862319e593943a3", decimals: 6 };
const USDC_B: Token = { chainId: 84532, symbol: "USDC", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6 };

const h = (account: number, token: Token, units: string, usd: number): Holding => ({
  account,
  token,
  amount: parseUnits(units, token.decimals),
  usd,
});

/** uneven, irregular holdings over 10 monad accounts */
const spread: Holding[] = [
  [812.37, 0], [1104.9, 1], [655.12, 2], [1490.03, 3], [377.41, 4],
  [930.66, 5], [1215.8, 6], [508.27, 7], [1702.55, 8], [743.18, 9],
].map(([usd, i]) => h(i!, USDC_M, String(usd), usd!));

describe("correlationScore", () => {
  test("no accounts scores 0", () => {
    const r = correlationScore({});
    expect(r.score).toBe(0);
    expect(r.accounts).toBe(0);
  });

  test("one account holding everything is linked: score 1", () => {
    const r = correlationScore({ portfolio: { holdings: [h(0, USDC_M, "5000", 5000), h(0, MON, "12.5", 400)] } });
    expect(r.links).toBe(1);
    expect(r.score).toBe(1);
    expect(r.risk).toBe("critical");
  });

  test("spread accounts with no transfers score low, and only from patterns", () => {
    const r = correlationScore({ portfolio: { holdings: spread } });
    expect(r.links).toBe(0);
    expect(r.directTransfers).toBe(0);
    expect(r.clusters).toHaveLength(0);
    expect(r.score).toBe(r.patterns);
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(0.5);
  });

  test("gas from account 0 to every account links them all: score 1", () => {
    const transfers = spread.map((x) => ({ from: { chainId: 10143, account: 0 }, to: { chainId: 10143, account: x.account } }));
    const r = correlationScore({ portfolio: { holdings: spread }, transfers });
    // the self-transfer 0 -> 0 does not count
    expect(r.directTransfers).toBe(9);
    expect(r.links).toBe(1);
    expect(r.score).toBe(1);
    expect(r.clusters).toHaveLength(1);
    expect(r.clusters[0]).toHaveLength(10);
  });

  test("each direct transfer raises the score", () => {
    const base = correlationScore({ portfolio: { holdings: spread } });
    const one = correlationScore({ portfolio: { holdings: spread }, transfers: [{ from: { chainId: 10143, account: 0 }, to: { chainId: 10143, account: 1 } }] });
    const two = correlationScore({
      portfolio: { holdings: spread },
      transfers: [
        { from: { chainId: 10143, account: 0 }, to: { chainId: 10143, account: 1 } },
        { from: { chainId: 10143, account: 0 }, to: { chainId: 10143, account: 2 } },
      ],
    });
    // 1 of 45 pairs, then 3 of 45 pairs
    expect(one.links).toBeCloseTo(1 / 45, 3);
    expect(two.links).toBeCloseTo(3 / 45, 3);
    expect(one.score).toBeGreaterThan(base.score);
    expect(two.score).toBeGreaterThan(one.score);
  });

  test("the same index on two chains is two accounts", () => {
    const r = correlationScore({ portfolio: { holdings: [h(0, USDC_B, "2500", 2500), h(0, USDC_M, "2500", 2500)] } });
    expect(r.accounts).toBe(2);
    expect(r.links).toBe(0);
  });

  test("monad mainnet #3 and monad testnet #3 are one account, so testnet transfers link a plan's mainnet holdings", () => {
    const MON_MAIN: Token = { ...MON, chainId: 143 };
    const r = correlationScore({
      portfolio: { holdings: [h(3, MON_MAIN, "100.37", 3.1), h(4, MON_MAIN, "200.91", 6.2)] },
      transfers: [{ from: { chainId: 10143, account: 3 }, to: { chainId: 10143, account: 4 } }],
    });
    expect(r.accounts).toBe(2);
    expect(r.links).toBe(1);
    expect(r.clusters[0]).toEqual([{ chainId: 143, account: 3 }, { chainId: 143, account: 4 }]);
  });

  test("a bridge that names its receiver links accounts across chains", () => {
    const r = correlationScore({
      portfolio: { holdings: [h(0, USDC_B, "2500", 2500), h(3, USDC_M, "2500", 2500)] },
      transfers: [{ from: { chainId: 84532, account: 0 }, to: { chainId: 10143, account: 3 } }],
    });
    expect(r.links).toBe(1);
    expect(r.score).toBe(1);
  });

  test("the split after a rebalance scores below the naive single account", () => {
    const naive = correlationScore({ portfolio: { holdings: [h(0, MON, "112000.5", 3500), h(0, USDC_M, "1500", 1500)] } });
    const split = correlationScore({ portfolio: { holdings: spread } });
    expect(split.score).toBeLessThan(naive.score);
  });

  test("uniform round balances score higher than irregular ones", () => {
    const uniform = [0, 1, 2, 3, 4, 5].map((i) => h(i, USDC_M, "1000", 1000));
    const u = correlationScore({ portfolio: { holdings: uniform } });
    const s = correlationScore({ portfolio: { holdings: spread } });
    expect(u.patterns).toBeGreaterThan(s.patterns);
    const sim = u.parts.find((p) => p.id === "balance-similarity")!;
    expect(sim.score).toBe(1);
  });

  test("a weight of 0 turns an algorithm off", () => {
    const r = correlationScore({ portfolio: { holdings: spread }, weights: { "chain-concentration": 0 } });
    expect(r.parts.map((p) => p.id)).not.toContain("chain-concentration");
    expect(r.patterns).toBeLessThan(correlationScore({ portfolio: { holdings: spread } }).patterns);
  });

  test("listed accounts that hold nothing still count", () => {
    const r = correlationScore({
      portfolio: { holdings: [h(1, USDC_M, "100.37", 100.37)] },
      accounts: [{ chainId: 10143, account: 2 }, { chainId: 10143, account: 3 }],
    });
    expect(r.accounts).toBe(3);
  });

  test("every score runs 0 to 1", () => {
    const r = correlationScore({ portfolio: { holdings: spread } });
    for (const p of r.parts) {
      expect(p.score).toBeGreaterThanOrEqual(0);
      expect(p.score).toBeLessThanOrEqual(1);
    }
  });
});

describe("isRoundUnits", () => {
  test("hand-picked amounts are round", () => {
    for (const x of [5, 1.2, 0.4, 5000, 20]) expect(isRoundUnits(x)).toBe(true);
  });
  test("amounts after a swap are not round", () => {
    for (const x of [3.760608, 4812.37, 0.123456, 1.23]) expect(isRoundUnits(x)).toBe(false);
  });
});
