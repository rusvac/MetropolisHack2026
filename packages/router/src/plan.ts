// split one swap into slices across venues and swarm accounts, and re-route the rest when a venue drops out
import type { BridgeVenue, Intent, PerpVenue, Plan, Quote, Slice, SpotVenue, Token } from "@spidereum/core";

/** the registry list as it is: the router picks spot, perp, and bridge venues by `kind` */
export type AnyVenue = SpotVenue | PerpVenue | BridgeVenue;

export interface PlanOptions {
  /** swarm account indices that may send slices. default: the keys of `balances`, else [0] */
  accounts?: number[];
  /** amount of the sell token each account holds. given = no slice spends more than its account holds */
  balances?: Record<number, bigint>;
  /** chunks for the split. more chunks = a finer split and more quote calls. default 20 */
  steps?: number;
  /** slice count at privacyWeight 1. default 20 */
  maxSlices?: number;
  /** wei per gas unit of the native token. default 50 gwei */
  gasPriceWei?: bigint;
  /** usd per whole token, by symbol. prices gas in the buy token */
  prices?: Record<string, number>;
  /** default "MON" */
  nativeSymbol?: string;
  /** least time between two moves. default 400 ms, one monad block */
  minDelayMs?: number;
  /** most time between two moves. default 2000 ms */
  maxDelayMs?: number;
  /** delay of the first slice. default 0 */
  startMs?: number;
  /** seeds the delays. default: a hash of intent.id, so one intent gives one plan */
  seed?: number;
}

export const DEFAULTS = {
  steps: 20,
  maxSlices: 20,
  gasPriceWei: 50_000_000_000n,
  nativeSymbol: "MON",
  minDelayMs: 400,
  maxDelayMs: 2_000,
};

export const spotVenues = (vs: readonly AnyVenue[]) => vs.filter((v): v is SpotVenue => v.kind === "spot");
export const perpVenue = (vs: readonly AnyVenue[]) => vs.find((v): v is PerpVenue => v.kind === "perp");
export const bridgeVenue = (vs: readonly AnyVenue[]) => vs.find((v): v is BridgeVenue => v.kind === "bridge");

/** the linear congruential generator from swarm-sim's planner, with a 32-bit multiply */
export function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x80000000;
  };
  return { next, int: (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min };
}
export type Rng = ReturnType<typeof seeded>;

/** fnv-1a, to seed the delays from the intent id */
export function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export function usdOf(prices: Record<string, number> | undefined, token: Token, amount: bigint): number {
  return (Number(amount) / 10 ** token.decimals) * (prices?.[token.symbol] ?? 0);
}

/** dollars of gas for `units`. 0 when the native token has no price */
export function gasUsd(units: bigint, opts: PlanOptions): number {
  const wei = units * (opts.gasPriceWei ?? DEFAULTS.gasPriceWei);
  return (Number(wei) / 1e18) * (opts.prices?.[opts.nativeSymbol ?? DEFAULTS.nativeSymbol] ?? 0);
}

/** gas for `units`, in atomic units of `token`. 0 when no price reaches the token */
export function gasIn(token: Token, units: bigint, opts: PlanOptions): bigint {
  const wei = units * (opts.gasPriceWei ?? DEFAULTS.gasPriceWei);
  if (token.symbol === (opts.nativeSymbol ?? DEFAULTS.nativeSymbol)) {
    return token.decimals >= 18 ? wei * 10n ** BigInt(token.decimals - 18) : wei / 10n ** BigInt(18 - token.decimals);
  }
  const price = opts.prices?.[token.symbol];
  if (!price) return 0n;
  return BigInt(Math.round((gasUsd(units, opts) / price) * 10 ** token.decimals));
}

/** quotes once per venue and amount. a venue that throws gives null, and the router drops it */
type Quoter = (venue: SpotVenue, amountIn: bigint) => Promise<Quote | null>;
function quoter(sell: Token, buy: Token): Quoter {
  const cache = new Map<string, Promise<Quote | null>>();
  return (venue, amountIn) => {
    const key = `${venue.id}:${amountIn}`;
    let quote = cache.get(key);
    if (!quote) {
      quote = venue.quote({ sell, buy, amountIn }).then(
        (q) => (q.amountOut >= 0n ? q : null),
        () => null,
      );
      cache.set(key, quote);
    }
    return quote;
  };
}

interface Pick {
  venue: SpotVenue;
  /** what this amount adds at the venue, after the amounts before it */
  out: bigint;
  quote: Quote;
}

/**
 * gives each amount, in order, to the venue with the best next output after gas.
 * `gasEach`: every amount is its own transaction. otherwise only a venue's first amount pays gas.
 * a venue that fails a quote drops out, and the route starts again without it
 */
async function route(
  sizes: bigint[],
  venues: SpotVenue[],
  quote: Quoter,
  gas: (units: bigint) => bigint,
  gasEach: boolean,
): Promise<Pick[]> {
  let alive = [...venues];
  for (;;) {
    const at = new Map<SpotVenue, { in: bigint; out: bigint }>();
    const picks: Pick[] = [];
    let restart = false;
    for (const size of sizes) {
      const tries = await Promise.all(
        alive.map(async (venue) => {
          const prev = at.get(venue);
          const q = await quote(venue, (prev?.in ?? 0n) + size);
          if (!q) return null;
          const out = q.amountOut - (prev?.out ?? 0n);
          const gain = out - (gasEach || !prev ? gas(q.gasUnits) : 0n);
          return { venue, q, out, gain };
        }),
      );
      const dead = alive.filter((_, i) => !tries[i]);
      if (dead.length > 0) {
        alive = alive.filter((v) => !dead.includes(v));
        if (dead.some((v) => at.has(v))) {
          restart = true;
          break;
        }
      }
      const ok = tries.filter((t) => t !== null);
      if (ok.length === 0) throw new Error("router: no venue can quote this swap");
      const best = ok.reduce((a, b) => (b.gain > a.gain ? b : a));
      const prev = at.get(best.venue);
      at.set(best.venue, { in: (prev?.in ?? 0n) + size, out: best.q.amountOut });
      picks.push({ venue: best.venue, out: best.out, quote: best.q });
    }
    if (!restart) return picks;
  }
}

interface Piece {
  venue: SpotVenue;
  account?: number;
  amountIn: bigint;
  expectedOut: bigint;
  gasUnits: bigint;
}

/** splits `total` into `n` parts that differ by at most one unit */
export function parts(total: bigint, n: number): bigint[] {
  const k = BigInt(n);
  return Array.from({ length: n }, (_, j) => (total * BigInt(j + 1)) / k - (total * BigInt(j)) / k);
}

/** splits `total` into `n` parts that vary by up to `spread` either way, so equal sizes do not show a pattern */
function varied(total: bigint, n: number, rng: Rng, spread = 0.2): bigint[] {
  const ws = Array.from({ length: n }, () => BigInt(Math.round((1 + spread * (rng.next() * 2 - 1)) * 1e6)));
  const sum = ws.reduce((s, w) => s + w, 0n);
  let acc = 0n;
  return ws.map((w) => {
    const from = (total * acc) / sum;
    acc += w;
    return (total * acc) / sum - from;
  });
}

/** gas per slice, for `replan`. the slice type has no gas field */
const sliceGas = new WeakMap<Slice, bigint>();

/** largest first, each to the account with the most left. a piece larger than every account splits */
function fitAccounts(pieces: Piece[], pool: number[], balances: Record<number, bigint>, total: bigint): Piece[] {
  const left = new Map(pool.map((a) => [a, balances[a] ?? 0n] as const));
  const held = [...left.values()].reduce((s, b) => s + b, 0n);
  if (held < total) throw new Error(`router: the accounts hold ${held} of the ${total} this swap sells`);
  const used = new Map<number, number>();
  const queue = [...pieces].sort((a, b) => (b.amountIn > a.amountIn ? 1 : b.amountIn < a.amountIn ? -1 : 0));
  const out: Piece[] = [];
  while (queue.length > 0) {
    const piece = queue.shift()!;
    let account = pool[0]!;
    for (const a of pool) {
      const d = left.get(a)! - left.get(account)!;
      if (d > 0n || (d === 0n && (used.get(a) ?? 0) < (used.get(account) ?? 0))) account = a;
    }
    const room = left.get(account)!;
    used.set(account, (used.get(account) ?? 0) + 1);
    if (room >= piece.amountIn) {
      out.push({ ...piece, account });
      left.set(account, room - piece.amountIn);
    } else {
      const part = (piece.expectedOut * room) / piece.amountIn;
      out.push({ ...piece, account, amountIn: room, expectedOut: part });
      left.set(account, 0n);
      queue.unshift({ ...piece, amountIn: piece.amountIn - room, expectedOut: piece.expectedOut - part });
    }
  }
  return out;
}

/** each venue's slices spread evenly over the timeline, so a venue that drops out halfway leaves slices to re-route */
function interleave(pieces: Piece[]): Piece[] {
  const count = new Map<SpotVenue, number>();
  for (const p of pieces) count.set(p.venue, (count.get(p.venue) ?? 0) + 1);
  const seen = new Map<SpotVenue, number>();
  const order = [...count.keys()];
  return pieces
    .map((p) => {
      const i = seen.get(p.venue) ?? 0;
      seen.set(p.venue, i + 1);
      return { p, key: (i + 0.5) / count.get(p.venue)!, v: order.indexOf(p.venue) };
    })
    .sort((a, b) => a.key - b.key || a.v - b.v)
    .map((x) => x.p);
}

export function share(part: bigint, total: bigint): number {
  return total === 0n ? 0 : Number((part * 1_000_000n) / total) / 1_000_000;
}

export async function plan(intent: Intent, venues: readonly AnyVenue[], opts: PlanOptions = {}): Promise<Plan> {
  if (intent.amountIn <= 0n) throw new Error("router: amountIn must be more than 0");
  const spot = spotVenues(venues);
  if (spot.length === 0) throw new Error("router: no spot venue");
  const quote = quoter(intent.sell, intent.buy);
  const gas = (units: bigint) => gasIn(intent.buy, units, opts);
  const w = Math.min(1, Math.max(0, intent.privacyWeight));

  // the baseline: the full size at the best single venue, after gas
  const full = (await Promise.all(spot.map((v) => quote(v, intent.amountIn)))).filter((q) => q !== null);
  if (full.length === 0) throw new Error("router: no venue can quote this swap");
  const net = (q: Quote) => q.amountOut - gas(q.gasUnits);
  const baseline = full.reduce((a, b) => (net(b) > net(a) ? b : a));

  // the split: each chunk to the venue with the best next output
  const steps = Math.max(1, Math.min(opts.steps ?? DEFAULTS.steps, Number(intent.amountIn)));
  const chunks = parts(intent.amountIn, steps);
  const picks = await route(chunks, spot, quote, gas, false);
  let allocs: { venue: SpotVenue; amountIn: bigint; quote: Quote }[] = [];
  picks.forEach((p, i) => {
    const a = allocs.find((x) => x.venue === p.venue);
    const size = chunks[i]!;
    if (a) {
      a.amountIn += size;
      a.quote = p.quote;
    } else allocs.push({ venue: p.venue, amountIn: size, quote: p.quote });
  });
  const splitNet = allocs.reduce((s, a) => s + net(a.quote), 0n);
  if (splitNet <= net(baseline)) {
    allocs = [{ venue: spot.find((v) => v.id === baseline.venue)!, amountIn: intent.amountIn, quote: baseline }];
  }

  // privacy: more slices, each a transaction, so the largest one shows less of the size
  const used = allocs.length;
  const target = Math.max(used, Math.round(used + w * ((opts.maxSlices ?? DEFAULTS.maxSlices) - used)));
  const counts = allocs.map(() => 1);
  for (let k = used; k < target; k++) {
    let i = 0;
    allocs.forEach((a, j) => {
      if (a.amountIn / BigInt(counts[j]!) > allocs[i]!.amountIn / BigInt(counts[i]!)) i = j;
    });
    counts[i]!++;
  }
  const rng = seeded(opts.seed ?? hash(intent.id));
  let pieces: Piece[] = allocs.flatMap((a, j) => {
    let before = 0n;
    return varied(a.amountIn, counts[j]!, rng).map((amountIn) => {
      const out0 = (a.quote.amountOut * before) / a.amountIn;
      before += amountIn;
      const out1 = (a.quote.amountOut * before) / a.amountIn;
      return { venue: a.venue, amountIn, expectedOut: out1 - out0, gasUnits: a.quote.gasUnits };
    });
  });
  pieces = pieces.filter((p) => p.amountIn > 0n);

  // accounts: within their balances when the caller gives them, else round-robin
  const pool = opts.accounts ?? (opts.balances ? Object.keys(opts.balances).map(Number) : [0]);
  if (pool.length === 0) throw new Error("router: no account to send from");
  if (opts.balances) pieces = fitAccounts(pieces, pool, opts.balances, intent.amountIn);
  pieces = interleave(pieces);

  // delays, as swarm-sim's planner gives them: a random wait between moves, from a seeded generator
  let t = opts.startMs ?? 0;
  const slices = pieces.map((p, i): Slice => {
    if (i > 0) t += rng.int(opts.minDelayMs ?? DEFAULTS.minDelayMs, opts.maxDelayMs ?? DEFAULTS.maxDelayMs);
    const slice: Slice = {
      venue: p.venue.id,
      account: p.account ?? pool[i % pool.length]!,
      amountIn: p.amountIn,
      expectedOut: p.expectedOut,
      delayMs: t,
    };
    sliceGas.set(slice, p.gasUnits);
    return slice;
  });

  const expectedOut = slices.reduce((s, x) => s + x.expectedOut, 0n);
  const largest = slices.reduce((m, x) => (x.amountIn > m ? x.amountIn : m), 0n);
  const perp = perpVenue(venues);
  const bridge = bridgeVenue(venues);
  const ratio = intent.hedge?.ratio ?? 0;
  return {
    intent,
    slices,
    baseline,
    expectedOut,
    gasUnits: pieces.reduce((s, p) => s + p.gasUnits, 0n),
    hedge:
      perp && ratio > 0
        ? await perp.quoteHedge(intent.buy, (expectedOut * BigInt(Math.round(ratio * 1e6))) / 1_000_000n)
        : undefined,
    bridge: bridge && intent.bridgeIn ? await bridge.quoteBridge(intent.bridgeIn, intent.sell) : undefined,
    largestSliceShare: share(largest, intent.amountIn),
  };
}

function sameSlice(a: Slice, b: Slice): boolean {
  return a.venue === b.venue && a.account === b.account && a.amountIn === b.amountIn && a.delayMs === b.delayMs;
}

/**
 * re-routes every slice not in `doneSlices` over the venues still given. each slice keeps its account, size,
 * and delay, so the accounts still hold what they send. the result keeps the order of `previous.slices`, and the
 * done slices stay the same objects: `next.slices.filter((s) => !done.includes(s))` is what is left to send
 */
export async function replan(
  previous: Plan,
  doneSlices: readonly Slice[],
  venues: readonly AnyVenue[],
  opts: PlanOptions = {},
): Promise<Plan> {
  const spot = spotVenues(venues);
  if (spot.length === 0) throw new Error("router: no venue left to re-route to");
  const { intent } = previous;

  // match done slices by object first, then by their fields
  const done = new Set<number>();
  const unmatched = [...doneSlices];
  for (const pass of [(a: Slice, b: Slice) => a === b, sameSlice]) {
    previous.slices.forEach((s, i) => {
      if (done.has(i)) return;
      const j = unmatched.findIndex((d) => pass(d, s));
      if (j >= 0) {
        done.add(i);
        unmatched.splice(j, 1);
      }
    });
  }

  const todo = previous.slices
    .map((s, i) => ({ s, i }))
    .filter(({ i }) => !done.has(i))
    .sort((a, b) => a.s.delayMs - b.s.delayMs);
  const avgGas = previous.slices.length > 0 ? previous.gasUnits / BigInt(previous.slices.length) : 0n;
  const picks = await route(
    todo.map(({ s }) => s.amountIn),
    spot,
    quoter(intent.sell, intent.buy),
    (units) => gasIn(intent.buy, units, opts),
    true,
  );

  const slices = [...previous.slices];
  todo.forEach(({ s, i }, k) => {
    const pick = picks[k]!;
    const next: Slice = { ...s, venue: pick.venue.id, expectedOut: pick.out };
    sliceGas.set(next, pick.quote.gasUnits);
    slices[i] = next;
  });
  return {
    ...previous,
    slices,
    expectedOut: slices.reduce((s, x) => s + x.expectedOut, 0n),
    gasUnits: slices.reduce((s, x) => s + (sliceGas.get(x) ?? avgGas), 0n),
  };
}
