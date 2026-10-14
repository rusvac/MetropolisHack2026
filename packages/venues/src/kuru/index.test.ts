// offline: a fake client stands in for the chain. the live checks are in kuru.live.test.ts
import { describe, expect, test } from "bun:test";
import { decodeFunctionData, zeroAddress, type Address, type PublicClient } from "viem";
import type { Intent, Token } from "@spidereum/core";
import { orderBookAbi, erc20Abi } from "./abi.ts";
import { createKuruVenue, orderSize, sideOf, type KuruMarketParams } from "./index.ts";

const MARKET: Address = "0x00000000000000000000000000000000000000aa";
const USDC_ADDR: Address = "0x00000000000000000000000000000000000000bb";
const ME: Address = "0x00000000000000000000000000000000000000cc";

const MON: Token = { chainId: 143, symbol: "MON", address: zeroAddress, decimals: 18 };
// a mainnet intent: its USDC address is not the fake market's USDC. the venue maps it by symbol
const USDC: Token = { chainId: 143, symbol: "USDC", address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", decimals: 6 };

const params: KuruMarketParams = {
  market: MARKET,
  pricePrecision: 10n ** 8n,
  sizePrecision: 10n ** 10n,
  base: zeroAddress,
  baseDecimals: 18,
  quote: USDC_ADDR,
  quoteDecimals: 6,
  tickSize: 100n,
  minSize: 10n ** 7n,
  maxSize: 10n ** 18n,
  takerFeeBps: 0,
};

/** a book with one price: 0.025 USDC per MON, both ways */
function fakeClient(opts: { allowance?: bigint } = {}) {
  const calls: string[] = [];
  const client = {
    async readContract({ functionName }: { functionName: string }) {
      calls.push(functionName);
      if (functionName === "getMarketParams") {
        return [100_000_000, 10n ** 10n, zeroAddress, 18n, USDC_ADDR, 6n, 100, 10n ** 7n, 10n ** 18n, 0n, 0n];
      }
      if (functionName === "allowance") return opts.allowance ?? 0n;
      throw new Error(`unexpected read ${functionName}`);
    },
    async simulateContract({ functionName, args }: { functionName: string; args: readonly bigint[] }) {
      calls.push(functionName);
      const units = args[0]!;
      // sell: units of 1e-10 MON -> USDC atomic. 1 MON = 1e10 units -> 25_000 atomic USDC
      if (functionName === "placeAndExecuteMarketSell") return { result: (units * 25_000n) / 10n ** 10n };
      // buy: units of 1e-8 USDC -> MON wei. 1 USDC = 1e8 units -> 40 MON
      return { result: (units * 40n * 10n ** 18n) / 10n ** 8n };
    },
    async estimateContractGas() {
      calls.push("estimateGas");
      return 137_000n;
    },
  };
  return { client: client as unknown as PublicClient, calls };
}

const intent = (sell: Token, buy: Token, amountIn: bigint): Intent => ({
  id: "t",
  sell,
  buy,
  amountIn,
  maxSlippageBps: 100,
  privacyWeight: 0,
});

describe("sideOf", () => {
  test("MON for USDC is a sell of the base, USDC for MON is a buy", () => {
    expect(sideOf(MON, USDC, params)).toBe("sell");
    expect(sideOf(USDC, MON, params)).toBe("buy");
  });
  test("a pair the market does not trade throws", () => {
    const WETH: Token = { chainId: 143, symbol: "WETH", address: "0x00000000000000000000000000000000000000dd", decimals: 18 };
    expect(() => sideOf(WETH, USDC, params)).toThrow();
  });
});

describe("orderSize", () => {
  test("a sell rounds the MON down to the size precision", () => {
    const { units, spend } = orderSize("sell", 10n ** 18n + 123n, params);
    expect(units).toBe(10n ** 10n);
    expect(spend).toBe(10n ** 18n);
  });
  test("a buy turns USDC atomic units into price precision units", () => {
    const { units, spend } = orderSize("buy", 1_500_000n, params);
    expect(units).toBe(150_000_000n);
    expect(spend).toBe(1_500_000n);
  });
});

describe("quote", () => {
  test("reads the book and says the quote is live", async () => {
    const { client } = fakeClient();
    const venue = createKuruVenue({ network: "mainnet", client, market: MARKET, execution: { network: "mainnet" } });
    const q = await venue.quote({ sell: MON, buy: USDC, amountIn: 2n * 10n ** 18n });
    expect(q.venue).toBe("kuru");
    expect(q.amountOut).toBe(50_000n);
    expect(q.simulated).toBe(false);
    expect(q.feeBps).toBe(0);
    expect(q.gasUnits).toBe(137_000n);
  });
  test("caches the market params and the gas estimate", async () => {
    const { client, calls } = fakeClient();
    const venue = createKuruVenue({ network: "mainnet", client, market: MARKET, execution: { network: "mainnet" } });
    for (let i = 0; i < 3; i++) await venue.quote({ sell: USDC, buy: MON, amountIn: 1_000_000n });
    expect(calls.filter((c) => c === "getMarketParams").length).toBe(1);
    expect(calls.filter((c) => c === "estimateGas").length).toBe(1);
  });
});

describe("build", () => {
  test("a MON sell is one market sell that sends the MON as value, with minAmountOut from a fresh quote", async () => {
    const { client } = fakeClient();
    const venue = createKuruVenue({ network: "mainnet", client: fakeClient().client, market: MARKET, execution: { network: "testnet", client, market: MARKET } });
    const amountIn = 10n ** 18n;
    const txs = await venue.build!({ venue: "kuru", account: 1, amountIn, expectedOut: 1n, delayMs: 0 }, intent(MON, USDC, amountIn), ME);
    expect(txs.length).toBe(1);
    expect(txs[0]!.to).toBe(MARKET);
    expect(txs[0]!.value).toBe(amountIn);
    const call = decodeFunctionData({ abi: orderBookAbi, data: txs[0]!.data });
    expect(call.functionName).toBe("placeAndExecuteMarketSell");
    // 25_000 out, 1% slippage
    expect(call.args).toEqual([10n ** 10n, 24_750n, false, true]);
  });
  test("a MON buy approves the USDC first, then sends a market buy", async () => {
    const { client } = fakeClient({ allowance: 0n });
    const venue = createKuruVenue({ network: "testnet", client, market: MARKET, execution: { network: "testnet", client, market: MARKET } });
    const txs = await venue.build!({ venue: "kuru", account: 1, amountIn: 1_000_000n, expectedOut: 1n, delayMs: 0 }, intent(USDC, MON, 1_000_000n), ME);
    expect(txs.length).toBe(2);
    const approve = decodeFunctionData({ abi: erc20Abi, data: txs[0]!.data });
    expect(txs[0]!.to).toBe(USDC_ADDR);
    expect(approve.functionName).toBe("approve");
    expect(String(approve.args[0]).toLowerCase()).toBe(MARKET);
    expect(approve.args[1]).toBe(1_000_000n);
    const buy = decodeFunctionData({ abi: orderBookAbi, data: txs[1]!.data });
    expect(buy.functionName).toBe("placeAndExecuteMarketBuy");
    expect(txs[1]!.value).toBe(0n);
  });
  test("skips the approve when the allowance covers the slice", async () => {
    const { client } = fakeClient({ allowance: 10n ** 12n });
    const venue = createKuruVenue({ network: "testnet", client, market: MARKET });
    const txs = await venue.build!({ venue: "kuru", account: 1, amountIn: 1_000_000n, expectedOut: 1n, delayMs: 0 }, intent(USDC, MON, 1_000_000n), ME);
    expect(txs.length).toBe(1);
  });
});
