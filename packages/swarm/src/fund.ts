// moves gas and tokens from one swarm account to others. every such transfer links the two accounts,
// so each one counts as a direct transfer, and the ledger keeps it for the correlation score
import { encodeFunctionData, erc20Abi } from "viem";
import type { Address, PublicClient } from "viem";
import type { TxRequest } from "@spidereum/core";
import { deriveSwarmAccount } from "./addresses.ts";
import { isNative, mnemonicFromEnv, NATIVE, publicClient, swarmChain } from "./chains.ts";
import { sendTxs } from "./send.ts";
import type { SendOptions, SentTx } from "./send.ts";
import type { SwarmTransfer } from "./types.ts";

export interface FundTransfer {
  /** receiving swarm account index, on the same chain */
  to: number;
  /** atomic units */
  amount: bigint;
  /** an erc-20 address, or "native" for gas. default "native" */
  token?: Address | "native";
}

export interface FundOptions extends SendOptions {
  /** sending swarm account index */
  from: number;
  transfers: FundTransfer[];
  /** send only what brings the receiver up to `amount`. skip receivers that already hold it */
  topUp?: boolean;
}

export interface FundResult {
  /** true when every transfer that needed to run landed */
  ok: boolean;
  chainId: number;
  from: number;
  /** the transfers that landed. each one is a direct transfer */
  transfers: SwarmTransfer[];
  /** the receivers that already held enough, with `topUp` */
  skipped: FundTransfer[];
  /** count of direct transfers this call made */
  directTransfers: number;
  txs: SentTx[];
  error?: string;
}

const ledger: SwarmTransfer[] = [];

/** every direct transfer that `fundAccounts` made in this process, oldest first */
export function directTransferLog(): readonly SwarmTransfer[] {
  return ledger;
}

export function clearDirectTransferLog(): void {
  ledger.length = 0;
}

/** adds a transfer made elsewhere, for example a gas top-up the lead sent by hand */
export function recordDirectTransfer(t: SwarmTransfer): void {
  ledger.push(t);
}

/** the transaction for one transfer to `to` */
export function fundTx(to: Address, amount: bigint, token?: Address | "native"): TxRequest {
  if (isNative(token)) return { to, data: "0x", value: amount };
  return {
    to: token as Address,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
    value: 0n,
  };
}

async function balanceOf(client: PublicClient, owner: Address, token?: Address | "native"): Promise<bigint> {
  if (isNative(token)) return client.getBalance({ address: owner });
  return client.readContract({ address: token as Address, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

async function symbolOf(client: PublicClient, chainId: number, token?: Address | "native"): Promise<string> {
  const c = swarmChain(chainId);
  if (isNative(token)) return c.native.symbol;
  if ((token as Address).toLowerCase() === c.usdc.address.toLowerCase()) return c.usdc.symbol;
  return client.readContract({ address: token as Address, abi: erc20Abi, functionName: "symbol" }).catch(() => "?");
}

/**
 * sends each transfer from account `from`, in order, and waits for each receipt.
 * returns the transfers that landed. each one counts as a direct transfer
 */
export async function fundAccounts(opts: FundOptions): Promise<FundResult> {
  for (const t of opts.transfers) {
    if (t.to === opts.from) throw new Error(`account ${opts.from} cannot fund itself`);
    if (t.amount <= 0n) throw new Error(`transfer to account ${t.to} has no amount`);
  }
  const chainId = opts.chainId ?? 10143;
  const mnemonic = mnemonicFromEnv(opts.mnemonic);
  const client = opts.client ?? publicClient(chainId, opts.rpcUrl);
  const result: FundResult = { ok: true, chainId, from: opts.from, transfers: [], skipped: [], directTransfers: 0, txs: [] };

  for (const t of opts.transfers) {
    const to = deriveSwarmAccount(mnemonic, chainId, t.to).address;
    let amount = t.amount;
    if (opts.topUp) {
      const held = await balanceOf(client, to, t.token);
      if (held >= t.amount) {
        result.skipped.push(t);
        continue;
      }
      amount = t.amount - held;
    }
    const sent = await sendTxs(opts.from, [fundTx(to, amount, t.token)], { ...opts, chainId, mnemonic, client });
    result.txs.push(...sent.txs);
    const tx = sent.txs[0];
    if (!sent.ok || !tx) {
      result.ok = false;
      result.error = `transfer to account ${t.to}: ${sent.error}`;
      return result;
    }
    const transfer: SwarmTransfer = {
      from: { chainId, account: opts.from },
      to: { chainId, account: t.to },
      kind: "direct",
      chainId,
      token: isNative(t.token) ? NATIVE : (t.token as Address),
      symbol: await symbolOf(client, chainId, t.token),
      amount,
      hash: tx.hash,
      url: tx.url,
      blockNumber: tx.blockNumber,
      at: Date.now(),
    };
    result.transfers.push(transfer);
    result.directTransfers++;
    ledger.push(transfer);
  }
  return result;
}
