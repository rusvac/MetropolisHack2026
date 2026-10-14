import { expect, test } from "bun:test";
import type { Token } from "@spidereum/core";
import { createMockVenue } from "./index.ts";

const usdc: Token = { chainId: 143, symbol: "USDC", address: "0x0000000000000000000000000000000000000001", decimals: 6 };
const mon: Token = { chainId: 143, symbol: "MON", address: "0x0000000000000000000000000000000000000002", decimals: 18 };

test("two half trades get more out than one full trade across two equal pools", async () => {
  const pool = { reserveIn: 1_000_000n * 10n ** 6n, reserveOut: 10_000_000n * 10n ** 18n, feeBps: 30 };
  const a = createMockVenue({ name: "a", ...pool });
  const b = createMockVenue({ name: "b", ...pool });
  const size = 100_000n * 10n ** 6n;

  const whole = await a.quote({ sell: usdc, buy: mon, amountIn: size });
  const halfA = await a.quote({ sell: usdc, buy: mon, amountIn: size / 2n });
  const halfB = await b.quote({ sell: usdc, buy: mon, amountIn: size / 2n });

  expect(whole.simulated).toBe(true);
  expect(halfA.amountOut + halfB.amountOut).toBeGreaterThan(whole.amountOut);
});
