#!/usr/bin/env bun
// `bun run demo:onchain`: the seven beats with every quote and every send on monad testnet.
// it sends real testnet transactions from swarm accounts 10 to 13, and prints an explorer link for each one.
//
//   bun run demo:onchain                 sell 0.05 MON per account, in slices, and turn one venue off halfway
//   bun run demo:onchain --dry           quote, plan, and build every transaction. send nothing
//   bun run demo:onchain --sell=0.03     MON each account sells
//   bun run demo:onchain --drop=none     no venue turns off
//
// each account keeps at least 0.08 MON for gas
import type { VenueId } from "../packages/core/src/index.ts";
import { beatSwarm, header, printEvent } from "./lib/beats.ts";
import { SIM, boxBottom, boxLine, boxTop, pct, section, seconds, toNumber, units, usd, type Out } from "./lib/format.ts";
import {
  GAS_RESERVE_WEI,
  ONCHAIN_NETWORK,
  loadOnchain,
  loadOnchainPortfolio,
  onchainLink,
  planOnchain,
  type OnchainOptions,
} from "./lib/onchain.ts";
import { runPlan, type MoveEvent, type RunEvent } from "./lib/run.ts";
import type { Portfolio } from "../packages/core/src/index.ts";

const LIVE = `live, ${ONCHAIN_NETWORK}`;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true";
}

function perAccount(p: Portfolio): Map<number, { MON: bigint; USDC: bigint; usd: number }> {
  const m = new Map<number, { MON: bigint; USDC: bigint; usd: number }>();
  for (const h of p.holdings) {
    const r = m.get(h.account) ?? { MON: 0n, USDC: 0n, usd: 0 };
    if (h.token.symbol === "MON") r.MON += h.amount;
    if (h.token.symbol === "USDC") r.USDC += h.amount;
    r.usd += h.usd;
    m.set(h.account, r);
  }
  return m;
}

export interface OnchainDemoOptions extends OnchainOptions {
  out?: Out;
  dropVenue?: VenueId | "auto" | null;
}

export async function runOnchainDemo(opts: OnchainDemoOptions = {}) {
  const out = opts.out ?? ((l: string) => console.log(l));
  const s = await loadOnchain(opts);
  header(out);
  out("");
  out(`  where each number comes from: monad testnet (10143), nothing from mainnet and nothing simulated`);
  out(`    venues       ${s.venues.map((v) => v.id).join(", ")}  (${LIVE} quotes)`);
  out(`    prices       MON at ${s.prices.MON!.toFixed(4)} USDC, the median of ${s.venuePrices.map((p) => `${p.venue} ${p.usdcPerMon.toFixed(4)}`).join(", ")}  (${LIVE})`);
  out(`    gas          ${units(s.gas.monadWei, 9, 1)} gwei, ${s.gas.source}  (${LIVE})`);
  out(`    balances     loadPortfolio on accounts ${s.accounts.join(", ")}  (${LIVE})`);
  out(`    planner      @spidereum/router plan, and replan for the re-route`);
  out(`    executor     ${s.executor.name}${opts.dryRun ? `  (${SIM}: nothing goes onchain)` : ""}`);
  out(`    dollars      USDC. MON is valued at the median testnet price above`);

  beatSwarm(out, s.swarm, "BURNER_MNEMONIC");

  // 2. the portfolio now, from live balances
  const before = await loadOnchainPortfolio(s);
  section(out, "2 · THE PORTFOLIO NOW", "Holdings per account, from live balances");
  out("");
  out(`  total ${usd(before.totalUsd)}  (${LIVE})`);
  for (const [a, r] of [...perAccount(before)].sort((x, y) => x[0] - y[0])) {
    out(`    monad:${String(a).padEnd(3)} ${units(r.MON, 18, 4).padStart(8)} MON  ${units(r.USDC, 6, 4).padStart(8)} USDC   ${usd(r.usd).padStart(8)}`);
  }

  // 3. the intent
  const p = await planOnchain(s, before, opts);
  section(out, "3 · THE INTENT", "What the testnet books can fill: a MON sale, split over venues and accounts");
  out("");
  out(`  "${p.sentence}"`);
  out("");
  for (const [a, x] of Object.entries(p.sellable)) out(`    monad:${a.padEnd(3)} sells up to ${units(x, 18, 4)} MON and keeps at least ${units(GAS_RESERVE_WEI, 18, 2)} MON for gas`);
  out(`  privacy   ${p.intent.privacyWeight}  (1 = the most slices, so the largest slice shows the least)`);

  // 4. the plan
  section(out, "4 · THE PLAN", "Slices per account and venue, each with a delay. Next to it, one trade at the best venue");
  out("");
  const plan = p.plan;
  for (const a of [...new Set(plan.slices.map((x) => x.account))]) {
    const mine = plan.slices.filter((x) => x.account === a);
    out(`    monad:${a}`);
    mine.forEach((x, i) =>
      out(
        `      ${i === mine.length - 1 ? "└─" : "├─"} ${seconds(x.delayMs).padStart(6)}  ${x.venue.padEnd(19)} ${units(x.amountIn, 18, 4).padStart(7)} MON → ${units(x.expectedOut, 6, 6).padStart(9)} USDC`,
      ),
    );
  }
  out(`    largest slice: ${pct(plan.largestSliceShare)} of the sale  (${LIVE} quotes)`);
  const gasMon = (u: bigint) => toNumber(u * s.gas.monadWei, 18);
  const splitNet = toNumber(plan.expectedOut, 6) - gasMon(plan.gasUnits) * s.prices.MON!;
  const naiveNet = toNumber(plan.baseline.amountOut, 6) - gasMon(plan.baseline.gasUnits) * s.prices.MON!;
  out("");
  out(boxTop());
  out(boxLine(`split vs one trade at ${plan.baseline.venue}, in USDC`));
  out(boxLine(`${LIVE} quotes and gas price`));
  out(boxLine(""));
  out(boxLine(`${"".padEnd(18)}${"split".padStart(12)}${"one trade".padStart(12)}`));
  out(boxLine(`${"transactions".padEnd(18)}${String(plan.slices.length).padStart(12)}${"1".padStart(12)}`));
  out(boxLine(`${"USDC out".padEnd(18)}${units(plan.expectedOut, 6, 6).padStart(12)}${units(plan.baseline.amountOut, 6, 6).padStart(12)}`));
  out(boxLine(`${"gas, in MON".padEnd(18)}${gasMon(plan.gasUnits).toFixed(5).padStart(12)}${gasMon(plan.baseline.gasUnits).toFixed(5).padStart(12)}`));
  out(boxLine(`${"net, in USDC".padEnd(18)}${splitNet.toFixed(6).padStart(12)}${naiveNet.toFixed(6).padStart(12)}`));
  out(boxLine(""));
  out(boxLine(splitNet >= naiveNet ? `the split gets ${(splitNet - naiveNet).toFixed(6)} USDC more, after gas` : `the split gets ${(naiveNet - splitNet).toFixed(6)} USDC less, after gas`));
  out(boxBottom());
  if (splitNet < naiveNet) {
    out("  at testnet size, gas is most of the cost: each slice spends about 0.02 MON of gas to sell a few hundredths of a MON.");
    out("  at the mainnet size in `bun run demo`, the gas for all the slices is under one cent");
  }

  // 5. execute
  const events: RunEvent[] = [];
  const gen = runPlan(p.rebalance, {
    executor: s.executor,
    spot: s.venues,
    replan: s.replan,
    dropVenue: opts.dropVenue === undefined ? "auto" : opts.dropVenue,
    speed: 1,
    prices: s.prices,
    queued: false,
  });
  let projected = before;
  for await (const e of gen) {
    events.push(e);
    projected = printEvent(out, e) ?? projected;
  }
  const finals = events.filter((e): e is MoveEvent => e.type === "move" && (e.status === "confirmed" || e.status === "failed" || e.status === "quoted"));
  const txs = finals.flatMap((e) => e.txs ?? []);
  const gasUsed = txs.reduce((t, x) => t + (x.gasUsed ?? 0n), 0n);
  out(`  ${txs.length} transactions onchain, ${txs.filter((t) => t.status === "success").length} with status success, ${units(gasUsed, 0)} gas (${gasMon(gasUsed).toFixed(5)} MON)`);

  // 6. the portfolio after: live balances again, or the projection on a dry run
  const after = opts.dryRun ? projected : await loadOnchainPortfolio(s);
  section(out, "6 · THE PORTFOLIO AFTER", opts.dryRun ? "Projected from the quotes, because the dry run sends nothing" : "Live balances after the run, per account and in total");
  out("");
  const b = perAccount(before);
  const a = perAccount(after);
  out(`  ${"account".padEnd(10)} ${"MON before".padStart(11)} ${"MON after".padStart(11)} ${"USDC before".padStart(12)} ${"USDC after".padStart(12)}`);
  for (const acc of [...new Set([...b.keys(), ...a.keys()])].sort((x, y) => x - y)) {
    const rb = b.get(acc) ?? { MON: 0n, USDC: 0n, usd: 0 };
    const ra = a.get(acc) ?? { MON: 0n, USDC: 0n, usd: 0 };
    out(`  ${`monad:${acc}`.padEnd(10)} ${units(rb.MON, 18, 4).padStart(11)} ${units(ra.MON, 18, 4).padStart(11)} ${units(rb.USDC, 6, 6).padStart(12)} ${units(ra.USDC, 6, 6).padStart(12)}`);
  }
  out(`  ${"total".padEnd(10)} ${usd(before.totalUsd).padStart(11)} ${usd(after.totalUsd).padStart(11)}   (${opts.dryRun ? `${SIM}: projected` : LIVE})`);

  // 7. what an observer can link
  const link = onchainLink(before, after, s.accounts, plan);
  section(out, "7 · WHAT AN OBSERVER CAN LINK", "The largest move, the correlation score, and the direct transfers");
  out("");
  out(`  largest single move     ${pct(link.largestShare)} of the sale   one trade: 100%`);
  out(`  correlation score       before ${link.correlation.before}   after ${link.correlation.after}   one account ${link.correlation.naive}   (0 = nothing to link, 100 = linked)`);
  out(`                          @spidereum/swarm correlationScore, with the funding transfers as links`);
  out(`  direct transfers        ${link.directTransfers}: the funding from monad account 0 before the run, and 0 in the run`);
  for (const t of link.transfers) out(`                          monad:0 → monad:${t.to.account}  ${t.amount} ${t.symbol}`);
  out("");
  out("  On testnet the lead funded these accounts straight from account 0, so an observer links all of them.");
  out("  On mainnet, funds enter each monad account through an Aurora Intents solver, and this count is the gas top-ups only.");

  section(out, "SUMMARY", "One sentence in, real transactions out");
  const reroutes = events.filter((e) => e.type === "reroute");
  out("");
  out(`  intent        "${p.sentence}"`);
  out(`  sent          ${txs.length} transactions from ${new Set(finals.map((e) => e.account)).size} accounts, ${opts.dryRun ? "none (dry run)" : `${txs.filter((t) => t.status === "success").length} succeeded`}`);
  out(`  re-route      ${reroutes.length ? reroutes.map((r) => (r.type === "reroute" ? `${r.moves.length} slices off ${r.from}` : "")).join(", ") : "none"}`);
  out(`  every number above is ${LIVE}${opts.dryRun ? ", except the dry run's projection" : ""}. every transaction has its explorer link.`);
  out("");
  return { setup: s, plan: p, before, after, events, link };
}

if (import.meta.main) {
  const drop = arg("drop");
  const sell = arg("sell");
  const accounts = arg("accounts");
  await runOnchainDemo({
    dryRun: !!arg("dry"),
    dropVenue: drop === undefined ? "auto" : drop === "none" ? null : (drop as VenueId),
    ...(sell ? { sellPerAccountWei: BigInt(Math.round(Number(sell) * 1e6)) * 10n ** 12n } : {}),
    ...(accounts ? { accounts: accounts.split(",").map(Number) } : {}),
  }).catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  });
}
