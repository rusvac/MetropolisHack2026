// offline tests for the aurora routes. fetch is faked, and the key is a test string
import { describe, expect, test } from "bun:test";
import { createAuroraHandler } from "./aurora.ts";

interface Call {
  url: string;
  body?: Record<string, unknown>;
}

function fake(answer: (c: Call) => Response) {
  const calls: Call[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit) => {
    const c: Call = { url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    return answer(c);
  };
  return { fetch: f as typeof fetch, calls };
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

const tokens = {
  tokens: [
    { assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", decimals: 6, blockchain: "base", symbol: "USDC", price: 1, priceUpdatedAt: "" },
    { assetId: "nep245:v2_1.omni.hot.tg:143_11111111111111111111", decimals: 18, blockchain: "monad", symbol: "MON", price: 0.025, priceUpdatedAt: "" },
  ],
};

const SECRET = "test-key-should-never-leak";

// assigning undefined to process.env stores the string "undefined", so delete instead
function restoreKey(saved: string | undefined) {
  if (saved === undefined) delete process.env.AURORA_API_KEY;
  else process.env.AURORA_API_KEY = saved;
}
const post = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("aurora routes", () => {
  test("health says whether a key is set, never the key", async () => {
    const handler = createAuroraHandler({ apiKey: SECRET, fetch: fake(() => json({})).fetch });
    const res = await handler(new Request("http://localhost/aurora/health"));
    const text = await res.text();
    expect(JSON.parse(text).keyPresent).toBe(true);
    expect(text).not.toContain(SECRET);
  });

  test("quote adds the key upstream and forces dry: true", async () => {
    const { fetch, calls } = fake(() => json({ quote: { amountOut: "1" } }));
    const handler = createAuroraHandler({ apiKey: SECRET, fetch });
    const res = await handler(post("/aurora/quote", { dry: false, amount: "100" }));
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe(`https://intents-api.aurora.dev/api/quote/${SECRET}`);
    expect(calls[0]!.body).toEqual({ dry: true, amount: "100" });
  });

  test("quote without a key answers 503 and calls nothing", async () => {
    const saved = process.env.AURORA_API_KEY;
    process.env.AURORA_API_KEY = "";
    try {
      const { fetch, calls } = fake(() => json({}));
      const res = await createAuroraHandler({ fetch })(post("/aurora/quote", { amount: "1" }));
      expect(res.status).toBe(503);
      expect(calls.length).toBe(0);
    } finally {
      restoreKey(saved);
    }
  });

  test("bridge-quote without a key returns a simulated quote as json", async () => {
    const saved = process.env.AURORA_API_KEY;
    process.env.AURORA_API_KEY = "";
    try {
      const { fetch } = fake(() => json(tokens));
      const res = await createAuroraHandler({ fetch })(
        post("/aurora/bridge-quote", {
          fromChain: "base",
          fromToken: "USDC",
          amount: "100000000",
          to: { chainId: 143, symbol: "MON", address: "0x0000000000000000000000000000000000000000", decimals: 18 },
        }),
      );
      expect(res.status).toBe(200);
      const q = (await res.json()) as Record<string, unknown>;
      expect(q.venue).toBe("aurora");
      expect(q.simulated).toBe(true);
      expect(q.amountIn).toBe("100000000");
      // 100 USDC at 0.025 per MON, less 15 bps: 3,994 MON
      expect(q.amountOut).toBe("3994000000000000000000");
    } finally {
      restoreKey(saved);
    }
  });

  test("a bad body is a 400, an unknown path is a 404", async () => {
    const handler = createAuroraHandler({ apiKey: SECRET, fetch: fake(() => json({})).fetch });
    expect((await handler(post("/aurora/bridge-quote", { fromChain: "base" }))).status).toBe(400);
    expect((await handler(new Request("http://localhost/aurora/nope"))).status).toBe(404);
  });
});
