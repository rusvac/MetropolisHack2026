#!/usr/bin/env bun
// `bun run demo`: the seven beats in the terminal, from one RebalancePlan.
//
//   bun run demo                  the run plays in about 15 s
//   bun run demo --fast           no waiting
//   bun run demo --drop=none      no venue turns off
//   bun run demo --drop=kuru      this venue turns off halfway
//   bun run demo --privacy=0.8    0 = the cheapest plan, 1 = the smallest largest slice
//
// the switches from mock to live are in scripts/config.ts
import type { VenueId } from "../packages/core/src/index.ts";
import { SENTENCE, demoIntent, loadSetup, type DemoConfig } from "./config.ts";
import { beatAfter, beatIntent, beatLink, beatPlan, beatPortfolio, beatSwarm, header, printEvent, sources, summary } from "./lib/beats.ts";
import type { Out } from "./lib/format.ts";
import { linkability } from "./lib/link.ts";
import { movesOf, runPlan } from "./lib/run.ts";

export interface DemoOptions {
  out?: Out;
  /** delays divide by this. Infinity = no waiting. default: the run plays in about `seconds` */
  speed?: number;
  seconds?: number;
  dropVenue?: VenueId | "auto" | null;
  privacyWeight?: number;
  config?: Partial<DemoConfig>;
}

/** assumptions for the "why monad" line. both simulated */
const ETH_GAS_GWEI = 1;
const ETH_USD = 4_000;

export async function runDemo(opts: DemoOptions = {}) {
  const out = opts.out ?? ((l: string) => console.log(l));
  const setup = await loadSetup(opts.config ?? {});
  const intent = demoIntent(opts.privacyWeight ?? 0.5);

  header(out);
  const { portfolio: before, simulated: balancesSimulated, note } = await setup.loadPortfolio();
  const { plan, planner, note: plannerNote } = await setup.plan(before, intent);
  sources(out, setup, note, balancesSimulated, plannerNote ? `${planner} (${plannerNote})` : planner);

  beatSwarm(out, setup.swarm, setup.seedNote);
  beatPortfolio(out, plan.before, note, balancesSimulated);
  beatIntent(out, SENTENCE, intent, plan.before, setup.venues.perp?.id ?? "no perp venue");
  beatPlan(out, plan, setup, { ethGasGwei: ETH_GAS_GWEI, ethUsd: ETH_USD });

  const lastMs = Math.max(0, ...movesOf(plan).map((m) => m.delayMs)) + 20_000;
  const speed = opts.speed ?? Math.max(1, lastMs / ((opts.seconds ?? 15) * 1_000));
  const gasPerTx = setup.gas.monadWei * 250_000n;
  let after = plan.after;
  const events = runPlan(plan, {
    executor: setup.executor,
    spot: setup.venues.spot,
    replan: setup.replan,
    dropVenue: opts.dropVenue === undefined ? "auto" : opts.dropVenue,
    speed,
    prices: setup.prices,
    gasPerTxWei: gasPerTx,
    queued: false,
  });
  const runEvents = [];
  for await (const e of events) {
    runEvents.push(e);
    after = printEvent(out, e) ?? after;
  }

  const hedge = plan.hedge ?? plan.swaps.find((x) => x.hedge)?.hedge;
  const hedgeNote = hedge ? `hedge: a short of ${(Number(hedge.size) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 0 })} MON on ${hedge.venue}, ${intent.hedgeRatio! * 100}% of the MON target. a quote, nothing sent` : null;
  const simulated = balancesSimulated || setup.executor.simulated || setup.venuesSimulated;
  beatAfter(out, intent, plan.before, after, simulated, hedgeNote);

  const gasTopUps = runEvents.flatMap((e) => (e.type === "move" && e.kind === "gas" && (e.status === "confirmed" || e.status === "quoted") ? [e.toAccount] : []));
  const link = linkability(plan, {
    prices: setup.prices,
    after,
    correlation: setup.correlation,
    correlationSource: setup.correlationNote,
    gasTopUps,
  });
  beatLink(out, link);
  summary(out, SENTENCE, plan, link, simulated);
  return { plan, after, link, events: runEvents, setup };
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true";
}

if (import.meta.main) {
  const drop = arg("drop");
  const privacy = arg("privacy");
  await runDemo({
    speed: arg("fast") ? Infinity : arg("speed") ? Number(arg("speed")) : undefined,
    dropVenue: drop === undefined ? "auto" : drop === "none" ? null : (drop as VenueId),
    privacyWeight: privacy ? Number(privacy) : undefined,
  }).catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  });
}
