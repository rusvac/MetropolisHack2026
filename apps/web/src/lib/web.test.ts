import { describe, expect, test } from "bun:test";
import { defaultIntent, fixturePlan } from "./fixture.ts";
import { fromUnits, toUnits } from "./format.ts";
import { parsePlanJson, stringify } from "./json.ts";
import { estimateScore, linkability, riskLevel } from "./linkability.ts";
import { planMoves, prices } from "./moves.ts";
import { reduce, startState } from "./run.ts";
import { simulateRun } from "./simulate.ts";
import { SseParser } from "./sse.ts";
import type { DemoPlan, ExecEvent } from "./types.ts";

const plan = fixturePlan(defaultIntent(), 1_700_000_000_000);

describe("units", () => {
  test("round-trip through atomic units", () => {
    expect(fromUnits(1234.5, 6)).toBe(1_234_500_000n);
    expect(toUnits(1_234_500_000n, 6)).toBeCloseTo(1234.5, 9);
    expect(toUnits(fromUnits(0.05, 18), 18)).toBeCloseTo(0.05, 12);
  });
});

describe("json", () => {
  test("a plan survives the trip to the server and back", () => {
    const back = parsePlanJson<DemoPlan>(stringify(plan));
    expect(back.swaps[0]!.slices[0]!.amountIn).toBe(plan.swaps[0]!.slices[0]!.amountIn);
    expect(typeof back.swaps[0]!.expectedOut).toBe("bigint");
    expect(typeof back.before.holdings[0]!.amount).toBe("bigint");
    expect(back.costUsd).toBe(plan.costUsd);
  });

  test("bigints may arrive as '123n' or as numbers", () => {
    const v = parsePlanJson<{ amountIn: bigint; size: bigint; usd: number }>('{"amountIn":"123n","size":5,"usd":1.5}');
    expect(v.amountIn).toBe(123n);
    expect(v.size).toBe(5n);
    expect(v.usd).toBe(1.5);
  });
});

describe("fixture plan", () => {
  test("is simulated, keeps direct transfers at 0, and beats the naive cost", () => {
    expect(plan.balancesSimulated).toBe(true);
    expect(plan.directTransfers).toBe(0);
    expect(plan.swaps[0]!.baseline.simulated).toBe(true);
    expect(plan.costUsd).toBeLessThan(plan.naiveCostUsd);
    expect(plan.swaps[0]!.expectedOut).toBeGreaterThan(plan.swaps[0]!.baseline.amountOut);
  });

  test("slices sum to the swap size and use both venues", () => {
    const s = plan.swaps[0]!;
    const sum = s.slices.reduce((a, x) => a + x.amountIn, 0n);
    expect(Math.abs(Number(s.intent.amountIn - sum))).toBeLessThan(s.slices.length * 2);
    expect(new Set(s.slices.map((x) => x.venue)).size).toBe(2);
    expect(s.largestSliceShare).toBeLessThan(0.2);
  });

  test("the privacy weight shrinks the largest slice", () => {
    const cheap = fixturePlan({ ...defaultIntent(), privacyWeight: 0 }).swaps[0]!;
    const quiet = fixturePlan({ ...defaultIntent(), privacyWeight: 1 }).swaps[0]!;
    expect(quiet.slices.length).toBeGreaterThan(cheap.slices.length);
    expect(quiet.largestSliceShare).toBeLessThan(cheap.largestSliceShare);
  });

  test("the projected portfolio lands near the targets", () => {
    const mon = plan.after.holdings.filter((h) => h.token.symbol === "MON").reduce((a, h) => a + h.usd, 0);
    expect(mon / plan.after.totalUsd).toBeGreaterThan(0.66);
    expect(mon / plan.after.totalUsd).toBeLessThan(0.72);
  });

  test("no swarm address appears on both chains", () => {
    const monad = new Set(plan.accounts!.filter((a) => a.chainId === 10143).map((a) => a.address.toLowerCase()));
    for (const a of plan.accounts!.filter((x) => x.chainId === 84532)) expect(monad.has(a.address.toLowerCase())).toBe(false);
  });
});

describe("moves", () => {
  test("one move per bridge, per slice, and one for the hedge", () => {
    const moves = planMoves(plan);
    expect(moves.length).toBe(plan.bridges.length + plan.swaps[0]!.slices.length + 1);
    expect(moves.filter((m) => m.kind === "hedge").length).toBe(1);
    expect(moves.every((m, i) => i === 0 || moves[i - 1]!.delayMs <= m.delayMs)).toBe(true);
  });

  test("prices come from the plan", () => {
    expect(prices(plan).MON).toBeCloseTo(0.05, 6);
  });
});

describe("linkability", () => {
  test("the split shows less size than one trade", () => {
    const l = linkability(plan, planMoves(plan));
    expect(l.largest.share).toBeLessThan(l.naiveLargest.share);
    const [, naive, split] = l.scores;
    expect(split!.score).toBeLessThan(naive!.score);
    expect(l.scoreSimulated).toBe(true);
  });

  test("the server's score wins over the estimate", () => {
    const l = linkability({ ...plan, correlation: { before: 71, after: 18 } }, planMoves(plan));
    expect(l.scores.map((s) => s.score)).toEqual([71, 18]);
    expect(l.scoreSimulated).toBe(false);
    const s = linkability(
      {
        ...plan,
        linkability: {
          largestMove: { split: 0.12, splitUsd: 400, naive: 1, totalUsd: 3300 },
          correlation: { before: 30, after: 20, naiveAfter: 90, source: "analyzer" },
          directTransfers: { planned: 0, gasTopUps: [3, 5], total: 2 },
        },
      },
      planMoves(plan),
    );
    expect(s.largest.share).toBe(0.12);
    expect(s.directTransfers).toBe(2);
    expect(s.scores.map((x) => x.score)).toEqual([30, 90, 20]);
  });

  test("risk levels use the analyzer's thresholds", () => {
    expect(riskLevel(80)).toBe("critical");
    expect(riskLevel(60)).toBe("high");
    expect(riskLevel(40)).toBe("medium");
    expect(riskLevel(39)).toBe("low");
    expect(estimateScore({ concentration: 1, largestMoveShare: 1, accounts: 1, directTransfers: 0 })).toBe(85);
  });
});

describe("sse", () => {
  test("parses split chunks, event names, and comments", () => {
    const got: ExecEvent[] = [];
    const p = new SseParser((e) => got.push(e));
    p.push(': hello\n\ndata: {"type":"start","runId":"r1","at":1}\n');
    p.push('\nevent: venue-off\ndata: {"venue":"kuru","at":2}\n\n');
    p.push('data: {"type":"move","id":"swap-0-0","kind":"swap","status":"sent","venue":"kuru","chainId":10143,"simulated":false,"at":3,"hash":"0xabc"}\r\n\r\n');
    p.end();
    expect(got.map((e) => e.type)).toEqual(["start", "venue-off", "move"]);
    expect(got[1]).toMatchObject({ type: "venue-off", venue: "kuru" });
  });
});

describe("run", () => {
  test("a re-route moves the queued slices off the venue", () => {
    const moves = planMoves(plan);
    let s = startState(moves, 0);
    const id = moves.find((m) => m.kind === "swap" && m.venue === "kuru")!.id;
    s = reduce(s, { type: "venue-off", venue: "kuru", at: 1 });
    s = reduce(s, { type: "reroute", from: "kuru", at: 2, moves: [{ id, to: "uniswap-v4" }] });
    expect(s.rows[id]!.venue).toBe("uniswap-v4");
    expect(s.rows[id]!.plannedVenue).toBe("kuru");
    s = reduce(s, { type: "move", id, kind: "swap", status: "confirmed", venue: "uniswap-v4", chainId: 10143, simulated: false, at: 3, hash: "0x1" });
    expect(s.rows[id]).toMatchObject({ status: "confirmed", hash: "0x1", plannedVenue: "kuru" });
  });

  test("the simulated run finishes, re-routes, and says simulated", async () => {
    const events: ExecEvent[] = [];
    const small = fixturePlan({ ...defaultIntent(), privacyWeight: 0.3 });
    const done = new Promise<void>((resolve) => {
      simulateRun(small, { dropVenue: "kuru" }, (e) => {
        events.push(e);
        if (e.type === "done") resolve();
      }, 300);
    });
    await done;
    expect(events.some((e) => e.type === "venue-off")).toBe(true);
    const moveEvents = events.filter((e) => e.type === "move");
    expect(moveEvents.every((e) => e.type === "move" && e.simulated)).toBe(true);
    const reroute = events.find((e) => e.type === "reroute");
    if (reroute?.type === "reroute") expect(reroute.moves.every((m) => m.to !== "kuru")).toBe(true);
  }, 10_000);
});
