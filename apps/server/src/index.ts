// the lead owns this file. it mounts the routes from aurora.ts (L4) and run.ts (L8).
// the seed and the aurora key stay on this server. apps/web never sees either
import { handleAurora } from "./aurora.ts";
import { handleRun } from "./run.ts";

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/aurora/")) return handleAurora(req);
  const run = await handleRun(req);
  if (run) return run;
  return new Response("not found", { status: 404 });
}

if (import.meta.main) {
  const server = Bun.serve({ port: Number(process.env.PORT ?? 8787), fetch: handle });
  console.log(`spidereum server on ${server.url}`);
}
