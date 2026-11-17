import { runWatch } from "@/lib/watch";
import { webAuthed, denied } from "@/lib/auth";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(req: Request) {
  if (!webAuthed(req)) return denied();
  return Response.json(await runWatch("manual"));
}
