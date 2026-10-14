// operator script for kuru on monad testnet. kuru's official testnet MON-USDC market quotes kuru's own
// USDC, which nobody on the team holds, and it has no bids. so lane L1 deploys a MON / circle-USDC market
// through kuru's testnet router, and seeds it with limit orders at the mainnet price.
//
//   bun run packages/venues/src/kuru/seed.ts status [market]
//   bun run packages/venues/src/kuru/seed.ts deploy            sends 1 tx from the account
//   bun run packages/venues/src/kuru/seed.ts seed <market> [bidUsdc=3] [askMon=0.5] [levels=4] [stepBps=20]
//
// KURU_ACCOUNT picks the swarm account (default 1, lane L1's). prints addresses and hashes, never a key
import { createWalletClient, encodeFunctionData, formatUnits, http, parseEther, parseEventLogs, parseUnits, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { monadTestnet } from "@spidereum/core";
import { deriveSwarmAccount } from "../../../swarm/src/addresses.ts";
import { erc20Abi, marginAccountAbi, orderBookAbi, routerAbi } from "./abi.ts";
import { KURU, clientFor, readMarketParams, type KuruMarketParams } from "./index.ts";

const T = KURU.testnet;
const testnet = clientFor("testnet");
const mainnet = clientFor("mainnet");

export const MARKET_SETTINGS = {
  /** 1 = NATIVE_IN_BASE: MON is the base, native */
  type: 1,
  base: zeroAddress,
  quote: T.circleUsdc as Address,
  // the same precisions as kuru's mainnet MON-USDC market
  sizePrecision: 10n ** 10n,
  pricePrecision: 10n ** 8n,
  tickSize: 100,
  /** 0.001 MON, so small slices fit */
  minSize: 10n ** 7n,
  maxSize: 10n ** 18n,
  /** mainnet's MON-USDC charges 0 */
  takerFeeBps: 0n,
  makerFeeBps: 0n,
  /** the official testnet market uses 100 */
  kuruAmmSpread: 100n,
} as const;

function wallet() {
  const mnemonic = process.env.BURNER_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("BURNER_MNEMONIC is empty");
  const index = Number(process.env.KURU_ACCOUNT ?? 1);
  const account = deriveSwarmAccount(mnemonic, 10143, index);
  return { index, account, client: createWalletClient({ account, chain: monadTestnet, transport: http(process.env.MONAD_TESTNET_RPC_URL) }) };
}

const link = (hash: Hex) => `${T.explorer}/tx/${hash}`;

async function send(label: string, w: ReturnType<typeof wallet>, tx: { to: Address; data: Hex; value?: bigint }) {
  // monad charges the gas limit, but a native-value call can run out of gas at the exact estimate
  // (seen on the margin deposit, 13 oct). pad the estimate by 30%
  const estimate = await testnet.estimateGas({ account: w.account, ...tx, value: tx.value ?? 0n });
  const hash = await w.client.sendTransaction({ ...tx, value: tx.value ?? 0n, gas: (estimate * 13n) / 10n });
  const receipt = await testnet.waitForTransactionReceipt({ hash });
  console.log(`${receipt.status === "success" ? "ok " : "REVERTED"} ${label}  ${link(hash)}`);
  if (receipt.status !== "success") throw new Error(`${label} reverted`);
  return receipt;
}

/** USDC per MON on mainnet, as the mid of kuru's best bid and ask (both 1e18-scaled) */
export async function mainnetMid(): Promise<number> {
  const [bid, ask] = await mainnet.readContract({ address: KURU.mainnet.monUsdc, abi: orderBookAbi, functionName: "bestBidAsk" });
  return (Number(bid) + Number(ask)) / 2 / 1e18;
}

async function status(market?: Address) {
  const w = wallet();
  const me = w.account.address;
  const [mon, usdc] = await Promise.all([
    testnet.getBalance({ address: me }),
    testnet.readContract({ address: T.circleUsdc, abi: erc20Abi, functionName: "balanceOf", args: [me] }),
  ]);
  console.log(`account ${w.index} ${me}: ${formatUnits(mon, 18)} MON, ${formatUnits(usdc, 6)} circle USDC`);
  console.log(`mainnet kuru MON-USDC mid: ${(await mainnetMid()).toFixed(6)} USDC per MON`);
  if (!market) return;
  const m = await readMarketParams(testnet, market);
  const [bid, ask] = await testnet.readContract({ address: market, abi: orderBookAbi, functionName: "bestBidAsk" });
  const [mMon, mUsdc] = await Promise.all([
    testnet.readContract({ address: T.marginAccount, abi: marginAccountAbi, functionName: "getBalance", args: [me, zeroAddress] }),
    testnet.readContract({ address: T.marginAccount, abi: marginAccountAbi, functionName: "getBalance", args: [me, m.quote] }),
  ]);
  console.log(`market ${market}: base ${m.base} quote ${m.quote} taker fee ${m.takerFeeBps} bps`);
  console.log(`  best bid ${bid >= 2n ** 255n ? "none" : Number(bid) / 1e18}  best ask ${ask === 0n ? "none" : Number(ask) / 1e18}`);
  console.log(`  margin account of ${me}: ${formatUnits(mMon, 18)} MON, ${formatUnits(mUsdc, 6)} USDC`);
}

async function deploy(): Promise<Address> {
  const w = wallet();
  const s = MARKET_SETTINGS;
  const { request, result } = await testnet.simulateContract({
    account: w.account,
    address: T.router,
    abi: routerAbi,
    functionName: "deployProxy",
    args: [s.type, s.base, s.quote, s.sizePrecision, Number(s.pricePrecision), s.tickSize, s.minSize, s.maxSize, s.takerFeeBps, s.makerFeeBps, s.kuruAmmSpread],
  });
  const hash = await w.client.writeContract(request);
  const receipt = await testnet.waitForTransactionReceipt({ hash });
  console.log(`${receipt.status === "success" ? "ok " : "REVERTED"} deploy MON / circle-USDC market ${result}  ${link(hash)}`);
  const [registered] = parseEventLogs({ abi: routerAbi, logs: receipt.logs, eventName: "MarketRegistered" });
  if (registered) console.log(`  market ${registered.args.market} vault ${registered.args.vaultAddress}`);
  return result;
}

/** limit bids below the mainnet mid and asks above it, from the account's margin balance */
async function seed(market: Address, bidUsdc: number, askMon: number, levels: number, stepBps: number) {
  const w = wallet();
  const me = w.account.address;
  const m: KuruMarketParams = await readMarketParams(testnet, market);
  const mid = await mainnetMid();
  console.log(`seeding ${market} around ${mid.toFixed(6)} USDC per MON: ${bidUsdc} USDC of bids, ${askMon} MON of asks, ${levels} levels, ${stepBps} bps apart`);

  const tick = m.tickSize;
  const toPrice = (p: number) => {
    const units = BigInt(Math.round(p * Number(m.pricePrecision)));
    return Number((units / tick) * tick);
  };

  if (bidUsdc > 0) {
    const amount = parseUnits(String(bidUsdc), 6);
    await send("approve USDC to the margin account", w, {
      to: m.quote,
      data: encode(erc20Abi, "approve", [T.marginAccount, amount]),
    });
    await send(`deposit ${bidUsdc} USDC to the margin account`, w, {
      to: T.marginAccount,
      data: encode(marginAccountAbi, "deposit", [me, m.quote, amount]),
    });
    for (let i = 1; i <= levels; i++) {
      const price = toPrice(mid * (1 - (i * stepBps) / 10_000));
      // the quote this level locks, in USDC: size * price. size in MON = (bidUsdc / levels) / price
      const usdcHere = (bidUsdc / levels) * 0.999;
      const sizeMon = usdcHere / (price / Number(m.pricePrecision));
      const size = BigInt(Math.floor(sizeMon * Number(m.sizePrecision)));
      await send(`bid ${sizeMon.toFixed(4)} MON at ${price / Number(m.pricePrecision)}`, w, {
        to: market,
        data: encode(orderBookAbi, "addBuyOrder", [price, size, true]),
      });
    }
  }

  if (askMon > 0) {
    const amount = parseEther(String(askMon));
    await send(`deposit ${askMon} MON to the margin account`, w, {
      to: T.marginAccount,
      data: encode(marginAccountAbi, "deposit", [me, zeroAddress, amount]),
      value: amount,
    });
    for (let i = 1; i <= levels; i++) {
      const price = toPrice(mid * (1 + (i * stepBps) / 10_000));
      const sizeMon = (askMon / levels) * 0.999;
      const size = BigInt(Math.floor(sizeMon * Number(m.sizePrecision)));
      await send(`ask ${sizeMon.toFixed(4)} MON at ${price / Number(m.pricePrecision)}`, w, {
        to: market,
        data: encode(orderBookAbi, "addSellOrder", [price, size, true]),
      });
    }
  }
}

function encode(abi: Abi, functionName: string, args: readonly unknown[]): Hex {
  return encodeFunctionData({ abi, functionName, args } as never);
}

if (import.meta.main) {
  const [cmd, a1, a2, a3, a4, a5] = process.argv.slice(2);
  if (cmd === "status") await status(a1 as Address | undefined);
  else if (cmd === "deploy") await deploy();
  else if (cmd === "seed") {
    if (!a1) throw new Error("seed needs the market address");
    await seed(a1 as Address, Number(a2 ?? 3), Number(a3 ?? 0.5), Number(a4 ?? 4), Number(a5 ?? 20));
  } else console.log("usage: seed.ts status [market] | deploy | seed <market> [bidUsdc] [askMon] [levels] [stepBps]");
}
