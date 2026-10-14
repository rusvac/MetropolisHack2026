// offline tests: no network. the live ones are in index.live.test.ts
import { expect, test } from "bun:test";
import { decodeFunctionData, erc20Abi, getAddress, zeroAddress, type PublicClient } from "viem";
import type { Intent, Slice, Token } from "@spidereum/core";
import { testPoolAbi } from "./pool/artifact.ts";
import {
  createTestPoolVenue,
  minOut,
  TEST_POOL_TOKENS,
  testPoolAmountOut,
  testPoolSide,
} from "./testpool.ts";
import { candidateKeys, createUniswapVenue, MON_USDC_POOL, MONAD_MAINNET_TOKENS, poolId, v4Currency } from "./v4.ts";

const mainUsdc = MONAD_MAINNET_TOKENS.USDC;
const mainMon = MONAD_MAINNET_TOKENS.MON;
const testUsdc: Token = TEST_POOL_TOKENS.USDC;
const testMon: Token = TEST_POOL_TOKENS.MON;
const POOL = "0x00000000000000000000000000000000000000aa" as const;
const ME = "0x00000000000000000000000000000000000000bb" as const;

test("the MON/USDC pool key hashes to the pool id found on mainnet", () => {
  expect(poolId(MON_USDC_POOL)).toBe("0x18a9fc874581f3ba12b7898f80a683c66fd5877fd74b26a85ba9a3a79c549954");
});

test("candidate keys sort the currencies the way v4 does", () => {
  const keys = candidateKeys(mainUsdc.address, zeroAddress);
  expect(keys).toHaveLength(4);
  for (const k of keys) {
    expect(k.currency0).toBe(zeroAddress);
    expect(k.currency1).toBe(mainUsdc.address);
  }
});

test("testnet tokens map to mainnet v4 currencies by symbol", () => {
  expect(v4Currency(testMon)).toBe(zeroAddress);
  expect(v4Currency(testUsdc)).toBe(mainUsdc.address);
  expect(v4Currency({ ...mainMon, symbol: "WMON" })).toBe(zeroAddress);
});

test("the uniswap venue quotes every tier and keeps the best output", async () => {
  const outs: Record<number, bigint> = { 100: 1n, 500: 40_000n * 10n ** 18n, 3000: 30_000n * 10n ** 18n };
  const seen: boolean[] = [];
  const client = {
    async simulateContract({ args }: { args: [{ poolKey: { fee: number }; zeroForOne: boolean }] }) {
      const fee = args[0].poolKey.fee;
      seen.push(args[0].zeroForOne);
      if (!(fee in outs)) throw new Error("revert");
      return { result: [outs[fee], 65_000n] };
    },
  } as unknown as PublicClient;
  const venue = createUniswapVenue({ client });
  const q = await venue.quote({ sell: mainUsdc, buy: mainMon, amountIn: 1_000n * 10n ** 6n });
  expect(q.venue).toBe("uniswap-v4");
  expect(q.amountOut).toBe(40_000n * 10n ** 18n);
  expect(q.feeBps).toBe(5);
  expect(q.simulated).toBe(false);
  expect(q.gasUnits).toBeGreaterThan(65_000n);
  // USDC in, native MON is currency0: one for zero
  expect(seen.every((z) => z === false)).toBe(true);
});

test("the test pool math matches the contract's", () => {
  // the forge test: 0.01 MON into 0.8 MON / 5 USDC at 30 bps
  const out = testPoolAmountOut(10n ** 16n, 8n * 10n ** 17n, 5_000_000n);
  expect(out).toBe((10n ** 16n * 9970n * 5_000_000n) / (8n * 10n ** 17n * 10_000n + 10n ** 16n * 9970n));
  expect(out).toBeLessThan(62_500n);
  expect(out).toBeGreaterThan(60_000n);
  expect(testPoolAmountOut(1n, 0n, 5n)).toBe(0n);
});

test("the test pool maps tokens by symbol, so mainnet tokens from a plan work", () => {
  expect(testPoolSide(mainMon)).toBe("MON");
  expect(testPoolSide(mainUsdc)).toBe("USDC");
  expect(() => testPoolSide({ ...mainUsdc, symbol: "AUSD", address: "0x00000000000000000000000000000000000000cc" })).toThrow();
});

test("the test pool quotes from the contract and says which venue", async () => {
  const client = {
    async readContract({ functionName, args }: { functionName: string; args: [bigint, boolean] }) {
      expect(functionName).toBe("getAmountOut");
      return args[1] ? 61_000n : 150_000_000_000_000_000n;
    },
  } as unknown as PublicClient;
  const venue = createTestPoolVenue({ client, address: POOL });
  const sell = await venue.quote({ sell: testMon, buy: testUsdc, amountIn: 10n ** 16n });
  expect(sell.venue).toBe("test-pool");
  expect(sell.amountOut).toBe(61_000n);
  const buy = await venue.quote({ sell: testUsdc, buy: testMon, amountIn: 1_000_000n });
  expect(buy.amountOut).toBe(150_000_000_000_000_000n);
  expect(buy.gasUnits).toBeGreaterThan(sell.gasUnits);
});

function intent(sell: Token, buy: Token): Intent {
  return { id: "t", sell, buy, amountIn: 0n, maxSlippageBps: 100, privacyWeight: 0 };
}

test("build sends MON with the swap, and the output floor is the slice less slippage", async () => {
  const venue = createTestPoolVenue({ client: {} as PublicClient, address: POOL });
  const slice: Slice = { venue: "test-pool", account: 2, amountIn: 10n ** 16n, expectedOut: 61_000n, delayMs: 0 };
  const txs = await venue.build!(slice, intent(testMon, testUsdc), ME);
  expect(txs).toHaveLength(1);
  expect(txs[0]!.to).toBe(POOL);
  expect(txs[0]!.value).toBe(10n ** 16n);
  const call = decodeFunctionData({ abi: testPoolAbi, data: txs[0]!.data });
  expect(call.functionName).toBe("swapMonForUsdc");
  expect(call.args).toEqual([minOut(61_000n, 100), getAddress(ME)]);
  expect(minOut(61_000n, 100)).toBe(60_390n);
});

test("build approves USDC first, then swaps", async () => {
  const venue = createTestPoolVenue({ client: {} as PublicClient, address: POOL });
  const slice: Slice = { venue: "test-pool", account: 2, amountIn: 500_000n, expectedOut: 7n * 10n ** 16n, delayMs: 0 };
  const txs = await venue.build!(slice, intent(testUsdc, testMon), ME);
  expect(txs).toHaveLength(2);
  expect(txs[0]!.to).toBe(TEST_POOL_TOKENS.USDC.address);
  const approve = decodeFunctionData({ abi: erc20Abi, data: txs[0]!.data });
  expect(approve.functionName).toBe("approve");
  expect(approve.args).toEqual([getAddress(POOL), 500_000n]);
  const swap = decodeFunctionData({ abi: testPoolAbi, data: txs[1]!.data });
  expect(swap.functionName).toBe("swapUsdcForMon");
  expect(swap.args).toEqual([500_000n, minOut(7n * 10n ** 16n, 100), getAddress(ME)]);
  expect(txs.every((t) => t.value === 0n)).toBe(true);
});

test("after the first scan, quote() calls only the best pool for the pair", async () => {
  let calls = 0;
  const client = {
    async simulateContract({ args }: { args: [{ poolKey: { fee: number } }] }) {
      calls++;
      return { result: [args[0].poolKey.fee === 500 ? 9n : 1n, 1n] };
    },
  } as unknown as PublicClient;
  const venue = createUniswapVenue({ client });
  await venue.quote({ sell: mainUsdc, buy: mainMon, amountIn: 1n });
  expect(calls).toBe(4);
  const q = await venue.quote({ sell: mainUsdc, buy: mainMon, amountIn: 2n });
  expect(calls).toBe(5);
  expect(q.amountOut).toBe(9n);
});

test("the testnet v4 venue swaps MON through the universal router with the MON attached", async () => {
  const { createUniswapTestnetVenue, UNISWAP_V4_MONAD_TESTNET } = await import("./v4-testnet.ts");
  const { decodeAbiParameters, parseAbi } = await import("viem");
  const venue = createUniswapTestnetVenue({ client: {} as PublicClient });
  const slice: Slice = { venue: venue.id, account: 2, amountIn: 10n ** 17n, expectedOut: 100_000n, delayMs: 0 };
  const txs = await venue.build!(slice, intent(testMon, testUsdc), ME);
  expect(txs).toHaveLength(1);
  expect(txs[0]!.to).toBe(UNISWAP_V4_MONAD_TESTNET.universalRouter);
  expect(txs[0]!.value).toBe(10n ** 17n);
  const call = decodeFunctionData({
    abi: parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]),
    data: txs[0]!.data,
  });
  expect(call.args[0]).toBe("0x10");
  const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], call.args[1][0]!);
  expect(actions).toBe("0x060c0f");
  expect(params).toHaveLength(3);
  // TAKE_ALL USDC, at least the expected output less 1%
  const [currency, least] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[2]!);
  expect(currency.toLowerCase()).toBe(TEST_POOL_TOKENS.USDC.address);
  expect(least).toBe(99_000n);
});

test("the testnet v4 venue approves Permit2 and the router before a USDC sale", async () => {
  const { createUniswapTestnetVenue, UNISWAP_V4_MONAD_TESTNET } = await import("./v4-testnet.ts");
  const venue = createUniswapTestnetVenue({ client: {} as PublicClient });
  const slice: Slice = { venue: venue.id, account: 2, amountIn: 200_000n, expectedOut: 10n ** 17n, delayMs: 0 };
  const txs = await venue.build!(slice, intent(testUsdc, testMon), ME);
  expect(txs.map((t) => t.to)).toEqual([
    TEST_POOL_TOKENS.USDC.address,
    UNISWAP_V4_MONAD_TESTNET.permit2,
    UNISWAP_V4_MONAD_TESTNET.universalRouter,
  ]);
  expect(txs.every((t) => t.value === 0n)).toBe(true);
});
