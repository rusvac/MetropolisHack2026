// a local plan for work before apps/server is up. every number in it is simulated:
// the pools are constant-product pools with made-up depth, the balances are made up,
// and the price of MON is fixed. the addresses are the swarm's real public addresses
import type {
  BridgeMove,
  HedgeQuote,
  Holding,
  Plan,
  Portfolio,
  Quote,
  RebalanceIntent,
  Slice,
  Token,
  VenueId,
} from "@spidereum/core";
import { fromUnits, toUnits } from "./format.ts";
import type { Address, DemoPlan, SwarmAccount } from "./types.ts";

const ZERO: Address = "0x0000000000000000000000000000000000000000";

export const TOKENS = {
  monTestnet: { chainId: 10143, symbol: "MON", address: ZERO, decimals: 18 },
  usdcTestnet: { chainId: 10143, symbol: "USDC", address: "0x534b2f3a21130d7a60830c2df862319e593943a3", decimals: 6 },
  usdcBaseSepolia: { chainId: 84532, symbol: "USDC", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6 },
  // the real plan quotes on mainnet. the fixture keeps the mainnet chain ids so the labels match.
  // the fixture never reads these addresses
  monMainnet: { chainId: 143, symbol: "MON", address: ZERO, decimals: 18 },
  usdcMainnet: { chainId: 143, symbol: "USDC", address: ZERO, decimals: 6 },
} satisfies Record<string, Token>;

/** simulated usd prices */
export const FIXTURE_PRICES: Record<string, number> = { MON: 0.05, USDC: 1 };

/** public addresses from `bun run swarm:addresses`. never a key */
const MONAD_ADDRESSES: Address[] = [
  "0xF62735eb65CacEC544AF135e2C69a6F27D9a6DD0",
  "0x20471aE93E64cbc0215A608c79D3e039eE906629",
  "0x857BD8EB67778538AC6d1D65EF219b9A296d63db",
  "0xcB659FD8B1720A7Ba8b36c0AD17ebf567a2E0257",
  "0x9C3C2672b51b46898dB584f6547Cfbf651059213",
  "0xCB737A1AB4Ff958ED25a3dB5eFdb2a11F26F2025",
  "0x65c7480832C3763a55557A778cFDFa2565a41e91",
  "0xFbd2b15ba8bBb07e570A2400896bEC945A9ce9cC",
  "0x07A7C6913d4ef3bAE4c88841F010E03a8B0Ce9Aa",
  "0xe609272EE9DC8e7a200179433EbDE93D13ea7B7d",
  "0xe03B68909e6e13bC98783cb36458e21DbbbFc806",
  "0xbaeb2F141aF2729B36B9E9fAf91363B84269C057",
];
const BASE_ADDRESSES: Address[] = [
  "0x914E49AC0106B35e08cAAaf0dC5e3E26012F8fB5",
  "0xE2c39CF3a2029EaB056b8BaF975bf08e76d3b0A2",
  "0xB9552aE272B9eFD1da7EECd98660cA6243Ee0543",
  "0xdE44b3ea1206f119Af3720d3FF6A0eA0fFd420dA",
];

export const FIXTURE_ACCOUNTS: SwarmAccount[] = [
  ...MONAD_ADDRESSES.map((address, index) => ({ chainId: 10143, index, address })),
  ...BASE_ADDRESSES.map((address, index) => ({ chainId: 84532, index, address })),
];

// simulated pools, usdc in and mon out
interface Pool {
  venue: VenueId;
  reserveUsdc: number;
  reserveMon: number;
  feeBps: number;
  gas: number;
}

export const FIXTURE_POOLS: Pool[] = [
  { venue: "kuru", reserveUsdc: 160_000, reserveMon: 3_200_000, feeBps: 20, gas: 160_000 },
  { venue: "uniswap-v4", reserveUsdc: 110_000, reserveMon: 2_200_000, feeBps: 30, gas: 190_000 },
];

/** mon out of `pool` for `x` usdc, after `fill` usdc already went through it */
export function poolOut(pool: Pool, fill: number, x: number): number {
  const outAt = (f: number) => {
    const eff = f * (1 - pool.feeBps / 10_000);
    return (pool.reserveMon * eff) / (pool.reserveUsdc + eff);
  };
  return outAt(fill + x) - outAt(fill);
}

const BRIDGE_BPS = 6;
const BRIDGE_FIXED_USDC = 0.35;
/** monad gas price for the estimate, in gwei of MON */
export const MONAD_GAS_GWEI = 100;

// the before state: usdc on base, a little mon on monad, gas mon in the receiving accounts
const START: { chainId: number; account: number; symbol: "MON" | "USDC"; units: number }[] = [
  { chainId: 84532, account: 0, symbol: "USDC", units: 2400 },
  { chainId: 84532, account: 1, symbol: "USDC", units: 1600 },
  { chainId: 84532, account: 2, symbol: "USDC", units: 600 },
  { chainId: 10143, account: 0, symbol: "MON", units: 5000 },
  { chainId: 10143, account: 1, symbol: "USDC", units: 150 },
  ...[2, 3, 4, 5, 6, 7, 8, 9, 10].map((account) => ({ chainId: 10143, account, symbol: "MON" as const, units: 20 })),
];

function token(chainId: number, symbol: "MON" | "USDC"): Token {
  if (chainId === 84532) return TOKENS.usdcBaseSepolia;
  return symbol === "MON" ? TOKENS.monTestnet : TOKENS.usdcTestnet;
}

function holding(chainId: number, account: number, symbol: "MON" | "USDC", units: number): Holding {
  const t = token(chainId, symbol);
  return { account, token: t, amount: fromUnits(units, t.decimals), usd: units * (FIXTURE_PRICES[symbol] ?? 0) };
}

function portfolio(holdings: Holding[], at: number): Portfolio {
  return { holdings, totalUsd: holdings.reduce((s, h) => s + h.usd, 0), at };
}

// a small seeded rng, so the same intent gives the same plan
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** split `total` into `n` parts that differ in size, so no two slices look alike */
function jitterSplit(total: number, n: number, rand: () => number): number[] {
  if (n <= 1) return [total];
  const w = Array.from({ length: n }, () => 0.6 + rand() * 0.8);
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((x) => (total * x) / sum);
}

export function fixturePlan(intent: RebalanceIntent, now = Date.now()): DemoPlan {
  const pw = Math.min(1, Math.max(0, intent.privacyWeight));
  const rand = rng(hash(intent.id) ^ Math.round(pw * 1000));
  const price = FIXTURE_PRICES;

  const before = portfolio(
    START.map((s) => holding(s.chainId, s.account, s.symbol, s.units)),
    now,
  );
  const total = before.totalUsd;
  const monWeight = intent.targets.find((t) => t.symbol === "MON")?.weight ?? 0.7;
  const monNowUsd = before.holdings.filter((h) => h.token.symbol === "MON").reduce((s, h) => s + h.usd, 0);
  const monTargetUsd = total * monWeight;

  // 1. bridges: every base account brings its usdc to monad, split over 1 to 3 receiving accounts
  const legsPer = 1 + Math.round(pw * 2);
  const bridges: BridgeMove[] = [];
  const monadUsdc = new Map<number, number>([[1, 150]]);
  let nextMonad = 2;
  let bridgeClock = 0;
  for (const s of START.filter((x) => x.chainId === 84532)) {
    for (const part of jitterSplit(s.units, legsPer, rand)) {
      const toAccount = nextMonad;
      nextMonad = nextMonad >= 10 ? 2 : nextMonad + 1;
      const out = part * (1 - BRIDGE_BPS / 10_000) - BRIDGE_FIXED_USDC;
      bridgeClock += 300 + Math.round(rand() * 1400);
      bridges.push({
        quote: {
          venue: "aurora",
          fromChain: "base",
          fromToken: "USDC",
          amountIn: fromUnits(part, 6),
          amountOut: fromUnits(out, 6),
          to: TOKENS.usdcMainnet,
          etaSeconds: 20,
          simulated: true,
          at: now,
        },
        fromAccount: s.account,
        toAccount,
        delayMs: bridgeClock,
      });
      monadUsdc.set(toAccount, (monadUsdc.get(toAccount) ?? 0) + out);
    }
  }

  // 2. one swap, usdc to mon, taken from each usdc account in proportion to its balance
  const usdcTotal = [...monadUsdc.values()].reduce((a, b) => a + b, 0);
  const swapUsdc = Math.min(usdcTotal, Math.max(0, (monTargetUsd - monNowUsd) / price.USDC!));
  const perAccount = 1 + Math.round(pw * 3);
  const landing = new Map(bridges.map((b) => [b.toAccount, b.delayMs + 1200]));

  interface Draft { account: number; usdc: number; delayMs: number }
  const drafts: Draft[] = [];
  for (const [account, bal] of monadUsdc) {
    const take = swapUsdc * (bal / usdcTotal);
    let t = landing.get(account) ?? Math.round(rand() * 600);
    for (const part of jitterSplit(take, perAccount, rand)) {
      t += 400 + Math.round(rand() * 1600);
      drafts.push({ account, usdc: part, delayMs: t });
    }
  }
  drafts.sort((a, b) => a.delayMs - b.delayMs);

  const fills = new Map<VenueId, number>(FIXTURE_POOLS.map((p) => [p.venue, 0]));
  const slices: Slice[] = [];
  let monOut = 0;
  let gasUnits = 0;
  for (const d of drafts) {
    // give each slice to the venue with the best next output
    let best = FIXTURE_POOLS[0]!;
    let bestOut = -1;
    for (const p of FIXTURE_POOLS) {
      const o = poolOut(p, fills.get(p.venue) ?? 0, d.usdc);
      if (o > bestOut) {
        best = p;
        bestOut = o;
      }
    }
    fills.set(best.venue, (fills.get(best.venue) ?? 0) + d.usdc);
    monOut += bestOut;
    gasUnits += best.gas;
    slices.push({
      venue: best.venue,
      account: d.account,
      amountIn: fromUnits(d.usdc, 6),
      expectedOut: fromUnits(bestOut, 18),
      delayMs: d.delayMs,
    });
  }

  // the naive trade: the full size at the best single venue
  let baselinePool = FIXTURE_POOLS[0]!;
  let baselineOut = -1;
  for (const p of FIXTURE_POOLS) {
    const o = poolOut(p, 0, swapUsdc);
    if (o > baselineOut) {
      baselinePool = p;
      baselineOut = o;
    }
  }
  const baseline: Quote = {
    venue: baselinePool.venue,
    sell: TOKENS.usdcMainnet,
    buy: TOKENS.monMainnet,
    amountIn: fromUnits(swapUsdc, 6),
    amountOut: fromUnits(baselineOut, 18),
    feeBps: baselinePool.feeBps,
    gasUnits: BigInt(baselinePool.gas),
    simulated: true,
    at: now,
  };

  const hedgeRatio = intent.hedgeRatio ?? 0;
  const hedge: HedgeQuote | undefined =
    hedgeRatio > 0
      ? {
          venue: "perpl",
          market: "MON-USD",
          size: fromUnits((monTargetUsd / price.MON!) * hedgeRatio, 18),
          markPrice: price.MON!,
          fundingRate: 0.0000114,
          simulated: true,
          at: now,
        }
      : undefined;

  const amountIn = fromUnits(swapUsdc, 6);
  const largest = slices.reduce((m, s) => (s.amountIn > m ? s.amountIn : m), 0n);
  const swap: Plan = {
    intent: {
      id: `${intent.id}-usdc-mon`,
      sell: TOKENS.usdcTestnet,
      buy: TOKENS.monTestnet,
      amountIn,
      maxSlippageBps: 100,
      hedge: hedgeRatio > 0 ? { ratio: hedgeRatio } : undefined,
      bridgeIn: { fromChain: "base", fromToken: "USDC", amount: fromUnits(4600, 6) },
      privacyWeight: pw,
    },
    slices,
    baseline,
    expectedOut: fromUnits(monOut, 18),
    gasUnits: BigInt(gasUnits),
    hedge,
    largestSliceShare: amountIn > 0n ? toUnits(largest, 6) / swapUsdc : 0,
  };

  // 3. the projected portfolio after the moves
  const monByAccount = new Map<number, number>();
  for (const s of START.filter((x) => x.chainId === 10143 && x.symbol === "MON")) monByAccount.set(s.account, s.units);
  for (const s of slices) monByAccount.set(s.account, (monByAccount.get(s.account) ?? 0) + toUnits(s.expectedOut, 18));
  const usdcLeft = new Map<number, number>();
  for (const [a, bal] of monadUsdc) usdcLeft.set(a, bal * (1 - swapUsdc / usdcTotal));

  const afterHoldings: Holding[] = [
    ...START.filter((x) => x.chainId === 84532).map((s) => holding(84532, s.account, "USDC", 0)),
    ...[...monByAccount].map(([a, units]) => holding(10143, a, "MON", units)),
    ...[...usdcLeft].map(([a, units]) => holding(10143, a, "USDC", units)),
  ];
  const after = portfolio(afterHoldings, now);

  // 4. cost in usd: bridge fees, price impact and venue fees, gas
  const gasUsd = (units: number) => units * MONAD_GAS_GWEI * 1e-9 * price.MON!;
  const bridgeFees = bridges.reduce((s, b) => s + toUnits(b.quote.amountIn - b.quote.amountOut, 6), 0);
  const swapCost = swapUsdc - monOut * price.MON!;
  const costUsd = bridgeFees + swapCost + gasUsd(gasUnits);
  const baseUsdc = START.filter((x) => x.chainId === 84532).reduce((s, x) => s + x.units, 0);
  const naiveBridge = baseUsdc * (BRIDGE_BPS / 10_000) + BRIDGE_FIXED_USDC;
  const naiveSwap = swapUsdc - baselineOut * price.MON!;
  const naiveCostUsd = naiveBridge + naiveSwap + gasUsd(baselinePool.gas);

  return {
    intent,
    before,
    bridges,
    swaps: [swap],
    hedge,
    after,
    costUsd,
    naiveCostUsd,
    directTransfers: 0,
    costs: {
      split: { bridgeUsd: bridgeFees, swapUsd: swapCost, gasUsd: gasUsd(gasUnits), totalUsd: costUsd, txCount: bridges.length + slices.length + (hedge ? 1 : 0) },
      naive: { bridgeUsd: naiveBridge, swapUsd: naiveSwap, gasUsd: gasUsd(baselinePool.gas), totalUsd: naiveCostUsd, txCount: 2 + (hedge ? 1 : 0) },
    },
    sources: {
      venues: { note: "fixture: two constant-product pools with made-up depth", simulated: true },
      prices: { note: "fixture: MON at $0.05", simulated: true },
      balances: { note: "fixture: made-up balances", simulated: true },
      gas: { gwei: MONAD_GAS_GWEI, note: "fixture: assumed", simulated: true },
      planner: "the browser fixture",
      executor: { note: "simulated in the browser: nothing goes onchain", simulated: true },
    },
    accounts: FIXTURE_ACCOUNTS,
    balancesSimulated: true,
    prices: { ...price },
  };
}

/** the demo's intent: 70% MON, 30% USDC, half the MON hedged */
export function defaultIntent(): RebalanceIntent {
  return {
    id: "rebalance-70-30",
    targets: [
      { symbol: "MON", weight: 0.7 },
      { symbol: "USDC", weight: 0.3 },
    ],
    hedgeRatio: 0.5,
    privacyWeight: 0.6,
  };
}
