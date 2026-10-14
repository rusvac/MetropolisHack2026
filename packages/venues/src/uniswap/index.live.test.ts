// live tests. the quotes are read-only and run when the RPC urls are in .env.
// the swap spends gas from swarm account 2 (lane L2's account), so it runs only with L2_LIVE_SWAP=1:
//   L2_LIVE_SWAP=1 bun test packages/venues/src/uniswap/index.live.test.ts
import { expect, test } from "bun:test";
import { createPublicClient, createWalletClient, erc20Abi, formatEther, formatUnits, http, parseEther } from "viem";
import { monadTestnet, type Intent, type Slice } from "@spidereum/core";
import { deriveSwarmAccount } from "../../../swarm/src/addresses.ts";
import { TEST_POOL_DEPLOYMENT } from "./pool/deployment.ts";
import { createTestPoolVenue, TEST_POOL_TOKENS } from "./testpool.ts";
import { createUniswapVenue, MONAD_MAINNET_TOKENS } from "./v4.ts";
import { createUniswapTestnetVenue } from "./v4-testnet.ts";

const hasMainnet = !!process.env.MONAD_RPC_URL;
const hasTestnet = !!process.env.MONAD_TESTNET_RPC_URL;
const hasPool = hasTestnet && !!TEST_POOL_DEPLOYMENT.address;
const swapOn = process.env.L2_LIVE_SWAP === "1" && !!process.env.BURNER_MNEMONIC;
const explorer = (h: string) => `https://testnet.monadexplorer.com/tx/${h}`;

/**
 * monad's reserve balance rule: an account below 10 MON can send MON only if it sent nothing in the previous
 * 3 blocks. before a transaction with value, wait until 3 blocks pass after the account's last one
 */
async function waitReserveBlocks(pub: { getBlockNumber(): Promise<bigint> }) {
  const now = await pub.getBlockNumber();
  while ((await pub.getBlockNumber()) <= now + 3n) await Bun.sleep(400);
}

test.skipIf(!hasMainnet)(
  "uniswap v4 on monad mainnet quotes MON/USDC both ways from the Quoter",
  async () => {
    const venue = createUniswapVenue();
    const { USDC, MON } = MONAD_MAINNET_TOKENS;
    const buy = await venue.quote({ sell: USDC, buy: MON, amountIn: 1_000n * 10n ** 6n });
    const sell = await venue.quote({ sell: MON, buy: USDC, amountIn: 10_000n * 10n ** 18n });
    console.log(
      `uniswap-v4 (monad mainnet): 1000 USDC -> ${formatEther(buy.amountOut)} MON, fee ${buy.feeBps} bps, gas ${buy.gasUnits}; ` +
        `10000 MON -> ${formatUnits(sell.amountOut, 6)} USDC`,
    );
    expect(buy.simulated).toBe(false);
    expect(buy.amountOut).toBeGreaterThan(0n);
    expect(sell.amountOut).toBeGreaterThan(0n);
    // the round trip loses fees and impact, never gains
    const usdcPerMon = Number(sell.amountOut) / 1e6 / 10_000;
    const monPerUsdc = Number(buy.amountOut) / 1e18 / 1_000;
    expect(usdcPerMon * monPerUsdc).toBeLessThan(1);
    expect(usdcPerMon * monPerUsdc).toBeGreaterThan(0.9);
    // a bigger trade gets a worse price: the reason to split
    const big = await venue.quote({ sell: USDC, buy: MON, amountIn: 100_000n * 10n ** 6n });
    expect(Number(big.amountOut) / 100_000).toBeLessThan(Number(buy.amountOut) / 1_000);
  },
  30_000,
);

test.skipIf(!hasPool)(
  "the test pool on monad testnet quotes from its live reserves",
  async () => {
    const venue = createTestPoolVenue();
    const s = await venue.state();
    console.log(
      `test pool ${s.address} (monad testnet): ${formatEther(s.reserveMon)} MON, ${formatUnits(s.reserveUsdc, 6)} USDC, ${s.midPrice.toFixed(4)} USDC per MON`,
    );
    expect(s.reserveMon).toBeGreaterThan(0n);
    expect(s.reserveUsdc).toBeGreaterThan(0n);
    const q = await venue.quote({ sell: TEST_POOL_TOKENS.USDC, buy: TEST_POOL_TOKENS.MON, amountIn: 100_000n });
    expect(q.venue).toBe("test-pool");
    expect(q.amountOut).toBeGreaterThan(0n);
  },
  30_000,
);

test.skipIf(!hasTestnet)(
  "uniswap v4 on monad testnet quotes MON/USDC from the testnet Quoter",
  async () => {
    const venue = createUniswapTestnetVenue();
    const q = await venue.quote({ sell: TEST_POOL_TOKENS.USDC, buy: TEST_POOL_TOKENS.MON, amountIn: 500_000n });
    console.log(`uniswap-v4 (monad testnet, Monad-maintained): 0.5 USDC -> ${formatEther(q.amountOut)} MON`);
    expect(q.amountOut).toBeGreaterThan(0n);
  },
  30_000,
);

test.skipIf(!(swapOn && hasPool))(
  "account 2 swaps MON to USDC and USDC to MON on the test pool",
  async () => {
    const account = deriveSwarmAccount(process.env.BURNER_MNEMONIC!.trim(), 10143, 2);
    const transport = http(process.env.MONAD_TESTNET_RPC_URL);
    const pub = createPublicClient({ chain: monadTestnet, transport });
    const wallet = createWalletClient({ chain: monadTestnet, transport, account });
    const venue = createTestPoolVenue();
    const { MON, USDC } = TEST_POOL_TOKENS;
    const usdcOf = () =>
      pub.readContract({ address: USDC.address, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });

    async function run(sell: typeof MON | typeof USDC, buy: typeof MON | typeof USDC, amountIn: bigint) {
      const q = await venue.quote({ sell, buy, amountIn });
      const intent: Intent = { id: "l2-live", sell, buy, amountIn, maxSlippageBps: 100, privacyWeight: 0 };
      const slice: Slice = { venue: venue.id, account: 2, amountIn, expectedOut: q.amountOut, delayMs: 0 };
      const txs = await venue.build!(slice, intent, account.address);
      const receipts = [];
      for (const t of txs) {
        if (t.value > 0n) await waitReserveBlocks(pub);
        const hash = await wallet.sendTransaction({ to: t.to, data: t.data, value: t.value });
        const r = await pub.waitForTransactionReceipt({ hash });
        console.log(`  ${r.status} ${explorer(hash)} gas used ${r.gasUsed}`);
        expect(r.status).toBe("success");
        receipts.push(r);
      }
      return { q, receipts };
    }

    const usdc0 = await usdcOf();
    console.log(`swap 0.01 MON -> USDC on the test pool`);
    const a = await run(MON, USDC, parseEther("0.01"));
    const usdc1 = await usdcOf();
    expect(usdc1 - usdc0).toBe(a.q.amountOut);

    console.log(`swap 0.05 USDC -> MON on the test pool`);
    const b = await run(USDC, MON, 50_000n);
    const usdc2 = await usdcOf();
    expect(usdc1 - usdc2).toBe(50_000n);
    console.log(
      `  got ${formatUnits(a.q.amountOut, 6)} USDC for 0.01 MON, and ${formatEther(b.q.amountOut)} MON for 0.05 USDC (test pool)`,
    );
  },
  120_000,
);

test.skipIf(!(swapOn && hasTestnet))(
  "account 2 swaps MON to USDC and USDC to MON through the testnet universal router",
  async () => {
    const account = deriveSwarmAccount(process.env.BURNER_MNEMONIC!.trim(), 10143, 2);
    const transport = http(process.env.MONAD_TESTNET_RPC_URL);
    const pub = createPublicClient({ chain: monadTestnet, transport });
    const wallet = createWalletClient({ chain: monadTestnet, transport, account });
    const venue = createUniswapTestnetVenue();
    const { MON, USDC } = TEST_POOL_TOKENS;
    for (const [sell, buy, amountIn] of [
      [MON, USDC, parseEther("0.01")],
      [USDC, MON, 50_000n],
    ] as const) {
      const q = await venue.quote({ sell, buy, amountIn });
      const intent: Intent = { id: "l2-live-v4", sell, buy, amountIn, maxSlippageBps: 100, privacyWeight: 0 };
      const slice: Slice = { venue: venue.id, account: 2, amountIn, expectedOut: q.amountOut, delayMs: 0 };
      console.log(`swap ${sell.symbol} -> ${buy.symbol} on uniswap v4 (testnet), quoted ${q.amountOut}`);
      for (const t of await venue.build!(slice, intent, account.address)) {
        if (t.value > 0n) await waitReserveBlocks(pub);
        const hash = await wallet.sendTransaction({ to: t.to, data: t.data, value: t.value });
        const r = await pub.waitForTransactionReceipt({ hash });
        console.log(`  ${r.status} ${explorer(hash)} gas used ${r.gasUsed}`);
        expect(r.status).toBe("success");
      }
    }
  },
  120_000,
);
