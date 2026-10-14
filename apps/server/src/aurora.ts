// lane L4: the server side of the aurora bridge. the api key lives here and never reaches apps/web.
// the lead mounts the handler in index.ts, for example: if (url.pathname.startsWith("/aurora/")) return handleAurora(req)
//
// routes (prefix "/aurora"):
//   GET  /aurora/health        { keyPresent } — never the key itself
//   GET  /aurora/tokens        aurora's token list with prices
//   POST /aurora/quote         aurora's quote endpoint, key added here. dry: true is forced unless allowRealQuotes
//   GET  /aurora/status        aurora's swap status, ?depositAddress=...
//   POST /aurora/bridge-quote  { fromChain, fromToken, amount, to, recipient?, refundTo?, confidentiality? }
//                              -> a BridgeQuote as json, bigints as strings
import type { Token } from "@spidereum/core";
import {
  AURORA_API_BASE,
  AURORA_PUBLIC_KEY_SEGMENT,
  type AuroraBridge,
  type AuroraBridgeOptions,
  bridgeQuoteToJson,
  createAuroraBridge,
} from "@spidereum/venues/src/aurora/index.ts";

export interface AuroraHandlerOptions {
  /** defaults to process.env.AURORA_API_KEY, read on every request */
  apiKey?: string;
  prefix?: string;
  baseUrl?: string;
  /** false (default) forces dry: true on /quote, so the proxy never reserves a deposit address */
  allowRealQuotes?: boolean;
  fetch?: typeof fetch;
}

// apps/server does not depend on viem, so the address type is spelled out here
type Address = `0x${string}`;

const MAX_BODY_BYTES = 16 * 1024;

/** the aurora key from the server env, or undefined. never log the return value */
export function auroraKeyFromEnv(): string | undefined {
  return process.env.AURORA_API_KEY?.trim() || undefined;
}

/** a bridge venue for server code: it calls aurora directly with the key from .env */
export function auroraBridgeFromEnv(opts: Omit<AuroraBridgeOptions, "apiKey" | "proxyUrl"> = {}): AuroraBridge {
  return createAuroraBridge({ ...opts, apiKey: auroraKeyFromEnv() });
}

export function createAuroraHandler(opts: AuroraHandlerOptions = {}): (req: Request) => Promise<Response> {
  const prefix = (opts.prefix ?? "/aurora").replace(/\/+$/, "");
  const baseUrl = (opts.baseUrl ?? AURORA_API_BASE).replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const key = () => opts.apiKey?.trim() || auroraKeyFromEnv();

  async function upstream(path: string, init: RequestInit): Promise<Response> {
    const res = await doFetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
    const headers = new Headers({ "content-type": res.headers.get("content-type") ?? "application/json" });
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) headers.set("retry-after", retryAfter);
    return new Response(await res.arrayBuffer(), { status: res.status, headers });
  }

  return async function handleAurora(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
      return json({ error: "not an aurora route" }, 404);
    }
    const route = url.pathname.slice(prefix.length) || "/";
    const apiKey = key();

    try {
      if (req.method === "GET" && route === "/health") {
        return json({ keyPresent: Boolean(apiKey), upstream: baseUrl });
      }

      if (req.method === "GET" && route === "/tokens") {
        // the token list answers any key, so prices work before the founder adds one
        const segment = encodeURIComponent(apiKey ?? AURORA_PUBLIC_KEY_SEGMENT);
        return await upstream(`/api/tokens/${segment}`, { method: "GET" });
      }

      if (req.method === "POST" && route === "/quote") {
        if (!apiKey) return noKey();
        const body = await readJson(req);
        if (!body.ok) return json({ error: body.error }, 400);
        const quote = { ...body.value, ...(opts.allowRealQuotes ? {} : { dry: true }) };
        return await upstream(`/api/quote/${encodeURIComponent(apiKey)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(quote),
        });
      }

      if (req.method === "GET" && route === "/status") {
        if (!apiKey) return noKey();
        const depositAddress = url.searchParams.get("depositAddress");
        if (!depositAddress) return json({ error: "depositAddress is required" }, 400);
        const qs = new URLSearchParams({ depositAddress });
        const memo = url.searchParams.get("depositMemo");
        if (memo) qs.set("depositMemo", memo);
        return await upstream(`/api/status/${encodeURIComponent(apiKey)}?${qs}`, { method: "GET" });
      }

      if (req.method === "POST" && route === "/bridge-quote") {
        const body = await readJson(req);
        if (!body.ok) return json({ error: body.error }, 400);
        const parsed = parseBridgeQuoteBody(body.value);
        if (!parsed.ok) return json({ error: parsed.error }, 400);
        const venue = createAuroraBridge({ apiKey, baseUrl, fetch: doFetch });
        const quote = await venue.quoteBridgeTo(parsed.req, parsed.to, {
          recipient: parsed.recipient,
          refundTo: parsed.refundTo,
          confidentiality: parsed.confidentiality,
        });
        return json(bridgeQuoteToJson(quote));
      }

      return json({ error: `no aurora route for ${req.method} ${route}` }, 404);
    } catch (err) {
      return json({ error: (err as Error).message }, 502);
    }
  };
}

/** the handler with the key from .env. mount it under /aurora */
export const handleAurora = createAuroraHandler();

function noKey(): Response {
  return json({ error: "AURORA_API_KEY is empty on the server", simulated: true }, 503);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function readJson(req: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string }> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, error: "body too large" };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "body must be a json object" };
    return { ok: true, value };
  } catch {
    return { ok: false, error: "body is not json" };
  }
}

type BridgeQuoteBody =
  | {
      ok: true;
      req: { fromChain: string; fromToken: string; amount: bigint };
      to: Token;
      recipient?: Address;
      refundTo?: Address;
      confidentiality?: "public" | "basic" | "advanced";
    }
  | { ok: false; error: string };

function parseBridgeQuoteBody(b: Record<string, unknown>): BridgeQuoteBody {
  const isAddress = (v: unknown): v is Address => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
  if (typeof b.fromChain !== "string" || typeof b.fromToken !== "string") {
    return { ok: false, error: "fromChain and fromToken are required strings" };
  }
  if (typeof b.amount !== "string" && typeof b.amount !== "number") {
    return { ok: false, error: "amount is required, in atomic units, as a string" };
  }
  let amount: bigint;
  try {
    amount = BigInt(b.amount);
  } catch {
    return { ok: false, error: "amount is not an integer" };
  }
  const to = b.to as Partial<Token> | undefined;
  if (!to || typeof to.chainId !== "number" || typeof to.symbol !== "string" || !isAddress(to.address) || typeof to.decimals !== "number") {
    return { ok: false, error: "to must be a Token: { chainId, symbol, address, decimals }" };
  }
  if (b.recipient !== undefined && !isAddress(b.recipient)) return { ok: false, error: "recipient is not an address" };
  if (b.refundTo !== undefined && !isAddress(b.refundTo)) return { ok: false, error: "refundTo is not an address" };
  const modes = ["public", "basic", "advanced"] as const;
  const confidentiality = modes.find((m) => m === b.confidentiality);
  if (b.confidentiality !== undefined && !confidentiality) {
    return { ok: false, error: "confidentiality is public, basic, or advanced" };
  }
  return {
    ok: true,
    req: { fromChain: b.fromChain, fromToken: b.fromToken, amount },
    to: to as Token,
    recipient: b.recipient as Address | undefined,
    refundTo: b.refundTo as Address | undefined,
    confidentiality,
  };
}
