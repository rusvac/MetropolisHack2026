// reads live balances on monad testnet and base sepolia. read-only: it sends nothing
import { describe, expect, test } from "bun:test";
import { loadPortfolio } from "./portfolio.ts";

const hasSeed = !!process.env.BURNER_MNEMONIC?.trim();

describe.skipIf(!hasSeed)("loadPortfolio, live", () => {
  test("reads accounts 0 to 9 on monad testnet and base sepolia", async () => {
    const p = await loadPortfolio({ accounts: 10, prices: { MON: 0.03, ETH: 4000, USDC: 1 }, includeZero: true });
    // 10 accounts x 2 tokens x 2 chains
    expect(p.holdings).toHaveLength(40);
    const monUsdc = p.holdings.find((h) => h.token.chainId === 10143 && h.account === 0 && h.token.symbol === "USDC")!;
    // the founder funded monad testnet account 0 with Circle's USDC on 13 oct
    expect(monUsdc.amount).toBeGreaterThan(0n);
    expect(monUsdc.usd).toBeCloseTo(Number(monUsdc.amount) / 1e6, 6);
    expect(p.totalUsd).toBeCloseTo(p.holdings.reduce((s, h) => s + h.usd, 0), 6);
    for (const h of p.holdings.filter((x) => x.amount > 0n)) {
      console.log(`  ${h.token.chainId} #${h.account} ${h.token.symbol} ${h.amount} = $${h.usd.toFixed(4)}`);
    }
  }, 30_000);

  test("one account set per chain", async () => {
    const p = await loadPortfolio({ accounts: { 10143: [0, 1], 84532: 0 }, prices: { USDC: 1 }, includeZero: true });
    expect(p.holdings.every((h) => h.token.chainId === 10143)).toBe(true);
    expect(new Set(p.holdings.map((h) => h.account))).toEqual(new Set([0, 1]));
  }, 30_000);
});
