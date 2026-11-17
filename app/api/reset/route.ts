import { startReal } from "@/lib/watch";
import { webAuthed, denied } from "@/lib/auth";
export const runtime = "nodejs";
export async function POST(req: Request) {
  if (!webAuthed(req)) return denied();
  const b = await req.json().catch(() => ({}));
  if (b.confirm !== "BORRAR") return Response.json({ error: "Escribí BORRAR para confirmar." }, { status: 400 });
  if (!(await startReal())) return Response.json({ error: "Ya estás usando tus datos." }, { status: 409 });
  return Response.json({ ok: true });
}
