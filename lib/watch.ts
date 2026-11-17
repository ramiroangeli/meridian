import { q, currentUser, logEvent } from "./db";
import { latestBalances } from "./state";
import { evaluate, type Alert } from "./rules";
import { krakenConfigured, fetchKraken, fxPerAud, priceAud, assetClass, clearTickerCache, FIAT, type OpenOrder } from "./kraken";

export const KRAKEN_CONN = "API Kraken (servidor)";
const MAX_SYSTEM_TASKS_PER_DAY = 10;
const pl = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

async function setStatus(uid: string, source: string, ok: boolean, message: string, detail: object = {}) {
  await q(`insert into source_status (user_id, source, ok, message, detail, synced_at) values ($1,$2,$3,$4,$5,now())
           on conflict (user_id, source) do update set ok=excluded.ok, message=excluded.message, detail=excluded.detail, synced_at=now()`,
    [uid, source, ok, message, JSON.stringify(detail)]);
}

async function upsertAccount(uid: string, name: string, cur: string, cls: string, purpose: string) {
  const r = await q(`insert into accounts (user_id,name,kind,zone,currency,asset_class,purpose,connection) values ($1,$2,'Exchange','AU',$3,$4,$5,$6)
                     on conflict (user_id, name) do update set asset_class=excluded.asset_class, connection=excluded.connection returning id`,
    [uid, name, cur, cls, purpose, KRAKEN_CONN]);
  return r[0].id as string;
}

// Trae saldos y órdenes de Kraken, los valúa en AUD y los guarda. Nunca opera.
async function syncKraken(uid: string, fx: { USD: number; EUR: number } | null) {
  const { holdings, open } = await fetchKraken();
  const today = new Date().toISOString().slice(0, 10), seen = new Set<string>(), noPrice: string[] = [];
  let total = 0;
  for (const h of holdings) {
    const p = await priceAud(h.base, fx);
    const value = p === null ? 0 : h.amount * p;
    if (p === null) noPrice.push(h.asset);
    else if (value < 1 && !FIAT.has(h.asset)) continue; // polvo: menos de AUD 1
    const name = `Kraken: ${h.asset}`; seen.add(name);
    const id = await upsertAccount(uid, name, h.asset, assetClass(h.asset), FIAT.has(h.asset) ? "Pendiente de invertir" : "Largo plazo");
    await q("insert into balances (user_id,account_id,native_amount,base_amount,source) values ($1,$2,$3,$4,'kraken-api')", [uid, id, h.amount, value]);
    if (p !== null && !FIAT.has(h.asset)) await q("insert into price_history (asset, day, aud) values ($1,$2,$3) on conflict (asset, day) do update set aud=excluded.aud", [h.asset, today, p]);
    total += value;
  }
  // Lo que ya no está en Kraken queda en cero, para no mostrar un saldo viejo como actual.
  const gone = await q("select id, name from accounts where user_id=$1 and connection=$2", [uid, KRAKEN_CONN]);
  for (const g of gone) if (!seen.has(g.name)) await q("insert into balances (user_id,account_id,native_amount,base_amount,source) values ($1,$2,0,0,'kraken-api')", [uid, g.id]);
  return { holdings: seen.size, total, open, noPrice };
}

export type WatchResult = { ok: boolean; summary: string; alerts: string[]; tasks: number };

export async function runWatch(trigger: "cron" | "manual" | "agente"): Promise<WatchResult> {
  clearTickerCache();
  const u = await currentUser();
  if (u.demo) return { ok: true, summary: "Datos de ejemplo: la vigilancia se activa cuando empieces con tus datos.", alerts: [], tasks: 0 };
  const uid = u.id, notes: string[] = [];

  const fx = await fxPerAud();
  if (fx) { for (const [c, r] of Object.entries(fx)) await q("insert into fx_rates values ($1,$2,$3) on conflict (user_id, currency) do update set per_base=excluded.per_base", [uid, c, r]); }
  else notes.push("sin tipos de cambio nuevos");

  let syncError: string | null = null, open: OpenOrder[] = [];
  if (krakenConfigured()) {
    try {
      const k = await syncKraken(uid, fx); open = k.open;
      const msg = `${pl(k.holdings, "activo", "activos")} por AUD ${Math.round(k.total).toLocaleString("es-AR")}, ${pl(k.open.length, "orden abierta", "órdenes abiertas")}` + (k.noPrice.length ? `; sin precio: ${k.noPrice.join(", ")}` : "");
      await setStatus(uid, "kraken", true, msg, { holdings: k.holdings, total: k.total, open: k.open.length, noPrice: k.noPrice });
      notes.push("Kraken: " + msg);
    } catch (e: any) {
      syncError = e?.message || "Error desconocido";
      await setStatus(uid, "kraken", false, syncError!);
      notes.push("Kraken con error");
    }
  } else await setStatus(uid, "kraken", false, "Sin configurar: faltan KRAKEN_API_KEY y KRAKEN_API_SECRET en Vercel.");

  // Foto mensual del patrimonio. Los aportes quedan vacíos hasta tener movimientos importados.
  const accs = await latestBalances(uid);
  const assets = accs.reduce((t, a) => t + (a.base_amount ?? 0), 0);
  const liab = (await q("select coalesce(sum(base_amount),0)::float8 as t from liabilities where user_id=$1", [uid]))[0].t;
  await q("insert into net_worth_history (user_id, month, net, contributions) values ($1,$2,$3,null) on conflict (user_id, month) do update set net=excluded.net",
    [uid, new Date().toISOString().slice(0, 7), assets - liab]);

  // Reglas
  const held = accs.filter((a) => a.connection === KRAKEN_CONN && (a.base_amount ?? 0) > 0 && !FIAT.has(a.currency)).map((a) => a.currency);
  const prices: { asset: string; now: number; weekAgo: number | null }[] = [];
  for (const asset of held) {
    const p = await q(`select (select aud::float8 from price_history where asset=$1 order by day desc limit 1) as now,
                              (select aud::float8 from price_history where asset=$1 and day <= current_date - 7 order by day desc limit 1) as week`, [asset]);
    if (p[0].now) prices.push({ asset, now: p[0].now, weekAgo: p[0].week });
  }
  const isTax = (a: any) => /impuesto|fiscal/i.test(a.purpose + " " + a.name);
  const taxAccs = accs.filter(isTax);
  const alerts: Alert[] = evaluate({
    now: Date.now(),
    accounts: accs.map((a) => ({ name: a.name, asOf: a.as_of ? new Date(a.as_of).getTime() : null })),
    prices, openOrders: open.map((o) => ({ pair: o.pair, side: o.side, opened: o.opened })),
    reserve: taxAccs.length ? taxAccs.reduce((t, a) => t + (a.base_amount ?? 0), 0) : null, taxDue: liab, syncError,
  });

  let created = 0;
  if (!u.paused) {
    const today = (await q("select count(*)::int as n from agent_tasks where user_id=$1 and from_code='sistema' and created_at > now() - interval '1 day'", [uid]))[0].n;
    for (const a of alerts) {
      if (today + created >= MAX_SYSTEM_TASKS_PER_DAY) break;
      const dup = await q("select id from agent_tasks where user_id=$1 and to_code=$2 and status in ('open','in_progress','blocked') and lower(title)=lower($3)", [uid, a.to, a.title]);
      if (dup.length) continue;
      await q("insert into agent_tasks (user_id,from_code,to_code,title,detail,priority) values ($1,'sistema',$2,$3,$4,$5)", [uid, a.to, a.title, a.detail, a.priority]);
      created++;
    }
  }
  const summary = (alerts.length ? `${pl(alerts.length, "alerta", "alertas")}, ${pl(created, "tarea nueva", "tareas nuevas")}` : "Sin novedades") + (u.paused ? " (en pausa: no se crearon tareas)" : "") + (notes.length ? ". " + notes.join("; ") : "");
  await setStatus(uid, "watch", !syncError, summary, { trigger, alerts: alerts.map((a) => a.title) });
  await logEvent(uid, "Vigilancia", trigger === "cron" ? "Revisión diaria" : trigger === "manual" ? "Revisión pedida desde el tablero" : "Revisión pedida por un agente", summary);
  return { ok: !syncError, summary, alerts: alerts.map((a) => a.title), tasks: created };
}

// Borra los datos de ejemplo y deja el sistema listo para datos reales. Conserva agentes, organigrama e instrucciones.
export async function startReal() {
  const u = await currentUser();
  if (!u.demo) return false;
  for (const t of ["agent_tasks", "proposals", "agent_runs", "events", "fiscal_items", "net_worth_history", "liabilities", "accounts", "source_status"])
    await q(`delete from ${t} where user_id=$1`, [u.id]);
  await q("update agents set implemented=false where user_id=$1", [u.id]);
  await q("update users set demo=false, paused=false, name='Mi cuenta' where id=$1", [u.id]);
  await logEvent(u.id, "Vos", "Empezaste con tus datos", "Se borraron los datos de ejemplo");
  return true;
}
