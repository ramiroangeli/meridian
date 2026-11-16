import type { Run } from "./db";

// Organigrama: quién ocupa cada rol, su puesto, su área y el modelo sugerido para correrlo.
// El modelo es una sugerencia: cada agente corre en el Claude del usuario, con el modelo que elija.
export const ORG: Record<string, { persona: string; title: string; area: string; model: string }> = {
  A: { persona: "Alma Reyes", title: "Chief of Staff", area: "dir", model: "Claude Opus · coordinación y criterio" },
  B: { persona: "Bruno Okafor", title: "Controller", area: "tes", model: "Claude Sonnet · conciliación y volumen" },
  H: { persona: "Hana Sato", title: "Treasury & FX Lead", area: "tes", model: "Claude Haiku · comparaciones frecuentes" },
  C: { persona: "Ciro Vidal", title: "Head of Income Growth", area: "cre", model: "Claude Sonnet · análisis de oportunidades" },
  D: { persona: "Dana Levi", title: "Decision Coach", area: "per", model: "Claude Sonnet · conversación y hábitos" },
  K: { persona: "Kai Moreno", title: "Learning Lead", area: "per", model: "Claude Sonnet · explicación paso a paso" },
  E: { persona: "Elio Marchetti", title: "Chief Investment Strategist", area: "inv", model: "Claude Opus · decisiones de asignación" },
  F: { persona: "Freya Lindqvist", title: "Quant & Markets Analyst", area: "inv", model: "Claude Sonnet · cálculo con código" },
  G: { persona: "Gael Duarte", title: "Execution Desk Lead", area: "inv", model: "Claude Haiku · verificaciones rápidas" },
  I: { persona: "Inés Zabala", title: "Global Tax Counsel", area: "fis", model: "Claude Opus · normativa entre países" },
  J: { persona: "Jano Petrov", title: "Security & Custody Officer", area: "fis", model: "Claude Sonnet · auditoría de accesos" },
  L: { persona: "Lía Nakamura", title: "Platform & Data Engineer", area: "pla", model: "Claude Haiku · tareas programadas" },
};

export const ORG_SCHEMA = ["persona", "title", "area", "model"].map((c) => `alter table agents add column if not exists ${c} text not null default ''`);

// Completa el organigrama en agentes que todavía no lo tienen. No pisa cambios hechos después.
export async function fillOrg(run: Run) {
  const missing = await run("select count(*)::int as n from agents where persona = ''");
  if (!missing[0].n) return;
  for (const [code, o] of Object.entries(ORG))
    await run("update agents set persona=$2, title=$3, area=$4, model=$5 where code=$1 and persona=''", [code, o.persona, o.title, o.area, o.model]);
}
