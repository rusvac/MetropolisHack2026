// live tests. the quotes are read-only and run when the RPC urls are in .env.
// the short spends gas and testnet AUSD from swarm account 3 (lane L3's account), so it runs only with L3_LIVE_SHORT=1:
//   L3_LIVE_SHORT=1 bun test packages/venues/src/perpl/perpl.live.test.ts
import { expect, test } from "bun:test";
import { type Log, formatEther, parseEventLogs } from "viem";
import type { Token } from "@spidereum/core";
import { deriveSwarmAccount } from "../../../swarm/src/addresses.ts";
import { sendTxs } from "../../../swarm/src/send.ts";
import { createPerplVenue, exchangeAbi, perplClient, readPerplAccount, readPerplPosition } from "./index.ts";

const hasMainnet = !!process.env.MONAD_RPC_URL;
const hasTestnet = !!process.env.MONAD_TESTNET_RPC_URL;
const shortOn = hasTestnet && process.env.L3_LIVE_SHORT === "1" && !!process.env.BURNER_MNEMONIC?.trim();
const ACCOUNT = 3;

const mon: Token = { chainId: 143, symbol: "MON", address: "0x0000000000000000000000000000000000000000", decimals: 18 };

test.skipIf(!hasMainnet)("perpl mainnet: the rest api quotes a MON short", async () => {
  const venue = createPerplVenue({ source: "api" });
  const q = await venue.quoteHedge(mon, 1_000n * 10n ** 18n);
  console.log(`  ${q.market}  mark $${q.markPrice}  funding ${(q.fundingRate! * 100).toFixed(6)}%/h  at ${new Date(q.at).toISOString()}`);
  expect(q.market).toBe("MON-PERP · perpl mainnet #10");
  expect(q.markPrice).toBeGreaterThan(0);
  expect(Number.isFinite(q.fundingRate)).toBe(true);
  expect(q.simulated).toBe(false);
  // the market state is at most a few minutes old
  expect(Date.now() - q.at).toBeLessThan(10 * 60_000);
});

test.skipIf(!hasMainnet)("perpl mainnet: the exchange contract agrees with the api", async () => {
  const venue = createPerplVenue();
  const [api, chain] = await Promise.all([
    createPerplVenue({ source: "api" }).readMarket("MON"),
    createPerplVenue({ source: "chain" }).readMarket("MON"),
  ]);
  console.log(`  api mark $${api.markPrice} (${api.fundingIntervalSec} s funding)  chain mark $${chain.markPrice} (${chain.fundingIntervalSec.toFixed(0)} s funding)`);
  expect(chain.perpId).toBe(10);
  expect(chain.source).toBe("chain");
  expect(Math.abs(chain.markPrice - api.markPrice) / api.markPrice).toBeLessThan(0.02);
  expect(venue.network).toEqual({ quote: "mainnet", execute: "testnet" });
}, 30_000);

test.skipIf(!hasTestnet)("perpl testnet: the MON perp is live", async () => {
  const m = await createPerplVenue({ quoteNetwork: "testnet" }).readMarket("MON");
  console.log(`  testnet #${m.perpId} mark $${m.markPrice} bid ${m.bestBid} ask ${m.bestAsk}`);
  expect(m.perpId).toBe(64);
  expect(m.markPrice).toBeGreaterThan(0);
});

// read-only: eth_simulateV1 runs buildHedge's transactions in order against live testnet state,
// with a MON balance override for gas. nothing is sent
test.skipIf(!hasTestnet || !process.env.BURNER_MNEMONIC?.trim())(
  "perpl testnet: account 3's hedge transactions simulate to an open short",
  async () => {
    const address = deriveSwarmAccount(process.env.BURNER_MNEMONIC!.trim(), 10143, ACCOUNT).address;
    const client = perplClient("testnet");
    const venue = createPerplVenue({ executeClient: client });
    const txs = await venue.buildHedge!(await venue.quoteHedge(mon, 100n * 10n ** 18n), address);
    const sim = await client.simulateCalls({
      account: address,
      calls: txs.map((t) => ({ to: t.to, data: t.data, value: t.value })),
      stateOverrides: [{ address, balance: 10n ** 18n }],
    });
    sim.results.forEach((r, i) => r.status === "failure" && console.log(`  tx ${i} fails: ${(r.error as Error | undefined)?.message?.split("\n").slice(0, 3).join(" | ")}`));
    expect(sim.results.map((r) => r.status)).toEqual(txs.map(() => "success"));
    const events = parseEventLogs({ abi: exchangeAbi, logs: sim.results.flatMap((r) => r.logs ?? []) as Log[] });
    const opened = events.find((e) => e.eventName === "PositionOpenedV2" || e.eventName === "PositionIncreasedV2");
    console.log(`  ${txs.length} transactions simulate. ${opened?.eventName}: ${JSON.stringify(opened?.args, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    expect(opened).toBeDefined();
    expect((opened!.args as { positionType: number }).positionType).toBe(1); // short
  },
  60_000,
);

test.skipIf(!shortOn)(
  "perpl testnet: swarm account 3 opens a MON short",
  async () => {
    const address = deriveSwarmAccount(process.env.BURNER_MNEMONIC!.trim(), 10143, ACCOUNT).address;
    const client = perplClient("testnet");
    const gas = await client.getBalance({ address });
    console.log(`  account ${ACCOUNT} ${address} holds ${formatEther(gas)} MON`);
    expect(gas).toBeGreaterThan(5n * 10n ** 16n);

    const venue = createPerplVenue({ executeClient: client });
    const size = 100n * 10n ** 18n; // 100 MON, 100 lots
    const quote = await venue.quoteHedge(mon, size);
    const before = await readPerplAccount(client, "testnet", address);
    const lotsBefore = before ? (await readPerplPosition(client, "testnet", 64, before.accountId)).lots : 0n;

    const txs = await venue.buildHedge!(quote, address);
    console.log(`  ${txs.length} transactions for ${quote.market} at mark $${quote.markPrice}`);
    const sent = await sendTxs(ACCOUNT, txs, { onTx: (t) => t.status !== "pending" && console.log(`  tx ${t.index} ${t.status} ${t.url}`) });
    expect(sent.error).toBeUndefined();
    expect(sent.ok).toBe(true);

    const after = await readPerplAccount(client, "testnet", address);
    expect(after).toBeDefined();
    const pos = await readPerplPosition(client, "testnet", 64, after!.accountId);
    console.log(`  perpl account ${after!.accountId}: ${pos.side} ${pos.lots} lots, entry ${pos.entryPNS}, deposit ${pos.depositCNS}`);
    expect(pos.side).toBe("short");
    expect(pos.lots).toBeGreaterThan(lotsBefore);
  },
  240_000,
);
