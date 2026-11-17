import { q, currentUser } from "./db";

const MES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const mes = (ym: string) => MES[Number(ym.slice(5, 7)) - 1];

export const ZONES = [
  { id: "AU", name: "Australia", tz: "Australia/Sydney", lon: 151 },
  { id: "UE", name: "Unión Europea", tz: "Europe/Madrid", lon: -4 },
  { id: "AR", name: "Argentina", tz: "America/Argentina/Buenos_Aires", lon: -58 },
  { id: "US", name: "Estados Unidos", tz: "America/New_York", lon: -74 },
  { id: "UK", name: "Reino Unido", tz: "Europe/London", lon: 0 },
];

export function rel(d: Date | null, none: string): string {
  if (!d) return none;
  const min = Math.round((Date.now() - new Date(d).getTime()) / 60000), a = Math.abs(min);
  const t = a < 60 ? `${a} min` : a < 2880 ? `${Math.round(a / 60)} h` : `${Math.round(a / 1440)} días`;
  return min >= 0 ? `hace ${t}` : `en ${t}`;
}

export async function latestBalances(uid: string) {
  return q(
    `select a.id, a.name, a.kind, a.zone, a.currency, a.asset_class, a.purpose, a.connection,
            b.native_amount::float8 as native_amount, b.base_amount::float8 as base_amount, b.as_of, b.source
       from accounts a
       left join lateral (select * from balances where account_id = a.id order by as_of desc limit 1) b on true
      where a.user_id = $1 order by a.created_at, a.name`, [uid]);
}

export async function agentRows(uid: string) {
  return q(
    `select a.*, r.id as run_id, r.status, r.task, r.result, r.started_at, r.finished_at, r.next_run_at, r.next_note
       from agents a
       left join lateral (select * from agent_runs where agent_id = a.id order by started_at desc limit 1) r on true
      where a.user_id = $1 order by a.code`, [uid]);
}

// Arma el estado completo en la forma que consume el tablero.
export async function buildState() {
  const user = await currentUser();
  const uid = user.id;
  const [fx, accs, liabs, hist, tx, agents, props, events, fiscal] = await Promise.all([
    q("select currency, per_base::float8 as r from fx_rates where user_id=$1", [uid]),
    latestBalances(uid),
    q("select name, zone, base_amount::float8 as amount, note from liabilities where user_id=$1", [uid]),
    q("select month, net::float8 as net, contributions::float8 as c from net_worth_history where user_id=$1 order by month desc limit 12", [uid]),
    q(`select substr(posted_on,1,7) as m, kind, essential, sum(amount)::float8 as total
         from transactions where user_id=$1 group by 1,2,3 order by 1`, [uid]),
    agentRows(uid),
    q("select * from proposals where user_id=$1 and status='pending' order by case level when 'urg' then 0 when 'rev' then 1 when 'sum' then 2 else 3 end, created_at", [uid]),
    q("select at, actor, action, result from events where user_id=$1 order by at desc limit 60", [uid]),
    q("select due, zone, title, status from fiscal_items where user_id=$1", [uid]),
  ]);

  const tasks = await q(
    `select id, from_code, to_code, title, detail, priority, status, result, created_at, updated_at from agent_tasks
      where user_id=$1 and (status in ('open','in_progress','blocked') or updated_at > now() - interval '14 days')
      order by case status when 'blocked' then 0 when 'in_progress' then 1 when 'open' then 2 else 3 end,
               case priority when 'alta' then 0 when 'normal' then 1 else 2 end, updated_at desc limit 80`, [uid]);
  const inbox: Record<string, number> = {};
  for (const t of tasks) if (["open", "in_progress", "blocked"].includes(t.status)) inbox[t.to_code] = (inbox[t.to_code] || 0) + 1;
  const status = await q("select source, ok, message, detail, synced_at from source_status where user_id=$1", [uid]);
  const src = (s: string) => { const r = status.find((x) => x.source === s); return r ? { ok: r.ok, msg: r.message, ago: rel(r.synced_at, ""), detail: r.detail } : null; };
  const months = [...new Set(tx.map((r) => r.m as string))].slice(-6);
  const pick = (m: string, f: (r: any) => boolean) => Math.abs(tx.filter((r) => r.m === m && f(r)).reduce((t, r) => t + r.total, 0));
  const h = hist.reverse();
  const LBL: Record<string, string> = { urg: "Aviso urgente", rev: "Acción para revisar", sum: "Para el resumen", idea: "Idea para después" };
  const when = new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  const used = new Set(accs.map((a) => a.zone));

  return {
    user: { name: user.name, demo: user.demo },
    base: user.base_currency,
    paused: user.paused,
    fx: Object.fromEntries(fx.map((r) => [r.currency, r.r])),
    zones: ZONES.filter((z) => used.has(z.id)),
    accounts: accs.map((a) => ({
      n: a.name, type: a.kind, zone: a.zone, cur: a.currency, nat: a.native_amount, aud: a.base_amount ?? 0,
      cls: a.asset_class, use: a.purpose, conn: a.connection,
      age: a.as_of ? Math.max(0, Math.round((Date.now() - new Date(a.as_of).getTime()) / 60000)) : 999999,
    })),
    liabs: liabs.map((l) => ({ n: l.name, zone: l.zone, aud: l.amount, note: l.note })),
    months: h.map((r) => mes(r.month)),
    nwHist: h.map((r) => r.net),
    contrib: h.map((r) => r.c),
    sources: { kraken: src("kraken"), watch: src("watch"), krakenConfigured: !!(process.env.KRAKEN_API_KEY && process.env.KRAKEN_API_SECRET), cron: !!process.env.CRON_SECRET },
    flow: {
      m: months.map(mes),
      ingreso: months.map((m) => pick(m, (r) => r.kind === "income")),
      esencial: months.map((m) => pick(m, (r) => r.kind === "expense" && r.essential)),
      discrecional: months.map((m) => pick(m, (r) => r.kind === "expense" && !r.essential)),
      fiscal: months.map((m) => pick(m, (r) => r.kind === "tax_reserve")),
    },
    agents: agents.map((a) => ({
      c: a.code, n: a.name, p: a.persona || a.name, title: a.title || a.name, area: a.area || "dir", model: a.model || "", st: a.status ?? (a.implemented ? "prog" : "idea"),
      task: a.task ?? "Sin tareas", res: a.result || (a.implemented ? "Sin resultados todavía" : "Rol todavía no implementado"),
      last: a.status === "run" ? "en curso" : rel(a.finished_at ?? a.started_at ?? null, "nunca"),
      next: a.next_note ?? rel(a.next_run_at ?? null, "sin programar"),
      schedule: a.schedule || "", inbox: inbox[a.code] || 0, obj: a.objective, data: a.data, out: a.deliverables, perm: a.permissions, kpi: a.kpi, dep: a.depends_on, esc: a.escalation, cost: a.cost_note,
    })),
    tasks: tasks.map((t) => ({ id: t.id, from: t.from_code, to: t.to_code, t: t.title, d: t.detail, pr: t.priority, st: t.status, res: t.result, age: rel(t.updated_at, ""), created: rel(t.created_at, "") })),
    props: props.map((p) => ({ id: p.id, lvl: p.level, lbl: LBL[p.level], ag: p.agent_code, t: p.title, ev: p.evidence, ben: p.benefit, esf: p.effort, risk: p.risk, next: p.next_step })),
    history: events.map((e) => ({ when: when.format(new Date(e.at)) + " UTC", who: e.actor, what: e.action, res: e.result })),
    fiscal: fiscal.map((f) => ({ d: f.due, j: f.zone, t: f.title, s: f.status })),
    costs: [["Modelo de IA para agentes", 0], ["Alojamiento web", 0], ["Base de datos", 0], ["Asesor fiscal, prorrateado", 40]],
  };
}
