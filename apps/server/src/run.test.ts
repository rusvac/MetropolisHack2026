// starts a server on a free port with the run's routes, on the mock venues and the fake portfolio
import { afterAll, beforeAll, expect, test } from "bun:test";

process.env.DEMO_VENUES = "mock";
process.env.DEMO_PORTFOLIO = "fake";
process.env.DEMO_EXECUTOR = "simulated";
process.env.DEMO_GAS = "fixed";
const { fetchRun, handleRun, intentFrom } = await import("./run.ts");

let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: fetchRun, idleTimeout: 30 });
  base = server.url.href.replace(/\/$/, "");
});

afterAll(() => {
  server.stop(true);
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** reads a server-sent events body into a list of parsed events */
async function readEvents(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((block) => block.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(6)));
}

test("handleRun returns null for a path it does not own", async () => {
  expect(await handleRun(new Request("http://x/aurora/quote", { method: "POST" }))).toBeNull();
  expect(await handleRun(new Request("http://x/", { method: "GET" }))).toBeNull();
});

test("POST /plan returns a RebalancePlan with bigints as strings and the extras", async () => {
  const res = await post("/plan", { intent: { id: "t1", targets: [{ symbol: "MON", weight: 0.7 }, { symbol: "USDC", weight: 0.3 }], hedgeRatio: 0.5, privacyWeight: 0.5 } });
  expect(res.status).toBe(200);
  const text = await res.text();
  const plan = JSON.parse(text);
  // the seed never leaves the server: the plan carries addresses only
  const seed = process.env.BURNER_MNEMONIC?.trim();
  if (seed) expect(text).not.toContain(seed);
  expect(Array.isArray(plan.swaps)).toBe(true);
  expect(plan.swaps.length).toBeGreaterThan(0);
  expect(typeof plan.swaps[0].intent.amountIn).toBe("string");
  expect(typeof plan.swaps[0].slices[0].amountIn).toBe("string");
  expect(plan.bridges.length).toBeGreaterThan(1);
  expect(plan.directTransfers).toBe(0);
  expect(plan.costUsd).toBeLessThan(plan.naiveCostUsd);
  expect(typeof plan.planId).toBe("string");
  expect(plan.balancesSimulated).toBe(true);
  expect(plan.accounts.length).toBeGreaterThan(0);
});

test("POST /plan refuses bad input", async () => {
  expect((await post("/plan", { targets: [{ symbol: "MON", weight: 0.9 }] })).status).toBe(400);
  expect((await fetch(`${base}/plan`, { method: "POST", body: "x" })).status).toBe(415);
  expect((await fetch(`${base}/plan`)).status).toBe(405);
  expect(typeof intentFrom({ privacyWeight: 2 })).toBe("string");
});

test("POST /execute streams one event per move, the venue turning off, and the re-route", async () => {
  const plan = await (await post("/plan", {})).json();
  const res = await post("/execute", { planId: plan.planId, dropVenue: "auto", speed: 1e9 });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const events = await readEvents(res);
  const types = events.map((e) => e.type);
  expect(types[0]).toBe("start");
  expect(types.at(-1)).toBe("done");
  expect(types).toContain("venue-off");
  expect(types).toContain("reroute");

  const moves = events.filter((e) => e.type === "move");
  const final = moves.filter((e) => e.status === "confirmed" || e.status === "quoted" || e.status === "failed");
  // every slice in the plan ends once
  const slices = plan.swaps.reduce((n: number, s: { slices: unknown[] }) => n + s.slices.length, 0);
  expect(final.filter((e) => e.kind === "swap").length).toBe(slices);
  // the simulated executor sends nothing: no hash, no link, and each move says so
  for (const e of final) {
    expect(e.simulated).toBe(true);
    expect(e.hash).toBeUndefined();
  }
  const off = events.find((e) => e.type === "venue-off")!;
  const after = final.filter((e) => e.kind === "swap" && (events.indexOf(e) > events.indexOf(off)));
  expect(after.every((e) => e.venue !== off.venue)).toBe(true);
});

test("POST /execute takes the plan from the body, as apps/web sends it", async () => {
  const plan = await (await post("/plan", { privacyWeight: 0.2 })).json();
  delete plan.planId;
  const res = await post("/execute", { plan, speed: 1e9 });
  const events = await readEvents(res);
  expect(events.at(-1)?.type).toBe("done");
  expect(events.some((e) => e.type === "venue-off")).toBe(false);
});

test("POST /execute/venue-off turns a venue off mid-run", async () => {
  const plan = await (await post("/plan", {})).json();
  const res = await post("/execute", { planId: plan.planId, dropVenue: null, speed: 10 });
  const runId = res.headers.get("x-run-id")!;
  expect(runId).toBeTruthy();
  const venue = plan.swaps[0].slices.at(-1).venue;
  const ok = await post("/execute/venue-off", { runId, venue });
  expect(ok.status).toBe(200);
  const events = await readEvents(res);
  expect(events.some((e) => e.type === "venue-off" && e.venue === venue)).toBe(true);
  expect((await post("/execute/venue-off", { runId: "nope", venue })).status).toBe(404);
}, 30_000);
