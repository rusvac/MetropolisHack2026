// offline tests: a fake rest api and a fake contract client. the live ones are in perpl.live.test.ts
import { expect, test } from "bun:test";
import type { Token } from "@spidereum/core";
import { type Address, type PublicClient, decodeFunctionData, erc20Abi, parseAbi } from "viem";
import {
  ORDER_TYPE,
  PERPL_NETWORKS,
  createPerplVenue,
  exchangeAbi,
  marginFor,
  marketLabel,
  perplSymbol,
  shortLimitPrice,
  sizeToLots,
  symbolFromLabel,
} from "./index.ts";

const mon: Token = { chainId: 143, symbol: "MON", address: "0x0000000000000000000000000000000000000000", decimals: 18 };
const me: Address = "0xcB659FD8B1720A7Ba8b36c0AD17ebf567a2E0257";
const testnet = PERPL_NETWORKS.testnet;

test("unit helpers", () => {
  expect(perplSymbol("MON Perp")).toBe("MON");
  expect(perplSymbol("wmon")).toBe("MON");
  expect(symbolFromLabel(marketLabel("MON", "mainnet", 10))).toBe("MON");
  // 150.7 MON at 0 lot decimals = 150 lots
  expect(sizeToLots(150_700_000_000_000_000_000n, 18, 0)).toBe(150n);
  expect(sizeToLots(1n * 10n ** 18n, 18, 3)).toBe(1000n);
  expect(shortLimitPrice(2_440n, 100)).toBe(2_415n);
  expect(shortLimitPrice(1n, 100)).toBe(1n);
  // 100 lots at 0.02440 usd, 2x: notional 2.44 usd, margin 1.22, plus half = 1.83 usd
  expect(marginFor(100n, 2_440n, 0, 5, 2)).toBe(1_830_001n);
});

// the shapes perpl's public api returns (GET /v1/pub/context and /v1/market-data/:id/ticker)
function fakeApi(): typeof fetch {
  return (async (url: string) => {
    if (url.endsWith("/v1/pub/context")) {
      return Response.json({
        markets: [
          { id: 1, perpetual_id: 1, symbol: "", name: "BTC", size_units: "BTC", funding_interval_sec: 2580, config: { is_open: true, price_decimals: 1, size_decimals: 5 }, funding: { rate: 40, at: { b: 1, t: 1 } } },
          { id: 10, perpetual_id: 10, symbol: "", name: "MON", size_units: "MON", funding_interval_sec: 2580, config: { is_open: true, price_decimals: 6, size_decimals: 0, taker_fee: 345 }, funding: { rate: 10, at: { b: 1, t: 1 } } },
        ],
      });
    }
    if (url.endsWith("/v1/market-data/10/ticker")) {
      return Response.json({ d: { "10": { at: { b: 5, t: 1_791_933_400_000 }, orl: 24_404, mrk: 24_411, bid: 24_419, ask: 24_451 } } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

test("quoteHedge reads mark and funding from the rest api", async () => {
  const venue = createPerplVenue({ fetch: fakeApi(), source: "api" });
  const size = 500n * 10n ** 18n;
  const q = await venue.quoteHedge(mon, size);
  expect(q.venue).toBe("perpl");
  expect(q.market).toBe("MON-PERP · perpl mainnet #10");
  expect(q.size).toBe(size);
  expect(q.markPrice).toBeCloseTo(0.024411, 9);
  // 10 micros per 2580 s interval -> per hour
  expect(q.fundingRate).toBeCloseTo((10e-6 * 3600) / 2580, 12);
  expect(q.simulated).toBe(false);
  expect(q.at).toBe(1_791_933_400_000);
  const m = await venue.readMarket("MON");
  expect(m.takerFee).toBeCloseTo(0.000345, 9);
  expect(m.bestBid).toBeCloseTo(0.024419, 9);
  expect(m.source).toBe("api");
});

// a fake testnet client: the MON perp, an AUSD balance, and an optional exchange account
function fakeTestnet(opts: { account?: { balance: bigint; locked: bigint }; ausd: bigint }): PublicClient {
  return {
    async readContract({ functionName }: { functionName: string }) {
      switch (functionName) {
        case "getPerpetualInfoV2":
          return { name: "MON Perp", symbol: "MON", priceDecimals: 5n, lotDecimals: 0n, markPNS: 2_440n, oraclePNS: 2_440n, basePricePNS: 1n, maxBidPriceONS: 2_437n, minAskPriceONS: 2_441n, fundingRatePct100k: 0, status: 4, markTimestamp: 1n };
        case "getMinAccountOpenCNS":
          return 100_000_000n;
        case "balanceOf":
          return opts.ausd;
        case "getAccountByAddr":
          if (!opts.account) throw new Error('reverted. Error: AccountDoesNotExist(address accountAddress)');
          return { accountId: 7n, balanceCNS: opts.account.balance, lockedBalanceCNS: opts.account.locked, frozen: 0 };
        default:
          throw new Error(`fake client: no ${functionName}`);
      }
    },
  } as unknown as PublicClient;
}

test("buildHedge, first time with no AUSD: faucet, approve, createAccount, then the short", async () => {
  const venue = createPerplVenue({ fetch: fakeApi(), source: "api", executeClient: fakeTestnet({ ausd: 0n }) });
  const q = await venue.quoteHedge(mon, 500n * 10n ** 18n);
  const txs = await venue.buildHedge!(q, me);
  expect(txs.map((t) => t.to)).toEqual([testnet.faucet!, testnet.collateral, testnet.exchange, testnet.exchange]);
  expect(txs.every((t) => t.value === 0n)).toBe(true);

  const faucet = decodeFunctionData({ abi: parseAbi(["function requestFunds(address to)"]), data: txs[0]!.data });
  expect(faucet.args[0]).toBe(me);
  const approve = decodeFunctionData({ abi: erc20Abi, data: txs[1]!.data });
  expect(approve.functionName).toBe("approve");
  expect(approve.args).toEqual([testnet.exchange, 100_000_000n]);
  const create = decodeFunctionData({ abi: exchangeAbi, data: txs[2]!.data });
  expect(create.functionName).toBe("createAccount");
  expect(create.args).toEqual([100_000_000n]);

  const order = decodeFunctionData({ abi: exchangeAbi, data: txs[3]!.data });
  expect(order.functionName).toBe("execOrders");
  const [descs, revertOnFail] = order.args as unknown as [Array<Record<string, unknown>>, boolean];
  expect(revertOnFail).toBe(true);
  expect(descs).toHaveLength(1);
  expect(descs[0]).toMatchObject({
    perpId: 64n, // the testnet MON perp, not the mainnet one the quote came from
    orderType: ORDER_TYPE.openShort,
    lotLNS: 500n,
    pricePNS: 2_413n, // best bid 1 + 2437 = 2438, less 1%
    immediateOrCancel: true,
    postOnly: false,
    leverageHdths: 200n,
    maxNegPnlCollatBPS: 1000n,
  });
});

test("buildHedge with a funded exchange account sends only the order", async () => {
  const venue = createPerplVenue({
    fetch: fakeApi(),
    source: "api",
    executeClient: fakeTestnet({ ausd: 0n, account: { balance: 100_000_000n, locked: 0n } }),
  });
  const txs = await venue.buildHedge!(await venue.quoteHedge(mon, 50n * 10n ** 18n), me);
  expect(txs).toHaveLength(1);
  expect(decodeFunctionData({ abi: exchangeAbi, data: txs[0]!.data }).functionName).toBe("execOrders");
});

test("buildHedge tops up a short balance with depositCollateral", async () => {
  const venue = createPerplVenue({
    fetch: fakeApi(),
    source: "api",
    executeClient: fakeTestnet({ ausd: 50_000_000n, account: { balance: 1_000n, locked: 0n } }),
  });
  const txs = await venue.buildHedge!(await venue.quoteHedge(mon, 1_000n * 10n ** 18n), me);
  const names = txs.map((t) => (t.to === testnet.collateral ? "approve" : decodeFunctionData({ abi: exchangeAbi, data: t.data }).functionName));
  expect(names).toEqual(["approve", "depositCollateral", "execOrders"]);
});

test("buildHedge refuses a size under one lot", async () => {
  const venue = createPerplVenue({ fetch: fakeApi(), source: "api", executeClient: fakeTestnet({ ausd: 0n }) });
  const q = await venue.quoteHedge(mon, 10n ** 17n);
  await expect(venue.buildHedge!(q, me)).rejects.toThrow("under one lot");
});
