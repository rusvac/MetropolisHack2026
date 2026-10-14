// the onchain run: every quote and every send on monad testnet. the testnet venues quote, the router's
// `plan` splits a MON sale over them and over swarm accounts 10 to 13, and @spidereum/swarm's sendSlice sends
// each slice. the 8 funding transfers from account 0 count as direct transfers in beat 7
import type { Intent, Plan, Portfolio, RebalancePlan, SpotVenue } from "../../packages/core/src/index.ts";
import { replan as routerReplanFn, plan as routerPlan } from "../../packages/router/src/index.ts";
import * as swarm from "../../packages/swarm/src/index.ts";
import { createKuruVenue, createTestPoolVenue, createUniswapTestnetVenue } from "../../packages/venues/src/index.ts";
import { routerReplan, swarmExecutor, type SwarmAccount } from "../config.ts";
import { toNumber } from "./format.ts";
import type { Transfer } from "./link.ts";
import type { GasInfo, Prices } from "./plan-math.ts";
import type { Executor } from "./run.ts";
import type { Replanner } from "./standin.ts";
import { MON, USDC_MONAD } from "./tokens.ts";

export const ONCHAIN_NETWORK = "monad testnet";
/** the accounts the lead funded for the onchain run */
export const ONCHAIN_ACCOUNTS = [10, 11, 12, 13];
/** MON each account keeps for gas after the run */
export const GAS_RESERVE_WEI = 8n * 10n ** 16n; // 0.08 MON
/** gas units a slice may cost, for the budget. monad charges the gas limit. the venues quote 114k to 181k */
const BUDGET_GAS_PER_SLICE = 250_000n;

export interface OnchainOptions {
  accounts?: number[];
  /** MON each account sells, in wei. default 0.05 MON */
  sellPerAccountWei?: bigint;
  /** slices per account. default 2 */
  slicesPerAccount?: number;
  privacyWeight?: number;
  /** build the transactions and send nothing */
  dryRun?: boolean;
}

export interface OnchainSetup {
  venues: SpotVenue[];
  gas: GasInfo;
  prices: Prices;
  /** each venue's price for a 0.01 MON sale, in USDC per MON */
  venuePrices: { venue: string; usdcPerMon: number }[];
  swarm: SwarmAccount[];
  accounts: number[];
  executor: Executor;
  replan: Replanner;
}

/** the funding the lead sent before the run: account 0 to each of 10 to 13, one MON transfer and one USDC transfer */
export function fundingTransfers(accounts: number[]): (Transfer & { symbol: string; amount: number })[] {
  return accounts.flatMap((a) => [
    { from: { chainId: 10143, account: 0 }, to: { chainId: 10143, account: a }, symbol: "MON", amount: 0.25 },
    { from: { chainId: 10143, account: 0 }, to: { chainId: 10143, account: a }, symbol: "USDC", amount: 0.5 },
  ]);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export async function loadOnchain(opts: OnchainOptions = {}): Promise<OnchainSetup> {
  const mnemonic = process.env.BURNER_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("BURNER_MNEMONIC is empty. the onchain run needs the swarm seed in .env");
  const accounts = (opts.accounts ?? ONCHAIN_ACCOUNTS).filter((a) => a >= 10 && a <= 19);
  if (accounts.length === 0) throw new Error("the onchain run sends from accounts 10 to 19 only");

  // the testnet venues: kuru's MON / circle-USDC book, the test pool, and uniswap v4 on testnet
  const venues: SpotVenue[] = [createKuruVenue({ network: "testnet" }), createTestPoolVenue(), createUniswapTestnetVenue()];
  const client = swarm.publicClient(10143);
  const gas: GasInfo = { monadWei: await client.getGasPrice(), simulated: false, source: "eth_gasPrice on monad testnet" };

  // the MON price: the median of each venue's quote for a 0.01 MON sale, with the fee added back
  const probe = 10n ** 16n;
  const venuePrices: OnchainSetup["venuePrices"] = [];
  for (const v of venues) {
    try {
      const q = await v.quote({ sell: MON, buy: USDC_MONAD, amountIn: probe });
      const fee = (q.feeBps ?? 0) / 10_000;
      if (q.amountOut > 0n) venuePrices.push({ venue: v.id, usdcPerMon: toNumber(q.amountOut, 6) / toNumber(probe, 18) / (1 - fee) });
    } catch {
      // a venue that cannot quote stays out of the price
    }
  }
  if (venuePrices.length === 0) throw new Error("no testnet venue quotes MON");
  const prices: Prices = { MON: median(venuePrices.map((p) => p.usdcPerMon)), USDC: 1 };

  const list: SwarmAccount[] = [
    ...[0, 1, 2, 3].map((index) => ({ chainId: 84532, index, address: swarm.deriveSwarmAccount(mnemonic, 84532, index).address })),
    ...[0, ...accounts].map((index) => ({ chainId: 10143, index, address: swarm.deriveSwarmAccount(mnemonic, 10143, index).address })),
  ];
  const executor = swarmExecutor(swarm as unknown as Record<string, unknown>, () => ({ venues: { spot: venues }, swarm: list }), [], {
    dryRun: opts.dryRun,
    accounts: new Set(accounts),
    maxSlippageBps: 100,
  });
  const replan = routerReplan({ replan: routerReplanFn }, () => ({
    accounts,
    gasPriceWei: gas.monadWei,
    prices,
  }));
  return { venues, gas, prices, venuePrices, swarm: list, accounts, executor, replan };
}

export async function loadOnchainPortfolio(s: OnchainSetup): Promise<Portfolio> {
  return swarm.loadPortfolio({ prices: s.prices, accounts: { 10143: s.accounts }, chains: [10143] });
}

export interface OnchainPlan {
  intent: Intent;
  plan: Plan;
  /** the plan in the RebalancePlan shape the run and the screens read */
  rebalance: RebalancePlan;
  /** MON each account may sell, after the gas reserve */
  sellable: Record<number, bigint>;
  sentence: string;
}

/** a MON sale the testnet books can fill: up to 0.05 MON per account, in slices, over the testnet venues */
export async function planOnchain(s: OnchainSetup, before: Portfolio, opts: OnchainOptions = {}): Promise<OnchainPlan> {
  const per = opts.sellPerAccountWei ?? 5n * 10n ** 16n;
  const slicesPer = opts.slicesPerAccount ?? 2;
  const gasBudget = BUDGET_GAS_PER_SLICE * BigInt(slicesPer) * s.gas.monadWei;
  const sellable: Record<number, bigint> = {};
  // the router may give an account up to 40% more than its share, so slices fit whole and none splits into dust.
  // that headroom also stays inside the gas reserve
  const room: Record<number, bigint> = {};
  for (const a of s.accounts) {
    const mon = before.holdings.filter((h) => h.account === a && h.token.symbol === "MON").reduce((t, h) => t + h.amount, 0n);
    const free = mon - GAS_RESERVE_WEI - gasBudget;
    const take = free < per ? free : per;
    if (take <= 0n) continue;
    sellable[a] = take;
    const wide = (take * 14n) / 10n;
    room[a] = wide < free ? wide : free;
  }
  const accounts = Object.keys(sellable).map(Number);
  if (accounts.length === 0) throw new Error(`no account in ${s.accounts.join(", ")} holds enough MON to sell and keep 0.08 MON for gas`);
  const amountIn = Object.values(sellable).reduce((t, x) => t + x, 0n);
  const intent: Intent = {
    id: "onchain-sell-mon",
    sell: MON,
    buy: USDC_MONAD,
    amountIn,
    maxSlippageBps: 100,
    privacyWeight: opts.privacyWeight ?? 1,
  };
  const plan = await routerPlan(intent, s.venues, {
    accounts,
    balances: room,
    gasPriceWei: s.gas.monadWei,
    prices: s.prices,
    maxSlices: slicesPer * accounts.length,
    minDelayMs: 400,
    maxDelayMs: 1_200,
  });
  const usd = (n: number) => n * (s.prices.MON ?? 0);
  const gasUsd = (units: bigint) => usd(toNumber(units * s.gas.monadWei, 18));
  const inUsd = usd(toNumber(amountIn, 18));
  const costUsd = inUsd - toNumber(plan.expectedOut, 6) + gasUsd(plan.gasUnits);
  const naiveCostUsd = inUsd - toNumber(plan.baseline.amountOut, 6) + gasUsd(plan.baseline.gasUnits);
  const rebalance: RebalancePlan = {
    intent: { id: intent.id, targets: [], privacyWeight: intent.privacyWeight },
    before,
    bridges: [],
    swaps: [plan],
    after: before,
    costUsd,
    naiveCostUsd,
    directTransfers: 0,
  };
  const sentence = `Sell ${toNumber(amountIn, 18)} MON for USDC from accounts ${accounts.join(", ")}, on Monad testnet.`;
  return { intent, plan, rebalance, sellable, sentence };
}

/** beat 7 on testnet: the funding transfers are links, and the analyzer scores the live balances with them */
export function onchainLink(before: Portfolio, after: Portfolio, accounts: number[], plan: Plan) {
  const transfers = fundingTransfers(accounts);
  const links = transfers.map((t) => ({ from: t.from, to: t.to }));
  const score = (p: Portfolio, ts: typeof links) => swarm.correlationScore({ portfolio: p, transfers: ts });
  const b = score(before, links);
  const a = score(after, links);
  // the naive version: one account holds the same value, and nothing links it to another
  const one: Portfolio = { ...after, holdings: after.holdings.map((h) => ({ ...h, account: accounts[0]! })) };
  const n = score(one, []);
  const largest = plan.slices.reduce((m, x) => (x.amountIn > m ? x.amountIn : m), 0n);
  return {
    transfers,
    largestShare: plan.intent.amountIn ? Number((largest * 10_000n) / plan.intent.amountIn) / 10_000 : 0,
    correlation: { before: Math.round(b.score * 100), after: Math.round(a.score * 100), naive: Math.round(n.score * 100) },
    directTransfers: a.directTransfers,
    clusters: a.clusters,
  };
}
