import { q, currentUser, logEvent } from "@/lib/db";
import { webAuthed, denied } from "@/lib/auth";
export const runtime = "nodejs";

// El usuario también puede dejar tareas en la bandeja de un agente desde el tablero.
export async function POST(req: Request) {
  if (!webAuthed(req)) return denied();
  const b = await req.json().catch(() => ({}));
  const title = String(b.title || "").trim(), detail = String(b.detail || "").trim(), to = String(b.to || "").toUpperCase();
  const pr = ["alta", "normal", "baja"].includes(b.priority) ? b.priority : "normal";
  if (title.length < 5 || title.length > 120) return Response.json({ error: "El título debe tener entre 5 y 120 caracteres." }, { status: 400 });
  if (detail.length > 800) return Response.json({ error: "El detalle admite hasta 800 caracteres." }, { status: 400 });
  const u = await currentUser();
  const ag = await q("select code, name from agents where user_id=$1 and code=$2", [u.id, to]);
  if (!ag.length) return Response.json({ error: "Elegí un agente válido." }, { status: 400 });
  await q("insert into agent_tasks (user_id,from_code,to_code,title,detail,priority) values ($1,'user',$2,$3,$4,$5)", [u.id, to, title, detail, pr]);
  await logEvent(u.id, "Vos", `Asignaste a ${to}: ${title}`);
  return Response.json({ ok: true });
}
