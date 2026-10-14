// lane L8: the demo run over http, for apps/web.
//
//   POST /plan               body { intent?, ...intent }           -> RebalancePlan + extras, bigints as strings
//   POST /execute            body { plan?, planId?, dropVenue?, speed? } -> text/event-stream, one event per move
//   POST /execute/venue-off  body { runId, venue }                  -> turns a venue off during a run
//
// DEMO_ONCHAIN=1 switches both routes to the onchain run: testnet quotes, real sends from accounts 10 to 13,
// an explorer link per transaction, and live balances in the done event. DEMO_ONCHAIN=dry builds and sends nothing.
//
// the lead mounts it in index.ts: `const r = await handleRun(req); if (r) return r;`.
// the run's switches (mock or live venues, portfolio, executor) are in scripts/config.ts.
// the seed stays here: the plan carries public addresses only
import type { Portfolio, RebalanceIntent, RebalancePlan, SpotVenue, VenueId } from "@spidereum/core";
import { SENTENCE, demoIntent, loadSetup, type Setup } from "../../../scripts/config.ts";
import { toJson } from "../../../scripts/lib/format.ts";
import { linkability } from "../../../scripts/lib/link.ts";
import { costBreakdown } from "../../../scripts/lib/plan-math.ts";
import { loadOnchain, loadOnchainPortfolio, onchainLink, planOnchain, type OnchainSetup } from "../../../scripts/lib/onchain.ts";
import { RunControl, movesOf, runPlan, type Executor, type RunEvent } from "../../../scripts/lib/run.ts";
import type { Replanner } from "../../../scripts/lib/standin.ts";

/** every bigint field in @spidereum/core's plan types, as apps/web/src/lib/json.ts revives them */
const BIGINT_KEYS = new Set(["amountIn", "amountOut", "expectedOut", "gasUnits", "amount", "size", "monadWei"]);
const INT = /^-?\d+n?$/;

function revive(key: string, value: unknown): unknown {
  if (!BIGINT_KEYS.has(key)) return value;
  if (typeof value === "string" && INT.test(value)) return BigInt(value.replace(/n$/, ""));
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.round(value));
  return value;
}

function json(body: unknown, status = 200): Response {
  return new Response(toJson(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function fail(status: number, message: string): Response {
  return json({ error: message }, status);
}

/** a cross-site page can post a form without a preflight. json only stops that */
async function readJson(req: Request): Promise<Record<string, unknown> | Response> {
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return fail(415, "send content-type: application/json");
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    const body = JSON.parse(text, revive);
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : fail(400, "the body must be a json object");
  } catch {
    return fail(400, "the body is not json");
  }
}

const unit = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** the intent from the body: `{ intent }`, the intent's fields at the top level, or the demo's intent */
export function intentFrom(body: Record<string, unknown>): RebalanceIntent | string {
  const src = (body.intent && typeof body.intent === "object" ? body.intent : body) as Partial<RebalanceIntent>;
  const base = demoIntent(unit(src.privacyWeight) ? src.privacyWeight : 0.5);
  const intent: RebalanceIntent = { ...base };
  if (typeof src.id === "string" && src.id.length <= 80) intent.id = src.id;
  if (src.targets !== undefined) {
    if (!Array.isArray(src.targets) || src.targets.length === 0 || src.targets.length > 8) return "targets must be a list of 1 to 8 { symbol, weight }";
    for (const t of src.targets) {
      if (!t || typeof t.symbol !== "string" || !/^[A-Za-z0-9]{1,12}$/.test(t.symbol) || !unit(t.weight)) return "each target needs a symbol and a weight from 0 to 1";
    }
    const sum = src.targets.reduce((s, t) => s + t.weight, 0);
    if (Math.abs(sum - 1) > 0.001) return `the target weights sum to ${sum}, not 1`;
    intent.targets = src.targets.map((t) => ({ symbol: t.symbol.toUpperCase(), weight: t.weight }));
  }
  if (src.hedgeRatio !== undefined) {
    if (!unit(src.hedgeRatio)) return "hedgeRatio must be from 0 to 1";
    intent.hedgeRatio = src.hedgeRatio;
  }
  if (src.privacyWeight !== undefined && !unit(src.privacyWeight)) return "privacyWeight must be from 0 to 1";
  return intent;
}

// plans the server made, so /execute can run the server's copy and not the client's
const plans = new Map<string, RebalancePlan>();
const MAX_PLANS = 50;

function remember(plan: RebalancePlan): string {
  const id = `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  plans.set(id, plan);
  while (plans.size > MAX_PLANS) plans.delete(plans.keys().next().value!);
  return id;
}

const runs = new Map<string, RunControl>();
let liveRuns = 0;

async function handlePlan(req: Request, setup: Setup): Promise<Response> {
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const intent = intentFrom(body);
  if (typeof intent === "string") return fail(400, intent);
  try {
    const { portfolio, simulated, note } = await setup.loadPortfolio();
    const { plan, planner, note: plannerNote } = await setup.plan(portfolio, intent);
    const planId = remember(plan);
    const link = linkability(plan, { prices: setup.prices, correlation: setup.correlation, correlationSource: setup.correlationNote });
    const costs = costBreakdown(plan, setup.prices, setup.gas);
    return json({
      ...plan,
      // PlanExtras, as apps/web/src/lib/types.ts reads them
      planId,
      accounts: setup.swarm,
      correlation: {
        before: link.correlation.before,
        after: link.correlation.after,
        naive: link.correlation.naiveAfter,
        simulated: simulated || setup.venuesSimulated,
      },
      balancesSimulated: simulated,
      prices: setup.prices,
      // more for the screens: where each number comes from, the cost rows, and beat 7
      sentence: SENTENCE,
      sources: {
        venues: { note: setup.venuesNote, simulated: setup.venuesSimulated },
        prices: { note: setup.pricesNote, simulated: setup.pricesSimulated },
        balances: { note, simulated },
        gas: { gwei: Number(setup.gas.monadWei) / 1e9, note: setup.gas.source, simulated: setup.gas.simulated },
        planner: plannerNote ? `${planner} (${plannerNote})` : planner,
        executor: { note: setup.executorNote, simulated: setup.executor.simulated },
        correlation: setup.correlationNote,
        notes: setup.notes,
      },
      costs,
      linkability: link,
      moves: movesOf(plan).length,
    });
  } catch (e) {
    return fail(500, `the plan failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function isPlan(v: unknown): v is RebalancePlan {
  const p = v as RebalancePlan | undefined;
  return !!p && typeof p === "object" && Array.isArray(p.swaps) && Array.isArray(p.bridges) && !!p.before && Array.isArray(p.before.holdings);
}

async function handleExecute(req: Request, setup: Setup): Promise<Response> {
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const sent = body.plan as (RebalancePlan & { planId?: string }) | undefined;
  const planId = typeof body.planId === "string" ? body.planId : sent?.planId;
  let plan = planId ? plans.get(planId) : undefined;
  if (!plan && !setup.executor.simulated) return fail(409, "a live run needs a plan from this server. POST /plan first, and send its planId");
  if (!plan && sent !== undefined) {
    if (!isPlan(sent)) return fail(400, "plan is not a RebalancePlan");
    plan = sent;
  }
  if (!plan) {
    const { portfolio } = await setup.loadPortfolio();
    plan = (await setup.plan(portfolio, demoIntent())).plan;
  }
  return streamRun(req, body, plan, {
    executor: setup.executor,
    spot: setup.venues.spot,
    replan: setup.replan,
    prices: setup.prices,
    gasPerTxWei: setup.gas.monadWei * 250_000n,
  });
}

interface RunContext {
  executor: Executor;
  spot: SpotVenue[];
  replan: Replanner;
  prices: Record<string, number>;
  gasPerTxWei: bigint;
  /** delays divide by this when the body gives no speed. default: the run plays in about 15 s */
  speed?: number;
  /** the portfolio after the run, from live balances. it replaces the projection in the done event */
  after?: () => Promise<Portfolio>;
}

function streamRun(req: Request, body: Record<string, unknown>, plan: RebalancePlan, ctx: RunContext): Response {
  if (!ctx.executor.simulated && liveRuns > 0) return fail(409, "a live run is going. wait for it to finish");
  const drop = body.dropVenue;
  const dropVenue = drop === null || drop === "none" ? null : typeof drop === "string" ? (drop as VenueId | "auto") : null;
  const lastMs = Math.max(0, ...movesOf(plan).map((m) => m.delayMs)) + 20_000;
  const speedIn = Number(body.speed);
  const speed = Number.isFinite(speedIn) && speedIn > 0 ? speedIn : (ctx.speed ?? Math.max(1, lastMs / 15_000));
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const control = new RunControl();
  runs.set(runId, control);
  const abort = new AbortController();
  req.signal?.addEventListener("abort", () => abort.abort());
  const live = !ctx.executor.simulated;
  if (live) liveRuns++;
  const events = runPlan(plan, {
    runId,
    executor: ctx.executor,
    spot: ctx.spot,
    replan: ctx.replan,
    dropVenue,
    speed,
    prices: ctx.prices,
    gasPerTxWei: ctx.gasPerTxWei,
    control,
    signal: abort.signal,
  });

  const enc = new TextEncoder();
  let ping: ReturnType<typeof setInterval> | undefined;
  const finish = () => {
    if (ping) clearInterval(ping);
    runs.delete(runId);
    if (live) liveRuns--;
  };
  const stream = new ReadableStream<Uint8Array>({
    async start(ctl) {
      const send = (e: RunEvent) => ctl.enqueue(enc.encode(`event: ${e.type}\ndata: ${toJson(e)}\n\n`));
      // a comment line every 5 s keeps the connection open through bun's idle timeout
      ping = setInterval(() => {
        try {
          ctl.enqueue(enc.encode(": ping\n\n"));
        } catch {
          // the stream closed
        }
      }, 5_000);
      try {
        for await (const e of events) {
          if (e.type === "done" && ctx.after) {
            try {
              send({ ...e, after: await ctx.after() });
              continue;
            } catch {
              // keep the projection when the balances do not load
            }
          }
          send(e);
        }
      } catch (e) {
        send({ type: "error", at: Date.now(), message: e instanceof Error ? e.message : String(e) });
      } finally {
        finish();
        try {
          ctl.close();
        } catch {
          // the client went away
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-run-id": runId,
    },
  });
}

// the onchain mode: DEMO_ONCHAIN=1 sends real slices on monad testnet from accounts 10 to 13.
// DEMO_ONCHAIN=dry quotes, plans, and builds the same transactions, and sends nothing

function onchainMode(): "off" | "live" | "dry" {
  const v = process.env.DEMO_ONCHAIN?.trim().toLowerCase();
  if (v === "1" || v === "live" || v === "true") return "live";
  if (v === "dry") return "dry";
  return "off";
}

const onchainSetups = new Map<string, Promise<OnchainSetup>>();

function onchainSetup(mode: "live" | "dry"): Promise<OnchainSetup> {
  let p = onchainSetups.get(mode);
  if (!p) {
    p = loadOnchain({ dryRun: mode === "dry" });
    onchainSetups.set(mode, p);
    p.catch(() => onchainSetups.delete(mode));
  }
  return p;
}

async function handlePlanOnchain(req: Request, mode: "live" | "dry"): Promise<Response> {
  const body = await readJson(req);
  if (body instanceof Response) return body;
  try {
    const s = await onchainSetup(mode);
    const before = await loadOnchainPortfolio(s);
    const sell = Number((body.intent as { sellPerAccount?: unknown } | undefined)?.sellPerAccount ?? body.sellPerAccount);
    const p = await planOnchain(s, before, {
      ...(Number.isFinite(sell) && sell > 0 && sell <= 0.1 ? { sellPerAccountWei: BigInt(Math.round(sell * 1e6)) * 10n ** 12n } : {}),
    });
    const planId = remember(p.rebalance);
    const link = onchainLink(before, before, s.accounts, p.plan);
    return json({
      ...p.rebalance,
      planId,
      onchain: { mode, network: "monad testnet", chainId: 10143 },
      accounts: s.swarm,
      correlation: { before: link.correlation.before, after: link.correlation.after, naive: link.correlation.naive, simulated: false },
      balancesSimulated: false,
      prices: s.prices,
      sentence: p.sentence,
      sources: {
        venues: { note: s.venues.map((v) => v.id).join(", "), simulated: false, network: "monad testnet" },
        prices: { note: `the median of ${s.venuePrices.map((v) => `${v.venue} ${v.usdcPerMon.toFixed(4)}`).join(", ")}`, simulated: false },
        balances: { note: `live balances of accounts ${s.accounts.join(", ")} on monad testnet`, simulated: false },
        gas: { gwei: Number(s.gas.monadWei) / 1e9, note: s.gas.source, simulated: false },
        planner: "@spidereum/router plan",
        executor: { note: s.executor.name, simulated: s.executor.simulated },
        correlation: "@spidereum/swarm correlationScore, with the 8 funding transfers from account 0 as links",
      },
      linkability: {
        largestMove: { split: link.largestShare, naive: 1 },
        correlation: link.correlation,
        directTransfers: { planned: 0, funding: link.transfers, total: link.directTransfers },
      },
      moves: p.plan.slices.length,
    });
  } catch (e) {
    return fail(500, `the onchain plan failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function handleExecuteOnchain(req: Request, mode: "live" | "dry"): Promise<Response> {
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const sent = body.plan as { planId?: string } | undefined;
  const planId = typeof body.planId === "string" ? body.planId : sent?.planId;
  const plan = planId ? plans.get(planId) : undefined;
  // an onchain run sends real transactions, so it runs only a plan this server made
  if (!plan) return fail(409, "an onchain run needs a plan from this server. POST /plan first, and send its planId");
  const s = await onchainSetup(mode);
  return streamRun(req, body, plan, {
    executor: s.executor,
    spot: s.venues,
    replan: s.replan,
    prices: s.prices,
    gasPerTxWei: 0n,
    speed: 1,
    ...(mode === "live" ? { after: () => loadOnchainPortfolio(s) } : {}),
  });
}

async function handleVenueOff(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const runId = typeof body.runId === "string" ? body.runId : "";
  const venue = typeof body.venue === "string" ? (body.venue as VenueId) : null;
  const control = runs.get(runId);
  if (!control) return fail(404, `no run ${runId || "(no runId)"} is going`);
  if (!venue) return fail(400, "venue is missing");
  control.venueOff(venue);
  return json({ ok: true, runId, venue });
}

const OWN = new Set(["/plan", "/execute", "/execute/venue-off"]);

/** the run's routes. returns null for a path this module does not own */
export async function handleRun(req: Request): Promise<Response | null> {
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
  if (!OWN.has(path)) return null;
  if (req.method !== "POST") return new Response("use POST", { status: 405, headers: { allow: "POST" } });
  const mode = onchainMode();
  if (mode !== "off") {
    if (path === "/plan") return handlePlanOnchain(req, mode);
    if (path === "/execute") return handleExecuteOnchain(req, mode);
    return handleVenueOff(req);
  }
  let setup: Setup;
  try {
    setup = await loadSetup();
  } catch (e) {
    return fail(503, `the demo could not load: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (path === "/plan") return handlePlan(req, setup);
  if (path === "/execute") return handleExecute(req, setup);
  return handleVenueOff(req);
}

/** the same routes for Bun.serve({ routes }) */
export const routes = {
  "/plan": { POST: (req: Request) => handleRun(req) as Promise<Response> },
  "/execute": { POST: (req: Request) => handleRun(req) as Promise<Response> },
  "/execute/venue-off": { POST: (req: Request) => handleRun(req) as Promise<Response> },
};

/** a fetch handler on its own: the run's routes, and 404 for the rest */
export async function fetchRun(req: Request): Promise<Response> {
  return (await handleRun(req)) ?? new Response("not found", { status: 404 });
}
