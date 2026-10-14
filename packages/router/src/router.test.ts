import { describe, expect, test } from "bun:test";
import type { BridgeVenue, Intent, PerpVenue, Portfolio, SpotVenue, Token } from "@spidereum/core";
// the router package does not depend on @spidereum/venues, so the test reaches the mock by path
import { createMockVenue } from "../../venues/src/mock/index.ts";
import { plan, rebalance, replan } from "./index.ts";

const usdc: Token = { chainId: 143, symbol: "USDC", address: "0x0000000000000000000000000000000000000001", decimals: 6 };
const mon: Token = { chainId: 143, symbol: "MON", address: "0x0000000000000000000000000000000000000000", decimals: 18 };
const baseUsdc: Token = { chainId: 84532, symbol: "USDC", address: "0x0000000000000000000000000000000000000003", decimals: 6 };
const baseEth: Token = { chainId: 84532, symbol: "ETH", address: "0x0000000000000000000000000000000000000000", decimals: 18 };
const USD = 10n ** 6n;
const MON = 10n ** 18n;

/** createMockVenue ignores direction, so a pair holds one pool per direction. 1 MON = $0.03 in both */
function pair(name: string, usdReserve: bigint, feeBps = 30, gasUnits?: bigint): SpotVenue {
  const monReserve = (usdReserve * MON * 100n) / (3n * USD);
  const buy = createMockVenue({ name, reserveIn: usdReserve, reserveOut: monReserve, feeBps, gasUnits });
  const sell = createMockVenue({ name, reserveIn: monReserve, reserveOut: usdReserve, feeBps, gasUnits });
  return { id: buy.id, kind: "spot", quote: (req) => (req.sell.symbol === "USDC" ? buy : sell).quote(req) };
}

const perp: PerpVenue = {
  id: "perpl",
  kind: "perp",
  quoteHedge: async (token, size) => ({ venue: "perpl", market: `${token.symbol}-USD`, size, markPrice: 0.03, simulated: true, at: 0 }),
};

/** 10 bps of the amount, nothing fixed */
const bridge: BridgeVenue = {
  id: "aurora",
  kind: "bridge",
  quoteBridge: async (req, to) => ({
    venue: "aurora",
    fromChain: req.fromChain,
    fromToken: req.fromToken,
    amountIn: req.amount,
    amountOut: (req.amount * 9_990n) / 10_000n,
    to,
    simulated: true,
    at: 0,
  }),
};

const intent = (amountIn: bigint, privacyWeight: number, extra: Partial<Intent> = {}): Intent => ({
  id: "test-swap",
  sell: usdc,
  buy: mon,
  amountIn,
  maxSlippageBps: 50,
  privacyWeight,
  ...extra,
});

const sumIn = (xs: { amountIn: bigint }[]) => xs.reduce((s, x) => s + x.amountIn, 0n);

describe("plan", () => {
  const deep = pair("deep", 300_000n * USD);
  const shallow = pair("shallow", 150_000n * USD);

  test("the split gets more out than the full size at the best single venue", async () => {
    const p = await plan(intent(20_000n * USD, 0), [deep, shallow]);
    expect(p.baseline.venue).toBe("mock-deep");
    expect(p.baseline.amountIn).toBe(20_000n * USD);
    expect(p.expectedOut).toBeGreaterThan(p.baseline.amountOut);
    expect(new Set(p.slices.map((s) => s.venue))).toEqual(new Set(["mock-deep", "mock-shallow"]));
    expect(sumIn(p.slices)).toBe(20_000n * USD);
    expect(p.slices.reduce((s, x) => s + x.expectedOut, 0n)).toBe(p.expectedOut);
    // the deeper pool takes about two thirds
    const atDeep = sumIn(p.slices.filter((s) => s.venue === "mock-deep"));
    expect(Number(atDeep) / Number(20_000n * USD)).toBeCloseTo(2 / 3, 1);
  });

  test("privacyWeight 0 sends one slice per venue, and 1 sends maxSlices smaller slices", async () => {
    const cheap = await plan(intent(20_000n * USD, 0), [deep, shallow]);
    const quiet = await plan(intent(20_000n * USD, 1), [deep, shallow], { maxSlices: 12 });
    expect(cheap.slices).toHaveLength(2);
    expect(quiet.slices).toHaveLength(12);
    expect(quiet.largestSliceShare).toBeLessThan(cheap.largestSliceShare);
    // sizes vary by up to 20% either way, so the largest of 12 is at most 1.2 / (1.2 + 11 * 0.8)
    expect(quiet.largestSliceShare).toBeLessThanOrEqual(0.121);
    expect(quiet.gasUnits).toBe(12n * 150_000n);
    expect(cheap.gasUnits).toBe(2n * 150_000n);
  });

  test("a small swap stays at one venue when a second transaction costs more gas than it saves", async () => {
    const pricey = pair("pricey-gas", 300_000n * USD, 30, 5_000_000n);
    const p = await plan(intent(10n * USD, 0), [deep, pricey], { prices: { MON: 0.03, USDC: 1 }, gasPriceWei: 10n ** 12n });
    expect(p.slices).toHaveLength(1);
    expect(p.slices[0]!.venue).toBe("mock-deep");
    expect(p.baseline.venue).toBe("mock-deep");
  });

  test("a venue that cannot quote gets no slice", async () => {
    const down: SpotVenue = { id: "mock-down", kind: "spot", quote: async () => Promise.reject(new Error("rpc down")) };
    const p = await plan(intent(20_000n * USD, 0.5), [down, deep, shallow]);
    expect(p.slices.some((s) => s.venue === "mock-down")).toBe(false);
    expect(sumIn(p.slices)).toBe(20_000n * USD);
  });

  test("no slice spends more than its account holds", async () => {
    const balances = { 3: 9_000n * USD, 4: 6_000n * USD, 5: 6_000n * USD };
    const p = await plan(intent(20_000n * USD, 0.5), [deep, shallow], { balances });
    for (const [account, held] of Object.entries(balances)) {
      expect(sumIn(p.slices.filter((s) => s.account === Number(account)))).toBeLessThanOrEqual(held);
    }
    expect(new Set(p.slices.map((s) => s.account)).size).toBe(3);
    expect(sumIn(p.slices)).toBe(20_000n * USD);
    await expect(plan(intent(30_000n * USD, 0.5), [deep], { balances })).rejects.toThrow("hold");
  });

  test("delays start at startMs and grow by one to five blocks, the same for the same intent", async () => {
    const opts = { accounts: [10, 11, 12, 13], startMs: 5_000 };
    const a = await plan(intent(20_000n * USD, 1), [deep, shallow], opts);
    const b = await plan(intent(20_000n * USD, 1), [deep, shallow], opts);
    expect(a.slices.map((s) => s.delayMs)).toEqual(b.slices.map((s) => s.delayMs));
    expect(a.slices[0]!.delayMs).toBe(5_000);
    for (let i = 1; i < a.slices.length; i++) {
      const step = a.slices[i]!.delayMs - a.slices[i - 1]!.delayMs;
      expect(step).toBeGreaterThanOrEqual(400);
      expect(step).toBeLessThanOrEqual(2_000);
    }
    // consecutive slices come from different accounts, and the venues alternate over the timeline
    expect(a.slices.every((s, i) => i === 0 || s.account !== a.slices[i - 1]!.account)).toBe(true);
    const half = a.slices.slice(0, a.slices.length / 2);
    expect(new Set(half.map((s) => s.venue)).size).toBe(2);
  });

  test("the hedge and the bridge quote come along when the intent asks and a venue is given", async () => {
    const p = await plan(
      intent(20_000n * USD, 0, { hedge: { ratio: 0.5 }, bridgeIn: { fromChain: "base", fromToken: "USDC", amount: 20_000n * USD } }),
      [deep, shallow, perp, bridge],
    );
    expect(p.hedge?.size).toBe(p.expectedOut / 2n);
    expect(p.bridge?.amountOut).toBe(19_980n * USD);
  });
});

describe("replan", () => {
  const deep = pair("deep", 300_000n * USD);
  const shallow = pair("shallow", 150_000n * USD);

  test("halfway, the shallow venue drops out and its remaining slices move to the deep one", async () => {
    const p = await plan(intent(20_000n * USD, 1), [deep, shallow], { accounts: [10, 11, 12, 13, 14] });
    const half = p.slices.length / 2;
    const done = p.slices.slice(0, half);
    expect(p.slices.slice(half).some((s) => s.venue === "mock-shallow")).toBe(true);

    const next = await replan(p, done, [deep]);
    expect(next.slices).toHaveLength(p.slices.length);
    next.slices.forEach((s, i) => {
      const old = p.slices[i]!;
      if (i < half) expect(s).toBe(old);
      else {
        expect(s.venue).toBe("mock-deep");
        expect([s.account, s.amountIn, s.delayMs]).toEqual([old.account, old.amountIn, old.delayMs]);
      }
    });
    expect(next.expectedOut).toBe(next.slices.reduce((s, x) => s + x.expectedOut, 0n));
    expect(next.baseline).toBe(p.baseline);
    expect(next.largestSliceShare).toBe(p.largestSliceShare);
    // the caller sends what is left
    expect(next.slices.filter((s) => !done.includes(s))).toHaveLength(p.slices.length - half);
  });

  test("done slices match by their fields too, for a plan that went through json", async () => {
    const p = await plan(intent(20_000n * USD, 1), [deep, shallow]);
    const copies = p.slices.slice(0, 3).map((s) => ({ ...s }));
    const next = await replan(p, copies, [deep]);
    expect(next.slices.slice(0, 3)).toEqual(p.slices.slice(0, 3));
    expect(next.slices.slice(3).every((s) => s.venue === "mock-deep")).toBe(true);
  });

  test("with no venue left it throws", async () => {
    const p = await plan(intent(20_000n * USD, 0), [deep, shallow]);
    await expect(replan(p, [], [perp])).rejects.toThrow("no venue");
  });
});

describe("rebalance", () => {
  // the demo: usdc on base in two accounts, a little mon on monad in two others
  const portfolio: Portfolio = {
    holdings: [
      { account: 0, token: baseUsdc, amount: 3_000n * USD, usd: 3_000 },
      { account: 1, token: baseUsdc, amount: 2_000n * USD, usd: 2_000 },
      { account: 0, token: baseEth, amount: MON / 100n, usd: 40 },
      { account: 10, token: mon, amount: 10_000n * MON, usd: 300 },
      { account: 11, token: mon, amount: 5_000n * MON, usd: 150 },
    ],
    totalUsd: 5_490,
    at: 0,
  };
  const target = (privacyWeight: number) => ({
    id: "get-me-to-70-30",
    targets: [
      { symbol: "MON", weight: 0.7 },
      { symbol: "USDC", weight: 0.3 },
    ],
    hedgeRatio: 0.5,
    privacyWeight,
  });
  const venues = [pair("kuru", 100_000n * USD), pair("uniswap", 60_000n * USD), perp, bridge];
  const opts = { accounts: [10, 11, 12, 13, 14, 15], tokens: { MON: mon, USDC: usdc } };

  test("reaches the targets through bridges, sliced swaps, and the hedge", async () => {
    const rp = await rebalance(portfolio, target(0.6), venues, opts);
    const monadUsd = (sym: string) =>
      rp.after.holdings.filter((h) => h.token.symbol === sym && [143, 10143].includes(h.token.chainId)).reduce((s, h) => s + h.usd, 0);
    const inScope = monadUsd("MON") + monadUsd("USDC");
    expect(monadUsd("MON") / inScope).toBeCloseTo(0.7, 1);
    expect(monadUsd("USDC") / inScope).toBeCloseTo(0.3, 1);

    // every base usdc moved, and each bridge landed in a different monad account, mon holders first
    expect(rp.bridges.reduce((s, b) => s + b.quote.amountIn, 0n)).toBe(5_000n * USD);
    const landed = rp.bridges.map((b) => b.toAccount);
    expect(new Set(landed).size).toBe(landed.length);
    expect(landed.slice(0, 2)).toEqual([10, 11]);
    expect(rp.after.holdings.some((h) => h.token.chainId === 84532 && h.token.symbol === "USDC")).toBe(false);
    // eth on base is not in the targets and stays where it is
    expect(rp.after.holdings.find((h) => h.token.symbol === "ETH")?.amount).toBe(MON / 100n);

    // one buy, in slices over both venues, each from an account that holds what it sends
    expect(rp.swaps).toHaveLength(1);
    const swap = rp.swaps[0]!;
    expect(swap.intent.sell.symbol).toBe("USDC");
    expect(new Set(swap.slices.map((s) => s.venue))).toEqual(new Set(["mock-kuru", "mock-uniswap"]));
    for (const account of new Set(swap.slices.map((s) => s.account))) {
      const got = rp.bridges.filter((b) => b.toAccount === account).reduce((s, b) => s + b.quote.amountOut, 0n);
      expect(sumIn(swap.slices.filter((s) => s.account === account))).toBeLessThanOrEqual(got);
    }
    // swaps start after the last bridge
    const lastBridge = Math.max(...rp.bridges.map((b) => b.delayMs));
    expect(Math.min(...swap.slices.map((s) => s.delayMs))).toBeGreaterThan(lastBridge);

    const monAfter = rp.after.holdings.filter((h) => h.token.symbol === "MON").reduce((s, h) => s + h.amount, 0n);
    expect(rp.hedge?.size).toBe(monAfter / 2n);
    expect(rp.directTransfers).toBe(0);
    expect(rp.costUsd).toBeGreaterThan(0);
    expect(rp.costUsd).toBeLessThan(rp.naiveCostUsd);
    expect(rp.before.totalUsd - rp.after.totalUsd).toBeCloseTo(rp.costUsd, 0);
  });

  test("a higher privacyWeight shows less size per move and costs a little more gas", async () => {
    const cheap = await rebalance(portfolio, target(0), venues, opts);
    const quiet = await rebalance(portfolio, target(1), venues, opts);
    expect(cheap.bridges).toHaveLength(2);
    expect(quiet.bridges).toHaveLength(6);
    expect(quiet.swaps[0]!.largestSliceShare).toBeLessThan(cheap.swaps[0]!.largestSliceShare);
    expect(quiet.swaps[0]!.gasUnits).toBeGreaterThan(cheap.swaps[0]!.gasUnits);
  });

  test("without a bridge venue, base funds stay and only monad funds trade", async () => {
    const kuru = pair("kuru", 100_000n * USD);
    // 70% mon: the base usdc counts, but no monad account holds usdc to buy with
    const stuck = await rebalance(portfolio, target(0.5), [kuru], opts);
    expect(stuck.bridges).toHaveLength(0);
    expect(stuck.swaps).toHaveLength(0);
    expect(stuck.hedge).toBeUndefined();
    expect(stuck.after.holdings.filter((h) => h.token.chainId === 84532 && h.token.symbol === "USDC")).toHaveLength(2);

    // 0% mon: the router sells all the monad mon, down to the reserve each account keeps for gas
    const all = { ...target(0.5), targets: [{ symbol: "MON", weight: 0 }, { symbol: "USDC", weight: 1 }] };
    const rp = await rebalance(portfolio, all, [kuru], opts);
    expect(rp.swaps).toHaveLength(1);
    expect(rp.swaps[0]!.intent.sell.symbol).toBe("MON");
    for (const account of [10, 11]) {
      const left = rp.after.holdings.find((h) => h.account === account && h.token.symbol === "MON")!.amount;
      expect(left).toBe(MON / 10n);
    }
  });

  test("prices come from the venues when the caller gives none", async () => {
    const rp = await rebalance(portfolio, target(0), venues, opts);
    const monHolding = rp.before.holdings.find((h) => h.account === 10)!;
    expect(monHolding.usd).toBeCloseTo(300, -1);
  });
});
