// sends a slice's transactions from its swarm account, in order, one receipt at a time.
//
// nonces: one lock per account and chain, so two slices from one account never race. the next nonce is
// the larger of the rpc's pending count and the last nonce this process sent, plus one.
//
// monad's reserve balance rule: an account below 10 MON can send a transaction that moves value (MON out)
// only when the account sent nothing in the last 3 blocks. otherwise the transaction lands and reverts.
// before a value transaction on monad, `sendTxs` waits until 3 blocks pass after the account's last receipt.
// https://docs.monad.xyz/developer-essentials/reserve-balance
import { walletActions } from "viem";
import type { Address, HDAccount, Hex, PublicClient } from "viem";
import type { Slice, TxRequest } from "@spidereum/core";
import { deriveSwarmAccount } from "./addresses.ts";
import { mnemonicFromEnv, publicClient, swarmChain, txUrl } from "./chains.ts";

/** monad's reserve window, in blocks */
export const MONAD_RESERVE_BLOCKS = 3n;

export interface SentTx {
  /** position in the slice */
  index: number;
  hash: Hex;
  url: string;
  nonce: number;
  to: Address;
  value: bigint;
  /** "pending" when sent, then "success" or "reverted" at the receipt */
  status: "pending" | "success" | "reverted";
  blockNumber?: bigint;
  gasUsed?: bigint;
  /** gas limit sent. monad charges the full limit */
  gas: bigint;
}

export interface SliceSendResult {
  /** true when every transaction landed with status success */
  ok: boolean;
  chainId: number;
  account: number;
  address: Address;
  txs: SentTx[];
  /** the first failure. the transactions after it were not sent */
  error?: string;
}

export interface SendOptions {
  /** default 10143, monad testnet */
  chainId?: number;
  mnemonic?: string;
  rpcUrl?: string;
  /** tests inject a client here */
  client?: PublicClient;
  /** called when a transaction is sent, and again at its receipt */
  onTx?: (tx: SentTx) => void;
  /** default 60 s */
  receiptTimeoutMs?: number;
  /**
   * gas over the estimate, in basis points. default 3000: every transaction sends 1.3 times the estimate, because a
   * kuru margin deposit ran out of gas at the exact estimate on monad testnet. monad charges the full limit
   */
  gasBufferBps?: number;
}

interface AccountState {
  next?: number;
  lastBlock?: bigint;
  lock: Promise<void>;
}

const states = new Map<string, AccountState>();

function stateFor(key: string): AccountState {
  let s = states.get(key);
  if (!s) {
    s = { lock: Promise.resolve() };
    states.set(key, s);
  }
  return s;
}

/** runs `fn` while it holds the lock for `key`. callers on the same key run one after another, in call order */
export async function withAccountLock<T>(key: string, fn: (s: AccountState) => Promise<T>): Promise<T> {
  const s = stateFor(key);
  const prev = s.lock;
  let release!: () => void;
  s.lock = new Promise<void>((r) => (release = r));
  await prev;
  try {
    return await fn(s);
  } finally {
    release();
  }
}

/** the next nonce: the larger of the rpc's pending count and the local count */
export function pickNonce(chainPending: number, localNext: number | undefined): number {
  return Math.max(chainPending, localNext ?? 0);
}

function shortError(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string };
  return (err.shortMessage ?? err.message ?? String(e)).split("\n")[0]!;
}

function isNonceError(msg: string): boolean {
  return /nonce too low|nonce is too low|already known|replacement transaction underpriced|nonce has already been used/i.test(msg);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitForBlock(client: PublicClient, target: bigint, pollMs: number, maxMs = 30_000): Promise<void> {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    const head = await client.getBlockNumber({ cacheTime: 0 }).catch(() => -1n);
    if (head >= target) return;
    await sleep(pollMs);
  }
}

/**
 * waits until `MONAD_RESERVE_BLOCKS` blocks pass after the account's last transaction. with no local record,
 * it compares the account's nonce now and 3 blocks ago, to catch a transaction another process sent.
 * if the rpc fails, it waits 3 blocks from the head
 */
async function waitOutReserveWindow(client: PublicClient, address: Address, s: AccountState, pollMs: number): Promise<void> {
  let last = s.lastBlock;
  if (last === undefined) {
    try {
      const head = await client.getBlockNumber({ cacheTime: 0 });
      const back = head > MONAD_RESERVE_BLOCKS ? head - MONAD_RESERVE_BLOCKS : 0n;
      const [then, now] = await Promise.all([
        client.getTransactionCount({ address, blockNumber: back }),
        client.getTransactionCount({ address, blockNumber: head }),
      ]);
      if (then === now) return;
      last = head;
    } catch {
      last = await client.getBlockNumber({ cacheTime: 0 }).catch(() => 0n);
    }
  }
  await waitForBlock(client, last + MONAD_RESERVE_BLOCKS, pollMs);
}

/** sends `txs` from swarm account `index` on `chainId`, in order, and waits for each receipt */
export async function sendTxs(index: number, txs: TxRequest[], opts: SendOptions = {}): Promise<SliceSendResult> {
  const chainId = opts.chainId ?? 10143;
  const c = swarmChain(chainId);
  const signer: HDAccount = deriveSwarmAccount(mnemonicFromEnv(opts.mnemonic), chainId, index);
  const client = (opts.client ?? publicClient(chainId, opts.rpcUrl)).extend(walletActions);
  const timeout = opts.receiptTimeoutMs ?? 60_000;
  const bufferBps = BigInt(opts.gasBufferBps ?? 3000);
  const result: SliceSendResult = { ok: true, chainId, account: index, address: signer.address, txs: [] };
  const notify = (tx: SentTx) => {
    try {
      opts.onTx?.({ ...tx });
    } catch {
      // a failing listener never stops a slice
    }
  };

  return withAccountLock(`${chainId}:${signer.address}`, async (s) => {
    for (const [i, tx] of txs.entries()) {
      // the reserve rule: a value transaction waits out the window after the account's last transaction
      if (c.monadReserve && tx.value > 0n) await waitOutReserveWindow(client, signer.address, s, c.pollingMs / 2);

      let sent: SentTx | undefined;
      let lastError = "";
      for (let attempt = 0; attempt < 2 && !sent; attempt++) {
        try {
          const nonce = pickNonce(
            await client.getTransactionCount({ address: signer.address, blockTag: "pending" }),
            s.next,
          );
          const estimate = await client.estimateGas({ account: signer.address, to: tx.to, data: tx.data, value: tx.value });
          const gas = (estimate * (10_000n + bufferBps)) / 10_000n;
          const hash = await client.sendTransaction({
            account: signer,
            chain: c.chain,
            to: tx.to,
            data: tx.data,
            value: tx.value,
            nonce,
            gas,
          });
          s.next = nonce + 1;
          sent = { index: i, hash, url: txUrl(chainId, hash), nonce, to: tx.to, value: tx.value, status: "pending", gas };
        } catch (e) {
          lastError = shortError(e);
          if (!isNonceError(lastError)) break;
          s.next = undefined; // resync from the rpc, then try once more
        }
      }
      if (!sent) {
        result.ok = false;
        result.error = `tx ${i} not sent: ${lastError}`;
        return result;
      }
      result.txs.push(sent);
      notify(sent);

      try {
        const receipt = await client.waitForTransactionReceipt({ hash: sent.hash, timeout, pollingInterval: c.pollingMs });
        sent.status = receipt.status;
        sent.blockNumber = receipt.blockNumber;
        sent.gasUsed = receipt.gasUsed;
        s.lastBlock = receipt.blockNumber;
      } catch (e) {
        s.next = undefined; // the transaction may never land. take the nonce from the rpc next time
        result.ok = false;
        result.error = `tx ${i} has no receipt: ${shortError(e)}`;
        return result;
      }
      notify(sent);
      if (sent.status === "reverted") {
        result.ok = false;
        const hint = c.monadReserve && tx.value > 0n ? " (a value transfer on monad: check the reserve balance rule)" : "";
        result.error = `tx ${i} reverted${hint}`;
        return result;
      }
    }
    return result;
  });
}

/** sends one slice's transactions (approvals first, as the venue built them) from the slice's account */
export function sendSlice(
  slice: Pick<Slice, "account">,
  txs: TxRequest[],
  opts: SendOptions = {},
): Promise<SliceSendResult> {
  return sendTxs(slice.account, txs, opts);
}
