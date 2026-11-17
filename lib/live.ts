import { q, currentUser, logEvent } from "./db";
import { ticker, clearTickerCache, pairMeta, addOrder, cancelOrder, queryOrder, waitFilled, balanceWith, tradeConfigured, krakenConfigured, ohlcDaily, KrakenError } from "./kraken";
import { COSTS, checkBuy, checkStopMove, mandateEnd, roundDown, slipFor, type Pos } from "./risk";
import { resolve, liquidity, allowedAssets, CORE, watchlist } from "./universe";
import { validate } from "./trading";

// Mandato con dinero real. Teo decide qué comprar y dónde poner el stop; este archivo aplica los límites y habla con Kraken.
// Reglas fijas: solo compras al contado de BTC, ETH, SOL y XRP contra AUD; cada posición con stop-loss cargado en Kraken;
// el peor caso con todos los stops ejecutados nunca queda debajo del piso; al objetivo vende todo y pasa a USDC.

const aud = (n: number) => "AUD " + new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(n);
const now = () => Date.now();

export async function liveMandate(uid: string) {
  const r = await q("select * from trading_mandates where user_id=$1 and mode='live' and status in ('active','paused') order by created_at desc limit 1", [uid]);
  return r[0] || null;
}
async function openPositions(mid: string) {
  const r = await q("select id, asset, pair, units::float8 as units, entry::float8 as entry, cost_aud::float8 as cost, sl::float8 as sl, tp::float8 as tp, sl_txid, rationale, opened_at from trading_positions where mandate_id=$1 and status='open' order by opened_at", [mid]);
  return r.map((p: any) => ({ ...p, slip: slipFor(p.asset) }));
}
async function setCash(mid: string, cash: number) {
  await q("update trading_mandates set book = jsonb_set(book, '{cash}', to_jsonb($2::float8)) where id=$1", [mid, cash]);
}
const cashOf = (m: any) => Number(m.book?.cash ?? 0);
async function fill(uid: string, mid: string, kind: string, price: number, units: number, amount: number, fee: number, equity: number, note: string) {
  await q("insert into trading_fills (user_id, mandate_id, t, kind, price, units, aud, fee, equity, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [uid, mid, now(), kind, price, units, amount, fee, equity, note]);
}
async function teo(uid: string, action: string, result = "") { await logEvent(uid, "Teo (trading)", action, result); }

export async function createLive(uid: string, m: { capital: number; floor: number; target: number }, liveFrom: Date) {
  const err = validate(m); if (err) throw new Error(err);
  if (!tradeConfigured()) throw new Error("Falta la clave de operación (KRAKEN_TRADE_KEY y KRAKEN_TRADE_SECRET) en Vercel.");
  if (!(liveFrom instanceof Date) || isNaN(liveFrom.getTime())) throw new Error("Fecha de inicio inválida.");
  const open = await q("select id from trading_mandates where user_id=$1 and status in ('active','paused')", [uid]);
  if (open.length) throw new Error("Ya hay un mandato en curso. Terminalo antes de crear otro.");
  const bal = await balanceWith(krakenConfigured() ? "read" : "trade");
  const audFree = Number(bal.ZAUD ?? bal.AUD ?? 0);
  if (audFree + 0.01 < m.capital) throw new Error(`En Kraken hay ${aud(audFree)} y el mandato necesita ${aud(m.capital)}.`);
  await q("insert into trading_mandates (user_id, mode, capital, floor, target, book, params, last_t, live_from, approve_first) values ($1,'live',$2,$3,$4,$5,$6,0,$7,true)",
    [uid, m.capital, m.floor, m.target, JSON.stringify({ cash: m.capital }), JSON.stringify({ core: CORE, costs: COSTS }), liveFrom]);
  await logEvent(uid, "Vos", `Creaste un mandato con dinero real: ${aud(m.capital)}, piso ${aud(m.floor)}, objetivo ${aud(m.target)}`, `Opera desde ${liveFrom.toISOString()}; hasta entonces, ensayo. La primera orden real requiere tu aprobación.`);
}

async function priceOf(asset: string) {
  const p = await ticker((await resolve(asset)).pair);
  if (!p) throw new KrakenError(`No hay precio para ${asset}.`);
  return p;
}

export async function liveEquity(m: any) {
  const pos = await openPositions(m.id);
  let v = cashOf(m);
  const marks: Record<string, number> = {};
  for (const p of pos) { const px = await ticker(p.pair); if (px) { marks[p.asset] = px; v += p.units * px; } else v += p.units * p.entry; }
  return { equity: v, positions: pos, marks };
}

// Todo lo que el control de riesgo necesita para una compra, leído de Kraken en el momento.
async function buyContext(uid: string, m: any, asset: string) {
  clearTickerCache();
  const p = await resolve(asset), allowed = await allowedAssets(uid);
  const liq = (await liquidity([p]))[p.asset];
  if (!liq) throw new KrakenError(`No hay precio para ${asset}.`);
  const pos = await openPositions(m.id), { equity } = await liveEquity(m);
  const meta = { ordermin: p.ordermin, costmin: p.costmin, lotDecimals: p.lotDecimals, pairDecimals: p.pairDecimals };
  return { p, allowed, liq, pos, equity, meta, price: liq.ask || liq.price };
}

type TradeIn = { asset: string; amount_aud: number; stop_loss: number; take_profit?: number | null; rationale: string };

export async function placeTrade(uid: string, t: TradeIn) {
  const u = await currentUser();
  if (u.paused) throw new Error("El sistema está en pausa: no se abren operaciones.");
  const m = await liveMandate(uid);
  if (!m) throw new Error("No hay un mandato con dinero real en curso.");
  if (m.status !== "active") throw new Error("El mandato está en pausa.");
  const asset = t.asset.toUpperCase();
  if (!t.rationale || t.rationale.trim().length < 20) throw new Error("Explicá el plan de la operación en al menos una oración.");
  const x = await buyContext(uid, m, asset), pair = x.p.pair, price = x.price;
  const c = checkBuy({ floor: Number(m.floor), cash: cashOf(m), positions: x.pos as Pos[], asset, amountAud: t.amount_aud, price, sl: t.stop_loss, tp: t.take_profit ?? null, meta: x.meta, allowed: x.allowed, liq: x.liq, equity: x.equity });
  if (!c.ok) throw new Error(c.error);
  const summary = `Comprar ${c.volume} ${asset} (~${aud(t.amount_aud)}) a mercado, precio ~${price}. Stop ${c.sl}${c.tp ? `, take profit ${c.tp}` : ""}. Peor caso del mandato: ${aud(c.worst)}.`;

  if (m.live_from && new Date(m.live_from).getTime() > now()) {
    await addOrder({ pair, type: "buy", ordertype: "market", volume: String(c.volume) }, true);
    await q("insert into trading_intents (user_id, mandate_id, asset, amount_aud, sl, tp, rationale, status, result) values ($1,$2,$3,$4,$5,$6,$7,'dryrun',$8)",
      [uid, m.id, asset, t.amount_aud, c.sl, c.tp, t.rationale, "Ensayo: Kraken validó la orden sin ejecutarla"]);
    await teo(uid, `Ensayo: ${summary}`, "Kraken validó la orden. No se envió: el mandato opera desde " + new Date(m.live_from).toISOString());
    return { estado: "ensayo", detalle: summary, nota: "Kraken validó la orden sin ejecutarla. Las órdenes reales empiezan en la fecha de inicio del mandato." };
  }
  if (m.approve_first) {
    const pending = await q("select id from trading_intents where mandate_id=$1 and status='pending'", [m.id]);
    if (pending.length) throw new Error("Ya hay una orden esperando la aprobación del usuario.");
    const pr = await q("insert into proposals (user_id,agent_code,level,title,evidence,benefit,effort,risk,next_step) values ($1,'M','urg',$2,$3,$4,$5,$6,$7) returning id",
      [uid, `Primera orden real: comprar ${asset}`, `${summary} Plan: ${t.rationale}`.slice(0, 400), "Empieza el mandato con un stop cargado en Kraken", "1 minuto", `Pérdida máxima de esta operación en el stop: ${aud(t.amount_aud - c.volume * c.sl * (1 - COSTS.fee - COSTS.slip))}`, "Aprobar envía la orden a Kraken; después Teo opera solo dentro de los límites"]);
    await q("insert into trading_intents (user_id, mandate_id, asset, amount_aud, sl, tp, rationale, status, proposal_id) values ($1,$2,$3,$4,$5,$6,$7,'pending',$8)",
      [uid, m.id, asset, t.amount_aud, c.sl, c.tp, t.rationale, pr[0].id]);
    await teo(uid, `Propuso la primera orden real: ${summary}`, "Espera tu aprobación en Decisiones");
    return { estado: "esperando_aprobacion", detalle: summary };
  }
  return executeBuy(uid, m, { asset, amount_aud: t.amount_aud, sl: c.sl, tp: c.tp, rationale: t.rationale }, c.volume, price);
}

async function executeBuy(uid: string, m: any, t: { asset: string; amount_aud: number; sl: number; tp: number | null; rationale: string }, volume: number, refPrice: number) {
  const pr = await resolve(t.asset), pair = pr.pair, meta = { lotDecimals: pr.lotDecimals };
  const o = await addOrder({ pair, type: "buy", ordertype: "market", volume: String(volume) });
  if (!o.txid) throw new Error("Kraken no devolvió el número de orden.");
  const f = await waitFilled(o.txid);
  if (f.volExec <= 0) throw new Error(`La compra no se ejecutó (estado: ${f.status}). Revisá Kraken.`);
  const spent = f.cost + f.fee, units = roundDown(f.volExec, meta.lotDecimals), cash = cashOf(m) - spent;
  await setCash(m.id, cash);
  let slTx: string | null = null;
  try {
    slTx = (await addOrder({ pair, type: "sell", ordertype: "stop-loss", price: String(t.sl), volume: String(units) })).txid;
  } catch (e: any) {
    // Sin stop no se puede quedar abierta: se vende de inmediato.
    const s = await addOrder({ pair, type: "sell", ordertype: "market", volume: String(units) });
    const sf = s.txid ? await waitFilled(s.txid) : null;
    const back = sf ? sf.cost - sf.fee : 0;
    await setCash(m.id, cash + back);
    await teo(uid, `No se pudo cargar el stop de ${t.asset} y se vendió de inmediato`, e?.message || "");
    throw new Error("Kraken rechazó el stop-loss y la posición se cerró por seguridad: " + (e?.message || ""));
  }
  await q("insert into trading_positions (user_id, mandate_id, asset, pair, units, entry, cost_aud, sl, tp, sl_txid, rationale) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [uid, m.id, t.asset, pair, units, f.price || refPrice, spent, t.sl, t.tp, slTx, t.rationale]);
  const eq = (await liveEquity({ ...m, book: { ...m.book, cash } })).equity;
  await fill(uid, m.id, "buy", f.price || refPrice, units, spent, f.fee, eq, `${t.asset}: stop ${t.sl}${t.tp ? `, take profit ${t.tp}` : ""}. ${t.rationale}`.slice(0, 400));
  await teo(uid, `Compró ${units} ${t.asset} a ${f.price || refPrice}`, `Costo ${aud(spent)}, stop ${t.sl} cargado en Kraken${t.tp ? `, take profit ${t.tp}` : ""}`);
  return { estado: "ejecutada", activo: t.asset, unidades: units, precio: f.price || refPrice, costo_aud: spent, stop: t.sl, take_profit: t.tp, efectivo_restante: cash };
}

// Se llama cuando el usuario aprueba la propuesta de la primera orden.
export async function executeIntentForProposal(uid: string, proposalId: string) {
  const it = (await q("select * from trading_intents where proposal_id=$1 and status='pending'", [proposalId]))[0];
  if (!it) return null;
  const m = await liveMandate(uid);
  try {
    if (!m || m.status !== "active") throw new Error("El mandato ya no está activo.");
    if ((await currentUser()).paused) throw new Error("El sistema está en pausa.");
    const asset = it.asset, x = await buyContext(uid, m, asset), price = x.price;
    // Se vuelve a controlar con el precio de ahora: entre la propuesta y tu aprobación pudo moverse.
    const c = checkBuy({ floor: Number(m.floor), cash: cashOf(m), positions: x.pos as Pos[], asset, amountAud: Number(it.amount_aud), price, sl: Number(it.sl), tp: it.tp === null ? null : Number(it.tp), meta: x.meta, allowed: x.allowed, liq: x.liq, equity: x.equity });
    if (!c.ok) throw new Error("Con el precio actual ya no cumple los límites: " + c.error);
    const r = await executeBuy(uid, m, { asset, amount_aud: Number(it.amount_aud), sl: c.sl, tp: c.tp, rationale: it.rationale }, c.volume, price);
    await q("update trading_intents set status='executed', result=$2 where id=$1", [it.id, `Compró ${r.unidades} ${asset} a ${r.precio}`]);
    await q("update trading_mandates set approve_first=false where id=$1", [m.id]);
    return { ok: true as const, result: r };
  } catch (e: any) {
    await q("update trading_intents set status='failed', result=$2 where id=$1", [it.id, e?.message || "Error"]);
    await teo(uid, "No se pudo ejecutar la orden aprobada", e?.message || "");
    return { ok: false as const, error: e?.message || "No se pudo ejecutar." };
  }
}
export async function rejectIntentForProposal(proposalId: string) {
  await q("update trading_intents set status='rejected', result='Rechazada por el usuario' where proposal_id=$1 and status='pending'", [proposalId]);
}

async function sellPosition(uid: string, m: any, p: any, reason: string, kind = "sell") {
  if (p.sl_txid) { try { await cancelOrder(p.sl_txid); } catch { /* ya ejecutada o cancelada */ } }
  // Si el stop se ejecutó justo antes de cancelarlo, no se vende dos veces.
  if (p.sl_txid) {
    const st = await queryOrder(p.sl_txid).catch(() => null);
    if (st && st.status === "closed" && st.volExec > 0) return closeFromStop(uid, m, p, st);
  }
  const s = await addOrder({ pair: p.pair, type: "sell", ordertype: "market", volume: String(p.units) });
  const f = s.txid ? await waitFilled(s.txid) : null;
  if (!f || f.volExec <= 0) throw new Error(`La venta de ${p.asset} no se ejecutó.`);
  const back = f.cost - f.fee, cash = cashOf(m) + back; m.book = { ...m.book, cash };
  await setCash(m.id, cash);
  await q("update trading_positions set status='closed', close_reason=$2, exit_price=$3, proceeds_aud=$4, closed_at=now() where id=$1", [p.id, reason, f.price, back]);
  await fill(uid, m.id, kind, f.price, p.units, back, f.fee, cash, `${p.asset}: ${reason}`);
  await teo(uid, `Vendió ${p.units} ${p.asset} a ${f.price}`, `${reason}. Resultado: ${aud(back - p.cost)}`);
  return back;
}
async function closeFromStop(uid: string, m: any, p: any, st: { cost: number; fee: number; price: number }) {
  const back = st.cost - st.fee, cash = cashOf(m) + back; m.book = { ...m.book, cash };
  await setCash(m.id, cash);
  await q("update trading_positions set status='closed', close_reason='stop-loss ejecutado en Kraken', exit_price=$2, proceeds_aud=$3, closed_at=now() where id=$1", [p.id, st.price, back]);
  await fill(uid, m.id, "stop", st.price, p.units, back, st.fee, cash, `${p.asset}: se ejecutó el stop-loss en Kraken`);
  await teo(uid, `Se ejecutó el stop de ${p.asset} a ${st.price}`, `Resultado: ${aud(back - p.cost)}`);
  return back;
}

export async function closePosition(uid: string, asset: string, reason: string) {
  const m = await liveMandate(uid); if (!m) throw new Error("No hay un mandato con dinero real en curso.");
  const p = (await openPositions(m.id)).find((x) => x.asset === asset.toUpperCase());
  if (!p) throw new Error(`No hay posición abierta en ${asset}.`);
  const back = await sellPosition(uid, m, p, reason || "Cierre decidido por Teo");
  return { estado: "cerrada", activo: p.asset, recibido_aud: back, resultado_aud: back - p.cost };
}

export async function moveStop(uid: string, asset: string, newSl: number) {
  const m = await liveMandate(uid); if (!m) throw new Error("No hay un mandato con dinero real en curso.");
  if ((await currentUser()).paused) throw new Error("El sistema está en pausa.");
  const pos = await openPositions(m.id), p = pos.find((x) => x.asset === asset.toUpperCase());
  if (!p) throw new Error(`No hay posición abierta en ${asset}.`);
  clearTickerCache();
  const meta = await pairMeta(p.pair), price = await priceOf(p.asset), sl = Math.round(newSl * 10 ** meta.pairDecimals) / 10 ** meta.pairDecimals;
  const c = checkStopMove(Number(m.floor), cashOf(m), pos as Pos[], p.asset, sl, price);
  if (!c.ok) throw new Error(c.error);
  // Primero se carga el stop nuevo y después se cancela el viejo, para no quedar nunca sin protección.
  const nt = (await addOrder({ pair: p.pair, type: "sell", ordertype: "stop-loss", price: String(sl), volume: String(p.units) })).txid;
  if (p.sl_txid) { try { await cancelOrder(p.sl_txid); } catch { /* ya no existía */ } }
  await q("update trading_positions set sl=$2, sl_txid=$3 where id=$1", [p.id, sl, nt]);
  await teo(uid, `Movió el stop de ${p.asset} de ${p.sl} a ${sl}`, `Peor caso del mandato: ${aud(c.worst)}`);
  return { estado: "stop_actualizado", activo: p.asset, stop: sl };
}

async function toUsdc(uid: string, m: any) {
  const cash = cashOf(m);
  try {
    const px = await ticker("USDCAUD"); if (!px) throw new Error("Kraken no ofrece USDC/AUD.");
    const meta = await pairMeta("USDCAUD"), vol = roundDown((cash * (1 - COSTS.fee)) / (px * 1.002), meta.lotDecimals);
    const o = await addOrder({ pair: "USDCAUD", type: "buy", ordertype: "market", volume: String(vol) });
    const f = o.txid ? await waitFilled(o.txid) : null;
    if (!f || f.volExec <= 0) throw new Error("La compra de USDC no se ejecutó.");
    await fill(uid, m.id, "target", f.price, f.volExec, f.cost + f.fee, f.fee, f.cost, `Pasó ${aud(f.cost + f.fee)} a ${f.volExec} USDC`);
    await setCash(m.id, cash - f.cost - f.fee);
    return `${f.volExec} USDC`;
  } catch (e: any) {
    await teo(uid, "No se pudo pasar a USDC; el dinero queda en AUD", e?.message || "");
    return null;
  }
}

async function finish(uid: string, m: any, status: "target" | "floor" | "ended", reason: string) {
  for (const p of await openPositions(m.id)) await sellPosition(uid, m, p, reason, status === "floor" ? "floor" : "sell");
  const total = cashOf(m);
  let usdc: string | null = null;
  if (status === "target") usdc = await toUsdc(uid, m);
  await q("update trading_mandates set status=$2, ended_at=now(), book = jsonb_set(book, '{endValue}', to_jsonb($3::float8)) where id=$1", [m.id, status, total]);
  if (status !== "ended")
    await q("insert into proposals (user_id,agent_code,level,title,evidence,benefit,effort,risk,next_step) values ($1,'M',$2,$3,$4,$5,$6,$7,$8)",
      [uid, status === "target" ? "rev" : "urg", status === "target" ? "El mandato real llegó al objetivo" : "El mandato real tocó el piso",
        `Se cerraron todas las posiciones. Resultado: ${aud(total)}${usdc ? `, pasado a ${usdc}` : " en AUD"} sobre un capital de ${aud(Number(m.capital))}.`,
        status === "target" ? "Ganancia asegurada en USDC" : "Se cortó la pérdida en el límite que fijaste", "15 minutos", "Ninguno: el mandato está detenido", "Revisar las operaciones en Trading y decidir el próximo paso"]);
  await teo(uid, `El mandato terminó: ${reason}`, `Resultado ${aud(total)}${usdc ? ` (${usdc})` : ""}`);
}

// Concilia con Kraken: stops ejecutados, take profits, objetivo y piso. Lo corren Teo, la vigilancia y el botón de sincronizar.
export async function reconcileLive(uid: string): Promise<string | null> {
  const m = await liveMandate(uid);
  if (!m) return null;
  if (m.live_from && new Date(m.live_from).getTime() > now()) return "Mandato real en ensayo hasta " + new Date(m.live_from).toISOString();
  clearTickerCache();
  const notes: string[] = [];
  for (const p of await openPositions(m.id)) {
    const st = p.sl_txid ? await queryOrder(p.sl_txid).catch(() => null) : null;
    if (st && st.status === "closed" && st.volExec > 0) { await closeFromStop(uid, m, p, st); notes.push(`stop de ${p.asset} ejecutado`); continue; }
    const px = await ticker(p.pair);
    if (st && (st.status === "canceled" || st.status === "expired")) {
      // Alguien canceló el stop en Kraken: se vuelve a cargar, o se vende si el precio ya está debajo.
      if (px && px > p.sl * (1 + 0.002)) {
        const nt = (await addOrder({ pair: p.pair, type: "sell", ordertype: "stop-loss", price: String(p.sl), volume: String(p.units) })).txid;
        await q("update trading_positions set sl_txid=$2 where id=$1", [p.id, nt]); notes.push(`stop de ${p.asset} recargado`);
        await teo(uid, `El stop de ${p.asset} no estaba en Kraken y se volvió a cargar`, `Stop ${p.sl}`);
      } else { await sellPosition(uid, m, p, "Stop ausente y precio debajo del stop"); notes.push(`${p.asset} vendido sin stop`); }
      continue;
    }
    if (px && p.tp && px >= p.tp) { await sellPosition(uid, m, p, `Take profit alcanzado (${p.tp})`); notes.push(`take profit de ${p.asset}`); }
  }
  const fresh = (await q("select * from trading_mandates where id=$1", [m.id]))[0];
  const { equity } = await liveEquity(fresh);
  await q("insert into trading_equity (mandate_id, t, equity, price) values ($1,$2,$3,0) on conflict do nothing", [m.id, now(), equity]);
  const end = mandateEnd(equity, Number(m.floor), Number(m.target));
  if (end) { await finish(uid, fresh, end, end === "target" ? `objetivo de ${aud(Number(m.target))} alcanzado` : `piso de ${aud(Number(m.floor))} alcanzado`); notes.push(end === "target" ? "objetivo alcanzado" : "piso alcanzado"); }
  return `Mandato real: patrimonio ${aud(equity)}` + (notes.length ? ` (${notes.join(", ")})` : "");
}

export async function endLive(uid: string) {
  const m = await liveMandate(uid); if (!m) throw new Error("No hay un mandato con dinero real en curso.");
  await finish(uid, m, "ended", "lo terminaste desde el tablero");
}

// Datos de mercado para que Teo decida: precio y estadísticas diarias de cada moneda permitida.
export async function marketSnapshot(uid: string, assets?: string[]) {
  const out: any[] = [];
  const list = (assets && assets.length ? assets : await allowedAssets(uid)).map((a) => a.toUpperCase()).slice(0, 12);
  for (const asset of list) {
    let pair = asset;
    try {
      pair = (await resolve(asset)).pair;
      const h = await ohlcDaily(pair), n = h.length, c = h.map((x) => x.c), last = c[n - 1];
      const sma = (k: number) => c.slice(-k).reduce((a, b) => a + b, 0) / k;
      let atr = 0; for (let i = n - 14; i < n; i++) atr += Math.max(h[i].h - h[i].l, Math.abs(h[i].h - h[i - 1].c), Math.abs(h[i].l - h[i - 1].c)); atr /= 14;
      const ch = (k: number) => last / c[n - 1 - k] - 1;
      const live = await ticker(pair);
      out.push({ moneda: asset, par: pair, precio_actual: live, cierre_diario: last, cambio_1d: ch(1), cambio_7d: ch(7), cambio_30d: ch(30), media_20d: sma(20), media_50d: sma(50), media_200d: n >= 200 ? sma(200) : null,
        atr_14d: atr, atr_pct: atr / last, maximo_30d: Math.max(...h.slice(-30).map((x) => x.h)), minimo_30d: Math.min(...h.slice(-30).map((x) => x.l)) });
    } catch (e: any) { out.push({ moneda: asset, par: pair, error: e?.message || "sin datos" }); }
  }
  return out;
}

export async function liveState(uid: string, m: any) {
  const { equity, positions, marks } = await liveEquity(m);
  const intents = await q("select asset, amount_aud::float8 as amount, sl::float8 as sl, tp::float8 as tp, rationale, status, result, created_at from trading_intents where mandate_id=$1 order by created_at desc limit 20", [m.id]);
  const closed = await q("select asset, units::float8 as units, entry::float8 as entry, exit_price::float8 as exit, cost_aud::float8 as cost, proceeds_aud::float8 as proceeds, close_reason, closed_at from trading_positions where mandate_id=$1 and status='closed' order by closed_at desc limit 30", [m.id]);
  return {
    equity, cash: cashOf(m), liveFrom: m.live_from, rehearsal: !!(m.live_from && new Date(m.live_from).getTime() > now()), approveFirst: m.approve_first,
    allowed: await allowedAssets(m.user_id),
    watch: await watchlist(m.user_id),
    positions: positions.map((p) => ({ asset: p.asset, units: p.units, entry: p.entry, cost: p.cost, sl: p.sl, tp: p.tp, mark: marks[p.asset] ?? null, rationale: p.rationale, opened: p.opened_at })),
    intents, closed,
  };
}

// Prueba de claves sin mover dinero: consulta saldos y pide a Kraken que valide (no ejecute) una orden mínima.
export async function checkKeys() {
  const res: { read?: string; trade?: string } = {};
  if (krakenConfigured()) { try { const b = await balanceWith("read"); res.read = `ok: AUD ${Math.round(Number(b.ZAUD ?? b.AUD ?? 0))} disponibles`; } catch (e: any) { res.read = "error: " + e.message; } }
  else res.read = "sin configurar";
  if (tradeConfigured()) {
    try {
      await balanceWith("trade");
      const meta = await pairMeta("XBTAUD");
      await addOrder({ pair: "XBTAUD", type: "buy", ordertype: "market", volume: String(meta.ordermin) }, true);
      res.trade = "ok: consulta saldos y Kraken valida órdenes (validación sin ejecutar)";
    } catch (e: any) { res.trade = "error: " + e.message; }
  } else res.trade = "sin configurar";
  return res;
}
