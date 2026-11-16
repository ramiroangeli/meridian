import { buildState } from "@/lib/state";
import { dbHint } from "@/lib/db";
import { webAuthed, denied } from "@/lib/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  if (!webAuthed(req)) return denied();
  try {
    return Response.json(await buildState(), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error(e);
    return Response.json({ error: "db", ...dbHint(e) }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
