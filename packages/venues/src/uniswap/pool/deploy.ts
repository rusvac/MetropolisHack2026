// deploys the test pool on monad testnet and seeds it, from swarm account 2 (lane L2's account) only.
//   bun run packages/venues/src/uniswap/pool/deploy.ts --mon 0.8 --usdc 5
// a second run with a deployed address only seeds: it adds the given amounts to the pool.
// prints addresses and explorer links. never prints the seed or a key
import { join } from "node:path";
import { createPublicClient, createWalletClient, erc20Abi, formatEther, formatUnits, http, parseEther, parseUnits } from "viem";
import { monadTestnet } from "viem/chains";
import { deriveSwarmAccount } from "../../../../swarm/src/addresses.ts";
import { testPoolAbi, testPoolBytecode } from "./artifact.ts";
import { TEST_POOL_DEPLOYMENT } from "./deployment.ts";

const ACCOUNT = 2;
const USDC = "0x534b2f3a21130d7a60830c2df862319e593943a3" as const;
const FEE_BPS = 30;
/** MON the account keeps for gas after the seed */
const GAS_FLOOR = parseEther("0.2");
const tx = (h: string) => `https://testnet.monadexplorer.com/tx/${h}`;

/**
 * monad's reserve balance rule: an account below 10 MON can send MON only if it sent nothing in the previous
 * 3 blocks. a transaction with value that breaks the rule reverts. wait out the 3 blocks first
 */
async function waitReserveBlocks(lastBlock: bigint) {
  while ((await pub.getBlockNumber()) <= lastBlock + 3n) await Bun.sleep(400);
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const mnemonic = process.env.BURNER_MNEMONIC?.trim();
if (!mnemonic) throw new Error("BURNER_MNEMONIC is empty");
const account = deriveSwarmAccount(mnemonic, 10143, ACCOUNT);
const transport = http(process.env.MONAD_TESTNET_RPC_URL);
const pub = createPublicClient({ chain: monadTestnet, transport });
const wallet = createWalletClient({ chain: monadTestnet, transport, account });

const seedMon = parseEther(arg("mon", "0.8"));
const seedUsdc = parseUnits(arg("usdc", "5"), 6);

const [mon, usdc] = await Promise.all([
  pub.getBalance({ address: account.address }),
  pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
]);
console.log(`account ${ACCOUNT} ${account.address}: ${formatEther(mon)} MON, ${formatUnits(usdc, 6)} USDC`);
if (mon < seedMon + GAS_FLOOR) throw new Error(`needs ${formatEther(seedMon + GAS_FLOOR)} MON for the seed and gas`);
if (usdc < seedUsdc) throw new Error(`needs ${formatUnits(seedUsdc, 6)} USDC for the seed`);

let lastBlock = 0n;
let pool = TEST_POOL_DEPLOYMENT.address;
if (!pool || process.argv.includes("--redeploy")) {
  const hash = await wallet.deployContract({ abi: testPoolAbi, bytecode: testPoolBytecode, args: [USDC, FEE_BPS] });
  console.log(`deploy  ${tx(hash)}`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deploy failed: ${receipt.status}`);
  pool = receipt.contractAddress;
  lastBlock = receipt.blockNumber;
  console.log(`pool    ${pool}  (gas used ${receipt.gasUsed})`);
  await Bun.write(
    join(import.meta.dir, "deployment.ts"),
    `// written by deploy.ts. the test pool on monad testnet (10143)
import type { Address, Hash } from "viem";

export const TEST_POOL_DEPLOYMENT: { address: Address | null; deployTx: Hash | null; owner: Address | null } = {
  address: "${pool}",
  deployTx: "${hash}",
  owner: "${account.address}",
};
`,
  );
}

if (seedUsdc > 0n) {
  const approve = await wallet.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [pool, seedUsdc] });
  console.log(`approve ${tx(approve)}`);
  const r = await pub.waitForTransactionReceipt({ hash: approve });
  if (r.status !== "success") throw new Error("approve failed");
  lastBlock = r.blockNumber;
}
if (seedMon > 0n && lastBlock > 0n) await waitReserveBlocks(lastBlock);
const add = await wallet.writeContract({
  address: pool,
  abi: testPoolAbi,
  functionName: "addLiquidity",
  args: [seedUsdc],
  value: seedMon,
});
console.log(`seed    ${tx(add)}`);
const r = await pub.waitForTransactionReceipt({ hash: add });
if (r.status !== "success") throw new Error("seed failed");

const [rm, ru] = await pub.readContract({ address: pool, abi: testPoolAbi, functionName: "getReserves" });
console.log(`reserves ${formatEther(rm)} MON, ${formatUnits(ru, 6)} USDC, ${(Number(ru) / 1e6 / (Number(rm) / 1e18)).toFixed(4)} USDC per MON`);
