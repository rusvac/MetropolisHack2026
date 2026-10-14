// the shared contract. every lane builds against these types. only the lead changes them
import type { Address, Hex } from "viem";

export { base, baseSepolia, monad, monadTestnet } from "viem/chains";

export type VenueId = "kuru" | "uniswap-v4" | "uniswap-v4-testnet" | "test-pool" | "perpl" | "aurora" | "cctp" | `mock-${string}`;

export interface Token {
  /** 10143 = monad testnet, 84532 = base sepolia, 143 = monad mainnet, 8453 = base */
  chainId: number;
  symbol: string;
  address: Address;
  decimals: number;
}

/** what the person asks for, in one sentence: sell this much of one token for another */
export interface Intent {
  id: string;
  sell: Token;
  buy: Token;
  /** amount of `sell`, in atomic units */
  amountIn: bigint;
  maxSlippageBps: number;
  /** open a matching short on a perp venue, as a share of the position (0 to 1) */
  hedge?: { ratio: number };
  /** bring funds in from another chain before the route runs */
  bridgeIn?: { fromChain: string; fromToken: string; amount: bigint };
  /** 0 = the cheapest plan. 1 = the smallest largest slice */
  privacyWeight: number;
}

export interface TxRequest {
  to: Address;
  data: Hex;
  value: bigint;
}

// spot venues: kuru, uniswap v4, mocks

export interface QuoteRequest {
  sell: Token;
  buy: Token;
  amountIn: bigint;
}

export interface Quote {
  venue: VenueId;
  sell: Token;
  buy: Token;
  amountIn: bigint;
  amountOut: bigint;
  /** venue fee in basis points, when the venue reports one */
  feeBps?: number;
  gasUnits: bigint;
  /** true when the numbers do not come from a live venue */
  simulated: boolean;
  /** unix ms */
  at: number;
}

export interface Slice {
  venue: VenueId;
  /** index of the swarm account that sends this slice (derivation index from BURNER_MNEMONIC) */
  account: number;
  amountIn: bigint;
  expectedOut: bigint;
  /** ms after the plan starts */
  delayMs: number;
}

export interface SpotVenue {
  id: VenueId;
  kind: "spot";
  quote(req: QuoteRequest): Promise<Quote>;
  /** transactions for one slice, approvals first. absent = a quote-only venue */
  build?(slice: Slice, intent: Intent, account: Address): Promise<TxRequest[]>;
}

// perp venue: perpl, for the hedge leg

export interface HedgeQuote {
  venue: VenueId;
  market: string;
  /** size of the short, in atomic units of the hedged token */
  size: bigint;
  markPrice: number;
  /** funding rate per hour, as a fraction */
  fundingRate?: number;
  simulated: boolean;
  at: number;
}

export interface PerpVenue {
  id: VenueId;
  kind: "perp";
  quoteHedge(token: Token, size: bigint): Promise<HedgeQuote>;
  buildHedge?(hedge: HedgeQuote, account: Address): Promise<TxRequest[]>;
}

// bridge: aurora intents, for funds that start on another chain

export interface BridgeQuote {
  venue: VenueId;
  fromChain: string;
  fromToken: string;
  amountIn: bigint;
  /** amount that lands on monad, in atomic units of `to` */
  amountOut: bigint;
  to: Token;
  etaSeconds?: number;
  simulated: boolean;
  at: number;
}

export interface BridgeMove {
  quote: BridgeQuote;
  /** swarm account that sends on the source chain */
  fromAccount: number;
  /** swarm account that receives on monad */
  toAccount: number;
  delayMs: number;
}

export interface BridgeVenue {
  id: VenueId;
  kind: "bridge";
  quoteBridge(req: NonNullable<Intent["bridgeIn"]>, to: Token): Promise<BridgeQuote>;
}

// the router's output, and the thing the screens draw

export interface Plan {
  intent: Intent;
  slices: Slice[];
  /** one trade of the full size at the best single venue */
  baseline: Quote;
  expectedOut: bigint;
  gasUnits: bigint;
  hedge?: HedgeQuote;
  bridge?: BridgeQuote;
  /** largest slice as a share of amountIn (0 to 1). lower = less size shown in one transaction */
  largestSliceShare: number;
}

// rebalance: the demo's main intent

export interface Holding {
  /** swarm account index on the holding's chain */
  account: number;
  token: Token;
  amount: bigint;
  usd: number;
}

export interface Portfolio {
  holdings: Holding[];
  totalUsd: number;
  at: number;
}

/** "get me to these weights": the person states targets, the spider finds the moves */
export interface RebalanceIntent {
  id: string;
  /** target weights by symbol. the weights sum to 1 */
  targets: { symbol: string; weight: number }[];
  /** share of the largest target position to short on a perp venue (0 to 1) */
  hedgeRatio?: number;
  privacyWeight: number;
}

export interface RebalancePlan {
  intent: RebalanceIntent;
  before: Portfolio;
  /** cross-chain moves run first */
  bridges: BridgeMove[];
  /** one plan per swap on monad, each split into slices */
  swaps: Plan[];
  hedge?: HedgeQuote;
  /** projected, from the quotes */
  after: Portfolio;
  costUsd: number;
  /** the same rebalance from one account, one bridge, and one trade per asset */
  naiveCostUsd: number;
  /** transfers from one swarm account straight to another. the planner keeps this at 0 */
  directTransfers: number;
}
