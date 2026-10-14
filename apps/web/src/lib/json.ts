// the plan carries bigints. json does not. the server sends them as decimal strings
// ("123" or "123n"), and this module turns them back into bigints by field name

/** every bigint field in @spidereum/core's RebalancePlan */
export const BIGINT_KEYS = new Set(["amountIn", "amountOut", "expectedOut", "gasUnits", "amount", "size"]);

const INT = /^-?\d+n?$/;

export function reviveBigints(key: string, value: unknown): unknown {
  if (!BIGINT_KEYS.has(key)) return value;
  if (typeof value === "string" && INT.test(value)) return BigInt(value.replace(/n$/, ""));
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.round(value));
  return value;
}

export function replaceBigints(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function parsePlanJson<T>(text: string): T {
  return JSON.parse(text, reviveBigints) as T;
}

export function stringify(value: unknown): string {
  return JSON.stringify(value, replaceBigints);
}
