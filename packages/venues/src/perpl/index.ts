// perpl: the hedge leg. quoteHedge reads the market from perpl's public rest api (mainnet by default,
// read-only) and falls back to the exchange contract. buildHedge opens the short on perpl testnet with
// an immediate-or-cancel order. the addresses, the abi, and the order format come from the perpl-sdk
// rust crate 0.2.4. the crate does not sign or send, so this file encodes the calls with viem
import type { HedgeQuote, PerpVenue, Token, TxRequest } from "@spidereum/core";
import {
  type Address,
  type PublicClient,
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  parseAbi,
} from "viem";
import { monad, monadTestnet } from "viem/chains";
import { exchangeAbi } from "./abi.ts";

export { exchangeAbi } from "./abi.ts";

export type PerplNetwork = "mainnet" | "testnet";

export interface PerplNetworkConfig {
  network: PerplNetwork;
  chainId: number;
  exchange: Address;
  /** AUSD (Agora) on both networks, 6 decimals */
  collateral: Address;
  /** public rest api base, no auth */
  api: string;
  explorer: string;
  /** market ids from perpl's networks page. ids differ per network */
  markets: Record<string, number>;
  /** agora's AUSD faucet. requestFunds(address) sends 10,000 AUSD. testnet only */
  faucet?: Address;
}

export const PERPL_NETWORKS: Record<PerplNetwork, PerplNetworkConfig> = {
  mainnet: {
    network: "mainnet",
    chainId: 143,
    exchange: "0x34B6552d57a35a1D042CcAe1951BD1C370112a6F",
    collateral: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",
    api: "https://app.perpl.xyz/api",
    explorer: "https://monadscan.com",
    markets: { BTC: 1, MON: 10, ETH: 20, SOL: 31, HYPE: 40, ZEC: 50 },
  },
  testnet: {
    network: "testnet",
    chainId: 10143,
    exchange: "0x1964C32f0bE608E7D29302AFF5E61268E72080cc",
    collateral: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC",
    api: "https://testnet.perpl.xyz/api",
    explorer: "https://testnet.monadexplorer.com",
    markets: { BTC: 16, ETH: 32, SOL: 48, MON: 64, ZEC: 256 },
    faucet: "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C",
  },
};

/** the order types of the exchange contract (0-indexed, as in the sdk's RequestType) */
export const ORDER_TYPE = { openLong: 0, openShort: 1, closeLong: 2, closeShort: 3, cancel: 4 } as const;

const faucetAbi = parseAbi(["function requestFunds(address to)"]);

/** a live read of one perpl market */
export interface PerplMarket {
  network: PerplNetwork;
  perpId: number;
  symbol: string;
  priceDecimals: number;
  lotDecimals: number;
  /** usd */
  markPrice: number;
  oraclePrice?: number;
  bestBid?: number;
  bestAsk?: number;
  /** the last funding rate set, per funding event, as a fraction. positive = longs pay shorts */
  fundingRatePerInterval: number;
  fundingIntervalSec: number;
  /** fundingRatePerInterval scaled to one hour */
  fundingRatePerHour: number;
  /** base-tier taker fee, as a fraction (0.000345 = 3.45 bps). rest api only */
  takerFee?: number;
  /** where the numbers came from */
  source: "api" | "chain";
  /** unix ms of the market state */
  at: number;
}

export interface PerplVenueOptions {
  /** where quotes come from. default "mainnet", read-only */
  quoteNetwork?: PerplNetwork;
  /** where buildHedge opens the short. default "testnet" */
  executeNetwork?: PerplNetwork;
  /** client for the quote network. default: http on MONAD_RPC_URL or MONAD_TESTNET_RPC_URL */
  quoteClient?: PublicClient;
  /** client for the execute network */
  executeClient?: PublicClient;
  /** "api" = rest only, "chain" = contract only, "auto" = rest, then the contract. default "auto" */
  source?: "api" | "chain" | "auto";
  /** leverage of the short. default 2 */
  leverage?: number;
  /** how far under the best bid the immediate-or-cancel order may fill, in bps. default 100 */
  slippageBps?: number;
  /** decimals of the hedged token, for size -> lots. default 18 (MON) */
  tokenDecimals?: number;
  /** the share of the collateral a fill under the mark may take as negative pnl, in bps. default 1000, as the rest api */
  maxNegPnlCollatBps?: number;
  fetch?: typeof fetch;
}

function env(name: string): string | undefined {
  return typeof process === "undefined" ? undefined : process.env[name]?.trim() || undefined;
}

export function perplClient(network: PerplNetwork): PublicClient {
  const chain = network === "mainnet" ? monad : monadTestnet;
  const url = env(network === "mainnet" ? "MONAD_RPC_URL" : "MONAD_TESTNET_RPC_URL");
  return createPublicClient({ chain, transport: http(url) }) as PublicClient;
}

export function perplTxUrl(network: PerplNetwork, hash: string): string {
  return `${PERPL_NETWORKS[network].explorer}/tx/${hash}`;
}

/** MON, WMON, "MON Perp", and "mon" all name the MON market */
export function perplSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase().replace(/[\s-]*PERP$/, "");
  return s === "WMON" ? "MON" : s;
}

/** the market label a HedgeQuote carries: "MON-PERP · perpl mainnet #10" */
export function marketLabel(symbol: string, network: PerplNetwork, perpId: number): string {
  return `${symbol}-PERP · perpl ${network} #${perpId}`;
}

export function symbolFromLabel(label: string): string {
  const m = /^([A-Z0-9]+)-PERP/.exec(label.trim());
  if (!m?.[1]) throw new Error(`perpl: cannot read a symbol from market "${label}"`);
  return m[1];
}

/** size in atomic units of the token -> lots of the perp. floors to the lot size */
export function sizeToLots(size: bigint, tokenDecimals: number, lotDecimals: number): bigint {
  const shift = tokenDecimals - lotDecimals;
  return shift >= 0 ? size / 10n ** BigInt(shift) : size * 10n ** BigInt(-shift);
}

/** a price limit for a short: `bps` under the reference, never below 1 */
export function shortLimitPrice(refPNS: bigint, bps: number): bigint {
  const p = (refPNS * BigInt(10_000 - bps)) / 10_000n;
  return p > 0n ? p : 1n;
}

/** collateral (6-decimal AUSD units) for `lots` at `pricePNS` with `leverage`, plus half again as a buffer */
export function marginFor(lots: bigint, pricePNS: bigint, lotDecimals: number, priceDecimals: number, leverage: number): bigint {
  const notional = (lots * pricePNS * 10n ** 6n) / (10n ** BigInt(lotDecimals) * 10n ** BigInt(priceDecimals));
  const hdths = BigInt(Math.round(leverage * 100));
  return (notional * 100n * 3n) / (hdths * 2n) + 1n;
}

export interface OrderDesc {
  orderDescId: bigint;
  perpId: bigint;
  orderType: number;
  orderId: bigint;
  pricePNS: bigint;
  lotLNS: bigint;
  expiryBlock: bigint;
  postOnly: boolean;
  fillOrKill: boolean;
  immediateOrCancel: boolean;
  maxMatches: bigint;
  leverageHdths: bigint;
  lastExecutionBlock: bigint;
  amountCNS: bigint;
  maxNegPnlCollatBPS: bigint;
}

/**
 * an immediate-or-cancel open-short, as OrderRequest::to_order_desc builds it in the sdk.
 * a short that fills under the mark opens with a negative pnl. `maxNegPnlCollatBps` caps the share of the
 * collateral that pnl may take. with 0, as in the sdk's example, the settlement reverts
 * (TakerOrderSettlementFailed) whenever the fill is under the mark. the rest api defaults it to 1000
 */
export function openShortDesc(p: { id: bigint; perpId: number; pricePNS: bigint; lots: bigint; leverage: number; maxNegPnlCollatBps?: number }): OrderDesc {
  return {
    orderDescId: p.id,
    perpId: BigInt(p.perpId),
    orderType: ORDER_TYPE.openShort,
    orderId: 0n,
    pricePNS: p.pricePNS,
    lotLNS: p.lots,
    expiryBlock: 0n,
    postOnly: false,
    fillOrKill: false,
    immediateOrCancel: true,
    maxMatches: 0n,
    leverageHdths: BigInt(Math.round(p.leverage * 100)),
    lastExecutionBlock: 0n,
    amountCNS: 0n,
    maxNegPnlCollatBPS: BigInt(p.maxNegPnlCollatBps ?? 1000),
  };
}

// rest api

interface ApiMarket {
  id: number;
  perpetual_id: number;
  symbol: string;
  name: string;
  size_units: string;
  funding_interval_sec: number;
  config: { is_open: boolean; price_decimals: number; size_decimals: number; taker_fee?: number };
  state?: ApiState;
  funding?: { rate: number; at: { b: number; t: number } };
}
interface ApiState {
  at: { b: number; t: number };
  orl: number;
  mrk: number;
  bid: number;
  ask: number;
}

async function getJson<T>(f: typeof fetch, url: string): Promise<T> {
  const res = await f(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`perpl api ${res.status} for ${url}`);
  return (await res.json()) as T;
}

/** the market list changes rarely and funding once per interval, so the context is kept for 60 s, per fetch */
const contextCache = new WeakMap<typeof fetch, Map<string, { at: number; markets: ApiMarket[] }>>();

export async function readMarketFromApi(network: PerplNetwork, symbol: string, f: typeof fetch = fetch): Promise<PerplMarket> {
  const cfg = PERPL_NETWORKS[network];
  const sym = perplSymbol(symbol);
  let byApi = contextCache.get(f);
  if (!byApi) contextCache.set(f, (byApi = new Map()));
  let ctx = byApi.get(cfg.api);
  if (!ctx || Date.now() - ctx.at > 60_000) {
    const body = await getJson<{ markets: ApiMarket[] }>(f, `${cfg.api}/v1/pub/context`);
    ctx = { at: Date.now(), markets: body.markets };
    byApi.set(cfg.api, ctx);
  }
  // mainnet fills `size_units` and `name`, testnet fills `symbol` too
  const market = ctx.markets.find((m) => [m.size_units, m.symbol, m.name].some((s) => s && perplSymbol(s) === sym));
  if (!market) throw new Error(`perpl ${network}: no ${sym} market in the api context`);
  const ticker = await getJson<{ d: Record<string, ApiState> }>(f, `${cfg.api}/v1/market-data/${market.id}/ticker`).catch(() => undefined);
  const state = ticker?.d[String(market.id)] ?? market.state;
  if (!state?.mrk) throw new Error(`perpl ${network}: no mark price for ${sym}`);
  const scale = 10 ** market.config.price_decimals;
  const perInterval = (market.funding?.rate ?? 0) / 1e6;
  const intervalSec = market.funding_interval_sec;
  return {
    network,
    perpId: market.perpetual_id,
    symbol: sym,
    priceDecimals: market.config.price_decimals,
    lotDecimals: market.config.size_decimals,
    markPrice: state.mrk / scale,
    oraclePrice: state.orl ? state.orl / scale : undefined,
    bestBid: state.bid ? state.bid / scale : undefined,
    bestAsk: state.ask ? state.ask / scale : undefined,
    fundingRatePerInterval: perInterval,
    fundingIntervalSec: intervalSec,
    fundingRatePerHour: intervalSec > 0 ? (perInterval * 3600) / intervalSec : perInterval,
    // micros. a simulated testnet fill charged 842 units on a 2,439,000-unit notional, that is 345 micros
    takerFee: market.config.taker_fee !== undefined ? market.config.taker_fee / 1e6 : undefined,
    source: "api",
    at: state.at?.t ?? Date.now(),
  };
}

// the exchange contract

export interface PerpInfo {
  perpId: number;
  symbol: string;
  priceDecimals: number;
  lotDecimals: number;
  markPNS: bigint;
  oraclePNS: bigint;
  /** best bid and ask in PNS. 0 = no orders on that side */
  bidPNS: bigint;
  askPNS: bigint;
  /** per funding event, fraction x 1e5 */
  fundingRatePct100k: number;
  paused: boolean;
  markTimestamp: number;
}

export async function readPerpInfo(client: PublicClient, network: PerplNetwork, perpId: number): Promise<PerpInfo> {
  const i = await client.readContract({
    address: PERPL_NETWORKS[network].exchange,
    abi: exchangeAbi,
    functionName: "getPerpetualInfoV2",
    args: [BigInt(perpId)],
  });
  // order-book prices (ONS) sit on top of the base price, as in the sdk's Order::from_snapshot
  const onBook = (ons: bigint) => (ons > 0n ? i.basePricePNS + ons : 0n);
  return {
    perpId,
    symbol: perplSymbol(i.symbol || i.name),
    priceDecimals: Number(i.priceDecimals),
    lotDecimals: Number(i.lotDecimals),
    markPNS: i.markPNS,
    oraclePNS: i.oraclePNS,
    bidPNS: onBook(i.maxBidPriceONS),
    askPNS: onBook(i.minAskPriceONS),
    fundingRatePct100k: Number(i.fundingRatePct100k),
    paused: i.status === 0,
    markTimestamp: Number(i.markTimestamp),
  };
}

/** the perp id for a symbol: the known table first, then the exchange's existence bitmap */
export async function findPerpId(client: PublicClient, network: PerplNetwork, symbol: string): Promise<number> {
  const cfg = PERPL_NETWORKS[network];
  const sym = perplSymbol(symbol);
  const known = cfg.markets[sym];
  if (known !== undefined) return known;
  const bitmap = await client.readContract({ address: cfg.exchange, abi: exchangeAbi, functionName: "getPerpetualExistsBitmap" });
  const ids: number[] = [];
  bitmap.forEach((word, w) => {
    for (let b = 0; b < 256; b++) if ((word >> BigInt(b)) & 1n) ids.push(w * 256 + b);
  });
  for (const id of ids) {
    const info = await readPerpInfo(client, network, id).catch(() => undefined);
    if (info?.symbol === sym && !info.paused) return id;
  }
  throw new Error(`perpl ${network}: no ${sym} perp on the exchange`);
}

export async function readMarketFromChain(client: PublicClient, network: PerplNetwork, symbol: string): Promise<PerplMarket> {
  const cfg = PERPL_NETWORKS[network];
  const perpId = await findPerpId(client, network, symbol);
  const [info, intervalBlocks, head] = await Promise.all([
    readPerpInfo(client, network, perpId),
    client.readContract({ address: cfg.exchange, abi: exchangeAbi, functionName: "getFundingInterval" }),
    client.getBlock(),
  ]);
  // seconds per block, measured over the last 10,000 blocks
  const past = await client.getBlock({ blockNumber: head.number - 10_000n });
  const secPerBlock = Number(head.timestamp - past.timestamp) / 10_000;
  const intervalSec = Number(intervalBlocks) * secPerBlock;
  const scale = 10 ** info.priceDecimals;
  const perInterval = info.fundingRatePct100k / 1e5;
  return {
    network,
    perpId,
    symbol: info.symbol,
    priceDecimals: info.priceDecimals,
    lotDecimals: info.lotDecimals,
    markPrice: Number(info.markPNS) / scale,
    oraclePrice: Number(info.oraclePNS) / scale,
    bestBid: info.bidPNS ? Number(info.bidPNS) / scale : undefined,
    bestAsk: info.askPNS ? Number(info.askPNS) / scale : undefined,
    fundingRatePerInterval: perInterval,
    fundingIntervalSec: intervalSec,
    fundingRatePerHour: intervalSec > 0 ? (perInterval * 3600) / intervalSec : perInterval,
    source: "chain",
    at: info.markTimestamp * 1000,
  };
}

/** the exchange account of a wallet, or undefined when the wallet has none */
export async function readPerplAccount(client: PublicClient, network: PerplNetwork, wallet: Address) {
  try {
    const a = await client.readContract({
      address: PERPL_NETWORKS[network].exchange,
      abi: exchangeAbi,
      functionName: "getAccountByAddr",
      args: [wallet],
    });
    return { accountId: a.accountId, balanceCNS: a.balanceCNS, lockedBalanceCNS: a.lockedBalanceCNS, frozen: a.frozen };
  } catch (err) {
    if (String((err as Error).message).includes("AccountDoesNotExist")) return undefined;
    throw err;
  }
}

/** the open position of an exchange account on one perp. lots = 0 when flat */
export async function readPerplPosition(client: PublicClient, network: PerplNetwork, perpId: number, accountId: bigint) {
  const [p, markPNS] = await client.readContract({
    address: PERPL_NETWORKS[network].exchange,
    abi: exchangeAbi,
    functionName: "getPositionV2",
    args: [BigInt(perpId), accountId],
  });
  return { side: p.positionType === 1 ? "short" : "long", lots: p.lotLNS, entryPNS: p.pricePNS, depositCNS: p.depositCNS, markPNS } as const;
}

export function createPerplVenue(opts: PerplVenueOptions = {}): PerpVenue & {
  network: { quote: PerplNetwork; execute: PerplNetwork };
  readMarket(symbol: string, network?: PerplNetwork): Promise<PerplMarket>;
} {
  const quoteNetwork = opts.quoteNetwork ?? "mainnet";
  const executeNetwork = opts.executeNetwork ?? "testnet";
  const source = opts.source ?? "auto";
  const leverage = opts.leverage ?? 2;
  const slippageBps = opts.slippageBps ?? 100;
  const tokenDecimals = opts.tokenDecimals ?? 18;
  const f = opts.fetch ?? fetch;
  const clients: Partial<Record<PerplNetwork, PublicClient>> = {};
  if (opts.quoteClient) clients[quoteNetwork] = opts.quoteClient;
  if (opts.executeClient) clients[executeNetwork] = opts.executeClient;
  const clientFor = (n: PerplNetwork) => (clients[n] ??= perplClient(n));

  async function readMarket(symbol: string, network: PerplNetwork = quoteNetwork): Promise<PerplMarket> {
    if (source === "chain") return readMarketFromChain(clientFor(network), network, symbol);
    try {
      return await readMarketFromApi(network, symbol, f);
    } catch (err) {
      if (source === "api") throw err;
      return readMarketFromChain(clientFor(network), network, symbol);
    }
  }

  return {
    id: "perpl",
    kind: "perp",
    network: { quote: quoteNetwork, execute: executeNetwork },
    readMarket,

    async quoteHedge(token: Token, size: bigint): Promise<HedgeQuote> {
      const m = await readMarket(token.symbol);
      return {
        venue: "perpl",
        market: marketLabel(m.symbol, m.network, m.perpId),
        size,
        markPrice: m.markPrice,
        fundingRate: m.fundingRatePerHour,
        simulated: false,
        at: m.at,
      };
    },

    /**
     * the transactions that open the short on the execute network, in order. each one must be mined
     * before the next is sent:
     * 1. testnet only, when the wallet lacks AUSD: the agora faucet (10,000 AUSD)
     * 2. approve AUSD, then createAccount (first time) or depositCollateral (when the free balance is short)
     * 3. execOrders with one immediate-or-cancel open-short, at most `slippageBps` under the best bid
     */
    async buildHedge(hedge: HedgeQuote, account: Address): Promise<TxRequest[]> {
      const network = executeNetwork;
      const cfg = PERPL_NETWORKS[network];
      const client = clientFor(network);
      const perpId = await findPerpId(client, network, symbolFromLabel(hedge.market));
      const info = await readPerpInfo(client, network, perpId);
      if (info.paused) throw new Error(`perpl ${network}: perp #${perpId} is paused`);

      const lots = sizeToLots(hedge.size, tokenDecimals, info.lotDecimals);
      if (lots <= 0n) throw new Error(`perpl: hedge size ${hedge.size} is under one lot of perp #${perpId}`);
      const ref = info.bidPNS > 0n ? info.bidPNS : info.markPNS;
      const pricePNS = shortLimitPrice(ref, slippageBps);
      const need = marginFor(lots, info.markPNS, info.lotDecimals, info.priceDecimals, leverage);

      const [existing, minOpen, wallet] = await Promise.all([
        readPerplAccount(client, network, account),
        client.readContract({ address: cfg.exchange, abi: exchangeAbi, functionName: "getMinAccountOpenCNS" }),
        client.readContract({ address: cfg.collateral, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
      ]);

      const txs: TxRequest[] = [];
      let deposit = 0n;
      let fund: "createAccount" | "depositCollateral" | undefined;
      if (!existing) {
        deposit = need > minOpen ? need : minOpen;
        fund = "createAccount";
      } else {
        const free = existing.balanceCNS - existing.lockedBalanceCNS;
        if (free < need) {
          // the api reports a 10 AUSD minimum deposit on both networks
          const short = need - free;
          deposit = short > 10_000_000n ? short : 10_000_000n;
          fund = "depositCollateral";
        }
      }
      if (fund) {
        if (wallet < deposit) {
          if (!cfg.faucet) throw new Error(`perpl ${network}: wallet holds ${wallet} AUSD units and needs ${deposit}`);
          txs.push({ to: cfg.faucet, data: encodeFunctionData({ abi: faucetAbi, functionName: "requestFunds", args: [account] }), value: 0n });
        }
        txs.push({ to: cfg.collateral, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [cfg.exchange, deposit] }), value: 0n });
        txs.push({ to: cfg.exchange, data: encodeFunctionData({ abi: exchangeAbi, functionName: fund, args: [deposit] }), value: 0n });
      }

      const desc = openShortDesc({ id: BigInt(Date.now()), perpId, pricePNS, lots, leverage, maxNegPnlCollatBps: opts.maxNegPnlCollatBps });
      txs.push({
        to: cfg.exchange,
        data: encodeFunctionData({ abi: exchangeAbi, functionName: "execOrders", args: [[desc], true] }),
        value: 0n,
      });
      return txs;
    },
  };
}
