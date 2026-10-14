// live checks. they skip unless asked, so `bun run check` stays offline:
//   LIVE=1 bun test packages/venues/src/kuru          read-only: mainnet quotes, the testnet book
//   LIVE=1 KURU_SWAP=1 bun test packages/venues/src/kuru   also sends two real swaps on monad testnet
//                                                          from swarm account 1 (lane L1's account)
import { describe, expect, test } from "bun:test";
import { createWalletClient, http, parseEther, parseEventLogs, type Hex } from "viem";
import { monadTestnet } from "@spidereum/core";
import type { Intent, Token } from "@spidereum/core";
import { deriveSwarmAccount } from "../../../swarm/src/addresses.ts";
import { erc20Abi, orderBookAbi } from "./abi.ts";
import { KURU, clientFor, createKuruVenue } from "./index.ts";

const LIVE = process.env.LIVE === "1";
const SWAP = LIVE && process.env.KURU_SWAP === "1";

// tokens as the plan names them: mainnet addresses. the venue maps them onto the testnet market by symbol
const MON: Token = { chainId: 143, symbol: "MON", address: "0x0000000000000000000000000000000000000000", decimals: 18 };
const USDC: Token = { chainId: 143, symbol: "USDC", address: KURU.mainnet.usdc, decimals: 6 };

describe.skipIf(!LIVE)("kuru live, read-only", () => {
  const venue = createKuruVenue();

  test("mainnet quotes both ways, with price impact on size", async () => {
    const small = await venue.quote({ sell: MON, buy: USDC, amountIn: parseEther("100") });
    const large = await venue.quote({ sell: MON, buy: USDC, amountIn: parseEther("1000000") });
    const buy = await venue.quote({ sell: USDC, buy: MON, amountIn: 100_000_000n });
    const pxSmall = Number(small.amountOut) / 1e6 / 100;
    const pxLarge = Number(large.amountOut) / 1e6 / 1_000_000;
    console.log(`mainnet: 100 MON -> ${Number(small.amountOut) / 1e6} USDC (${pxSmall.toFixed(6)} each), gas ${small.gasUnits}`);
    console.log(`mainnet: 1,000,000 MON -> ${Number(large.amountOut) / 1e6} USDC (${pxLarge.toFixed(6)} each)`);
    console.log(`mainnet: 100 USDC -> ${Number(buy.amountOut) / 1e18} MON`);
    expect(small.simulated).toBe(false);
    expect(small.amountOut).toBeGreaterThan(0n);
    expect(buy.amountOut).toBeGreaterThan(0n);
    expect(pxLarge).toBeLessThan(pxSmall);
  }, 30_000);

  test("the testnet execution market has both sides", async () => {
    const sell = await venue.quoteExecution({ sell: MON, buy: USDC, amountIn: parseEther("0.1") });
    const buy = await venue.quoteExecution({ sell: USDC, buy: MON, amountIn: 1_000n });
    console.log(`testnet ${venue.describe().execution.market}: 0.1 MON -> ${Number(sell.amountOut) / 1e6} USDC, 0.001 USDC -> ${Number(buy.amountOut) / 1e18} MON`);
    expect(sell.amountOut).toBeGreaterThan(0n);
    expect(buy.amountOut).toBeGreaterThan(0n);
  }, 30_000);
});

describe.skipIf(!SWAP)("kuru live swap on monad testnet, from swarm account 1", () => {
  const mnemonic = process.env.BURNER_MNEMONIC?.trim() ?? "";
  const account = deriveSwarmAccount(mnemonic, 10143, 1);
  const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(process.env.MONAD_TESTNET_RPC_URL) });
  const testnet = clientFor("testnet");
  const venue = createKuruVenue();

  async function run(intent: Intent) {
    const quote = await venue.quote({ sell: intent.sell, buy: intent.buy, amountIn: intent.amountIn });
    const txs = await venue.build!(
      { venue: "kuru", account: 1, amountIn: intent.amountIn, expectedOut: quote.amountOut, delayMs: 0 },
      intent,
      account.address,
    );
    let last: Hex | undefined;
    for (const tx of txs) {
      // monad charges the gas limit. pad the estimate: a native-value call can run out at the exact estimate
      const gas = await testnet.estimateGas({ account: account.address, ...tx });
      const hash = await wallet.sendTransaction({ ...tx, gas: (gas * 13n) / 10n });
      const receipt = await testnet.waitForTransactionReceipt({ hash });
      console.log(`${receipt.status} ${KURU.testnet.explorer}/tx/${hash}`);
      expect(receipt.status).toBe("success");
      last = hash;
    }
    const receipt = await testnet.getTransactionReceipt({ hash: last! });
    const trades = parseEventLogs({ abi: orderBookAbi, logs: receipt.logs, eventName: "Trade" });
    return { quote, trades, hash: last! };
  }

  test("sell 0.1 MON for circle USDC", async () => {
    const before = await testnet.readContract({ address: KURU.testnet.circleUsdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    const { quote, trades } = await run({ id: "kuru-live-sell", sell: MON, buy: USDC, amountIn: parseEther("0.1"), maxSlippageBps: 100, privacyWeight: 0 });
    const after = await testnet.readContract({ address: KURU.testnet.circleUsdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    console.log(`sold 0.1 MON: plan said ${quote.amountOut} (mainnet), got ${after - before} atomic USDC on testnet, ${trades.length} fill(s)`);
    expect(trades.length).toBeGreaterThan(0);
    expect(after - before).toBeGreaterThan(0n);
  }, 90_000);

  test("buy MON with 0.005 circle USDC", async () => {
    const { quote, trades } = await run({ id: "kuru-live-buy", sell: USDC, buy: MON, amountIn: 5_000n, maxSlippageBps: 100, privacyWeight: 0 });
    const filled = trades.reduce((sum, t) => sum + t.args.filledSize, 0n);
    console.log(`bought with 0.005 USDC: plan said ${quote.amountOut} wei (mainnet), filled ${filled} size units on testnet`);
    expect(trades.length).toBeGreaterThan(0);
  }, 90_000);
});
