// lane L4, stretch: a live testnet bridge, because aurora has no testnet.
// circle cctp v2 burns usdc on base sepolia and mints it on monad testnet. circle's forwarding service sends
// the mint on monad, so no swarm account needs MON for that step and no swarm account sends on monad.
//
// sources, read 13 oct 2026:
// - domains and testnet support: https://developers.circle.com/cctp/concepts/supported-chains-and-domains.md
//   (base = 6, monad = 15, "if a mainnet is listed, its official testnet is also supported", forwarding on monad)
// - addresses: https://developers.circle.com/cctp/references/contract-addresses.md (same on both testnets)
// - flow: https://developers.circle.com/cctp/howtos/transfer-usdc-with-forwarding-service.md
// - checked onchain: MessageTransmitterV2.localDomain() is 6 on base sepolia and 15 on monad testnet
//
// run `bun run packages/venues/src/aurora/cctp.ts [usdc] [monad account]` for a read-only dry run.
// it sends only with --send, from base sepolia swarm account 0. fast transfer unless --standard
import {
  type Account,
  type Address,
  type Hash,
  type Hex,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  http,
  pad,
  parseAbi,
  parseUnits,
} from "viem";
import { baseSepolia, monadTestnet } from "viem/chains";
import type { BridgeQuote, Token, TxRequest, VenueId } from "@spidereum/core";

export const CCTP_TESTNET = {
  iris: "https://iris-api-sandbox.circle.com",
  tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  messageTransmitterV2: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  tokenMinterV2: "0xb43db544E2c27092c107639Ad201b3dEfAbcF192",
  domain: { baseSepolia: 6, monadTestnet: 15 },
  usdc: {
    baseSepolia: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    monadTestnet: "0x534b2f3a21130d7a60830c2df862319e593943a3",
  },
} as const;

/** the forwarding service hook: "cctp-forward" padded to 24 bytes, version 0, extra length 0 */
export const FORWARDING_HOOK_DATA: Hex = "0x636374702d666f72776172640000000000000000000000000000000000000000";

/** finality thresholds: 1000 = fast transfer, 2000 = standard */
export const FINALITY = { fast: 1000, standard: 2000 } as const;

/** circle's usdc on monad testnet, as a core `Token` */
export const MONAD_TESTNET_USDC: Token = {
  chainId: 10143,
  symbol: "USDC",
  address: CCTP_TESTNET.usdc.monadTestnet,
  decimals: 6,
};

// core's VenueId has no "cctp" yet. the lead adds it, then this cast goes away
export const CCTP_VENUE_ID = "cctp";

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);

const tokenMessengerAbi = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
]);

const messageTransmitterAbi = parseAbi([
  "function receiveMessage(bytes message, bytes attestation) returns (bool)",
  "function localDomain() view returns (uint32)",
]);

export interface CctpFee {
  finalityThreshold: number;
  /** protocol fee, in basis points of the burned amount */
  minimumFee: number;
  /** forwarding fee in atomic usdc. present when the query asks for forwarding */
  forwardFee?: { low: number; med: number; high: number };
}

/** circle's live fee table for a route. GET /v2/burn/USDC/fees/{src}/{dst} */
export async function getCctpFees(
  src = CCTP_TESTNET.domain.baseSepolia,
  dst = CCTP_TESTNET.domain.monadTestnet,
  opts: { forward?: boolean; fetch?: typeof fetch; iris?: string } = {},
): Promise<CctpFee[]> {
  const iris = opts.iris ?? CCTP_TESTNET.iris;
  const forward = opts.forward ?? true;
  const res = await (opts.fetch ?? fetch)(`${iris}/v2/burn/USDC/fees/${src}/${dst}${forward ? "?forward=true" : ""}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`cctp fees: HTTP ${res.status}`);
  return (await res.json()) as CctpFee[];
}

export interface CctpTransferPlan {
  /** usdc burned on base sepolia, atomic */
  burnAmount: bigint;
  /** the most the recipient gives up in fees, atomic. circle charges at most this */
  maxFee: bigint;
  protocolFee: bigint;
  forwardFee: bigint;
  /** what lands on monad if circle charges the full maxFee */
  minAmountOut: bigint;
  minFinalityThreshold: number;
  forward: boolean;
}

/**
 * fees for one burn of `burnAmount`. the recipient gets burnAmount minus the fee circle charges, and that fee is
 * at most maxFee. forwarding uses the "med" fee, which circle recommends
 */
export function planCctpTransfer(
  burnAmount: bigint,
  fees: CctpFee[],
  opts: { fast?: boolean; forward?: boolean } = {},
): CctpTransferPlan {
  // fast by default: about 8 s on base instead of 15 to 19 min, for 1.3 bps
  const fast = opts.fast ?? true;
  const forward = opts.forward ?? true;
  const threshold = fast ? FINALITY.fast : FINALITY.standard;
  const row = fees.find((f) => f.finalityThreshold === threshold);
  if (!row) throw new Error(`cctp: no fee row for finality ${threshold}`);
  if (forward && !row.forwardFee) throw new Error("cctp: the fee table has no forwarding fee. query with forward=true");
  // minimumFee is in bps and can be fractional (1.3), so scale by 100 first, as circle's guide does
  const protocolFee = (burnAmount * BigInt(Math.round(row.minimumFee * 100)) + 999_999n) / 1_000_000n;
  const forwardFee = forward ? BigInt(row.forwardFee!.med) : 0n;
  const maxFee = protocolFee + forwardFee;
  if (maxFee >= burnAmount) throw new Error("cctp: the amount does not cover the fees");
  return {
    burnAmount,
    maxFee,
    protocolFee,
    forwardFee,
    minAmountOut: burnAmount - maxFee,
    minFinalityThreshold: threshold,
    forward,
  };
}

/** a quote in the shape the screens draw. amounts are atomic usdc. the fees come from circle's live api */
export async function quoteCctpTestnet(
  burnAmount: bigint,
  opts: { fast?: boolean; fetch?: typeof fetch } = {},
): Promise<BridgeQuote & { plan: CctpTransferPlan }> {
  const fees = await getCctpFees(CCTP_TESTNET.domain.baseSepolia, CCTP_TESTNET.domain.monadTestnet, {
    forward: true,
    fetch: opts.fetch,
  });
  const plan = planCctpTransfer(burnAmount, fees, { fast: opts.fast, forward: true });
  return {
    venue: CCTP_VENUE_ID,
    fromChain: "base-sepolia",
    fromToken: CCTP_TESTNET.usdc.baseSepolia,
    amountIn: burnAmount,
    amountOut: plan.minAmountOut,
    to: MONAD_TESTNET_USDC,
    // circle's finality page: fast attestation on base takes about 8 s, standard about 15 to 19 min.
    // the forwarded mint on monad adds a few seconds
    etaSeconds: opts.fast === false ? 19 * 60 : 20,
    simulated: false,
    at: Date.now(),
    plan,
  };
}

/** approve, then burn with the forwarding hook. pure: no network. the account sends both on base sepolia */
export function buildCctpBurnTxs(plan: CctpTransferPlan, mintRecipient: Address): TxRequest[] {
  const recipient32 = pad(mintRecipient, { size: 32 });
  const anyCaller = pad("0x", { size: 32 });
  const burn = plan.forward
    ? encodeFunctionData({
        abi: tokenMessengerAbi,
        functionName: "depositForBurnWithHook",
        args: [
          plan.burnAmount,
          CCTP_TESTNET.domain.monadTestnet,
          recipient32,
          CCTP_TESTNET.usdc.baseSepolia,
          anyCaller,
          plan.maxFee,
          plan.minFinalityThreshold,
          FORWARDING_HOOK_DATA,
        ],
      })
    : encodeFunctionData({
        abi: tokenMessengerAbi,
        functionName: "depositForBurn",
        args: [
          plan.burnAmount,
          CCTP_TESTNET.domain.monadTestnet,
          recipient32,
          CCTP_TESTNET.usdc.baseSepolia,
          anyCaller,
          plan.maxFee,
          plan.minFinalityThreshold,
        ],
      });
  return [
    {
      to: CCTP_TESTNET.usdc.baseSepolia,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [CCTP_TESTNET.tokenMessengerV2, plan.burnAmount],
      }),
      value: 0n,
    },
    { to: CCTP_TESTNET.tokenMessengerV2, data: burn, value: 0n },
  ];
}

export interface CctpBridgeResult {
  approveHash?: Hash;
  burnHash: Hash;
  plan: CctpTransferPlan;
  mintRecipient: Address;
  explorer: { burn: string };
}

/**
 * the live testnet bridge: burn on base sepolia from `account`, mint to `mintRecipient` on monad testnet.
 * waits for the burn receipt, not for the mint. call waitForCctpMint next
 */
export async function sendCctpBridge(args: {
  account: Account;
  /** usdc to burn, atomic */
  amount: bigint;
  mintRecipient: Address;
  rpcUrl?: string;
  fast?: boolean;
  fetch?: typeof fetch;
}): Promise<CctpBridgeResult> {
  const transport = http(args.rpcUrl ?? process.env.BASE_SEPOLIA_RPC_URL);
  const pub = createPublicClient({ chain: baseSepolia, transport });
  const wallet = createWalletClient({ chain: baseSepolia, transport, account: args.account });
  const owner = args.account.address;

  const fees = await getCctpFees(CCTP_TESTNET.domain.baseSepolia, CCTP_TESTNET.domain.monadTestnet, {
    forward: true,
    fetch: args.fetch,
  });
  const plan = planCctpTransfer(args.amount, fees, { fast: args.fast, forward: true });

  const balance = await pub.readContract({
    address: CCTP_TESTNET.usdc.baseSepolia,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
  if (balance < plan.burnAmount) {
    throw new Error(`cctp: ${owner} holds ${formatUnits(balance, 6)} USDC on base sepolia, needs ${formatUnits(plan.burnAmount, 6)}`);
  }

  const [approveTx, burnTx] = buildCctpBurnTxs(plan, args.mintRecipient);
  const allowance = await pub.readContract({
    address: CCTP_TESTNET.usdc.baseSepolia,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, CCTP_TESTNET.tokenMessengerV2],
  });
  let approveHash: Hash | undefined;
  if (allowance < plan.burnAmount) {
    approveHash = await wallet.sendTransaction({ to: approveTx!.to, data: approveTx!.data, value: 0n });
    await pub.waitForTransactionReceipt({ hash: approveHash });
  }
  const burnHash = await wallet.sendTransaction({ to: burnTx!.to, data: burnTx!.data, value: 0n });
  const receipt = await pub.waitForTransactionReceipt({ hash: burnHash });
  if (receipt.status !== "success") throw new Error(`cctp: burn reverted, ${burnHash}`);

  return {
    approveHash,
    burnHash,
    plan,
    mintRecipient: args.mintRecipient,
    explorer: { burn: `https://sepolia.basescan.org/tx/${burnHash}` },
  };
}

export interface CctpMessageStatus {
  status: "pending" | "complete" | "forwarded";
  /** the mint on monad testnet, sent by circle's forwarding service */
  forwardTxHash?: Hash;
  message?: Hex;
  attestation?: Hex;
  explorer?: string;
}

/** one look at circle's message api for a burn. GET /v2/messages/{srcDomain}?transactionHash= */
export async function getCctpMessage(
  burnHash: Hash,
  opts: { fetch?: typeof fetch; iris?: string } = {},
): Promise<CctpMessageStatus> {
  const iris = opts.iris ?? CCTP_TESTNET.iris;
  const res = await (opts.fetch ?? fetch)(
    `${iris}/v2/messages/${CCTP_TESTNET.domain.baseSepolia}?transactionHash=${burnHash}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  // 404 means circle has not seen the burn yet
  if (res.status === 404) return { status: "pending" };
  if (!res.ok) throw new Error(`cctp messages: HTTP ${res.status}`);
  const body = (await res.json()) as {
    messages?: { status?: string; message?: Hex; attestation?: Hex | "PENDING"; forwardTxHash?: Hash }[];
  };
  const m = body.messages?.[0];
  if (!m) return { status: "pending" };
  if (m.forwardTxHash) {
    return {
      status: "forwarded",
      forwardTxHash: m.forwardTxHash,
      message: m.message,
      attestation: m.attestation === "PENDING" ? undefined : m.attestation,
      explorer: `https://testnet.monadexplorer.com/tx/${m.forwardTxHash}`,
    };
  }
  if (m.status === "complete" && m.attestation && m.attestation !== "PENDING") {
    return { status: "complete", message: m.message, attestation: m.attestation };
  }
  return { status: "pending" };
}

/** poll every 5 s until circle forwards the mint, or the timeout passes */
export async function waitForCctpMint(
  burnHash: Hash,
  opts: { timeoutMs?: number; intervalMs?: number; fetch?: typeof fetch; onPoll?: (s: CctpMessageStatus) => void } = {},
): Promise<CctpMessageStatus> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  for (;;) {
    const s = await getCctpMessage(burnHash, { fetch: opts.fetch });
    opts.onPoll?.(s);
    if (s.status === "forwarded") return s;
    if (Date.now() > deadline) return s;
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 5_000));
  }
}

/**
 * fallback when the forwarding service does not mint: send receiveMessage on monad testnet yourself.
 * use the recipient's own account. if account 0 sends it, that transaction links account 0 to the recipient
 */
export async function receiveCctpMessage(args: {
  account: Account;
  message: Hex;
  attestation: Hex;
  rpcUrl?: string;
}): Promise<Hash> {
  const transport = http(args.rpcUrl ?? process.env.MONAD_TESTNET_RPC_URL);
  const wallet = createWalletClient({ chain: monadTestnet, transport, account: args.account });
  return wallet.sendTransaction({
    to: CCTP_TESTNET.messageTransmitterV2,
    data: encodeFunctionData({
      abi: messageTransmitterAbi,
      functionName: "receiveMessage",
      args: [args.message, args.attestation],
    }),
    value: 0n,
  });
}

// read-only dry run. prints public addresses and balances, never the seed or a key
if (import.meta.main) {
  const { deriveSwarmAccount } = await import("../../../swarm/src/addresses.ts");
  const mnemonic = process.env.BURNER_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("BURNER_MNEMONIC is empty. put the seed in .env");
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const send = process.argv.includes("--send");
  const fast = !process.argv.includes("--standard");
  const amount = parseUnits(args[0] ?? "1", 6);
  const toIndex = Number(args[1] ?? 10);

  const from = deriveSwarmAccount(mnemonic, 84532, 0);
  const to = deriveSwarmAccount(mnemonic, 10143, toIndex).address;
  const pub = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL) });
  const [eth, usdc, fees] = await Promise.all([
    pub.getBalance({ address: from.address }),
    pub.readContract({ address: CCTP_TESTNET.usdc.baseSepolia, abi: erc20Abi, functionName: "balanceOf", args: [from.address] }),
    getCctpFees(),
  ]);
  const plan = planCctpTransfer(amount, fees, { fast, forward: true });
  console.log("cctp v2, base sepolia (domain 6) -> monad testnet (domain 15), circle forwarding service");
  console.log(`  from   base sepolia account 0  ${from.address}`);
  console.log(`         holds ${formatUnits(eth, 18)} ETH and ${formatUnits(usdc, 6)} USDC`);
  console.log(`  to     monad testnet account ${toIndex}  ${to}`);
  console.log(`  burn   ${formatUnits(plan.burnAmount, 6)} USDC, ${fast ? "fast" : "standard"} transfer`);
  console.log(`  fees   at most ${formatUnits(plan.maxFee, 6)} USDC (protocol ${formatUnits(plan.protocolFee, 6)}, forwarding ${formatUnits(plan.forwardFee, 6)}), live from circle`);
  console.log(`  lands  at least ${formatUnits(plan.minAmountOut, 6)} USDC on monad testnet`);
  if (usdc < plan.burnAmount || eth === 0n) {
    console.log(`  not funded: send base sepolia ETH (0.01 is plenty) and at least ${formatUnits(plan.burnAmount, 6)} USDC to ${from.address}`);
    console.log("  usdc faucet: https://faucet.circle.com (base sepolia)");
  }
  if (send) {
    const r = await sendCctpBridge({ account: from, amount, mintRecipient: to, fast });
    console.log(`  burn   ${r.explorer.burn}`);
    const s = await waitForCctpMint(r.burnHash, { onPoll: (p) => process.stdout.write(p.status === "pending" ? "." : "") });
    console.log(`\n  mint   ${s.status} ${s.explorer ?? ""}`);
  } else {
    console.log("  dry run. add --send to burn")
  }
}
