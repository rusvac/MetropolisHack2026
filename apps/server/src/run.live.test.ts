// the onchain mode over http, dry: testnet quotes, live balances, and built transactions. it sends nothing.
// runs with `bun run test:live`
import { afterAll, beforeAll, expect, test } from "bun:test";

process.env.DEMO_ONCHAIN = "dry";
const { fetchRun } = await import("./run.ts");

let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: fetchRun });
});
afterAll(() => {
  server.stop(true);
  delete process.env.DEMO_ONCHAIN;
});

const post = (path: string, body: unknown) =>
  fetch(new URL(path, server.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("DEMO_ONCHAIN=dry plans on testnet quotes and streams built, unsent slices with a re-route", async () => {
  const res = await post("/plan", {});
  expect(res.status).toBe(200);
  const plan = await res.json();
  expect(plan.onchain.network).toBe("monad testnet");
  expect(plan.balancesSimulated).toBe(false);
  expect(plan.swaps[0].slices.length).toBeGreaterThan(1);
  expect(plan.linkability.directTransfers.total).toBe(8);

  const run = await post("/execute", { planId: plan.planId, dropVenue: "auto" });
  expect(run.status).toBe(200);
  const events = (await run.text())
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
  expect(events.at(-1).type).toBe("done");
  const finals = events.filter((e) => e.type === "move" && e.status !== "queued" && e.status !== "sent");
  expect(finals.every((e) => e.status === "quoted" && e.note.startsWith("dry run"))).toBe(true);
  expect(events.some((e) => e.type === "reroute")).toBe(true);
  // a plan the server did not make never runs onchain
  expect((await post("/execute", { plan: { ...plan, planId: "nope" } })).status).toBe(409);
}, 120_000);
