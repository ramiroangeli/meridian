import { createMandate, setMandate, computeOdds, currentMandate } from "@/lib/trading";
import { currentUser } from "@/lib/db";
import { webAuthed, denied } from "@/lib/auth";
export const runtime = "nodejs";
export const maxDuration = 60;

// Solo el usuario, con sesión en el tablero, crea o cambia el mandato.
export async function POST(req: Request) {
  if (!webAuthed(req)) return denied();
  const b = await req.json().catch(() => ({}));
  const u = await currentUser();
  const plan = { capital: Number(b.capital), floor: Number(b.floor), target: Number(b.target) };
  try {
    if (b.action === "odds") {
      const m = await currentMandate(u.id);
      const use = m && ["active", "paused"].includes(m.status) ? { capital: Number(m.capital), floor: Number(m.floor), target: Number(m.target) } : plan;
      return Response.json(await computeOdds(u.id, use));
    }
    if (b.action === "create") { await createMandate(u.id, plan); return Response.json({ ok: true }); }
    if (["pause", "resume", "end"].includes(b.action)) { await setMandate(u.id, b.action); return Response.json({ ok: true }); }
    return Response.json({ error: "Acción no válida" }, { status: 400 });
  } catch (e: any) {
    return Response.json({ error: e?.message || "No se pudo completar." }, { status: 400 });
  }
}
