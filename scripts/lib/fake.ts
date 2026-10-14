// the mock side of the demo: two constant-product pools, a mock perp, a mock bridge, and a fake
// portfolio. every number from here is simulated, and every quote says simulated: true
import type {
  BridgeQuote,
  BridgeVenue,
  HedgeQuote,
  Holding,
  Intent,
  PerpVenue,
  Portfolio,
  QuoteRequest,
  SpotVenue,
  Token,
  VenueId,
} from "../../packages/core/src/index.ts";
import { createMockVenue } from "../../packages/venues/src/index.ts";
import { MON, USDC_BASE } from "./tokens.ts";

/** the mock MON price in dollars. simulated */
export const MOCK_MON_USD = 0.04;

export interface MockPairOptions {
  name: string;
  /** USDC reserve, whole tokens */
  usdc: number;
  feeBps: number;
  gasUnits?: bigint;
  /** dollars per MON. default MOCK_MON_USD */
  monUsd?: number;
}

/**
 * a mock pool for the MON-USDC pair that quotes both ways. createMockVenue quotes one way
 * (reserveIn is the token the person sells), so this keeps one per direction
 */
export function createMockPair(opts: MockPairOptions): SpotVenue {
  const usdcReserve = BigInt(Math.round(opts.usdc)) * 10n ** 6n;
  const monReserve = BigInt(Math.round(opts.usdc / (opts.monUsd ?? MOCK_MON_USD))) * 10n ** 18n;
  const common = { name: opts.name, feeBps: opts.feeBps, gasUnits: opts.gasUnits };
  const buyMon = createMockVenue({ ...common, reserveIn: usdcReserve, reserveOut: monReserve });
  const sellMon = createMockVenue({ ...common, reserveIn: monReserve, reserveOut: usdcReserve });
  return {
    id: buyMon.id,
    kind: "spot",
    quote(req: QuoteRequest) {
      return req.sell.symbol === "MON" ? sellMon.quote(req) : buyMon.quote(req);
    },
  };
}

/** two mock pools with different depth and fees, so a split beats one trade. `monUsd` sets their price */
export function mockSpotVenues(monUsd = MOCK_MON_USD): SpotVenue[] {
  return [
    createMockPair({ name: "kuru", usdc: 180_000, feeBps: 10, gasUnits: 180_000n, monUsd }),
    createMockPair({ name: "uniswap-v4", usdc: 260_000, feeBps: 30, gasUnits: 140_000n, monUsd }),
  ];
}

export function mockPerp(monUsd = MOCK_MON_USD): PerpVenue {
  const id: VenueId = "mock-perpl";
  return {
    id,
    kind: "perp",
    async quoteHedge(_token: Token, size: bigint): Promise<HedgeQuote> {
      return { venue: id, market: "MON-USD", size, markPrice: monUsd, fundingRate: 0.0000125, simulated: true, at: Date.now() };
    },
  };
}

/** a mock bridge: 8 bps plus a fixed 0.25 USDC solver fee, 20 seconds to land */
export function mockBridge(): BridgeVenue {
  const id: VenueId = "mock-aurora";
  return {
    id,
    kind: "bridge",
    async quoteBridge(req: NonNullable<Intent["bridgeIn"]>, to: Token): Promise<BridgeQuote> {
      const fixed = 250_000n; // 0.25 USDC
      const afterBps = (req.amount * 9_992n) / 10_000n;
      const amountOut = afterBps > fixed ? afterBps - fixed : 0n;
      return {
        venue: id,
        fromChain: req.fromChain,
        fromToken: req.fromToken,
        amountIn: req.amount,
        amountOut,
        to,
        etaSeconds: 20,
        simulated: true,
        at: Date.now(),
      };
    },
  };
}

function usdcHolding(account: number, whole: number): Holding {
  return { account, token: USDC_BASE, amount: BigInt(whole) * 10n ** 6n, usd: whole };
}

function monHolding(account: number, whole: number, monUsd: number): Holding {
  return { account, token: MON, amount: BigInt(whole) * 10n ** 18n, usd: whole * monUsd };
}

/**
 * the demo's starting point: USDC on base over three accounts, and a little MON on monad spread
 * over the demo accounts, enough for gas. $600 of MON at the mock price. simulated
 */
export function fakePortfolio(monUsd = MOCK_MON_USD): Portfolio {
  const holdings = [
    usdcHolding(0, 1_850),
    usdcHolding(1, 1_400),
    usdcHolding(2, 1_150),
    monHolding(10, 4_200, monUsd),
    monHolding(11, 3_100, monUsd),
    monHolding(12, 2_400, monUsd),
    monHolding(13, 1_900, monUsd),
    monHolding(14, 1_300, monUsd),
    monHolding(15, 1_100, monUsd),
    monHolding(16, 600, monUsd),
    monHolding(17, 400, monUsd),
  ];
  return { holdings, totalUsd: holdings.reduce((s, h) => s + h.usd, 0), at: Date.now() };
}
