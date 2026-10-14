// lane L1: kuru, the order book on monad.
// quote() reads one kuru market with an eth_call from address zero, the way kuru's own sdk estimates
// (CostEstimator.returnMarketSellEstimate). build() returns a market order on the execution market.
// by default quotes read monad mainnet (real liquidity) and build() targets monad testnet
import {
  createPublicClient,
  encodeFunctionData,
  http,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";
import { monad, monadTestnet } from "@spidereum/core";
import type { Intent, Quote, QuoteRequest, Slice, SpotVenue, Token, TxRequest } from "@spidereum/core";
import { erc20Abi, orderBookAbi } from "./abi.ts";

export type KuruNetwork = "mainnet" | "testnet";

/** kuru's addresses, from https://docs.kuru.io/contracts/Contract-addresses (checked 13 oct 2026) */
export const KURU = {
  mainnet: {
    chainId: 143,
    router: "0xd651346d7c789536ebf06dc72aE3C8502cd695CC",
    marginAccount: "0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5",
    usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    /** official MON-USDC market. base = native MON, quote = USDC */
    monUsdc: "0x065C9d28E428A0db40191a54d33d5b7c71a9C394",
    explorer: "https://monadscan.com",
  },
  testnet: {
    chainId: 10143,
    router: "0x7EFbE105Ca7415dE98F96622173458ac1c054630",
    marginAccount: "0xd029C2D98ff85D8F64799017fE00a59B1159CE02",
    /** kuru's own testnet USDC. it has no public mint, and we found no faucet for it */
    kuruUsdc: "0x3bA3d39AFcf8bb994f7964B3e0171Ea2Ba361570",
    /** circle's testnet USDC, the token the swarm holds */
    circleUsdc: "0x534b2f3a21130d7a60830c2df862319e593943a3",
    /** kuru's official testnet MON-USDC market. it quotes kuru's USDC and has no bids */
    officialMonUsdc: "0xa241896A7Dbe8a550D2E5fF7A914bB1989ceD2D9",
    /**
     * MON / circle-USDC market, deployed through kuru's testnet router by swarm account 1 (lane L1),
     * seeded from account 1 at the mainnet price. deploy tx 0x895627a0…bd3. see seed.ts
     */
    monUsdc: "0x10D447F2cfa2f2750D8b91461c580902573ACC90" as Address,
    explorer: "https://testnet.monadexplorer.com",
  },
} as const;

const CHAINS = { mainnet: monad, testnet: monadTestnet } as const;
const RPC_ENV = { mainnet: "MONAD_RPC_URL", testnet: "MONAD_TESTNET_RPC_URL" } as const;

export interface KuruVenueOptions {
  /** network quote() reads. default "mainnet": real liquidity, read-only */
  network?: KuruNetwork;
  /** public client for `network`. default: http to MONAD_RPC_URL or MONAD_TESTNET_RPC_URL */
  client?: PublicClient;
  /** market quote() reads. default: the MON-USDC market for `network` */
  market?: Address;
  /** where build() sends. default: testnet, the MON / circle-USDC market */
  execution?: {
    network?: KuruNetwork;
    client?: PublicClient;
    market?: Address;
  };
  /** gas for one market order when eth_estimateGas fails. default 300k */
  fallbackGas?: bigint;
}

export interface KuruMarketParams {
  market: Address;
  pricePrecision: bigint;
  sizePrecision: bigint;
  base: Address;
  baseDecimals: number;
  quote: Address;
  quoteDecimals: number;
  tickSize: bigint;
  minSize: bigint;
  maxSize: bigint;
  takerFeeBps: number;
}

/** "sell" = the person sells the base (MON) for the quote (USDC). "buy" = the person buys MON with USDC */
export type KuruSide = "sell" | "buy";

export function clientFor(network: KuruNetwork, rpcUrl?: string): PublicClient {
  const url = rpcUrl ?? (typeof process !== "undefined" ? process.env[RPC_ENV[network]] : undefined);
  return createPublicClient({ chain: CHAINS[network], transport: http(url) }) as PublicClient;
}

export async function readMarketParams(client: PublicClient, market: Address): Promise<KuruMarketParams> {
  const p = await client.readContract({ address: market, abi: orderBookAbi, functionName: "getMarketParams" });
  return {
    market,
    pricePrecision: BigInt(p[0]),
    sizePrecision: p[1],
    base: p[2],
    baseDecimals: Number(p[3]),
    quote: p[4],
    quoteDecimals: Number(p[5]),
    tickSize: BigInt(p[6]),
    minSize: p[7],
    maxSize: p[8],
    takerFeeBps: Number(p[9]),
  };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function isBaseToken(t: Token, m: KuruMarketParams): boolean {
  if (same(t.address, m.base)) return true;
  // the markets here trade native MON as the base. accept MON by symbol, so a mainnet intent maps to the testnet market
  return same(m.base, zeroAddress) && t.symbol.toUpperCase() === "MON";
}

function isQuoteToken(t: Token, m: KuruMarketParams): boolean {
  if (same(t.address, m.quote)) return true;
  // USDC differs per network (circle's on mainnet, kuru's or circle's on testnet). match by symbol and decimals
  return t.symbol.toUpperCase() === "USDC" && t.decimals === m.quoteDecimals;
}

export function sideOf(sell: Token, buy: Token, m: KuruMarketParams): KuruSide {
  if (isBaseToken(sell, m) && isQuoteToken(buy, m)) return "sell";
  if (isQuoteToken(sell, m) && isBaseToken(buy, m)) return "buy";
  throw new Error(`kuru: market ${m.market} does not trade ${sell.symbol} for ${buy.symbol}`);
}

/** the order arguments for `amountIn` atomic units, and the atomic amount the order really spends after rounding */
export function orderSize(side: KuruSide, amountIn: bigint, m: KuruMarketParams): { units: bigint; spend: bigint } {
  if (side === "sell") {
    const one = 10n ** BigInt(m.baseDecimals);
    const units = (amountIn * m.sizePrecision) / one;
    return { units, spend: (units * one) / m.sizePrecision };
  }
  const one = 10n ** BigInt(m.quoteDecimals);
  const units = (amountIn * m.pricePrecision) / one;
  return { units, spend: (units * one) / m.pricePrecision };
}

/** what a market order of `amountIn` returns right now, from an eth_call. 0 when the book has nothing on that side */
export async function simulateMarketOrder(
  client: PublicClient,
  m: KuruMarketParams,
  side: KuruSide,
  amountIn: bigint,
): Promise<bigint> {
  const { units } = orderSize(side, amountIn, m);
  if (units === 0n) return 0n;
  const { result } = await client.simulateContract({
    address: m.market,
    abi: orderBookAbi,
    functionName: side === "sell" ? "placeAndExecuteMarketSell" : "placeAndExecuteMarketBuy",
    args: [units, 0n, false, false],
    account: zeroAddress,
  });
  return result;
}

interface Leg {
  network: KuruNetwork;
  client: PublicClient;
  market: Address;
  params?: Promise<KuruMarketParams>;
  gas: Partial<Record<KuruSide, bigint>>;
}

function leg(network: KuruNetwork, client: PublicClient | undefined, market: Address | undefined): Leg {
  return { network, client: client ?? clientFor(network), market: market ?? KURU[network].monUsdc, gas: {} };
}

function paramsOf(l: Leg): Promise<KuruMarketParams> {
  if (same(l.market, zeroAddress)) {
    return Promise.reject(new Error(`kuru: no MON-USDC market set for ${l.network}. pass one in the options`));
  }
  l.params ??= readMarketParams(l.client, l.market).catch((e) => {
    l.params = undefined;
    throw e;
  });
  return l.params;
}

export function createKuruVenue(opts: KuruVenueOptions = {}): SpotVenue & {
  /** the quote leg and the execution leg, for the screens and the report */
  describe(): { quote: { network: KuruNetwork; market: Address }; execution: { network: KuruNetwork; market: Address } };
  /** a quote from the execution market. build() uses it to set minAmountOut */
  quoteExecution(req: QuoteRequest): Promise<Quote>;
} {
  const fallbackGas = opts.fallbackGas ?? 300_000n;
  const q = leg(opts.network ?? "mainnet", opts.client, opts.market);
  const execNetwork = opts.execution?.network ?? "testnet";
  // one leg when quote and execution are the same market, so the params and gas caches are shared
  const x =
    execNetwork === q.network && !opts.execution?.client && (!opts.execution?.market || same(opts.execution.market, q.market))
      ? q
      : leg(execNetwork, opts.execution?.client, opts.execution?.market);

  async function gasFor(l: Leg, side: KuruSide, units: bigint, m: KuruMarketParams): Promise<bigint> {
    const cached = l.gas[side];
    if (cached !== undefined) return cached;
    let gas = fallbackGas;
    try {
      gas = await l.client.estimateContractGas({
        address: m.market,
        abi: orderBookAbi,
        functionName: side === "sell" ? "placeAndExecuteMarketSell" : "placeAndExecuteMarketBuy",
        args: [units, 0n, false, false],
        account: zeroAddress,
      });
    } catch {
      // keep the fallback. a quote never fails on the gas estimate alone
    }
    l.gas[side] = gas;
    return gas;
  }

  async function quoteOn(l: Leg, req: QuoteRequest): Promise<Quote> {
    const m = await paramsOf(l);
    const side = sideOf(req.sell, req.buy, m);
    const { units } = orderSize(side, req.amountIn, m);
    const [amountOut, gasUnits] = await Promise.all([
      simulateMarketOrder(l.client, m, side, req.amountIn),
      units === 0n ? Promise.resolve(0n) : gasFor(l, side, units, m),
    ]);
    return {
      venue: "kuru",
      sell: req.sell,
      buy: req.buy,
      amountIn: req.amountIn,
      amountOut,
      feeBps: m.takerFeeBps,
      gasUnits,
      simulated: false,
      at: Date.now(),
    };
  }

  return {
    id: "kuru",
    kind: "spot",
    describe: () => ({
      quote: { network: q.network, market: q.market },
      execution: { network: x.network, market: x.market },
    }),
    quote: (req) => quoteOn(q, req),
    quoteExecution: (req) => quoteOn(x, req),

    async build(slice: Slice, intent: Intent, account: Address): Promise<TxRequest[]> {
      const m = await paramsOf(x);
      const side = sideOf(intent.sell, intent.buy, m);
      const { units, spend } = orderSize(side, slice.amountIn, m);
      if (units === 0n) throw new Error(`kuru: slice of ${slice.amountIn} is below the market's size precision`);

      // the plan's expectedOut comes from the quote network. the execution market has its own book,
      // so minAmountOut comes from a fresh quote of the execution market
      const out = await simulateMarketOrder(x.client, m, side, spend);
      if (out === 0n) {
        throw new Error(`kuru ${x.network}: market ${m.market} has no liquidity to ${side === "sell" ? "buy MON" : "sell MON"}`);
      }
      const minAmountOut = (out * BigInt(10_000 - intent.maxSlippageBps)) / 10_000n;

      if (side === "sell") {
        const native = same(m.base, zeroAddress);
        const txs: TxRequest[] = [];
        if (!native) txs.push(...(await approval(x.client, m.base, account, m.market, spend)));
        txs.push({
          to: m.market,
          data: encodeFunctionData({
            abi: orderBookAbi,
            functionName: "placeAndExecuteMarketSell",
            args: [units, minAmountOut, false, true],
          }),
          value: native ? spend : 0n,
        });
        return txs;
      }

      const native = same(m.quote, zeroAddress);
      const txs: TxRequest[] = [];
      if (!native) txs.push(...(await approval(x.client, m.quote, account, m.market, spend)));
      txs.push({
        to: m.market,
        data: encodeFunctionData({
          abi: orderBookAbi,
          functionName: "placeAndExecuteMarketBuy",
          args: [units, minAmountOut, false, true],
        }),
        value: native ? spend : 0n,
      });
      return txs;
    },
  };
}

/** an approve for `spender`, or nothing when the allowance already covers `amount` */
async function approval(
  client: PublicClient,
  token: Address,
  owner: Address,
  spender: Address,
  amount: bigint,
): Promise<TxRequest[]> {
  const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
  if (allowance >= amount) return [];
  return [{ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }), value: 0n }];
}
