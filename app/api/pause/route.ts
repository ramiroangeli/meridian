import { q, currentUser, logEvent } from "@/lib/db";
import { webAuthed, denied } from "@/lib/auth";
export const runtime = "nodejs";
export async function POST(req: Request) {
  if (!webAuthed(req)) return denied();
  const { paused } = await req.json();
  const u = await currentUser();
  await q("update users set paused=$2 where id=$1", [u.id, !!paused]);
  await logEvent(u.id, "Vos", paused ? "Pausaste los agentes" : "Reanudaste los agentes");
  return Response.json({ paused: !!paused });
}
