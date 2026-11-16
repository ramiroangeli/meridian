import { buildState } from "@/lib/state";
import { webAuthed, denied } from "@/lib/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  if (!webAuthed(req)) return denied();
  return Response.json(await buildState(), { headers: { "cache-control": "no-store" } });
}
