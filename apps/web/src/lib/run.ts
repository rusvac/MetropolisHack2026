// folds the run's events into the state the timeline draws
import type { Portfolio, VenueId } from "@spidereum/core";
import { toUnits } from "./format.ts";
import type { Move } from "./moves.ts";
import type { ExecEvent, MoveKind, MoveStatus, RerouteEvent } from "./types.ts";

export interface RunRow {
  id: string;
  kind: MoveKind;
  status: MoveStatus;
  venue: VenueId;
  /** the venue in the plan, when a re-route moved this slice */
  plannedVenue?: VenueId;
  account?: number;
  toAccount?: number;
  chainId: number;
  amountIn?: number;
  amountOut?: number;
  symbolIn?: string;
  symbolOut?: string;
  decimalsIn?: number;
  decimalsOut?: number;
  usd?: number;
  hash?: string;
  url?: string;
  simulated: boolean;
  /** time of the last change */
  at?: number;
  sentAt?: number;
  doneAt?: number;
  note?: string;
}

export interface RunState {
  status: "idle" | "running" | "done" | "error";
  runId?: string;
  startedAt?: number;
  endedAt?: number;
  rows: Record<string, RunRow>;
  order: string[];
  venueOff?: { venue: VenueId; at: number };
  reroutes: RerouteEvent[];
  errors: string[];
  after?: Portfolio;
  /** true when the run sends nothing onchain */
  simulated?: boolean;
}

export const IDLE: RunState = { status: "idle", rows: {}, order: [], reroutes: [], errors: [] };

export function startState(moves: Move[], at = Date.now()): RunState {
  const rows: Record<string, RunRow> = {};
  for (const m of moves) {
    rows[m.id] = {
      id: m.id,
      kind: m.kind,
      status: "queued",
      venue: m.venue,
      account: m.account,
      toAccount: m.toAccount,
      chainId: m.chainId,
      amountIn: m.amountIn,
      amountOut: m.amountOut,
      symbolIn: m.symbolIn,
      symbolOut: m.symbolOut,
      decimalsIn: m.decimalsIn,
      decimalsOut: m.decimalsOut,
      usd: m.usd,
      simulated: m.simulated,
    };
  }
  return { ...IDLE, status: "running", startedAt: at, rows, order: moves.map((m) => m.id) };
}

function units(atomic: string | bigint | undefined, decimals: number | undefined): number | undefined {
  if (atomic === undefined || decimals === undefined) return undefined;
  if (typeof atomic === "bigint") return toUnits(atomic, decimals);
  if (!/^-?\d+$/.test(atomic)) return undefined;
  return toUnits(BigInt(atomic), decimals);
}

export function reduce(state: RunState, e: ExecEvent): RunState {
  switch (e.type) {
    case "start":
      return { ...state, status: "running", runId: e.runId ?? state.runId, startedAt: state.startedAt ?? e.at, simulated: e.simulated ?? state.simulated };
    case "move": {
      const prev = state.rows[e.id];
      const known = !!prev;
      const row: RunRow = {
        ...(prev ?? { id: e.id, kind: e.kind, chainId: e.chainId, simulated: e.simulated, venue: e.venue, status: e.status }),
        status: e.status === "queued" && prev && prev.status !== "queued" ? prev.status : e.status,
        venue: e.venue ?? prev?.venue,
        account: e.account ?? prev?.account,
        toAccount: e.toAccount ?? prev?.toAccount,
        chainId: e.chainId ?? prev?.chainId,
        amountIn: units(e.amountIn, e.decimalsIn ?? prev?.decimalsIn) ?? prev?.amountIn,
        amountOut: units(e.amountOut, e.decimalsOut ?? prev?.decimalsOut) ?? prev?.amountOut,
        symbolIn: e.symbolIn ?? prev?.symbolIn,
        symbolOut: e.symbolOut ?? prev?.symbolOut,
        decimalsIn: e.decimalsIn ?? prev?.decimalsIn,
        decimalsOut: e.decimalsOut ?? prev?.decimalsOut,
        usd: e.usd ?? prev?.usd,
        hash: e.hash ?? prev?.hash,
        url: e.url ?? prev?.url,
        simulated: e.simulated,
        at: e.at,
        note: e.note ?? prev?.note,
        sentAt: e.status === "sent" ? e.at : prev?.sentAt,
        doneAt: e.status === "confirmed" || e.status === "quoted" || e.status === "failed" ? e.at : prev?.doneAt,
      };
      if (prev?.plannedVenue) row.plannedVenue = prev.plannedVenue;
      else if (prev && e.venue && prev.venue !== e.venue && e.status !== "queued") row.plannedVenue = prev.venue;
      return {
        ...state,
        rows: { ...state.rows, [e.id]: row },
        order: known ? state.order : [...state.order, e.id],
      };
    }
    case "venue-off":
      return { ...state, venueOff: { venue: e.venue, at: e.at } };
    case "reroute": {
      const rows = { ...state.rows };
      const order = [...state.order];
      // a swap row to copy symbols and decimals from, for slices the re-route made new
      const like = state.order.map((id) => state.rows[id]).find((r) => r?.kind === "swap");
      for (const m of e.moves) {
        const r = rows[m.id];
        if (r) {
          const amountOut = m.slice ? (units(m.slice.expectedOut, r.decimalsOut) ?? r.amountOut) : r.amountOut;
          rows[m.id] = { ...r, plannedVenue: r.plannedVenue ?? r.venue, venue: m.to, amountOut, at: e.at };
          continue;
        }
        if (!m.slice) continue;
        rows[m.id] = {
          id: m.id,
          kind: "swap",
          status: "queued",
          venue: m.to,
          plannedVenue: e.from,
          account: m.slice.account,
          chainId: like?.chainId ?? 10143,
          symbolIn: like?.symbolIn,
          symbolOut: like?.symbolOut,
          decimalsIn: like?.decimalsIn,
          decimalsOut: like?.decimalsOut,
          amountIn: units(m.slice.amountIn, like?.decimalsIn ?? 6),
          amountOut: units(m.slice.expectedOut, like?.decimalsOut ?? 18),
          usd: like && like.amountIn && like.usd ? (like.usd / like.amountIn) * (units(m.slice.amountIn, like.decimalsIn ?? 6) ?? 0) : undefined,
          simulated: like?.simulated ?? true,
          at: e.at,
        };
        order.push(m.id);
      }
      return { ...state, rows, order, reroutes: [...state.reroutes, e] };
    }
    case "done":
      return { ...state, status: "done", endedAt: e.at, after: e.after ?? state.after, simulated: e.simulated ?? state.simulated };
    case "error":
      return { ...state, errors: [...state.errors, e.message] };
  }
}

export interface RunCounts {
  /** every move that still counts: re-routed slices do not */
  total: number;
  confirmed: number;
  sent: number;
  quoted: number;
  failed: number;
  queued: number;
  rerouted: number;
}

export function counts(state: RunState): RunCounts {
  const c: RunCounts = { total: 0, confirmed: 0, sent: 0, quoted: 0, failed: 0, queued: 0, rerouted: 0 };
  for (const id of state.order) {
    const r = state.rows[id];
    if (!r) continue;
    if (r.status === "rerouted") {
      c.rerouted++;
      continue;
    }
    c.total++;
    if (r.status === "confirmed") c.confirmed++;
    else if (r.status === "sent") c.sent++;
    else if (r.status === "quoted") c.quoted++;
    else if (r.status === "failed") c.failed++;
    else c.queued++;
  }
  return c;
}

/** usd routed per venue, from the rows as they stand */
export function venueShares(state: RunState): Map<VenueId, number> {
  const m = new Map<VenueId, number>();
  for (const id of state.order) {
    const r = state.rows[id];
    if (!r || r.kind !== "swap" || r.status === "rerouted") continue;
    m.set(r.venue, (m.get(r.venue) ?? 0) + (r.usd ?? 0));
  }
  return m;
}
