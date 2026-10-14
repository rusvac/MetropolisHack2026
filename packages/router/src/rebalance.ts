// turn target weights into moves: bridges into different monad accounts, sliced swaps, and the hedge quote
import type { BridgeMove, HedgeQuote, Holding, Plan, Portfolio, RebalanceIntent, RebalancePlan, Token } from "@spidereum/core";
import {
  type AnyVenue,
  DEFAULTS,
  type PlanOptions,
  bridgeVenue,
  gasUsd,
  hash,
  parts,
  perpVenue,
  plan,
  seeded,
  spotVenues,
  usdOf,
} from "./plan.ts";

export interface RebalanceOptions extends Omit<PlanOptions, "balances" | "startMs"> {
  /** tokens the venues quote, by symbol, for example the monad mainnet tokens. default: the monad tokens in the portfolio */
  tokens?: Record<string, Token>;
  /** the dollar token every swap routes through. default "USDC" */
  usdSymbol?: string;
  /** size of the price probe, in dollars. a symbol already in `prices` skips the probe. default 100 */
  probeUsd?: number;
  /** skip a swap or a bridge smaller than this, in dollars. default 1 */
  minTradeUsd?: number;
  /** bridges per base holding at privacyWeight 1. default 3 */
  maxBridgeSplit?: number;
  /** default 50 */
  maxSlippageBps?: number;
  /** native token each account keeps for gas when it sells the native token. default 0.1 MON */
  gasReserveWei?: bigint;
  /** `fromChain` for the bridge quotes. default "base" */
  fromChain?: string;
}

const MONAD_CHAINS = new Set([143, 10143]);
export const onMonad = (token: Token) => MONAD_CHAINS.has(token.chainId);

export async function rebalance(
  portfolio: Portfolio,
  intent: RebalanceIntent,
  venues: readonly AnyVenue[],
  opts: RebalanceOptions = {},
): Promise<RebalancePlan> {
  const usd = opts.usdSymbol ?? "USDC";
  const native = opts.nativeSymbol ?? DEFAULTS.nativeSymbol;
  const minTrade = opts.minTradeUsd ?? 1;
  const w = Math.min(1, Math.max(0, intent.privacyWeight));
  const rng = seeded(opts.seed ?? hash(intent.id));
  const wait = () => rng.int(opts.minDelayMs ?? DEFAULTS.minDelayMs, opts.maxDelayMs ?? DEFAULTS.maxDelayMs);
  const spot = spotVenues(venues);
  const bridge = bridgeVenue(venues);
  const perp = perpVenue(venues);

  const sum = intent.targets.reduce((s, t) => s + t.weight, 0);
  if (!(sum > 0)) throw new Error("router: the target weights must sum to more than 0");
  const weight = (symbol: string) => (intent.targets.find((t) => t.symbol === symbol)?.weight ?? 0) / sum;
  const scope = new Set([...intent.targets.map((t) => t.symbol), usd]);
  const others = [...scope].filter((s) => s !== usd);

  // tokens the venues quote
  const tokens: Record<string, Token> = {};
  for (const h of portfolio.holdings) if (onMonad(h.token)) tokens[h.token.symbol] ??= h.token;
  Object.assign(tokens, opts.tokens);
  for (const s of scope) if (!tokens[s]) throw new Error(`router: no monad token for ${s}. pass opts.tokens`);
  const usdToken = tokens[usd]!;

  // prices from quotes: buy each token with probeUsd dollars at the best venue, and take out the venue fee
  const prices: Record<string, number> = { [usd]: 1, ...opts.prices };
  const probe = BigInt(Math.round((opts.probeUsd ?? 100) * 10 ** usdToken.decimals));
  await Promise.all(
    others
      .filter((s) => prices[s] === undefined)
      .map(async (s) => {
        const token = tokens[s]!;
        const quotes = await Promise.all(
          spot.map((v) => v.quote({ sell: usdToken, buy: token, amountIn: probe }).catch(() => null)),
        );
        const best = quotes.reduce((a, q) => (q && q.amountOut > (a?.amountOut ?? 0n) ? q : a), null);
        if (!best || best.amountOut === 0n) throw new Error(`router: no venue prices ${s}`);
        const got = Number(best.amountOut) / 10 ** token.decimals / (1 - (best.feeBps ?? 0) / 10_000);
        prices[s] = Number(probe) / 10 ** usdToken.decimals / got;
      }),
  );
  const po: PlanOptions = { ...opts, prices };
  const valued = (holdings: Holding[], at: number): Portfolio => {
    const hs = holdings.map((h) => ({
      ...h,
      usd: prices[h.token.symbol] === undefined ? h.usd : usdOf(prices, h.token, h.amount),
    }));
    return { holdings: hs, totalUsd: hs.reduce((s, h) => s + h.usd, 0), at };
  };
  const before = valued(portfolio.holdings, portfolio.at);

  // monad balances by account and symbol, as the moves change them
  const bal = new Map<number, Map<string, bigint>>();
  const get = (a: number, s: string) => bal.get(a)?.get(s) ?? 0n;
  const add = (a: number, s: string, d: bigint) => {
    if (!bal.has(a)) bal.set(a, new Map());
    bal.get(a)!.set(s, get(a, s) + d);
  };
  for (const h of before.holdings) if (onMonad(h.token) && scope.has(h.token.symbol)) add(h.account, h.token.symbol, h.amount);

  const held = [...new Set(before.holdings.filter((h) => onMonad(h.token)).map((h) => h.account))].sort((a, b) => a - b);
  const pool = opts.accounts ?? defaultPool(held);
  if (pool.length === 0) throw new Error("router: no monad account");

  // 1. bridges: each base holding in scope splits into bridges that land in different monad accounts.
  // accounts that hold the native token come first, so they can pay gas for their slices
  const bridges: BridgeMove[] = [];
  const off = before.holdings.filter((h) => !onMonad(h.token) && scope.has(h.token.symbol) && h.amount > 0n);
  let bridgeCost = 0;
  let t = 0;
  if (bridge) {
    const gas = new Set(before.holdings.filter((h) => onMonad(h.token) && h.token.symbol === native && h.amount > 0n).map((h) => h.account));
    const landing = [...pool.filter((a) => gas.has(a)), ...pool.filter((a) => !gas.has(a))];
    const k = 1 + Math.round(w * ((opts.maxBridgeSplit ?? 3) - 1));
    const jobs: { h: Holding; amount: bigint; toAccount: number; delayMs: number }[] = [];
    for (const h of off) {
      const n = Math.max(1, Math.min(k, Math.floor(h.usd / minTrade)));
      for (const amount of parts(h.amount, n)) {
        jobs.push({ h, amount, toAccount: landing[jobs.length % landing.length]!, delayMs: t });
        t += wait();
      }
    }
    const fromChain = opts.fromChain ?? "base";
    const quotes = await Promise.all(
      jobs.map((j) => bridge.quoteBridge({ fromChain, fromToken: j.h.token.symbol, amount: j.amount }, tokens[j.h.token.symbol]!)),
    );
    jobs.forEach((j, i) => {
      const quote = quotes[i]!;
      bridges.push({ quote, fromAccount: j.h.account, toAccount: j.toAccount, delayMs: j.delayMs });
      add(j.toAccount, quote.to.symbol, quote.amountOut);
      bridgeCost += usdOf(prices, j.h.token, j.amount) - usdOf(prices, quote.to, quote.amountOut);
    });
  }
  const stayed = bridge ? [] : off;

  // 2. swaps through the dollar token: sells first, as they free dollars for the buys
  const heldUsd = (s: string) =>
    [...bal.keys()].reduce((x, a) => x + usdOf(prices, tokens[s]!, get(a, s)), 0) +
    stayed.filter((h) => h.token.symbol === s).reduce((x, h) => x + h.usd, 0);
  const gap = (s: string) => weight(s) * [...scope].reduce((x, y) => x + heldUsd(y), 0) - heldUsd(s);
  const reserve = (s: string) => (s === native ? (opts.gasReserveWei ?? 10n ** 17n) : 0n);
  const swaps: Plan[] = [];
  const swap = async (sell: string, buy: string, usdAmount: number) => {
    const balances = Object.fromEntries(pool.map((a) => [a, maxZero(get(a, sell) - reserve(sell))]));
    const available = Object.values(balances).reduce((x, b) => x + b, 0n);
    const want = BigInt(Math.floor((usdAmount / prices[sell]!) * 10 ** tokens[sell]!.decimals));
    const amountIn = want < available ? want : available;
    if (usdOf(prices, tokens[sell]!, amountIn) < minTrade) return;
    const p = await plan(
      {
        id: `${intent.id}:${sell}-${buy}`,
        sell: tokens[sell]!,
        buy: tokens[buy]!,
        amountIn,
        maxSlippageBps: opts.maxSlippageBps ?? 50,
        privacyWeight: w,
      },
      spot,
      { ...po, accounts: pool, balances, startMs: t },
    );
    for (const s of p.slices) {
      add(s.account, sell, -s.amountIn);
      add(s.account, buy, s.expectedOut);
    }
    t = (p.slices.at(-1)?.delayMs ?? t) + wait();
    swaps.push(p);
  };
  for (const s of others) if (gap(s) < -minTrade) await swap(s, usd, -gap(s));
  for (const s of others) if (gap(s) > minTrade) await swap(usd, s, gap(s));

  // 3. the hedge: a short on the largest target that is not the dollar token
  let hedge: HedgeQuote | undefined;
  const big = [...intent.targets].filter((x) => x.symbol !== usd).sort((a, b) => b.weight - a.weight)[0];
  if (perp && big && (intent.hedgeRatio ?? 0) > 0) {
    const amount = [...bal.keys()].reduce((x, a) => x + get(a, big.symbol), 0n);
    const size = (amount * BigInt(Math.round(intent.hedgeRatio! * 1e6))) / 1_000_000n;
    if (size > 0n) hedge = await perp.quoteHedge(tokens[big.symbol]!, size);
  }

  // 4. the portfolio after, projected from the quotes
  const tokenFor = (s: string) => before.holdings.find((h) => onMonad(h.token) && h.token.symbol === s)?.token ?? tokens[s]!;
  const afterHoldings: Holding[] = before.holdings.filter((h) => !scope.has(h.token.symbol) || stayed.includes(h));
  for (const [account, m] of bal) {
    for (const [s, amount] of m) if (amount > 0n) afterHoldings.push({ account, token: tokenFor(s), amount, usd: 0 });
  }
  afterHoldings.sort(
    (a, b) => Number(onMonad(b.token)) - Number(onMonad(a.token)) || a.account - b.account || a.token.symbol.localeCompare(b.token.symbol),
  );
  const after = valued(afterHoldings, Date.now());

  // 5. costs in dollars: what the quotes lose against the probe prices, plus gas
  const swapCost = (sell: Token, buy: Token, amountIn: bigint, amountOut: bigint, gasUnits: bigint) =>
    usdOf(prices, sell, amountIn) - usdOf(prices, buy, amountOut) + gasUsd(gasUnits, po);
  const costUsd = swaps.reduce(
    (c, p) => c + swapCost(p.intent.sell, p.intent.buy, p.intent.amountIn, p.expectedOut, p.gasUnits),
    bridgeCost,
  );

  // the naive version: one account, one bridge per token, one trade per swap at the best single venue
  let naiveCostUsd = swaps.reduce(
    (c, p) => c + swapCost(p.intent.sell, p.intent.buy, p.baseline.amountIn, p.baseline.amountOut, p.baseline.gasUnits),
    0,
  );
  if (bridge) {
    const bySymbol = new Map<string, Holding[]>();
    for (const h of off) bySymbol.set(h.token.symbol, [...(bySymbol.get(h.token.symbol) ?? []), h]);
    const fromChain = opts.fromChain ?? "base";
    for (const [s, hs] of bySymbol) {
      const amount = hs.reduce((x, h) => x + h.amount, 0n);
      const quote = await bridge.quoteBridge({ fromChain, fromToken: s, amount }, tokens[s]!);
      naiveCostUsd += usdOf(prices, hs[0]!.token, amount) - usdOf(prices, quote.to, quote.amountOut);
    }
  }

  return {
    intent,
    before,
    bridges,
    swaps,
    hedge,
    after,
    costUsd,
    naiveCostUsd,
    // every move goes from an account to a venue or through the bridge. the router plans no account-to-account send.
    // a gas top-up from account 0 at execution is a direct transfer, and the swarm lane counts it
    directTransfers: 0,
  };
}

const maxZero = (x: bigint) => (x > 0n ? x : 0n);

/** the monad accounts that hold funds, then fresh indices after them, eight in all */
function defaultPool(held: number[]): number[] {
  const pool = [...held];
  let next = held.length > 0 ? Math.max(...held) + 1 : 0;
  while (pool.length < 8) pool.push(next++);
  return pool;
}
