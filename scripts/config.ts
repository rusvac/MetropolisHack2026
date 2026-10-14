// the demo's switches. each one goes from mock to live in one line: change the default here,
// or set the env var for one run (for example DEMO_VENUES=live bun run demo).
// `bun run demo` and apps/server/src/run.ts both load the demo from this module
import type { Intent, Portfolio, RebalanceIntent, RebalancePlan, Slice, SpotVenue, VenueId } from "../packages/core/src/index.ts";
import { deriveSwarmAccount } from "../packages/swarm/src/addresses.ts";
import { fakePortfolio, mockBridge, mockPerp, mockSpotVenues } from "./lib/fake.ts";
import { walletConcentration, type CorrelationFn } from "./lib/link.ts";
import { midPrice, type GasInfo, type Prices, type VenueSet } from "./lib/plan-math.ts";
import { isMockVenue, landed, simulatedExecutor, type Executor, type Move } from "./lib/run.ts";
import { txUrl } from "./lib/tokens.ts";
import { standInRebalance, standInReplan, type Replanner } from "./lib/standin.ts";
import { DEMO_BASE_ACCOUNTS, DEMO_MONAD_ACCOUNTS, MON_MAINNET, USDC_MAINNET } from "./lib/tokens.ts";

function pick<T extends string>(env: string, fallback: T, allowed: readonly T[]): T {
  const v = process.env[env]?.trim() as T | undefined;
  return v && allowed.includes(v) ? v : fallback;
}

export const DEMO = {
  /** "live": the venues @spidereum/venues exports, with a mock where a venue is missing. "mock": all mock */
  venues: "live" as "mock" | "live",
  /** "fake": a fixed portfolio. "live": balances from @spidereum/swarm's loadPortfolio */
  portfolio: "fake" as "fake" | "live",
  /** "simulated": nothing goes onchain. "swarm": @spidereum/swarm's sendSlice, from accounts 10 to 19 only */
  executor: "simulated" as "simulated" | "swarm",
  /** "auto": @spidereum/router's rebalance when it works, else the stand-in */
  planner: "auto" as "auto" | "stand-in" | "router",
  /** "auto": @spidereum/swarm's correlationScore when it works, else the stand-in */
  correlation: "auto" as "auto" | "stand-in",
  /** "live": eth_gasPrice from monad mainnet. "fixed": 100 gwei, simulated */
  gas: "live" as "live" | "fixed",
};

/** DEMO, with the env vars on top. read at load time, so a test can set them first */
export function demoConfig(): DemoConfig {
  return {
    venues: pick("DEMO_VENUES", DEMO.venues, ["mock", "live"] as const),
    portfolio: pick("DEMO_PORTFOLIO", DEMO.portfolio, ["fake", "live"] as const),
    executor: pick("DEMO_EXECUTOR", DEMO.executor, ["simulated", "swarm"] as const),
    planner: pick("DEMO_PLANNER", DEMO.planner, ["auto", "stand-in", "router"] as const),
    correlation: pick("DEMO_CORRELATION", DEMO.correlation, ["auto", "stand-in"] as const),
    gas: pick("DEMO_GAS", DEMO.gas, ["live", "fixed"] as const),
  };
}

export type DemoConfig = typeof DEMO;

/** the sentence and the intent the demo states */
export const SENTENCE = "Get me to 70% MON and 30% USDC, with half the MON hedged.";

export function demoIntent(privacyWeight = 0.5): RebalanceIntent {
  return {
    id: "rebalance-70-30",
    targets: [
      { symbol: "MON", weight: 0.7 },
      { symbol: "USDC", weight: 0.3 },
    ],
    hedgeRatio: 0.5,
    privacyWeight,
  };
}

/** only these accounts may send in a live run. the lead funds them */
export const LIVE_SEND_ACCOUNTS = new Set(DEMO_MONAD_ACCOUNTS);

export interface SwarmAccount {
  chainId: number;
  index: number;
  address: string;
}

export interface PlanResult {
  plan: RebalancePlan;
  /** "@spidereum/router" or "stand-in" */
  planner: string;
  note?: string;
}

export interface Setup {
  config: DemoConfig;
  venues: VenueSet;
  venuesNote: string;
  /** true when any venue is a mock */
  venuesSimulated: boolean;
  prices: Prices;
  pricesNote: string;
  pricesSimulated: boolean;
  gas: GasInfo;
  swarm: SwarmAccount[];
  seedNote: string;
  monadAccounts: number[];
  baseAccounts: number[];
  loadPortfolio(): Promise<{ portfolio: Portfolio; simulated: boolean; note: string }>;
  plan(before: Portfolio, intent: RebalanceIntent): Promise<PlanResult>;
  replan: Replanner;
  replanNote: string;
  executor: Executor;
  executorNote: string;
  correlation: CorrelationFn;
  correlationNote: string;
  /** what fell back to a stand-in, and why */
  notes: string[];
}

export type Mod = Record<string, unknown>;

async function load(path: string): Promise<Mod | null> {
  try {
    return (await import(path)) as Mod;
  } catch {
    return null;
  }
}

const fn = (m: Mod | null, name: string) => (m && typeof m[name] === "function" ? (m[name] as (...a: unknown[]) => unknown) : null);

async function gasInfo(mode: DemoConfig["gas"]): Promise<GasInfo> {
  const fixed: GasInfo = { monadWei: 100n * 10n ** 9n, simulated: true, source: "fixed at 100 gwei" };
  const url = process.env.MONAD_RPC_URL;
  if (mode === "fixed" || !url) return fixed;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
      signal: AbortSignal.timeout(4_000),
    });
    const body = (await res.json()) as { result?: string };
    if (!body.result) return fixed;
    return { monadWei: BigInt(body.result), simulated: false, source: "eth_gasPrice on monad mainnet" };
  } catch {
    return fixed;
  }
}

function deriveSwarm(monad: number[], base: number[]): { accounts: SwarmAccount[]; note: string } {
  const env = process.env.BURNER_MNEMONIC?.trim();
  // the public test seed of hardhat and anvil, only when .env has no seed
  const mnemonic = env || "test test test test test test test test test test test junk";
  const note = env ? "BURNER_MNEMONIC" : "the public test seed, because BURNER_MNEMONIC is not set";
  const accounts: SwarmAccount[] = [];
  for (const index of base) accounts.push({ chainId: 84532, index, address: deriveSwarmAccount(mnemonic, 84532, index).address });
  for (const index of monad) accounts.push({ chainId: 10143, index, address: deriveSwarmAccount(mnemonic, 10143, index).address });
  return { accounts, note };
}

/**
 * the spot venues of a live run, by the factory name @spidereum/venues exports. a name the registry does not
 * export is skipped. kuru and uniswap-v4 quote monad mainnet. the test pool quotes and executes on testnet
 */
// mainnet quote venues only. the testnet venues belong to demo:onchain
export const LIVE_SPOT_FACTORIES = ["createKuruVenue", "createUniswapVenue"];

/** options per venue factory. every factory defaults to mainnet quotes and testnet execution */
function factoryOptions(name: string): Record<string, unknown> {
  if (name === "createAuroraBridge") return process.env.AURORA_API_KEY ? { apiKey: process.env.AURORA_API_KEY } : {};
  return {};
}

async function loadVenues(mode: DemoConfig["venues"], notes: string[]): Promise<{ venues: VenueSet; note: string; simulated: boolean }> {
  if (mode === "mock") {
    return { venues: { spot: mockSpotVenues(), perp: mockPerp(), bridge: mockBridge() }, note: "mock-kuru, mock-uniswap-v4, mock-perpl, mock-aurora: all simulated", simulated: true };
  }
  const reg = await load("../packages/venues/src/index.ts");
  const make = async (name: string) => {
    const f = fn(reg, name);
    if (!f) return null;
    try {
      return await f(factoryOptions(name));
    } catch (e) {
      notes.push(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };
  const spot = (await Promise.all(LIVE_SPOT_FACTORIES.map(make))).filter(Boolean) as VenueSet["spot"];
  let perp = (await make("createPerplVenue")) as VenueSet["perp"] | null;
  let bridge = (await make("createAuroraBridge")) as VenueSet["bridge"] | null;
  // a missing venue falls back to a mock at the live price, so the split stays honest
  const live = spot.length ? await midPrice(spot).catch(() => null) : null;
  const monUsd = live?.monUsd;
  if (spot.length < 2) {
    notes.push(`${spot.length} live spot venue(s). a mock pool at the live price fills in`);
    const mocks = mockSpotVenues(monUsd).filter((m) => !spot.some((v) => m.id === `mock-${v.id}`));
    spot.push(...mocks.slice(0, 2 - spot.length));
  }
  if (!perp) {
    notes.push("no live perp venue. the hedge quote is a mock");
    perp = mockPerp(monUsd);
  }
  if (!bridge) {
    notes.push("no live bridge. the bridge quotes are a mock");
    bridge = mockBridge();
  }
  // aurora quotes live only with a key (or a proxy). its bridge says so in `live`
  const isLive = (v: { id: string; live?: unknown }) => !isMockVenue(v.id) && v.live !== false;
  const all = [...spot, perp, bridge] as { id: string; live?: unknown }[];
  const simulated = all.some((v) => !isLive(v));
  const note = all.map((v) => `${v.id} ${isLive(v) ? "live" : "simulated"}`).join(", ");
  return { venues: { spot, perp, bridge }, note, simulated };
}

function routerPlanner(mod: Mod | null, setup: () => Setup, mode: DemoConfig["planner"]): Setup["plan"] {
  const rebalance = fn(mod, "rebalance");
  return async (before, intent) => {
    const s = setup();
    const standIn = async (note?: string): Promise<PlanResult> => ({
      plan: await standInRebalance(before, intent, s.venues, { monadAccounts: s.monadAccounts, gas: s.gas }),
      planner: "stand-in (scripts/lib/standin.ts)",
      ...(note ? { note } : {}),
    });
    if (mode === "stand-in" || !rebalance) return standIn(mode === "stand-in" ? undefined : "@spidereum/router exports no rebalance");
    try {
      const venues = [...s.venues.spot, ...(s.venues.perp ? [s.venues.perp] : []), ...(s.venues.bridge ? [s.venues.bridge] : [])];
      const plan = (await rebalance(before, intent, venues, {
        accounts: s.monadAccounts,
        // quotes come from monad mainnet. the run maps each token to its testnet twin
        tokens: { MON: MON_MAINNET, USDC: USDC_MAINNET },
        gasPriceWei: s.gas.monadWei,
        prices: s.prices,
      })) as RebalancePlan;
      if (!plan || !Array.isArray(plan.swaps) || !Array.isArray(plan.bridges)) throw new Error("rebalance returned no RebalancePlan");
      return { plan, planner: "@spidereum/router" };
    } catch (e) {
      if (mode === "router") throw e;
      return standIn(`@spidereum/router's rebalance failed (${e instanceof Error ? e.message : String(e)})`);
    }
  };
}

/** the router's replan as a Replanner. `options` gives the plan options at call time */
export function routerReplan(mod: Mod | null, options: () => Record<string, unknown>): Replanner {
  const replan = fn(mod, "replan");
  if (!replan) return standInReplan;
  return async (args) => {
    try {
      // the router's replan takes the slices already done, and keeps them as the same objects.
      // a slice keeps its account, size, and delay through a re-route, so match on those
      const left = new Map<string, number>();
      for (const s of args.remaining) left.set(key(s), (left.get(key(s)) ?? 0) + 1);
      const done = args.swap.slices.filter((s) => {
        const n = left.get(key(s)) ?? 0;
        if (n > 0) {
          left.set(key(s), n - 1);
          return false;
        }
        return true;
      });
      const next = (await replan(args.swap, done, args.venues, options())) as { slices?: Slice[] };
      if (!next || !Array.isArray(next.slices)) throw new Error("replan returned no slices");
      const todo = next.slices.filter((s) => !done.includes(s));
      if (todo.some((s) => s.venue === args.dropped)) throw new Error("replan kept the dropped venue");
      return todo;
    } catch {
      return standInReplan(args);
    }
  };
}

const key = (s: Slice) => `${s.account}:${s.amountIn}:${s.delayMs}`;

export interface SwarmExecutorOptions {
  /** quote the slice again on its venue just before the build, so the minimum output fits the book now. default true */
  requote?: boolean;
  /** build the transactions and send nothing */
  dryRun?: boolean;
  /** slippage for the minimum output, in basis points. default 100 */
  maxSlippageBps?: number;
  /** accounts that may send. default 10 to 19 */
  accounts?: Set<number>;
}

/**
 * the live executor: @spidereum/swarm's sendSlice, for swap slices from accounts 10 to 19 only. the bridge,
 * the hedge, and gas top-ups stay quotes. `mod` is the swarm module, so a test can pass a fake one
 */
export function swarmExecutor(
  mod: Mod | null,
  setup: () => Pick<Setup, "venues" | "swarm">,
  notes: string[],
  opts: SwarmExecutorOptions = {},
): Executor {
  const sendSlice = fn(mod, "sendSlice");
  if (!sendSlice && !opts.dryRun) {
    notes.push("@spidereum/swarm exports no sendSlice. the run is simulated");
    return simulatedExecutor();
  }
  const allowed = opts.accounts ?? LIVE_SEND_ACCOUNTS;
  const slippage = opts.maxSlippageBps ?? 100;
  return {
    name: opts.dryRun ? "dry run (builds, sends nothing)" : `swarm (monad testnet, accounts ${[...allowed].join(", ")})`,
    simulated: !!opts.dryRun,
    async send(move: Move, _runId: string, onSent?: (hash: string) => void) {
      if (move.kind === "bridge") return { status: "quoted", hash: null, url: null, note: "bridge quote only, nothing sent" };
      if (move.kind === "hedge") return { status: "quoted", hash: null, url: null, note: "short quote only, nothing sent" };
      if (move.kind === "gas") return { status: "quoted", hash: null, url: null, note: "not sent: the lead tops up gas from account 0" };
      if (!allowed.has(move.account)) throw new Error(`account ${move.account} may not send. only accounts ${[...allowed].join(", ")} send in a live run`);
      const venue = setup().venues.spot.find((v) => v.id === move.venue);
      if (!venue?.build) return { status: "quoted", hash: null, url: null, note: `${move.venue} is quote-only, nothing sent` };
      const address = setup().swarm.find((a) => a.chainId === 10143 && a.index === move.account)?.address;
      if (!address) throw new Error(`no address for monad account ${move.account}`);
      const slice: Slice = { venue: move.venue, account: move.account, amountIn: move.amountIn, expectedOut: move.amountOut, delayMs: move.delayMs };
      const intent: Intent = { id: move.id, sell: move.sell, buy: move.buy, amountIn: move.amountIn, maxSlippageBps: slippage, privacyWeight: 0 };
      if (opts.requote ?? true) {
        // the plan's expectedOut can come from another network or an older book. quote the execution market now
        const v = venue as typeof venue & { quoteExecution?: SpotVenue["quote"] };
        try {
          const q = await (v.quoteExecution ?? v.quote).call(v, { sell: move.sell, buy: move.buy, amountIn: move.amountIn });
          if (q.amountOut <= 0n) throw new Error("the venue quotes 0");
          slice.expectedOut = q.amountOut;
        } catch (e) {
          return { status: "failed", hash: null, url: null, note: `quote failed: ${e instanceof Error ? e.message : String(e)}`, reroute: true };
        }
      }
      let txs: Awaited<ReturnType<NonNullable<typeof venue.build>>>;
      try {
        txs = await venue.build(slice, intent, address as Intent["sell"]["address"]);
      } catch (e) {
        // for example kuru's thin testnet book. the run re-routes the slice to the other venues
        return { status: "failed", hash: null, url: null, note: `build failed: ${e instanceof Error ? e.message : String(e)}`, reroute: true };
      }
      if (opts.dryRun) {
        return { status: "quoted", hash: null, url: null, expectedOut: slice.expectedOut, note: `dry run: built ${txs.length} transaction${txs.length === 1 ? "" : "s"}, nothing sent` };
      }
      const result = (await sendSlice!(slice, txs, {
        chainId: 10143,
        onTx: (tx: { hash: string; status: string }) => {
          if (tx.status === "pending") onSent?.(tx.hash);
        },
      })) as { ok: boolean; txs: { hash: string; url?: string; status: string; gasUsed?: bigint }[]; error?: string };
      const links = result.txs.map((t) => ({ hash: t.hash, url: t.url ?? txUrl(10143, t.hash), status: t.status, ...(t.gasUsed !== undefined ? { gasUsed: t.gasUsed } : {}) }));
      const last = links.at(-1);
      const allOk = result.ok && links.length === txs.length && links.every((t) => t.status === "success");
      if (!allOk || !last) {
        return { status: "failed", txs: links, hash: last?.hash ?? null, url: last?.url ?? null, expectedOut: slice.expectedOut, note: result.error ?? "a transaction did not succeed" };
      }
      return { ...landed(10143, last.hash), txs: links, expectedOut: slice.expectedOut };
    },
  };
}

function correlationFrom(mod: Mod | null, mode: DemoConfig["correlation"]): { fn: CorrelationFn; note: string } {
  const score = fn(mod, "correlationScore");
  const standIn = { fn: walletConcentration, note: "stand-in: wallet concentration, ported from spidereum's analyzer" };
  if (mode === "stand-in" || !score) return standIn;
  return {
    fn: (portfolio, transfers = []) => {
      try {
        const r = score({ portfolio, transfers }) as { score?: number };
        if (typeof r.score !== "number" || !Number.isFinite(r.score)) throw new Error("no score");
        return Math.round(r.score * 100);
      } catch {
        return walletConcentration(portfolio);
      }
    },
    note: "@spidereum/swarm correlationScore: the ported analyzer, with direct transfers as links",
  };
}

const cache = new Map<string, Promise<Setup>>();

/** load the demo once per config: venues, prices, gas, swarm addresses, planner, executor */
export function loadSetup(over: Partial<DemoConfig> = {}): Promise<Setup> {
  const config = { ...demoConfig(), ...over };
  const key = JSON.stringify(config);
  let p = cache.get(key);
  if (!p) {
    p = buildSetup(config);
    cache.set(key, p);
    // a failed load is not kept, so the next call tries again
    p.catch(() => cache.delete(key));
  }
  return p;
}

async function buildSetup(config: DemoConfig): Promise<Setup> {
  const notes: string[] = [];
  const monadAccounts = DEMO_MONAD_ACCOUNTS;
  const baseAccounts = DEMO_BASE_ACCOUNTS;
  const [venuesR, gas, router, swarmMod] = await Promise.all([
    loadVenues(config.venues, notes),
    gasInfo(config.gas),
    load("../packages/router/src/index.ts"),
    load("../packages/swarm/src/index.ts"),
  ]);
  const mid = await midPrice(venuesR.venues.spot);
  const prices: Prices = { USDC: 1, MON: mid.monUsd };
  const swarm = deriveSwarm(monadAccounts, baseAccounts);
  const corr = correlationFrom(swarmMod, config.correlation);

  let setup!: Setup;
  const get = () => setup;
  const executor = config.executor === "swarm" ? swarmExecutor(swarmMod, get, notes) : simulatedExecutor();
  setup = {
    config,
    venues: venuesR.venues,
    venuesNote: venuesR.note,
    venuesSimulated: venuesR.simulated,
    prices,
    pricesNote: `from a 10 USDC probe quote on ${mid.venue}`,
    pricesSimulated: mid.simulated,
    gas,
    swarm: swarm.accounts,
    seedNote: swarm.note,
    monadAccounts,
    baseAccounts,
    async loadPortfolio() {
      if (config.portfolio === "fake") return { portfolio: fakePortfolio(prices.MON), simulated: true, note: "a fixed portfolio" };
      const lp = fn(swarmMod, "loadPortfolio");
      if (!lp) {
        notes.push("@spidereum/swarm exports no loadPortfolio. the portfolio is the fake one");
        return { portfolio: fakePortfolio(prices.MON), simulated: true, note: "a fixed portfolio, simulated (no loadPortfolio)" };
      }
      try {
        const portfolio = (await lp({ prices, accounts: { 10143: monadAccounts, 84532: baseAccounts } })) as Portfolio;
        return { portfolio, simulated: false, note: "live balances on monad testnet and base sepolia" };
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        notes.push(`loadPortfolio failed (${why}). the portfolio is the fake one`);
        return { portfolio: fakePortfolio(prices.MON), simulated: true, note: `a fixed portfolio, simulated (loadPortfolio failed: ${why})` };
      }
    },
    plan: routerPlanner(router, get, config.planner),
    replan: routerReplan(router, () => ({ accounts: setup.monadAccounts, gasPriceWei: setup.gas.monadWei, prices: setup.prices })),
    replanNote: fn(router, "replan") ? "@spidereum/router replan, else the stand-in" : "stand-in",
    executor,
    executorNote: executor.simulated ? "simulated: nothing goes onchain" : executor.name,
    correlation: corr.fn,
    correlationNote: corr.note,
    notes,
  };
  return setup;
}

export type { VenueId };
