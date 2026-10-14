// offline tests for the aurora bridge and the cctp testnet bridge. no key, no network: fetch is faked
import { describe, expect, test } from "bun:test";
import { decodeFunctionData, parseAbi, type Address } from "viem";
import type { Token } from "@spidereum/core";
import {
  AURORA_ASSETS,
  MONAD_MON,
  MONAD_USDC,
  createAuroraBridge,
  resolveDestinationAsset,
  resolveOriginAsset,
  type AuroraQuoteBody,
} from "./index.ts";
import {
  CCTP_TESTNET,
  FORWARDING_HOOK_DATA,
  buildCctpBurnTxs,
  getCctpMessage,
  planCctpTransfer,
  type CctpFee,
} from "./cctp.ts";

const USDC_6 = 1_000_000n;
const bridgeIn = { fromChain: "base", fromToken: "USDC", amount: 1_000n * USDC_6 };
const monadTestnetUsdc: Token = {
  chainId: 10143,
  symbol: "USDC",
  address: "0x534b2f3a21130d7a60830c2df862319e593943a3",
  decimals: 6,
};
const recipient: Address = "0x1111111111111111111111111111111111111111";
const refundTo: Address = "0x2222222222222222222222222222222222222222";

const tokenList = {
  tokens: [
    { ...AURORA_ASSETS.baseUsdc, price: 1, priceUpdatedAt: "2026-10-13T00:00:00Z" },
    { ...AURORA_ASSETS.monadUsdc, price: 1, priceUpdatedAt: "2026-10-13T00:00:00Z" },
    { ...AURORA_ASSETS.monadMon, price: 0.025, priceUpdatedAt: "2026-10-13T00:00:00Z" },
  ],
};

interface Call {
  url: string;
  method: string;
  body?: AuroraQuoteBody;
}

/** a fetch that records calls and answers by path */
function fakeFetch(answer: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return answer(call);
  };
  return { fetch: f as typeof fetch, calls };
}

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

function auroraQuote(body: AuroraQuoteBody) {
  const usdcOut = body.destinationAsset === AURORA_ASSETS.monadUsdc.assetId;
  return {
    correlationId: "c-1",
    quote: {
      timeEstimate: 24,
      amountIn: body.amount,
      amountInUsd: String(Number(body.amount) / 1e6),
      amountOut: usdcOut ? String((BigInt(body.amount) * 9_990n) / 10_000n) : "39960000000000000000",
      amountOutUsd: String((Number(body.amount) / 1e6) * 0.999),
      minAmountOut: usdcOut ? String((BigInt(body.amount) * 9_890n) / 10_000n) : "39560000000000000000",
      withdrawFee: "1000",
    },
  };
}

describe("asset ids", () => {
  test("base usdc resolves by symbol, by address, and from base sepolia", () => {
    expect(resolveOriginAsset("base", "USDC")?.assetId).toBe(AURORA_ASSETS.baseUsdc.assetId);
    expect(resolveOriginAsset("8453", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")?.assetId).toBe(
      AURORA_ASSETS.baseUsdc.assetId,
    );
    expect(resolveOriginAsset("84532", "usdc")?.assetId).toBe(AURORA_ASSETS.baseUsdc.assetId);
    expect(resolveOriginAsset("solana", "USDC")).toBeUndefined();
  });

  test("monad testnet usdc and native mon map to their mainnet assets", () => {
    expect(resolveDestinationAsset(monadTestnetUsdc)?.assetId).toBe(AURORA_ASSETS.monadUsdc.assetId);
    expect(resolveDestinationAsset(MONAD_USDC)?.assetId).toBe(AURORA_ASSETS.monadUsdc.assetId);
    expect(resolveDestinationAsset(MONAD_MON)?.assetId).toBe(AURORA_ASSETS.monadMon.assetId);
    expect(resolveDestinationAsset({ ...MONAD_MON, chainId: 10143 })?.assetId).toBe(AURORA_ASSETS.monadMon.assetId);
  });
});

describe("createAuroraBridge without a key", () => {
  test("prices from aurora's token list, says simulated, and never calls the quote endpoint", async () => {
    const { fetch, calls } = fakeFetch(() => json(tokenList));
    const venue = createAuroraBridge({ fetch });
    expect(venue.live).toBe(false);

    const q = await venue.quoteBridge(bridgeIn, monadTestnetUsdc);

    expect(q.venue).toBe("aurora");
    expect(q.simulated).toBe(true);
    expect(q.to).toEqual(monadTestnetUsdc);
    // stable to stable: 2 bps aurora floor plus 5 bps estimated spread
    expect(q.amountOut).toBe(999_300_000n);
    expect(calls.every((c) => c.url.includes("/api/tokens/"))).toBe(true);
  });

  test("falls back to fixed prices when the token list is unreachable", async () => {
    const { fetch } = fakeFetch(() => {
      throw new Error("offline");
    });
    const q = await createAuroraBridge({ fetch }).quoteBridgeTo(bridgeIn, MONAD_MON);
    expect(q.simulated).toBe(true);
    expect(q.source).toBe("fixed-prices");
    expect(q.amountOut).toBeGreaterThan(0n);
  });
});

describe("createAuroraBridge with a key", () => {
  test("sends a dry EXACT_INPUT quote with aurora's asset ids and parses the answer", async () => {
    const { fetch, calls } = fakeFetch((c) => (c.body ? json(auroraQuote(c.body)) : json(tokenList)));
    const venue = createAuroraBridge({ apiKey: "k-test", fetch, recipient, refundTo });
    expect(venue.live).toBe(true);

    const q = await venue.quoteBridge(bridgeIn, monadTestnetUsdc);

    const quoteCall = calls.find((c) => c.method === "POST")!;
    expect(quoteCall.url).toBe("https://intents-api.aurora.dev/api/quote/k-test");
    expect(quoteCall.body).toMatchObject({
      dry: true,
      swapType: "EXACT_INPUT",
      depositType: "ORIGIN_CHAIN",
      originAsset: AURORA_ASSETS.baseUsdc.assetId,
      destinationAsset: AURORA_ASSETS.monadUsdc.assetId,
      amount: "1000000000",
      recipient,
      refundTo,
      recipientType: "DESTINATION_CHAIN",
    });
    expect(q.simulated).toBe(false);
    expect(q.source).toBe("aurora-quote");
    expect(q.amountOut).toBe(999_000_000n);
    expect(q.minAmountOut).toBe(989_000_000n);
    expect(q.etaSeconds).toBe(24);
    expect(q.costBps).toBeCloseTo(10, 5);
  });

  test("an aurora error gives a simulated quote with the reason, or throws when asked", async () => {
    const refuse = () => fakeFetch((c) => (c.method === "POST" ? json({ message: "Application key not found" }, 404) : json(tokenList)));
    const q = await createAuroraBridge({ apiKey: "bad", fetch: refuse().fetch }).quoteBridge(bridgeIn, monadTestnetUsdc);
    expect(q.simulated).toBe(true);
    expect((q as { note?: string }).note).toContain("404");

    const strict = createAuroraBridge({ apiKey: "bad", fetch: refuse().fetch, onError: "throw" });
    await expect(strict.quoteBridge(bridgeIn, monadTestnetUsdc)).rejects.toThrow("404");
  });

  test("the gas leg quotes native MON for the same recipient", async () => {
    const { fetch, calls } = fakeFetch((c) => (c.body ? json(auroraQuote(c.body)) : json(tokenList)));
    const venue = createAuroraBridge({ apiKey: "k-test", fetch });
    const { main, gas } = await venue.quoteBridgeWithGas(bridgeIn, monadTestnetUsdc, { amountIn: 1n * USDC_6 }, { recipient });

    const bodies = calls.filter((c) => c.body).map((c) => c.body!);
    expect(bodies.map((b) => b.amount).sort()).toEqual(["1000000", "999000000"]);
    expect(bodies.find((b) => b.amount === "1000000")!.destinationAsset).toBe(AURORA_ASSETS.monadMon.assetId);
    expect(bodies.every((b) => b.recipient === recipient)).toBe(true);
    expect(main.to).toEqual(monadTestnetUsdc);
    expect(gas.to).toEqual(MONAD_MON);
    expect(gas.amountOut).toBe(39_960_000_000_000_000_000n);
  });

  test("confidential mode adds aurora's confidentiality flag, public sends none", async () => {
    const { fetch, calls } = fakeFetch((c) => (c.body ? json(auroraQuote(c.body)) : json(tokenList)));
    const venue = createAuroraBridge({ apiKey: "k-test", fetch });
    await venue.quoteBridge(bridgeIn, monadTestnetUsdc);
    await venue.quoteBridgeTo(bridgeIn, monadTestnetUsdc, { confidentiality: "advanced" });
    const bodies = calls.filter((c) => c.body).map((c) => c.body!);
    expect(bodies[0]!.confidentiality).toBeUndefined();
    expect(bodies[1]!.confidentiality).toBe("advanced");
  });

  test("a real quote refuses the dry-run placeholder address", async () => {
    const { fetch } = fakeFetch(() => json(tokenList));
    const venue = createAuroraBridge({ apiKey: "k-test", fetch });
    await expect(venue.quoteBridgeTo(bridgeIn, monadTestnetUsdc, { dry: false })).rejects.toThrow("real recipient");
  });
});

describe("createAuroraBridge through the server proxy", () => {
  test("calls the proxy and sends no key", async () => {
    const { fetch, calls } = fakeFetch((c) => (c.body ? json(auroraQuote(c.body)) : json(tokenList)));
    const venue = createAuroraBridge({ proxyUrl: "http://localhost:8787/aurora/", fetch });
    const q = await venue.quoteBridge(bridgeIn, monadTestnetUsdc);
    expect(calls[0]!.url).toBe("http://localhost:8787/aurora/quote");
    expect(JSON.stringify(calls)).not.toContain("api/quote");
    expect(q.simulated).toBe(false);
  });

  test("the proxy's 503 for a missing key gives a simulated quote", async () => {
    const { fetch } = fakeFetch((c) =>
      c.method === "POST" ? json({ error: "AURORA_API_KEY is empty on the server" }, 503) : json(tokenList),
    );
    const q = await createAuroraBridge({ proxyUrl: "http://x/aurora", fetch }).quoteBridge(bridgeIn, monadTestnetUsdc);
    expect(q.simulated).toBe(true);
    expect(q.amountOut).toBe(999_300_000n);
  });
});

describe("cctp v2 testnet bridge", () => {
  const fees: CctpFee[] = [
    { finalityThreshold: 1000, minimumFee: 1.3, forwardFee: { low: 51322, med: 51448, high: 51574 } },
    { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 51322, med: 51448, high: 51574 } },
  ];

  test("the forwarding hook is 'cctp-forward' padded to 24 bytes, then version 0 and length 0", () => {
    const bytes = Buffer.from(FORWARDING_HOOK_DATA.slice(2), "hex");
    expect(bytes.length).toBe(32);
    expect(bytes.subarray(0, 12).toString("utf8")).toBe("cctp-forward");
    expect(bytes.subarray(12).every((b) => b === 0)).toBe(true);
  });

  test("standard transfer: the fee is the forwarding fee only", () => {
    const plan = planCctpTransfer(2n * USDC_6, fees, { fast: false });
    expect(plan.minFinalityThreshold).toBe(2000);
    expect(plan.maxFee).toBe(51_448n);
    expect(plan.minAmountOut).toBe(2_000_000n - 51_448n);
  });

  test("fast transfer adds 1.3 bps, rounded up", () => {
    const plan = planCctpTransfer(10n * USDC_6, fees, { fast: true });
    expect(plan.protocolFee).toBe(1_300n);
    expect(plan.maxFee).toBe(52_748n);
  });

  test("an amount below the fees is refused", () => {
    expect(() => planCctpTransfer(50_000n, fees)).toThrow("does not cover");
  });

  test("approve then depositForBurnWithHook to domain 15, recipient padded to 32 bytes", () => {
    const plan = planCctpTransfer(2n * USDC_6, fees, { fast: false });
    const to: Address = "0x3333333333333333333333333333333333333333";
    const [approve, burn] = buildCctpBurnTxs(plan, to);

    expect(approve!.to).toBe(CCTP_TESTNET.usdc.baseSepolia);
    expect(burn!.to).toBe(CCTP_TESTNET.tokenMessengerV2);
    const decoded = decodeFunctionData({
      abi: parseAbi([
        "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
      ]),
      data: burn!.data,
    });
    expect(decoded.functionName).toBe("depositForBurnWithHook");
    const [amount, domain, mintRecipient, burnToken, , maxFee, finality, hook] = decoded.args;
    expect(amount).toBe(2_000_000n);
    expect(domain).toBe(15);
    expect(mintRecipient).toBe(`0x${"0".repeat(24)}${to.slice(2)}`);
    expect(burnToken.toLowerCase()).toBe(CCTP_TESTNET.usdc.baseSepolia.toLowerCase());
    expect(maxFee).toBe(51_448n);
    expect(finality).toBe(2000);
    expect(hook).toBe(FORWARDING_HOOK_DATA);
  });

  test("the message api: 404 is pending, a forwardTxHash is the mint", async () => {
    const hash = `0x${"ab".repeat(32)}` as const;
    const pending = await getCctpMessage(hash, { fetch: (async () => json({}, 404)) as unknown as typeof fetch });
    expect(pending.status).toBe("pending");

    const mint = `0x${"cd".repeat(32)}`;
    const done = await getCctpMessage(hash, {
      fetch: (async () => json({ messages: [{ status: "complete", forwardTxHash: mint }] })) as unknown as typeof fetch,
    });
    expect(done.status).toBe("forwarded");
    expect(done.explorer).toBe(`https://testnet.monadexplorer.com/tx/${mint}`);
  });
});
