import { q, logEvent } from "./db";
import { ohlcDaily } from "./kraken";
import { step, newBook, equityAt, odds, run, zeroEdge, DEFAULTS, WARMUP, type Book, type Candle, type Mandate, type Params } from "./strategy";

// Mandato de trading. Por ahora solo en modo simulado: usa precios reales de Kraken, pero no envía órdenes.
const num = (x: any) => Number(x);

// Teo aparece en la oficina según lo que hace el motor: cada paso diario queda como una ejecución suya.
async function teoRun(uid: string, status: string, task: string, result: string) {
  const a = await q("select id from agents where user_id=$1 and code='M'", [uid]);
  if (!a.length) return;
  await q("update agents set implemented=true where id=$1", [a[0].id]);
  await q("insert into agent_runs (user_id, agent_id, status, task, result, finished_at, next_note) values ($1,$2,$3,$4,$5,now(),$6)",
    [uid, a[0].id, status, task, result, status === "prog" || status === "done" ? "mañana, con la vela diaria" : "tras tu decisión"]);
}

export async function currentMandate(uid: string) {
  const r = await q("select * from trading_mandates where user_id=$1 order by created_at desc limit 1", [uid]);
  return r[0] || null;
}

export function validate(m: Mandate): string | null {
  if (![m.capital, m.floor, m.target].every((x) => Number.isFinite(x) && x > 0)) return "Capital, piso y objetivo tienen que ser montos positivos.";
  if (!(m.floor < m.capital && m.capital < m.target)) return "El piso tiene que ser menor que el capital, y el objetivo mayor.";
  if (m.capital > 1_000_000) return "El capital supera el máximo permitido.";
  if ((m.capital - m.floor) / m.capital < 0.05) return "El piso deja menos de 5% de margen: no hay espacio para operar.";
  return null;
}

export async function createMandate(uid: string, m: Mandate) {
  const err = validate(m); if (err) throw new Error(err);
  const open = await q("select id from trading_mandates where user_id=$1 and status in ('active','paused')", [uid]);
  if (open.length) throw new Error("Ya hay un mandato en curso. Terminalo antes de crear otro.");
  const h = await ohlcDaily();
  if (h.length < WARMUP(DEFAULTS) + 1) throw new Error("Kraken devolvió muy poco historial para arrancar.");
  const last = h[h.length - 1];
  const r = await q("insert into trading_mandates (user_id, capital, floor, target, book, params, last_t) values ($1,$2,$3,$4,$5,$6,$7) returning id",
    [uid, m.capital, m.floor, m.target, JSON.stringify(newBook(m)), JSON.stringify(DEFAULTS), last.t]);
  await q("insert into trading_equity (mandate_id, t, equity, price) values ($1,$2,$3,$4)", [r[0].id, last.t, m.capital, last.c]);
  await teoRun(uid, "prog", "Mandato simulado en curso", `Capital AUD ${m.capital}, piso ${m.floor}, objetivo ${m.target}`);
  await logEvent(uid, "Vos", `Creaste un mandato de trading simulado: AUD ${m.capital}, piso ${m.floor}, objetivo ${m.target}`, "Arranca con la próxima vela diaria cerrada");
  return r[0].id as string;
}

export async function setMandate(uid: string, action: "pause" | "resume" | "end") {
  const m = await currentMandate(uid);
  if (!m || !["active", "paused"].includes(m.status)) throw new Error("No hay un mandato en curso.");
  if (action === "pause") {
    await q("update trading_mandates set status='paused' where id=$1", [m.id]);
    await logEvent(uid, "Vos", "Pausaste el mandato de trading");
  } else if (action === "resume") {
    // Al reanudar no se simulan los días en pausa: arranca desde la última vela cerrada.
    const h = await ohlcDaily(); const book = m.book as Book; book.pending = null;
    await q("update trading_mandates set status='active', last_t=$2, book=$3 where id=$1", [m.id, h[h.length - 1].t, JSON.stringify(book)]);
    await logEvent(uid, "Vos", "Reanudaste el mandato de trading");
  } else {
    await q("update trading_mandates set status='ended', ended_at=now() where id=$1", [m.id]);
    await logEvent(uid, "Vos", "Terminaste el mandato de trading", "La posición simulada queda congelada");
  }
}

const LABEL: Record<string, string> = { buy: "Compra", sell: "Venta", stop: "Stop", target: "Objetivo", floor: "Piso" };
const aud = (n: number) => "AUD " + Math.round(n).toLocaleString("es-AR");

// Procesa las velas diarias nuevas. Lo corre la vigilancia diaria, el botón de sincronizar y refresh_data.
export async function stepMandates(uid: string): Promise<string | null> {
  const m = await currentMandate(uid);
  if (!m || m.status !== "active") return null;
  const h = await ohlcDaily(m.pair);
  const mand: Mandate = { capital: num(m.capital), floor: num(m.floor), target: num(m.target) };
  const p = m.params as Params, book = m.book as Book;
  let lastT = num(m.last_t), n = 0;
  const notes: string[] = [];
  for (let i = 0; i < h.length; i++) {
    if (h[i].t <= lastT || i < WARMUP(p)) continue;
    const fills = step(h as Candle[], i, book, mand, p);
    for (const f of fills) {
      await q("insert into trading_fills (user_id, mandate_id, t, kind, price, units, aud, fee, equity, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [uid, m.id, f.t, f.kind, f.price, f.units, f.aud, f.fee, f.equity, f.note]);
      notes.push(`${LABEL[f.kind]}: ${f.note}`);
    }
    await q("insert into trading_equity (mandate_id, t, equity, price) values ($1,$2,$3,$4) on conflict (mandate_id, t) do nothing", [m.id, h[i].t, equityAt(book, h[i].c), h[i].c]);
    lastT = h[i].t; n++;
    if (book.status !== "active") break;
  }
  const status = book.status === "active" ? "active" : book.status;
  await q("update trading_mandates set book=$2, last_t=$3, status=$4, ended_at=case when $4 in ('floor','target') then now() else ended_at end where id=$1", [m.id, JSON.stringify(book), lastT, status]);
  const eq = equityAt(book, h[h.length - 1]?.c ?? 0);
  for (const nt of notes) await logEvent(uid, "Teo (trading)", nt, `Patrimonio del mandato: ${aud(eq)}`);
  if (n) await teoRun(uid, status === "active" ? "done" : "appr", "Paso diario del mandato", `${n} ${n === 1 ? "día" : "días"} procesados, patrimonio ${aud(eq)}`);
  if (status === "target")
    await q("insert into proposals (user_id,agent_code,level,title,evidence,benefit,effort,risk,next_step) values ($1,'M','rev',$2,$3,$4,$5,$6,$7)",
      [uid, "El mandato simulado llegó al objetivo", `El patrimonio simulado llegó a ${aud(book.endValue ?? eq)} y pasó a USDC.`, "Evidencia de que la estrategia puede funcionar", "15 minutos", "Un resultado simulado no garantiza el real", "Revisar las operaciones y decidir si se prueba con dinero real"]);
  if (status === "floor")
    await q("insert into proposals (user_id,agent_code,level,title,evidence,benefit,effort,risk,next_step) values ($1,'M','urg',$2,$3,$4,$5,$6,$7)",
      [uid, "El mandato simulado tocó el piso", `El patrimonio simulado terminó en ${aud(book.endValue ?? eq)}, contra un piso de ${aud(mand.floor)}.`, "Evita perder dinero real con esta estrategia", "15 minutos", "Ninguno: fue simulado", "Revisar qué falló antes de probar otra estrategia"]);
  return n ? `Trading simulado: ${n} ${n === 1 ? "día procesado" : "días procesados"}, patrimonio ${aud(eq)}` + (status !== "active" ? `, terminó en ${status === "target" ? "objetivo" : "piso"}` : "") : null;
}

export async function computeOdds(uid: string, m: Mandate) {
  const err = validate(m); if (err) throw new Error(err);
  const h = await ohlcDaily();
  if (h.length < 200) throw new Error("Kraken devolvió muy poco historial para simular.");
  const opt = { paths: 1000, horizonDays: 730, seed: 11 };
  const bt = run(h, m);
  const detail = {
    plan: m, zeroEdge: zeroEdge(m),
    trend: odds(h, m, opt), neutral: odds(h, m, { ...opt, neutral: true }),
    backtest: { status: bt.status, equity: bt.equity, days: bt.days, trades: bt.fills.filter((f) => f.kind === "buy").length, maxDrawdown: bt.maxDrawdown },
    data: { pair: "BTC/AUD", from: h[0].t, to: h[h.length - 1].t, days: h.length, change: h[h.length - 1].c / h[0].c - 1 },
    params: DEFAULTS,
  };
  await q(`insert into source_status (user_id, source, ok, message, detail, synced_at) values ($1,'trading_odds',true,'',$2,now())
           on conflict (user_id, source) do update set ok=true, detail=excluded.detail, synced_at=now()`, [uid, JSON.stringify(detail)]);
  await logEvent(uid, "Teo (trading)", "Calculó las probabilidades del plan", `Objetivo antes que piso: ${(detail.trend.target * 100).toFixed(0)}% con la tendencia histórica, ${(detail.neutral.target * 100).toFixed(0)}% sin tendencia`);
  return detail;
}

export async function tradingState(uid: string) {
  const m = await currentMandate(uid);
  const o = await q("select detail, synced_at from source_status where user_id=$1 and source='trading_odds'", [uid]);
  if (!m) return { mandate: null, fills: [], equity: [], odds: o[0] ? { ...o[0].detail, at: o[0].synced_at } : null };
  const fills = await q("select t, kind, price::float8 as price, units::float8 as units, aud::float8 as aud, fee::float8 as fee, equity::float8 as equity, note from trading_fills where mandate_id=$1 order by t desc, created_at desc limit 60", [m.id]);
  const eq = await q("select t, equity::float8 as equity, price::float8 as price from trading_equity where mandate_id=$1 order by t", [m.id]);
  const b = m.book as Book, last = eq[eq.length - 1];
  return {
    mandate: { id: m.id, mode: m.mode, pair: m.pair, capital: num(m.capital), floor: num(m.floor), target: num(m.target), status: m.status,
      cash: b.cash, units: b.units, stop: b.stop, entry: b.entry, pending: b.pending, endValue: b.endValue,
      equity: last ? last.equity : num(m.capital), price: last ? last.price : null, lastT: num(m.last_t), created: m.created_at },
    fills, equity: eq.map((e) => [Number(e.t), e.equity]), odds: o[0] ? { ...o[0].detail, at: o[0].synced_at } : null,
  };
}
