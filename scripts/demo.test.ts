// the terminal demo and the run engine, on the mock venues and the fake portfolio. no network
import { expect, test } from "bun:test";
import type { Portfolio } from "../packages/core/src/index.ts";
import { demoIntent } from "./config.ts";
import { runDemo } from "./demo.ts";
import { fakePortfolio, mockBridge, mockPerp, mockSpotVenues } from "./lib/fake.ts";
import { linkability, walletConcentration } from "./lib/link.ts";
import type { GasInfo, VenueSet } from "./lib/plan-math.ts";
import { runPlan, simulatedExecutor, type Executor, type RunEvent } from "./lib/run.ts";
import { standInRebalance, standInReplan } from "./lib/standin.ts";
import { DEMO_MONAD_ACCOUNTS, USDC_BASE } from "./lib/tokens.ts";

const offline = { venues: "mock", portfolio: "fake", executor: "simulated", gas: "fixed" } as const;
const gas: GasInfo = { monadWei: 100n * 10n ** 9n, simulated: true, source: "test" };
const venues = (): VenueSet => ({ spot: mockSpotVenues(), perp: mockPerp(), bridge: mockBridge() });
const prices = { USDC: 1, MON: 0.04 };

async function collect(gen: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

test("bun run demo prints the seven beats, says simulated, and re-routes", async () => {
  const lines: string[] = [];
  const r = await runDemo({ out: (l) => lines.push(l), speed: Infinity, config: offline });
  const text = lines.join("\n");
  for (const beat of ["1 · THE SWARM", "2 · THE PORTFOLIO NOW", "3 · THE INTENT", "4 · THE PLAN", "5 · EXECUTE", "6 · THE PORTFOLIO AFTER", "7 · WHAT AN OBSERVER CAN LINK"]) {
    expect(text).toContain(`[${beat}]`);
  }
  expect(text).toContain("(simulated)");
  expect(text).toContain("turns off");
  expect(text).toContain("re-route off");
  expect(r.plan.costUsd).toBeLessThan(r.plan.naiveCostUsd);
  expect(r.plan.directTransfers).toBe(0);
  expect(r.link.largestMove.split).toBeLessThan(1);
  // the words the public text must not use
  for (const banned of ["obfuscation", "anonymity", "mixer", "disconnected identities", "decoy", "salt transaction"]) {
    expect(text.toLowerCase()).not.toContain(banned);
  }
});

test("the stand-in plan bridges into separate monad accounts and plans no direct transfer", async () => {
  const before = fakePortfolio();
  const plan = await standInRebalance(before, demoIntent(0.5), venues(), { monadAccounts: DEMO_MONAD_ACCOUNTS, gas });
  expect(plan.bridges.length).toBeGreaterThan(2);
  expect(new Set(plan.bridges.map((b) => b.toAccount)).size).toBe(plan.bridges.length);
  expect(plan.directTransfers).toBe(0);
  expect(plan.costUsd).toBeLessThan(plan.naiveCostUsd);
  const mon = plan.after.holdings.filter((h) => h.token.symbol === "MON").reduce((s, h) => s + h.usd, 0);
  expect(mon / plan.after.totalUsd).toBeGreaterThan(0.6);
});

test("the run re-routes every queued slice off the venue that turns off", async () => {
  const v = venues();
  const plan = await standInRebalance(fakePortfolio(), demoIntent(0.8), v, { monadAccounts: DEMO_MONAD_ACCOUNTS, gas });
  const events = await collect(
    runPlan(plan, { executor: simulatedExecutor(), spot: v.spot, replan: standInReplan, dropVenue: "mock-kuru", speed: Infinity, prices }),
  );
  const offAt = events.findIndex((e) => e.type === "venue-off");
  expect(offAt).toBeGreaterThan(0);
  const later = events.slice(offAt).filter((e) => e.type === "move" && e.kind === "swap" && e.status === "confirmed");
  expect(later.length).toBeGreaterThan(0);
  for (const e of later) if (e.type === "move") expect(e.venue).not.toBe("mock-kuru");
  // the simulated executor sends nothing: no hash and no explorer link
  for (const e of events) if (e.type === "move") expect(e.hash).toBeUndefined();
  const done = events.at(-1)!;
  expect(done.type).toBe("done");
});

test("an account with no MON gets a gas top-up from account 0, and beat 7 counts it", async () => {
  const before: Portfolio = { holdings: [{ account: 0, token: USDC_BASE, amount: 2_000n * 10n ** 6n, usd: 2_000 }], totalUsd: 2_000, at: 0 };
  const v = venues();
  const plan = await standInRebalance(before, demoIntent(0.5), v, { monadAccounts: [12, 13, 14], gas });
  const events = await collect(
    runPlan(plan, { executor: simulatedExecutor(), spot: v.spot, replan: standInReplan, speed: Infinity, prices, gasPerTxWei: gas.monadWei * 250_000n }),
  );
  const tops = events.filter((e) => e.type === "move" && e.kind === "gas" && e.status === "confirmed");
  expect(tops.length).toBeGreaterThan(0);
  const link = linkability(plan, { prices });
  expect(link.directTransfers.gasTopUps.length).toBe(tops.length);
  expect(link.directTransfers.total).toBe(tops.length);
});

test("a slice its venue cannot fill re-routes to the other venue", async () => {
  const v = venues();
  const plan = await standInRebalance(fakePortfolio(), demoIntent(0.5), v, { monadAccounts: DEMO_MONAD_ACCOUNTS, gas });
  let failed = false;
  const thin: Executor = {
    name: "thin book",
    simulated: true,
    async send(move) {
      if (move.kind === "swap" && move.venue === "mock-kuru" && !failed) {
        failed = true;
        return { status: "failed", hash: null, url: null, note: "the book is thin", reroute: true };
      }
      return simulatedExecutor().send(move, "t");
    },
  };
  const events = await collect(runPlan(plan, { executor: thin, spot: v.spot, replan: standInReplan, speed: Infinity, prices }));
  const reroute = events.find((e) => e.type === "reroute");
  expect(reroute?.type === "reroute" && reroute.moves[0]?.to).toBe("mock-uniswap-v4");
  const swaps = plan.swaps[0]!.slices.length;
  const final = events.filter((e) => e.type === "move" && e.kind === "swap" && e.status === "confirmed");
  expect(final.length).toBe(swaps);
});

test("the stand-in correlation score: one account scores 90, the most the ported algorithm gives, and a spread scores lower", () => {
  const one = fakePortfolio();
  const all = { ...one, holdings: [{ ...one.holdings[0]!, usd: one.totalUsd }] };
  expect(walletConcentration(all)).toBe(90);
  expect(walletConcentration(one)).toBeLessThan(100);
});

test("the swarm executor sends only swap slices from accounts 10 to 19, and keeps the rest as quotes", async () => {
  const { swarmExecutor } = await import("./config.ts");
  const sent: { account: number; txs: number }[] = [];
  const fakeSwarm = {
    async sendSlice(slice: { account: number }, txs: unknown[], o: { onTx?: (t: { hash: string; status: string }) => void }) {
      sent.push({ account: slice.account, txs: txs.length });
      const hash = `0x${"ab".repeat(32)}`;
      o.onTx?.({ hash, status: "pending" });
      return { ok: true, txs: [{ hash, url: `https://testnet.monadexplorer.com/tx/${hash}`, status: "success", gasUsed: 114_000n }] };
    },
  };
  let thin = true;
  const v = venues();
  const live = {
    ...v.spot[0]!,
    async build() {
      if (thin) throw new Error("the book is thin");
      return [{ to: "0x0000000000000000000000000000000000000001" as const, data: "0x" as const, value: 0n }];
    },
  };
  const setup = () => ({ venues: { ...v, spot: [live, v.spot[1]!] }, swarm: DEMO_MONAD_ACCOUNTS.map((index) => ({ chainId: 10143, index, address: `0x${index.toString(16).padStart(40, "0")}` })) });
  const ex = swarmExecutor(fakeSwarm, setup, []);
  expect(ex.simulated).toBe(false);

  const plan = await standInRebalance(fakePortfolio(), demoIntent(0.5), v, { monadAccounts: DEMO_MONAD_ACCOUNTS, gas });
  const { movesOf } = await import("./lib/run.ts");
  const moves = movesOf(plan);
  const bridge = moves.find((m) => m.kind === "bridge")!;
  const hedge = moves.find((m) => m.kind === "hedge")!;
  const slice = moves.find((m) => m.kind === "swap" && m.venue === live.id)!;
  const quoteOnly = moves.find((m) => m.kind === "swap" && m.venue !== live.id)!;

  expect((await ex.send(bridge, "t")).status).toBe("quoted");
  expect((await ex.send(hedge, "t")).status).toBe("quoted");
  expect((await ex.send({ ...slice, kind: "gas" }, "t")).status).toBe("quoted");
  // a venue without build() is quote-only
  expect((await ex.send(quoteOnly, "t")).status).toBe("quoted");
  // a thin book asks the run to re-route
  const r1 = await ex.send(slice, "t");
  expect(r1.status).toBe("failed");
  expect(r1.reroute).toBe(true);
  thin = false;
  // an account outside 10 to 19 never sends
  await expect(ex.send({ ...slice, account: 3 }, "t")).rejects.toThrow("may not send");
  const hashes: string[] = [];
  const r2 = await ex.send(slice, "t", (h) => hashes.push(h));
  expect(r2.status).toBe("confirmed");
  expect(r2.url).toContain("testnet.monadexplorer.com/tx/0x");
  expect(hashes.length).toBe(1);
  expect(sent).toEqual([{ account: slice.account, txs: 1 }]);
});

test("the onchain plan keeps 0.08 MON per account for gas, splits into whole slices, and counts the 8 funding transfers", async () => {
  const { planOnchain, onchainLink, fundingTransfers, GAS_RESERVE_WEI } = await import("./lib/onchain.ts");
  const { MON, USDC_MONAD } = await import("./lib/tokens.ts");
  const accounts = [10, 11, 12, 13];
  const holdings = accounts.flatMap((account) => [
    { account, token: MON, amount: 25n * 10n ** 16n, usd: 0.25 },
    { account, token: USDC_MONAD, amount: 500_000n, usd: 0.5 },
  ]);
  const before: Portfolio = { holdings, totalUsd: 3, at: 0 };
  const spot = mockSpotVenues(1);
  const setup = {
    venues: spot,
    gas: { monadWei: 102n * 10n ** 9n, simulated: false, source: "test" },
    prices: { MON: 1, USDC: 1 },
    venuePrices: [],
    swarm: [],
    accounts,
    executor: simulatedExecutor(),
    replan: standInReplan,
  };
  const p = await planOnchain(setup, before, { sellPerAccountWei: 5n * 10n ** 16n });
  expect(p.plan.intent.amountIn).toBe(2n * 10n ** 17n);
  const spent = new Map<number, bigint>();
  for (const s of p.plan.slices) {
    spent.set(s.account, (spent.get(s.account) ?? 0n) + s.amountIn);
    // no dust slice
    expect(s.amountIn).toBeGreaterThan(10n ** 15n);
  }
  for (const [, x] of spent) expect(25n * 10n ** 16n - x).toBeGreaterThan(GAS_RESERVE_WEI);
  expect(fundingTransfers(accounts).length).toBe(8);
  const link = onchainLink(before, before, accounts, p.plan);
  expect(link.directTransfers).toBe(8);
  expect(link.correlation.before).toBe(100);
  // an account that cannot keep the gas reserve sells nothing
  const poor: Portfolio = { ...before, holdings: holdings.map((h) => (h.token.symbol === "MON" ? { ...h, amount: 9n * 10n ** 16n } : h)) };
  await expect(planOnchain(setup, poor)).rejects.toThrow("0.08 MON");
});
