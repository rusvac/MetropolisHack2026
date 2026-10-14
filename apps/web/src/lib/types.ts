// web-side types. the plan itself is @spidereum/core's RebalancePlan.
// PlanExtras are optional fields the server may add next to the plan. the screens work without them
import type { Portfolio, RebalancePlan, Slice, VenueId } from "@spidereum/core";

export type Address = `0x${string}`;

export interface SwarmAccount {
  chainId: number;
  /** derivation index from the seed */
  index: number;
  address: Address;
}

export interface CostRow {
  bridgeUsd: number;
  swapUsd: number;
  gasUsd: number;
  totalUsd: number;
  txCount: number;
}

export interface SourceNote {
  note: string;
  simulated: boolean;
}

/** beat 7 as the server counts it (scripts/lib/link.ts) */
export interface ServerLinkability {
  largestMove: { split: number; splitUsd: number; naive: number; totalUsd: number };
  correlation: { before: number; after: number; naiveAfter: number; source: string };
  directTransfers: { planned: number; gasTopUps: number[]; total: number };
}

export interface PlanExtras {
  /** the server's id for this plan. a live run needs it */
  planId?: string;
  /** public addresses of the swarm accounts. the server derives them. the browser never sees the seed */
  accounts?: SwarmAccount[];
  /** correlation score, 0 to 100, higher = easier to link. from the ported analyzer (L7) */
  correlation?: { before: number; after: number; naive?: number; simulated?: boolean };
  /** true when `before` does not come from live balances */
  balancesSimulated?: boolean;
  /** usd price per symbol that the plan used */
  prices?: Record<string, number>;
  /** where each number comes from */
  sources?: {
    venues?: SourceNote;
    prices?: SourceNote;
    balances?: SourceNote;
    gas?: { gwei: number; note: string; simulated: boolean };
    planner?: string;
    executor?: SourceNote;
    correlation?: string;
    notes?: string[];
  };
  /** cost in dollars, split and naive, by part */
  costs?: { split: CostRow; naive: CostRow };
  linkability?: ServerLinkability;
}

export type DemoPlan = RebalancePlan & PlanExtras;

/** where a plan came from: the server (live quotes and balances) or the browser fixture (all simulated) */
export type Source = "server" | "fixture";

// the run, as server-sent events from POST /execute.
// each event is one `data: <json>` line. move ids match the plan:
// `bridge-<i>`, `swap-<planIndex>-<sliceIndex>`, `hedge`, `gas-<i>`

export type MoveKind = "bridge" | "swap" | "hedge" | "gas";

export type MoveStatus =
  /** planned, not sent yet */
  | "queued"
  /** sent, waiting for the receipt */
  | "sent"
  | "confirmed"
  | "failed"
  /** a quote only, no transaction (the bridge and the hedge on the must tier) */
  | "quoted"
  /** taken off a venue that turned off. a new move with the same slice follows */
  | "rerouted";

export interface MoveEvent {
  type: "move";
  id: string;
  kind: MoveKind;
  status: MoveStatus;
  venue: VenueId;
  /** swarm account that sends the move, on `chainId` */
  account?: number;
  /** bridges: the monad account that receives */
  toAccount?: number;
  /** the chain the transaction lives on */
  chainId: number;
  toChainId?: number;
  /** atomic units, as decimal strings (the parser may hand them over as bigints) */
  amountIn?: string | bigint;
  amountOut?: string | bigint;
  symbolIn?: string;
  symbolOut?: string;
  decimalsIn?: number;
  decimalsOut?: number;
  usd?: number;
  hash?: string;
  /** the explorer link, when the server sends one */
  url?: string;
  /** true when no transaction exists on any chain */
  simulated: boolean;
  at: number;
  note?: string;
}

export interface StartEvent {
  type: "start";
  runId?: string;
  at: number;
  moves?: number;
  /** true when the run sends nothing onchain */
  simulated?: boolean;
}

export interface VenueOffEvent {
  type: "venue-off";
  venue: VenueId;
  at: number;
}

export interface RerouteEvent {
  type: "reroute";
  from: VenueId;
  at: number;
  /** each slice that moved, with its new venue */
  moves: { id: string; to: VenueId; slice?: Slice }[];
}

export interface DoneEvent {
  type: "done";
  at: number;
  after?: Portfolio;
  simulated?: boolean;
}

export interface ErrorEvent {
  type: "error";
  at: number;
  message: string;
}

export type ExecEvent = StartEvent | MoveEvent | VenueOffEvent | RerouteEvent | DoneEvent | ErrorEvent;

export interface ExecuteOptions {
  /** turn this venue off halfway through the run, to show the re-route */
  dropVenue?: VenueId;
}
