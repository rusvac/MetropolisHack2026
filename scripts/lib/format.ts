// output helpers in the style of spidereum's example-swarm.ts, and bigint-safe json

export type Out = (line: string) => void;

export const SIM = "simulated";

export function section(out: Out, title: string, subtitle: string): void {
  out("");
  out(`[${"═".repeat(70)}]`);
  out(`[${title}]`);
  out(`[${"═".repeat(70)}]`);
  out(subtitle);
}

export function usd(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** a display number from atomic units. display only, never for math */
export function toNumber(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

export function units(amount: bigint, decimals: number, maxFrac = 2): string {
  return toNumber(amount, decimals).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: maxFrac });
}

export function pct(share: number, digits = 1): string {
  return `${(share * 100).toFixed(digits)}%`;
}

export function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

export function seconds(ms: number): string {
  return `+${(ms / 1000).toFixed(1)}s`;
}

/** a box line padded to the inner width */
export function boxLine(text: string, width = 68): string {
  const visible = [...text].length;
  return `  │ ${text}${" ".repeat(Math.max(0, width - 1 - visible))}│`;
}

export function boxTop(width = 68): string {
  return `  ┌${"─".repeat(width)}┐`;
}

export function boxMid(width = 68): string {
  return `  ├${"─".repeat(width)}┤`;
}

export function boxBottom(width = 68): string {
  return `  └${"─".repeat(width)}┘`;
}

/** JSON.stringify that writes bigints as decimal strings */
export function toJson(value: unknown, space?: number): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), space);
}

/** a seeded rng (mulberry32), so a plan and its delays repeat from run to run */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}
