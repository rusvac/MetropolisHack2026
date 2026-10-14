// networks, venues, explorers, and number formats. every number on a screen names its network
import type { VenueId } from "@spidereum/core";

export interface Network {
  id: number;
  name: string;
  short: string;
  /** "execute" networks hold balances and run transactions. "quote" networks are read-only */
  role: "execute" | "quote";
  explorer: string;
  color: string;
}

export const NETWORKS: Record<number, Network> = {
  10143: { id: 10143, name: "Monad testnet", short: "monad testnet", role: "execute", explorer: "https://testnet.monadexplorer.com", color: "#8b7bff" },
  84532: { id: 84532, name: "Base Sepolia", short: "base sepolia", role: "execute", explorer: "https://sepolia.basescan.org", color: "#3b82f6" },
  143: { id: 143, name: "Monad mainnet", short: "monad mainnet", role: "quote", explorer: "https://monadscan.com", color: "#b4a8ff" },
  8453: { id: 8453, name: "Base mainnet", short: "base mainnet", role: "quote", explorer: "https://basescan.org", color: "#60a5fa" },
};

export function network(chainId: number): Network {
  return (
    NETWORKS[chainId] ?? {
      id: chainId,
      name: `chain ${chainId}`,
      short: `chain ${chainId}`,
      role: "execute",
      explorer: "",
      color: "#9ca3af",
    }
  );
}

/** chain names that BridgeQuote.fromChain may carry */
export function chainIdFromName(name: string): number | undefined {
  const n = name.toLowerCase().replace(/[\s_-]/g, "");
  if (n === "base" || n === "8453") return 8453;
  if (n === "basesepolia" || n === "84532") return 84532;
  if (n === "monad" || n === "143") return 143;
  if (n === "monadtestnet" || n === "10143") return 10143;
  return undefined;
}

export function txUrl(chainId: number, hash: string): string | undefined {
  const net = NETWORKS[chainId];
  return net ? `${net.explorer}/tx/${hash}` : undefined;
}

export function addressUrl(chainId: number, address: string): string | undefined {
  const net = NETWORKS[chainId];
  return net ? `${net.explorer}/address/${address}` : undefined;
}

export interface VenueInfo {
  id: VenueId;
  name: string;
  /** what the venue does in the plan */
  kind: "spot" | "perp" | "bridge" | "transfer";
  color: string;
}

const KNOWN: Record<string, Omit<VenueInfo, "id">> = {
  kuru: { name: "Kuru", kind: "spot", color: "#34d3b4" },
  "uniswap-v4": { name: "Uniswap v4", kind: "spot", color: "#ff5fb0" },
  perpl: { name: "Perpl", kind: "perp", color: "#fbbf24" },
  aurora: { name: "Aurora Intents", kind: "bridge", color: "#a3e635" },
};

export function venue(id: VenueId): VenueInfo {
  const known = KNOWN[id];
  if (known) return { id, ...known };
  if (id === "mock-gas") return { id, name: "gas top-up", kind: "transfer", color: "#f87171" };
  if (id === "test-pool") return { id, name: "test pool", kind: "spot", color: "#c4a5ff" };
  if (id === "uniswap-v4-testnet") return { id, name: "Uniswap v4 (testnet)", kind: "spot", color: "#ff9fd0" };
  const rest = id.replace(/^mock-/, "");
  const base = KNOWN[rest];
  // a mock that stands in for a live venue keeps the venue's color, and says mock
  if (base) return { id, ...base, name: `${base.name} mock` };
  return { id, name: `test pool ${rest}`.trim(), kind: "spot", color: "#c4a5ff" };
}

/** the venue's place in the fan-out: bridges first, then spot venues, then the perp */
export function venueOrder(id: VenueId): number {
  const v = venue(id);
  const rest = id.replace(/^mock-/, "");
  if (v.kind === "bridge") return 0;
  if (v.kind === "perp") return 9;
  return rest.startsWith("kuru") ? 1 : rest.startsWith("uniswap") ? 2 : 3;
}

/** account label: "m3" on monad, "b1" on base */
export function accountLabel(chainId: number, index: number): string {
  const prefix = chainId === 84532 || chainId === 8453 ? "b" : "m";
  return `${prefix}${index}`;
}

export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** atomic units to a js number. fine for display, not for math that moves funds */
export function toUnits(amount: bigint, decimals: number): number {
  if (decimals <= 0) return Number(amount);
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const v = Number(whole) + Number(frac) / Number(base);
  return neg ? -v : v;
}

/** a js number to atomic units */
export function fromUnits(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  const fixed = value.toFixed(Math.min(decimals, 12));
  const [w, f = ""] = fixed.split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(w + frac);
}

export function usd(v: number, opts: { cents?: boolean; sign?: boolean } = {}): string {
  const abs = Math.abs(v);
  const cents = opts.cents ?? abs < 1000;
  const s = abs.toLocaleString("en-US", {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? (abs > 0 && abs < 1 ? 4 : 2) : 0,
  });
  const sign = v < 0 ? "−" : opts.sign ? "+" : "";
  return `${sign}$${s}`;
}

export function usdCompact(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `$${(v / 1000).toFixed(1)}k`;
  return usd(v);
}

export function amount(v: number, maxFrac = 2): string {
  const abs = Math.abs(v);
  const frac = abs >= 1000 ? 0 : abs >= 1 ? maxFrac : 4;
  return v.toLocaleString("en-US", { maximumFractionDigits: frac, minimumFractionDigits: 0 });
}

export function pct(v: number, frac = 1): string {
  return `${(v * 100).toFixed(frac)}%`;
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export function clock(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0").slice(0, 1);
  return `${hh}:${mm}:${ss}.${ms}`;
}
