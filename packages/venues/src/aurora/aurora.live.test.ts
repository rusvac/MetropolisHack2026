// live tests: aurora's mainnet token list and quote, circle's sandbox fee api, and the cctp contracts on testnet.
// read-only. they run only with LIVE=1, so `bun run check` stays offline: LIVE=1 bun test aurora.live
import { describe, expect, test } from "bun:test";
import { createPublicClient, http, parseAbi } from "viem";
import { baseSepolia, monadTestnet } from "viem/chains";
import { AURORA_API_BASE, AURORA_ASSETS, MONAD_MON, MONAD_USDC, createAuroraBridge, type AuroraToken } from "./index.ts";
import { CCTP_TESTNET, getCctpFees, quoteCctpTestnet } from "./cctp.ts";

const LIVE = process.env.LIVE === "1";
const HAS_KEY = Boolean(process.env.AURORA_API_KEY?.trim());
const bridgeIn = { fromChain: "base", fromToken: "USDC", amount: 100_000_000n };

describe.skipIf(!LIVE)("aurora, mainnet, live", () => {
  test("the token list holds every asset id this venue uses", async () => {
    const res = await fetch(`${AURORA_API_BASE}/api/tokens/public`);
    const { tokens } = (await res.json()) as { tokens: AuroraToken[] };
    for (const a of Object.values(AURORA_ASSETS)) {
      const t = tokens.find((x) => x.assetId === a.assetId);
      expect(t?.decimals).toBe(a.decimals);
    }
  }, 20_000);

  test("without a key, the quote is priced from the live token list", async () => {
    const q = await createAuroraBridge().quoteBridgeTo(bridgeIn, MONAD_MON);
    expect(q.simulated).toBe(true);
    expect(q.source).toBe("aurora-prices");
    expect(q.amountOut).toBeGreaterThan(0n);
  }, 20_000);

  test.skipIf(!HAS_KEY)("with the key, a real dry quote for 100 USDC into USDC and into MON", async () => {
    const venue = createAuroraBridge({ apiKey: process.env.AURORA_API_KEY, onError: "throw" });
    const usdc = await venue.quoteBridge(bridgeIn, MONAD_USDC);
    const mon = await venue.quoteBridge(bridgeIn, MONAD_MON);
    expect(usdc.simulated).toBe(false);
    expect(mon.simulated).toBe(false);
    expect(usdc.amountOut).toBeGreaterThan(95_000_000n);
    expect(mon.amountOut).toBeGreaterThan(0n);
  }, 30_000);
});

describe.skipIf(!LIVE)("cctp v2, testnet, live", () => {
  test("circle quotes base sepolia (6) to monad testnet (15) with forwarding", async () => {
    const fees = await getCctpFees(6, 15, { forward: true });
    expect(fees.find((f) => f.finalityThreshold === 2000)?.forwardFee?.med).toBeGreaterThan(0);
    const q = await quoteCctpTestnet(2_000_000n);
    expect(q.amountOut).toBeLessThan(2_000_000n);
    expect(q.amountOut).toBeGreaterThan(1_800_000n);
  }, 20_000);

  test("the message transmitter reports domain 6 on base sepolia and 15 on monad testnet", async () => {
    const abi = parseAbi(["function localDomain() view returns (uint32)"]);
    const base = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL) });
    const monad = createPublicClient({ chain: monadTestnet, transport: http(process.env.MONAD_TESTNET_RPC_URL) });
    const read = (c: typeof base | typeof monad) =>
      c.readContract({ address: CCTP_TESTNET.messageTransmitterV2, abi, functionName: "localDomain" });
    expect(await read(base)).toBe(6);
    expect(await read(monad)).toBe(15);
  }, 20_000);
});
