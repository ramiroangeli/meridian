import { q, currentUser, logEvent } from "@/lib/db";
import { webAuthed, denied } from "@/lib/auth";
import { executeIntentForProposal, rejectIntentForProposal } from "@/lib/live";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAP: Record<string, [string, string, string]> = {
  approve: ["approved", "Aprobaste", "Pendiente de que la ejecutes"],
  reject: ["rejected", "Rechazaste", "Registrado"],
  postpone: ["postponed", "Pospusiste", "Registrado"],
};

// Solo una persona con sesión en el tablero resuelve propuestas. El conector MCP no expone esta acción.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!webAuthed(req)) return denied();
  const { id } = await ctx.params;
  const { action } = await req.json();
  const m = MAP[action];
  if (!m || !/^[0-9a-f-]{36}$/.test(id)) return Response.json({ error: "Acción no válida" }, { status: 400 });
  const u = await currentUser();
  const r = await q("update proposals set status=$3, resolved_at=now() where id=$1 and user_id=$2 and status='pending' returning title", [id, u.id, m[0]]);
  if (!r.length) return Response.json({ error: "La propuesta ya fue resuelta" }, { status: 409 });
  // Si la propuesta es una orden de trading, aprobarla la ejecuta (con los límites controlados de nuevo).
  const intent = await q("select id from trading_intents where proposal_id=$1 and status='pending'", [id]);
  if (intent.length) {
    if (action === "approve") {
      const x = await executeIntentForProposal(u.id, id);
      await logEvent(u.id, "Vos", `${m[1]}: ${r[0].title}`, x?.ok ? "Orden enviada a Kraken" : "No se ejecutó: " + (x as any)?.error);
      return Response.json({ status: m[0], trade: x });
    }
    await rejectIntentForProposal(id);
  }
  await logEvent(u.id, "Vos", `${m[1]}: ${r[0].title}`, m[2]);
  return Response.json({ status: m[0] });
}
