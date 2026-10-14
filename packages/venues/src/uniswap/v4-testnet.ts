// uniswap v4 code on monad testnet (10143), from a Monad-maintained deployment. it is not an official
// Uniswap deployment. addresses from https://github.com/monad-developers/uniswap-v4-hooks-example
// (shared-infrastructure.json, linked from https://docs.monad.xyz/guides/uniswap-v4-hooks/pool-lifecycle.md).
// quotes come from its Quoter. build() swaps through its Universal Router, so this venue executes on testnet
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  http,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { monadTestnet, type Intent, type QuoteRequest, type Slice, type SpotVenue, type TxRequest } from "@spidereum/core";
import { minOut, testPoolSide, TEST_POOL_TOKENS } from "./testpool.ts";
import { v4QuoterAbi, type PoolKey } from "./v4.ts";

/** not in VenueId yet. the lead can add "uniswap-v4-testnet" to the union and switch to it */
export const UNISWAP_TESTNET_VENUE_ID = "uniswap-v4-testnet" as const;

export const UNISWAP_V4_MONAD_TESTNET = {
  chainId: 10143,
  poolManager: "0x451D64ab3b650040d2aE1886602b97ed6eDc643d",
  quoter: "0x869834d127b230283fe63E0d0A9bEB67216a94C7",
  stateView: "0xB639209539c61BaF67AC04876315786F8D0b153c",
  universalRouter: "0x1b7bFCd2870329B987191910D85c22C7287f3c22",
  positionManager: "0x3Bb14E3D0Cd50aBe3EdACa06d06c29C78676C31A",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  wrappedNative: "0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541",
} as const satisfies Record<string, Address | number>;

/**
 * native MON against circle's testnet USDC, 0.05%, found on 13 oct 2026 through the testnet StateView.
 * pool id 0x40ab892dad820a1b57392a8a6e7c783e108a2285e83d3a6dbf1dd44902a19972, near 1 USDC per MON.
 * shallow: 1 USDC quotes, 10 USDC does not
 */
export const TESTNET_MON_USDC_POOL: PoolKey = {
  currency0: zeroAddress,
  currency1: TEST_POOL_TOKENS.USDC.address,
  fee: 500,
  tickSpacing: 10,
  hooks: zeroAddress,
};

// universal router command and v4 router actions, from the pinned commits in shared-infrastructure.json
const V4_SWAP = 0x10;
const SWAP_EXACT_IN_SINGLE = 0x06;
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;

const universalRouterAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);
const permit2Abi = parseAbi([
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

const poolKeyType = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

const exactInputSingleType = {
  type: "tuple",
  components: [
    { name: "poolKey", ...poolKeyType },
    { name: "zeroForOne", type: "bool" },
    { name: "amountIn", type: "uint128" },
    { name: "amountOutMinimum", type: "uint128" },
    { name: "minHopPriceX36", type: "uint256" },
    { name: "hookData", type: "bytes" },
  ],
} as const;

/** the universal router input for one exact-input swap in one pool: swap, settle the input, take the output */
export function encodeV4ExactInSingle(key: PoolKey, zeroForOne: boolean, amountIn: bigint, amountOutMin: bigint): Hex {
  const [input, output] = zeroForOne ? [key.currency0, key.currency1] : [key.currency1, key.currency0];
  const actions = `0x${[SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL].map((a) => a.toString(16).padStart(2, "0")).join("")}` as Hex;
  const params: Hex[] = [
    encodeAbiParameters(
      [exactInputSingleType],
      [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: amountOutMin, minHopPriceX36: 0n, hookData: "0x" }],
    ),
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [input, amountIn]),
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [output, amountOutMin]),
  ];
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, params]);
}

/**
 * gas per transaction, from the live swaps on monad testnet on 13 oct 2026 (index.live.test.ts).
 * monad charges the gas limit, and its receipts report it. a USDC sale adds the ERC-20 and Permit2 approvals
 */
export const UNISWAP_TESTNET_GAS = { monIn: 181_000n, usdcIn: 489_000n, approvals: 142_000n } as const;

export interface UniswapTestnetVenueOptions {
  /** a client on monad testnet (10143). default: a client on MONAD_TESTNET_RPC_URL */
  client?: PublicClient;
  pool?: PoolKey;
  /** seconds a built swap stays valid. default 1 hour, so slices with long delays still settle */
  deadlineSeconds?: number;
}

export function createUniswapTestnetVenue(opts: UniswapTestnetVenueOptions = {}): SpotVenue {
  const client: PublicClient =
    opts.client ??
    (createPublicClient({ chain: monadTestnet, transport: http(process.env.MONAD_TESTNET_RPC_URL, { batch: true }) }) as PublicClient);
  const key = opts.pool ?? TESTNET_MON_USDC_POOL;
  const deadlineSeconds = opts.deadlineSeconds ?? 3600;
  const { universalRouter, permit2, quoter } = UNISWAP_V4_MONAD_TESTNET;

  /** MON is currency0 in the pool, so selling MON is zero for one */
  function zeroForOne(sellSide: "MON" | "USDC"): boolean {
    const sellCurrency = sellSide === "MON" ? zeroAddress : TEST_POOL_TOKENS.USDC.address;
    return key.currency0.toLowerCase() === sellCurrency.toLowerCase();
  }

  function direction(sell: { symbol: string; address: Address; chainId: number; decimals: number }, buy: typeof sell) {
    const s = testPoolSide(sell);
    if (s === testPoolSide(buy)) throw new Error("uniswap-v4 testnet: sell and buy are the same token");
    return s;
  }

  return {
    id: UNISWAP_TESTNET_VENUE_ID,
    kind: "spot",
    async quote(req: QuoteRequest) {
      const side = direction(req.sell, req.buy);
      const { result } = await client.simulateContract({
        address: quoter,
        abi: v4QuoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ poolKey: key, zeroForOne: zeroForOne(side), exactAmount: req.amountIn, hookData: "0x" }],
      });
      return {
        venue: UNISWAP_TESTNET_VENUE_ID,
        sell: req.sell,
        buy: req.buy,
        amountIn: req.amountIn,
        amountOut: result[0],
        feeBps: key.fee / 100,
        gasUnits:
          side === "MON" ? UNISWAP_TESTNET_GAS.monIn : UNISWAP_TESTNET_GAS.usdcIn + UNISWAP_TESTNET_GAS.approvals,
        simulated: false,
        at: Date.now(),
      };
    },
    async build(slice: Slice, intent: Intent, _account: Address): Promise<TxRequest[]> {
      const side = direction(intent.sell, intent.buy);
      const least = minOut(slice.expectedOut, intent.maxSlippageBps);
      const input = encodeV4ExactInSingle(key, zeroForOne(side), slice.amountIn, least);
      const deadline = BigInt(Math.floor((Date.now() + slice.delayMs) / 1000) + deadlineSeconds);
      const swap: TxRequest = {
        to: universalRouter,
        data: encodeFunctionData({
          abi: universalRouterAbi,
          functionName: "execute",
          args: [`0x${V4_SWAP.toString(16)}`, [input], deadline],
        }),
        value: side === "MON" ? slice.amountIn : 0n,
      };
      if (side === "MON") return [swap];
      // USDC in: the router pulls through Permit2. exact amounts, so slices built ahead of time settle in order
      return [
        {
          to: TEST_POOL_TOKENS.USDC.address,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [permit2, slice.amountIn] }),
          value: 0n,
        },
        {
          to: permit2,
          data: encodeFunctionData({
            abi: permit2Abi,
            functionName: "approve",
            args: [TEST_POOL_TOKENS.USDC.address, universalRouter, slice.amountIn, Number(deadline)],
          }),
          value: 0n,
        },
        swap,
      ];
    },
  };
}
