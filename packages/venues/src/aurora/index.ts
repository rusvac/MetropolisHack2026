// lane L4: the bridge leg. usdc on base into monad through aurora intents (the swap api, a 1click wrapper).
// docs: https://docs.intents.aurora.dev/llms-full.txt ("what is swap api?" and "swap api reference").
// aurora has no testnet, so these quotes are mainnet and read-only (`dry: true`). no deposit address is reserved.
//
// the api key stays on the server. two ways to reach aurora:
// - server code: createAuroraBridge({ apiKey }) calls intents-api.aurora.dev directly
// - anything else: createAuroraBridge({ proxyUrl }) calls apps/server/src/aurora.ts, which adds the key
// with neither, or when aurora refuses, the quote is priced from aurora's live token list and says simulated: true
import type { Address } from "viem";
import type { BridgeQuote, BridgeVenue, Intent, Token } from "@spidereum/core";
import {
  type AuroraAsset,
  AURORA_ASSETS,
  MONAD_MON,
  MONAD_USDC,
  resolveDestinationAsset,
  resolveOriginAsset,
  rescale,
} from "./assets.ts";

export { AURORA_ASSETS, MONAD_MON, MONAD_USDC, resolveDestinationAsset, resolveOriginAsset } from "./assets.ts";
export type { AuroraAsset } from "./assets.ts";

export const AURORA_API_BASE = "https://intents-api.aurora.dev";

/** the path segment used for the token list when no key is set. the token list answers any key */
export const AURORA_PUBLIC_KEY_SEGMENT = "public";

/** dry quotes need a recipient and a refund address. no funds move, so a burn address is enough */
export const DRY_RUN_ADDRESS: Address = "0x000000000000000000000000000000000000dEaD";

export type BridgeRequest = NonNullable<Intent["bridgeIn"]>;

/** where the numbers came from. only "aurora-quote" is live */
export type AuroraQuoteSource = "aurora-quote" | "aurora-prices" | "fixed-prices";

/** a `BridgeQuote` plus what aurora reports. every extra field is optional for the screens */
export interface AuroraBridgeQuote extends BridgeQuote {
  source: AuroraQuoteSource;
  originAsset: string;
  destinationAsset: string;
  /** the amount aurora guarantees after slippage, in atomic units of `to` */
  minAmountOut: bigint;
  amountInUsd?: number;
  amountOutUsd?: number;
  /** total cost of the bridge as basis points of the input value: fees, spread, and withdraw fee */
  costBps?: number;
  /** aurora's fee to send the output to the recipient, already taken out of amountOut */
  withdrawFee?: bigint;
  recipient: Address;
  correlationId?: string;
  /** why the quote is simulated, when it is */
  note?: string;
}

/** the subset of aurora's POST /api/quote body this venue sends. field names are aurora's */
export interface AuroraQuoteBody {
  dry: boolean;
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT" | "ANY_INPUT";
  depositType: "ORIGIN_CHAIN" | "INTENTS";
  depositMode?: "SIMPLE" | "MEMO";
  originAsset: string;
  destinationAsset: string;
  amount: string;
  slippageTolerance: number;
  refundTo: string;
  refundType: "ORIGIN_CHAIN" | "INTENTS";
  recipient: string;
  recipientType: "DESTINATION_CHAIN" | "INTENTS";
  quoteWaitingTimeMs?: number;
  /** aurora's confidential intents: hides the origin wallet and the route. the monad side stays public */
  confidentiality?: Confidentiality;
}

/** "public" is aurora's default. "basic" and "advanced" settle on confidential intents rails */
export type Confidentiality = "public" | "basic" | "advanced";

/** aurora's quote response. only the fields this venue reads */
export interface AuroraQuoteResponse {
  correlationId?: string;
  quote: {
    timeEstimate: number;
    amountIn: string;
    amountInUsd?: string;
    amountOut: string;
    amountOutUsd?: string;
    minAmountOut: string;
    withdrawFee?: string;
    depositAddress?: string;
    deadline?: string;
  };
}

export interface AuroraToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  priceUpdatedAt: string;
  contractAddress?: string;
}

export interface AuroraBridgeOptions {
  /** server code only. never pass this in apps/web */
  apiKey?: string;
  /** base url of the server's aurora routes, for example "http://localhost:8787/aurora". the server adds the key */
  proxyUrl?: string;
  /** defaults to intents-api.aurora.dev */
  baseUrl?: string;
  /** monad address that receives. a dry quote does not need a real one */
  recipient?: Address;
  /** address on the source chain for refunds. a dry quote does not need a real one */
  refundTo?: Address;
  /** slippage in basis points. aurora's examples use 100 */
  slippageBps?: number;
  /** "simulate" (default) returns a simulated quote when aurora fails. "throw" raises the error */
  onError?: "simulate" | "throw";
  /** default "public". the "confidential swaps" page: one flag on the same quote endpoint */
  confidentiality?: Confidentiality;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface QuoteBridgeOptions {
  recipient?: Address;
  refundTo?: Address;
  /** false reserves a deposit address. only for a real bridge, never for the plan */
  dry?: boolean;
  confidentiality?: Confidentiality;
}

export interface AuroraBridge extends BridgeVenue {
  quoteBridge(req: BridgeRequest, to: Token): Promise<AuroraBridgeQuote>;
  /** quoteBridge with a recipient and refund address per call, for one bridge move per swarm account */
  quoteBridgeTo(req: BridgeRequest, to: Token, opts?: QuoteBridgeOptions): Promise<AuroraBridgeQuote>;
  /**
   * the gas question: aurora delivers native MON as a destination asset, so one small extra quote into MON
   * puts gas in the receiving account from a solver, not from swarm account 0. returns both legs
   */
  quoteBridgeWithGas(
    req: BridgeRequest,
    to: Token,
    gas: { amountIn: bigint },
    opts?: QuoteBridgeOptions,
  ): Promise<{ main: AuroraBridgeQuote; gas: AuroraBridgeQuote }>;
  /** true when quotes can come from aurora's live quote endpoint (a key here, or a proxy) */
  readonly live: boolean;
}

// aurora's documented fee floor: 2 bps on stables, 10 bps on the rest (the "api keys & fees" page).
// the simulation adds an estimate of solver spread on top, since the real quote includes it
const SIM_SOLVER_SPREAD_BPS = 5;
const SIM_ETA_SECONDS = 60;
// last resort when the token list is unreachable. read from aurora's token list on 13 oct 2026
const FIXED_PRICES_USD: Record<string, number> = {
  [AURORA_ASSETS.baseUsdc.assetId]: 1,
  [AURORA_ASSETS.monadUsdc.assetId]: 1,
  [AURORA_ASSETS.monadUsdt0.assetId]: 1,
  [AURORA_ASSETS.monadMon.assetId]: 0.0244,
  [AURORA_ASSETS.baseEth.assetId]: 2498,
};
const TOKEN_LIST_TTL_MS = 5 * 60_000;

export function createAuroraBridge(opts: AuroraBridgeOptions = {}): AuroraBridge {
  const apiKey = opts.apiKey?.trim() || undefined;
  const proxyUrl = opts.proxyUrl?.replace(/\/+$/, "");
  const baseUrl = (opts.baseUrl ?? AURORA_API_BASE).replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const slippageBps = opts.slippageBps ?? 100;
  const onError = opts.onError ?? "simulate";
  const live = Boolean(apiKey || proxyUrl);

  let tokenCache: { at: number; tokens: AuroraToken[] } | undefined;

  function url(endpoint: "quote" | "tokens"): string {
    if (proxyUrl) return `${proxyUrl}/${endpoint}`;
    const key = apiKey ?? AURORA_PUBLIC_KEY_SEGMENT;
    return `${baseUrl}/api/${endpoint}/${encodeURIComponent(key)}`;
  }

  async function call(endpoint: "quote" | "tokens", init: RequestInit): Promise<Response> {
    // one retry on 429, and only when aurora asks for a short wait (the "rate limits" page)
    for (let attempt = 1; ; attempt++) {
      const res = await doFetch(url(endpoint), { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const wait = Number(res.headers.get("retry-after"));
      if (res.status !== 429 || attempt >= 2 || !(wait > 0 && wait <= 10)) return res;
      await new Promise((r) => setTimeout(r, wait * 1000 + 250));
    }
  }

  async function tokenList(): Promise<AuroraToken[] | undefined> {
    if (tokenCache && Date.now() - tokenCache.at < TOKEN_LIST_TTL_MS) return tokenCache.tokens;
    try {
      const res = await call("tokens", { method: "GET" });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { tokens?: AuroraToken[] };
      if (!Array.isArray(body.tokens)) return undefined;
      tokenCache = { at: Date.now(), tokens: body.tokens };
      return body.tokens;
    } catch {
      return undefined;
    }
  }

  async function simulate(
    req: BridgeRequest,
    to: Token,
    origin: AuroraAsset,
    dest: AuroraAsset,
    recipient: Address,
    note: string,
  ): Promise<AuroraBridgeQuote> {
    const tokens = await tokenList();
    const priceOf = (a: AuroraAsset) => tokens?.find((t) => t.assetId === a.assetId)?.price;
    const livePrices = priceOf(origin) !== undefined && priceOf(dest) !== undefined;
    const pIn = (livePrices ? priceOf(origin) : FIXED_PRICES_USD[origin.assetId]) ?? 0;
    const pOut = (livePrices ? priceOf(dest) : FIXED_PRICES_USD[dest.assetId]) ?? 0;
    const feeBps = (origin.stable && dest.stable ? 2 : 10) + SIM_SOLVER_SPREAD_BPS;

    const amountInUsd = (Number(req.amount) / 10 ** origin.decimals) * pIn;
    const amountOutUsd = amountInUsd * (1 - feeBps / 10_000);
    // bigint math, so a stable-to-stable quote has no float dust
    const ratio = pOut > 0 ? BigInt(Math.round((pIn / pOut) * 1e18)) : 0n;
    const amountOutDest =
      (req.amount * 10n ** BigInt(dest.decimals) * ratio * BigInt(10_000 - feeBps)) /
      (10n ** BigInt(origin.decimals) * 10n ** 18n * 10_000n);
    const amountOut = rescale(amountOutDest, dest.decimals, to.decimals);
    const minAmountOut = (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;

    return {
      venue: "aurora",
      fromChain: req.fromChain,
      fromToken: req.fromToken,
      amountIn: req.amount,
      amountOut,
      to,
      etaSeconds: SIM_ETA_SECONDS,
      simulated: true,
      at: Date.now(),
      source: livePrices ? "aurora-prices" : "fixed-prices",
      originAsset: origin.assetId,
      destinationAsset: dest.assetId,
      minAmountOut,
      amountInUsd,
      amountOutUsd,
      costBps: feeBps,
      recipient,
      note,
    };
  }

  async function quoteBridgeTo(
    req: BridgeRequest,
    to: Token,
    q: QuoteBridgeOptions = {},
  ): Promise<AuroraBridgeQuote> {
    const origin = resolveOriginAsset(req.fromChain, req.fromToken);
    if (!origin) throw new Error(`aurora: no asset for ${req.fromToken} on ${req.fromChain}`);
    const dest = resolveDestinationAsset(to);
    if (!dest) throw new Error(`aurora: no asset for ${to.symbol} on chain ${to.chainId}`);
    if (req.amount <= 0n) throw new Error("aurora: amount must be above 0");

    const recipient = q.recipient ?? opts.recipient ?? DRY_RUN_ADDRESS;
    const refundTo = q.refundTo ?? opts.refundTo ?? DRY_RUN_ADDRESS;
    const dry = q.dry ?? true;
    if (!dry && (recipient === DRY_RUN_ADDRESS || refundTo === DRY_RUN_ADDRESS)) {
      throw new Error("aurora: a real quote needs a real recipient and refund address");
    }

    if (!live) {
      return simulate(req, to, origin, dest, recipient, "AURORA_API_KEY is empty. priced from aurora's token list");
    }

    const body: AuroraQuoteBody = {
      dry,
      swapType: "EXACT_INPUT",
      depositType: "ORIGIN_CHAIN",
      depositMode: "SIMPLE",
      originAsset: origin.assetId,
      destinationAsset: dest.assetId,
      amount: req.amount.toString(),
      slippageTolerance: slippageBps,
      refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient,
      recipientType: "DESTINATION_CHAIN",
    };
    const confidentiality = q.confidentiality ?? opts.confidentiality ?? "public";
    if (confidentiality !== "public") body.confidentiality = confidentiality;

    let res: Response;
    try {
      res = await call("quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const reason = `aurora unreachable: ${(err as Error).message}`;
      if (onError === "throw") throw new Error(reason);
      return simulate(req, to, origin, dest, recipient, reason);
    }

    if (!res.ok) {
      const reason = `aurora quote failed: HTTP ${res.status} ${await errorMessage(res)}`;
      if (onError === "throw") throw new Error(reason);
      return simulate(req, to, origin, dest, recipient, reason);
    }

    const data = (await res.json()) as AuroraQuoteResponse;
    return fromAuroraResponse(data, req, to, origin, dest, recipient);
  }

  return {
    id: "aurora",
    kind: "bridge",
    live,
    quoteBridge: (req, to) => quoteBridgeTo(req, to),
    quoteBridgeTo,
    async quoteBridgeWithGas(req, to, gas, q) {
      if (gas.amountIn <= 0n || gas.amountIn >= req.amount) {
        throw new Error("aurora: the gas leg must be above 0 and below the bridge amount");
      }
      const [main, gasLeg] = await Promise.all([
        quoteBridgeTo({ ...req, amount: req.amount - gas.amountIn }, to, q),
        quoteBridgeTo({ ...req, amount: gas.amountIn }, MONAD_MON, q),
      ]);
      return { main, gas: gasLeg };
    },
  };
}

/** turn aurora's quote response into a `BridgeQuote`. exported for the tests */
export function fromAuroraResponse(
  data: AuroraQuoteResponse,
  req: BridgeRequest,
  to: Token,
  origin: AuroraAsset,
  dest: AuroraAsset,
  recipient: Address,
): AuroraBridgeQuote {
  const q = data.quote;
  const amountInUsd = optionalNumber(q.amountInUsd);
  const amountOutUsd = optionalNumber(q.amountOutUsd);
  const costBps =
    amountInUsd && amountOutUsd !== undefined && amountInUsd > 0
      ? Math.round(((amountInUsd - amountOutUsd) / amountInUsd) * 10_000 * 10) / 10
      : undefined;
  return {
    venue: "aurora",
    fromChain: req.fromChain,
    fromToken: req.fromToken,
    amountIn: BigInt(q.amountIn),
    amountOut: rescale(BigInt(q.amountOut), dest.decimals, to.decimals),
    to,
    etaSeconds: q.timeEstimate,
    simulated: false,
    at: Date.now(),
    source: "aurora-quote",
    originAsset: origin.assetId,
    destinationAsset: dest.assetId,
    minAmountOut: rescale(BigInt(q.minAmountOut), dest.decimals, to.decimals),
    amountInUsd,
    amountOutUsd,
    costBps,
    withdrawFee: q.withdrawFee ? BigInt(q.withdrawFee) : undefined,
    recipient,
    correlationId: data.correlationId,
  };
}

/** a bridge quote as json: bigints become decimal strings. for the server's responses and the screens */
export function bridgeQuoteToJson(q: BridgeQuote): Record<string, unknown> {
  return JSON.parse(JSON.stringify(q, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

function optionalNumber(v: string | undefined): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown };
    return String(body.message ?? body.error ?? "");
  } catch {
    return "";
  }
}
