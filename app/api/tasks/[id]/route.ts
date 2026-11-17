import { q, currentUser, logEvent } from "@/lib/db";
import { webAuthed, denied } from "@/lib/auth";
export const runtime = "nodejs";

// Desde el tablero, el usuario puede cancelar cualquier tarea abierta.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!webAuthed(req)) return denied();
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return Response.json({ error: "Tarea inválida" }, { status: 400 });
  const u = await currentUser();
  const r = await q("update agent_tasks set status='cancelled', result='Cancelada por el usuario', updated_at=now() where id=$1 and user_id=$2 and status in ('open','in_progress','blocked') returning title", [id, u.id]);
  if (!r.length) return Response.json({ error: "La tarea ya estaba cerrada" }, { status: 409 });
  await logEvent(u.id, "Vos", `Cancelaste la tarea: ${r[0].title}`);
  return Response.json({ ok: true });
}
