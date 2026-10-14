// the seven beats, printed in the style of spidereum's example-swarm.ts.
// every number that does not come from a live venue or a live balance says "simulated"
import type { Portfolio, RebalanceIntent, RebalancePlan } from "../../packages/core/src/index.ts";
import type { Setup, SwarmAccount } from "../config.ts";
import { SIM, boxBottom, boxLine, boxTop, pct, section, seconds, toNumber, units, usd, type Out } from "./format.ts";
import type { Linkability } from "./link.ts";
import { costBreakdown, gasUsd, type Prices } from "./plan-math.ts";
import { execChain, isMockVenue, movesOf, type MoveEvent, type RunEvent } from "./run.ts";
import { chainName } from "./tokens.ts";

const tag = (simulated: boolean, network?: string) => (simulated ? `  (${SIM})` : network ? `  (live, ${network})` : "  (live)");
const word = (simulated: boolean, network?: string) => (simulated ? SIM : network ? `live, ${network}` : "live");

function where(chainId: number, account: number): string {
  return `${execChain(chainId) === 10143 ? "monad" : "base"}:${account}`;
}

export function header(out: Out): void {
  out(`
╔═══════════════════════════════════════════════════════════════════════╗
║                 SPIDEREUM  ·  REBALANCE IN ONE SENTENCE               ║
║                                                                       ║
║    one intent, split into slices across Monad venues and accounts     ║
╚═══════════════════════════════════════════════════════════════════════╝`);
}

export function sources(out: Out, s: Setup, portfolioNote: string, balancesSimulated: boolean, planner: string): void {
  out("");
  out("  where each number comes from");
  out(`    venues       ${s.venuesNote}`);
  out(`    prices       MON ${usd4(s.prices.MON ?? 0)}, ${s.pricesNote}${tag(s.pricesSimulated, "monad mainnet")}`);
  out(`    balances     ${portfolioNote}${tag(balancesSimulated)}`);
  out(`    gas          ${units(s.gas.monadWei, 9, 1)} gwei, ${s.gas.source}${tag(s.gas.simulated, "monad mainnet")}`);
  out(`    planner      ${planner}`);
  out(`    executor     ${s.executorNote}`);
  out(`    correlation  ${s.correlationNote}`);
  for (const n of s.notes) out(`    note         ${n}`);
}

function usd4(v: number): string {
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}

// 1. the swarm

export function beatSwarm(out: Out, accounts: SwarmAccount[], seedNote: string): void {
  section(out, "1 · THE SWARM", "N accounts from one seed, on Monad and on Base");
  out("");
  out(`  seed: ${seedNote}. the seed and the keys never leave the server`);
  const groups: [number, string][] = [
    [84532, "base sepolia    m/44'/60'/1'/0/i"],
    [10143, "monad testnet   m/44'/60'/0'/0/i"],
  ];
  for (const [chainId, label] of groups) {
    out("");
    out(`  ${label}`);
    for (const a of accounts.filter((x) => x.chainId === chainId)) out(`    ${String(a.index).padStart(2)}  ${a.address}`);
  }
  const monad = new Set(accounts.filter((a) => a.chainId === 10143).map((a) => a.address.toLowerCase()));
  const both = accounts.filter((a) => a.chainId === 84532 && monad.has(a.address.toLowerCase())).length;
  const distinct = new Set(accounts.map((a) => a.address.toLowerCase())).size;
  out("");
  out(`  ${both === 0 ? "✓" : "✗"} ${both} addresses appear on both chains (${accounts.length} accounts, ${distinct} distinct addresses)`);
}

// 2. the portfolio now

function bySymbol(p: Portfolio): Map<string, number> {
  const m = new Map<string, number>();
  for (const h of p.holdings) m.set(h.token.symbol, (m.get(h.token.symbol) ?? 0) + h.usd);
  return m;
}

function byAccount(p: Portfolio): Map<string, number> {
  const m = new Map<string, number>();
  for (const h of p.holdings) {
    const k = where(h.token.chainId, h.account);
    m.set(k, (m.get(k) ?? 0) + h.usd);
  }
  return m;
}

export function beatPortfolio(out: Out, p: Portfolio, note: string, simulated: boolean, network = "monad testnet and base sepolia balances"): void {
  section(out, "2 · THE PORTFOLIO NOW", "Holdings per account and per chain, in dollars");
  out("");
  out(`  total ${usd(p.totalUsd)}${tag(simulated, network)}  ${note}`);
  if (p.holdings.length === 0) out("  the swarm holds nothing yet: fund monad accounts 10 to 19 and base accounts 0 to 3, or set portfolio to fake in scripts/config.ts");
  out("");
  out("  allocation");
  for (const [symbol, v] of bySymbol(p)) out(`    ${symbol.padEnd(6)} ${usd(v).padStart(12)}  ${pct(p.totalUsd ? v / p.totalUsd : 0).padStart(6)}`);
  out("");
  out("  per account");
  for (const h of p.holdings) {
    out(`    ${where(h.token.chainId, h.account).padEnd(9)} ${h.token.symbol.padEnd(5)} ${units(h.amount, h.token.decimals).padStart(14)}  ${usd(h.usd).padStart(12)}`);
  }
  out("");
  out("  per chain");
  const chains = new Map<number, number>();
  for (const h of p.holdings) chains.set(execChain(h.token.chainId), (chains.get(execChain(h.token.chainId)) ?? 0) + h.usd);
  for (const [chainId, v] of chains) out(`    ${chainName(chainId).padEnd(14)} ${usd(v).padStart(12)}`);
}

// 3. the intent

export function beatIntent(out: Out, sentence: string, intent: RebalanceIntent, p: Portfolio, perpVenue: string): void {
  section(out, "3 · THE INTENT", "Target weights, the hedge ratio, and the privacy weight");
  out("");
  out(`  "${sentence}"`);
  out("");
  const now = bySymbol(p);
  for (const t of intent.targets) {
    const target = t.weight * p.totalUsd;
    const have = now.get(t.symbol) ?? 0;
    const need = target - have;
    out(
      `  ${t.symbol.padEnd(5)} target ${pct(t.weight).padStart(6)} ${usd(target).padStart(12)}   now ${pct(p.totalUsd ? have / p.totalUsd : 0).padStart(6)}   ${need >= 0 ? "buy " : "sell"} ${usd(Math.abs(need)).padStart(11)}`,
    );
  }
  out("");
  out(`  hedge     ${pct(intent.hedgeRatio ?? 0, 0)} of the MON position, a short on ${perpVenue}`);
  out(`  privacy   ${intent.privacyWeight}  (0 = the cheapest plan, 1 = the smallest largest slice)`);
}

// 4. the plan

export interface PlanView {
  /** ETH per gas and dollars per ETH, for the "why monad" line. both simulated */
  ethGasGwei: number;
  ethUsd: number;
}

export function beatPlan(out: Out, plan: RebalancePlan, s: Setup, view: PlanView): void {
  section(out, "4 · THE PLAN", "Bridges into different Monad accounts, swap slices over the venues, and the short");
  const moves = movesOf(plan);
  const { split, naive } = costBreakdown(plan, s.prices, s.gas);

  if (plan.bridges.length) {
    const sim = plan.bridges.some((b) => b.quote.simulated);
    out("");
    out(`  bridges, base → monad, through ${plan.bridges[0]!.quote.venue}${tag(sim, "mainnet quotes")}`);
    for (const b of plan.bridges) {
      const q = b.quote;
      out(
        `    base:${String(b.fromAccount).padEnd(3)} ──${units(q.amountIn, q.to.decimals).padStart(9)} ${q.fromToken}──▶  monad:${String(b.toAccount).padEnd(3)} lands ${units(q.amountOut, q.to.decimals).padStart(9)} ${q.to.symbol}   ${seconds(b.delayMs)}`,
      );
    }
  }

  plan.swaps.forEach((swap, si) => {
    const venues = [...new Set(swap.slices.map((x) => x.venue))];
    const sim = swap.baseline.simulated || venues.some((v) => isMockVenue(v));
    out("");
    out(`  swap ${si}: ${swap.intent.sell.symbol} → ${swap.intent.buy.symbol}, ${swap.slices.length} slices over ${venues.join(" and ")}${tag(sim, `quotes from ${chainName(swap.baseline.sell.chainId)}`)}`);
    const accounts = [...new Set(swap.slices.map((x) => x.account))];
    for (const a of accounts) {
      const mine = swap.slices.filter((x) => x.account === a);
      out(`    monad:${a}`);
      mine.forEach((x, i) => {
        const branch = i === mine.length - 1 ? "└─" : "├─";
        out(
          `      ${branch} ${seconds(x.delayMs).padStart(7)}  ${x.venue.padEnd(16)} ${units(x.amountIn, swap.intent.sell.decimals).padStart(10)} ${swap.intent.sell.symbol} → ${units(x.expectedOut, swap.intent.buy.decimals, 0).padStart(10)} ${swap.intent.buy.symbol}`,
        );
      });
    }
    out(`    largest slice: ${pct(swap.largestSliceShare)} of the swap`);
  });

  const hedge = plan.hedge ?? plan.swaps.find((x) => x.hedge)?.hedge;
  if (hedge) {
    const hm = moves.find((m) => m.kind === "hedge");
    out("");
    out(`  hedge${tag(hedge.simulated, "perp quote")}`);
    out(
      `    monad:${hm?.account ?? "?"}  short ${units(hedge.size, 18, 0)} MON on ${hedge.venue} (${hedge.market}), mark ${usd4(hedge.markPrice)}${hedge.fundingRate !== undefined ? `, funding ${(hedge.fundingRate * 100).toFixed(4)}%/h` : ""}, about ${usd(toNumber(hedge.size, 18) * hedge.markPrice)}`,
    );
  }

  const bridgeSim = plan.bridges.some((b) => b.quote.simulated);
  const swapSim = s.pricesSimulated || plan.swaps.some((x) => x.baseline.simulated || x.slices.some((y) => isMockVenue(y.venue)));
  const gasSim = s.gas.simulated || s.pricesSimulated;
  const other = plan.costUsd - split.totalUsd;
  const row = (label: string, a: string, b: string, note = "") => boxLine(`${label.padEnd(16)}${a.padStart(12)}${b.padStart(12)}   ${note}`);
  out("");
  out(boxTop());
  out(boxLine("split vs naive, in dollars"));
  out(boxLine("naive = one account, one bridge, one trade per asset"));
  out(boxLine(""));
  out(row("", "split", "naive"));
  out(row("transactions", String(split.txCount), String(naive.txCount)));
  if (plan.bridges.length) out(row("bridge fees", usd(split.bridgeUsd), usd(naive.bridgeUsd), word(bridgeSim)));
  out(row("swap cost", usd(split.swapUsd), usd(naive.swapUsd), word(swapSim, "mainnet quotes")));
  out(row("gas", usd(split.gasUsd), usd(naive.gasUsd), word(gasSim, "mainnet gas price")));
  if (Math.abs(other) >= 0.01) out(row("other", usd(other), ""));
  out(row("total", usd(plan.costUsd), usd(plan.naiveCostUsd), word(bridgeSim || swapSim || gasSim)));
  out(boxLine(""));
  const saved = plan.naiveCostUsd - plan.costUsd;
  const size = plan.swaps.reduce((t, x) => t + toNumber(x.intent.amountIn, x.intent.sell.decimals) * (s.prices[x.intent.sell.symbol] ?? 0), 0);
  out(
    boxLine(
      Math.abs(saved) < 0.01
        ? "the split costs within one cent of the naive version"
        : saved > 0
          ? `the split saves ${usd(saved)} (${pct(size ? saved / size : 0, 2)} of the swaps)`
          : `the split costs ${usd(-saved)} more than the naive version`,
    ),
  );
  out(boxBottom());

  // why monad: the same transactions at ethereum gas
  const txs = plan.swaps.reduce((t, x) => t + x.slices.length, 0) + (hedge ? 1 : 0);
  const units_ = plan.swaps.reduce((t, x) => t + x.gasUnits, 0n);
  const monadGas = gasUsd(units_, s.gas, s.prices.MON ?? 0);
  const ethGas = (Number(units_) * view.ethGasGwei * 1e-9) * view.ethUsd;
  out("");
  out(`  why monad: ${txs} transactions on monad, ${units(units_, 0)} gas`);
  const cents = monadGas < 0.01 ? `$${monadGas.toFixed(4)}` : usd(monadGas);
  out(`    on monad at ${units(s.gas.monadWei, 9, 1)} gwei: ${cents}${tag(s.gas.simulated || s.pricesSimulated, "monad mainnet gas price")}. at 400 ms a block, they settle in about ${(txs * 0.4).toFixed(1)} s of blocks`);
  out(`    on ethereum at ${view.ethGasGwei} gwei and ETH ${usd(view.ethUsd)}: ${usd(ethGas)}  (${SIM}: a fixed gas price and ETH price)`);
}

// 5. execute

/** an amount with as many decimals as a small number needs */
function amt(amount: bigint, decimals: number): string {
  const n = Math.abs(toNumber(amount, decimals));
  return units(amount, decimals, n >= 1000 ? 0 : n >= 1 ? 2 : 6);
}

function moveLine(e: MoveEvent): string {
  const from = e.kind === "bridge" ? `${where(e.chainId, e.account)} → ${where(e.toChainId, e.toAccount)}` : e.kind === "gas" ? `monad:${e.account} → monad:${e.toAccount}` : where(e.chainId, e.account);
  const venue = e.kind === "gas" ? "gas top-up" : e.venue;
  const amount =
    e.kind === "swap" || e.kind === "bridge"
      ? `${amt(e.amountIn, e.decimalsIn)} ${e.symbolIn} → ${amt(e.amountOut, e.decimalsOut)} ${e.symbolOut}`
      : e.kind === "hedge"
        ? `short ${amt(e.amountIn, e.decimalsIn)} ${e.symbolIn}`
        : `${units(e.amountIn, e.decimalsIn, 3)} ${e.symbolIn}`;
  const status =
    e.status === "confirmed" && e.simulated
      ? SIM
      : e.status === "quoted"
        ? `quoted${e.quoteSimulated ? `, ${SIM}` : ""}`
        : e.status;
  return `   ${seconds(e.elapsedMs).padStart(7)}  ${e.id.padEnd(11)} ${from.padEnd(18)} ${venue.padEnd(19)} ${amount.padEnd(32)} ${status}`;
}

/** prints one run event. returns the portfolio after, on the done event */
export function printEvent(out: Out, e: RunEvent): Portfolio | null {
  switch (e.type) {
    case "start":
      section(out, "5 · EXECUTE", "A live timeline. Halfway through, one venue turns off, and its slices re-route");
      out("");
      out(`  run ${e.runId}: ${e.moves} moves, executor ${e.executor}${e.simulated ? ` (${SIM}: nothing goes onchain)` : ""}`);
      if (e.transitMs > 0) out(`  the swaps wait ${(e.transitMs / 1000).toFixed(1)} s of plan time for the bridged funds to land (${SIM} transit)`);
      if (e.dropVenue) out(`  ${e.dropVenue} turns off after half of the slices`);
      out("");
      out(`   ${"time".padStart(7)}  ${"move".padEnd(11)} ${"account".padEnd(18)} ${"venue".padEnd(19)} ${"amount".padEnd(32)} result`);
      out(`   ${"─".repeat(117)}`);
      return null;
    case "move":
      if (e.status === "queued" || e.status === "sent") return null;
      out(moveLine(e));
      if (e.txs?.length) for (const tx of e.txs) out(`   ${"".padStart(7)}  ${tx.url ?? tx.hash}  ${tx.status}${tx.gasUsed ? `, ${units(tx.gasUsed, 0)} gas` : ""}`);
      else if (e.hash) out(`   ${"".padStart(7)}  ${e.url ?? e.hash}`);
      if (e.status === "quoted" && e.note?.startsWith("dry run")) out(`   ${"".padStart(7)}  ${e.note}`);
      if (e.status === "failed" && e.note) out(`   ${"".padStart(7)}  ${e.note}`);
      if (e.kind === "gas") out(`   ${"".padStart(7)}  a direct transfer between two swarm accounts: beat 7 counts it`);
      return null;
    case "venue-off":
      out(`   ${seconds(e.elapsedMs).padStart(7)}  ✗ ${e.venue} turns off`);
      return null;
    case "reroute": {
      const to = new Map<string, number>();
      for (const m of e.moves) to.set(m.to, (to.get(m.to) ?? 0) + 1);
      const list = [...to.entries()].map(([v, n]) => `${n} → ${v}`).join(", ");
      out(`   ${seconds(e.elapsedMs).padStart(7)}  ↻ re-route off ${e.from}: ${e.moves.length} slices (${list || "none left"})`);
      return null;
    }
    case "done":
      out(`   ${"─".repeat(117)}`);
      out(`  done in ${(e.elapsedMs / 1000).toFixed(1)} s: ${e.confirmed} sent, ${e.quoted} quoted, ${e.failed} failed${e.simulated ? `, all ${SIM}` : ""}`);
      return e.after;
    case "error":
      out(`  error: ${e.message}`);
      return null;
  }
}

// 6. the portfolio after

export function beatAfter(out: Out, intent: RebalanceIntent, before: Portfolio, after: Portfolio, simulated: boolean, hedgeNote: string | null): void {
  section(out, "6 · THE PORTFOLIO AFTER", "Before and after, per account and in total, against the targets");
  const b = byAccount(before);
  const a = byAccount(after);
  const keys = [...new Set([...b.keys(), ...a.keys()])].sort((x, y) => {
    const [cx, ix] = x.split(":");
    const [cy, iy] = y.split(":");
    return cx === cy ? Number(ix) - Number(iy) : cx! < cy! ? -1 : 1;
  });
  out("");
  out(`  ${"account".padEnd(10)} ${"before".padStart(12)} ${"after".padStart(12)}${simulated ? `   (${SIM})` : ""}`);
  for (const k of keys) out(`  ${k.padEnd(10)} ${usd(b.get(k) ?? 0).padStart(12)} ${usd(a.get(k) ?? 0).padStart(12)}`);
  out(`  ${"total".padEnd(10)} ${usd(before.totalUsd).padStart(12)} ${usd(after.totalUsd).padStart(12)}`);
  out("");
  const sb = bySymbol(before);
  const sa = bySymbol(after);
  out(`  ${"".padEnd(6)} ${"target".padStart(8)} ${"before".padStart(8)} ${"after".padStart(8)}`);
  for (const t of intent.targets) {
    const wb = before.totalUsd ? (sb.get(t.symbol) ?? 0) / before.totalUsd : 0;
    const wa = after.totalUsd ? (sa.get(t.symbol) ?? 0) / after.totalUsd : 0;
    out(`  ${t.symbol.padEnd(6)} ${pct(t.weight).padStart(8)} ${pct(wb).padStart(8)} ${pct(wa).padStart(8)}`);
  }
  if (hedgeNote) {
    out("");
    out(`  ${hedgeNote}`);
  }
}

// 7. what an observer can link

export function beatLink(out: Out, l: Linkability): void {
  section(out, "7 · WHAT AN OBSERVER CAN LINK", "The largest move, the correlation score, and the direct transfers");
  out("");
  out(`  largest single move     split ${pct(l.largestMove.split)} of the rebalance (${usd(l.largestMove.splitUsd)} of ${usd(l.largestMove.totalUsd)})   naive ${pct(l.largestMove.naive, 0)}`);
  out(`  correlation score       before ${l.correlation.before}   after ${l.correlation.after}   naive after ${l.correlation.naiveAfter}   (0 = nothing to link, 100 = linked)`);
  out(`                          ${l.correlation.source}`);
  const tops = l.directTransfers.gasTopUps;
  out(
    `  direct transfers        ${l.directTransfers.total}: ${l.directTransfers.planned} in the plan, ${tops.length} gas top-ups from monad account 0${tops.length ? ` (to ${tops.map((a) => `monad:${a}`).join(", ")})` : ""}`,
  );
  out("");
  out(`  "If one account funds the swarm, is every account linked onchain?"`);
  out("  No. Funds enter the monad accounts through Aurora Intents solvers, not from a swarm account.");
  out(
    tops.length
      ? `  Gas is the exception: ${tops.length} accounts get MON for gas from account 0, and each top-up links two accounts. The count above includes them.`
      : "  Gas is the exception, and this run needs no top-up: every account that sends already holds MON.",
  );
}

export function summary(out: Out, sentence: string, plan: RebalancePlan, l: Linkability, simulated: boolean): void {
  section(out, "SUMMARY", "One sentence in, a split rebalance out");
  const slices = plan.swaps.reduce((t, x) => t + x.slices.length, 0);
  const venues = new Set(plan.swaps.flatMap((x) => x.slices.map((y) => y.venue)));
  const accounts = new Set([...plan.bridges.map((b) => b.toAccount), ...plan.swaps.flatMap((x) => x.slices.map((y) => y.account))]);
  out("");
  out(`  intent        "${sentence}"`);
  const saved = plan.naiveCostUsd - plan.costUsd;
  const verdict = Math.abs(saved) < 0.01 ? "within one cent" : saved > 0 ? `saves ${usd(saved)}` : `costs ${usd(-saved)} more`;
  out(`  moves         ${plan.bridges.length} bridges, ${slices} slices over ${venues.size} venue${venues.size === 1 ? "" : "s"} in the plan, ${plan.hedge ? 1 : 0} hedge, from ${accounts.size} monad accounts`);
  out(`  cost          split ${usd(plan.costUsd)} vs naive ${usd(plan.naiveCostUsd)}: ${verdict}${simulated ? `  (${SIM})` : ""}`);
  out(`  size shown    the largest move is ${pct(l.largestMove.split)} of the rebalance, not 100%`);
  out(`  correlation   ${l.correlation.before} before, ${l.correlation.after} after, ${l.correlation.naiveAfter} for the naive version`);
  out(`  direct links  ${l.directTransfers.total}`);
  out("");
  out(`  every number marked "${SIM}" comes from a mock venue, a fixed input, or a run that sent nothing.`);
  out("");
}
