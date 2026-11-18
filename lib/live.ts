import { q, currentUser, logEvent } from "./db";
import { ticker, clearTickerCache, pairMeta, addOrder, cancelOrder, queryOrder, waitFilled, balanceWith, tradeConfigured, krakenConfigured, ohlcDaily, KrakenError } from "./kraken";
import { COSTS, checkBuy, checkStopMove, mandateEnd, roundDown, slipFor, type Pos } from "./risk";
import { resolve, liquidity, allowedAssets, CORE, watchlist, audPerUsd, fxOf, type Quote } from "./universe";
import { validate } from "./trading";

// Mandato con dinero real. Teo decide qué comprar y dónde poner el stop; este archivo aplica los límites y habla con Kraken.
// Reglas fijas: compras al contado contra AUD o USD; cada posición con stop-loss cargado en Kraken;
// el peor caso con todos los stops ejecutados nunca queda debajo del piso; al objetivo vende todo y pasa a USDC.
// La caja del mandato tiene dos saldos: AUD (book.cash) y USD (book.usd). Todo control de riesgo se hace en AUD.

const aud = (n: number) => "AUD " + new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(n);
const now = () => Date.now();
const r8 = (x: number) => Math.round(x * 1e8) / 1e8;

export async function liveMandate(uid: string) {
  const r = await q("select * from trading_mandates where user_id=$1 and mode='live' and status in ('active','paused') order by created_at desc limit 1", [uid]);
  return r[0] || null;
}
async function openPositions(mid: string) {
  const r = await q("select id, asset, pair, quote, units::float8 as units, entry::float8 as entry, cost_aud::float8 as cost, sl::float8 as sl, tp::float8 as tp, sl_txid, rationale, opened_at from trading_positions where mandate_id=$1 and status='open' order by opened_at", [mid]);
  return r.map((p: any) => ({ ...p, slip: slipFor(p.asset) }));
}
// Para el control de riesgo, los stops en USD se pasan a AUD.
const riskPos = (pos: any[], k: number): Pos[] => pos.map((p) => ({ asset: p.asset, units: p.units, sl: p.sl * fxOf(p.quote, k), slip: p.slip }));

const audOf = (m: any) => Number(m.book?.cash ?? 0);
const usdOf = (m: any) => Number(m.book?.usd ?? 0);
const cashTotal = (m: any, k: number) => audOf(m) + usdOf(m) * k;
async function setBal(m: any, quote: Quote, value: number) {
  const field = quote === "USD" ? "usd" : "cash";
  m.book = { ...m.book, [field]: r8(value) };
  await q(`update trading_mandates set book = jsonb_set(book, '{${field}}', to_jsonb($2::float8)) where id=$1`, [m.id, r8(value)]);
}
const balOf = (m: any, quote: Quote) => (quote === "USD" ? usdOf(m) : audOf(m));
async function fill(uid: string, mid: string, kind: string, price: number, units: number, amount: number, fee: number, equity: number, note: string) {
  await q("insert into trading_fills (user_id, mandate_id, t, kind, price, units, aud, fee, equity, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [uid, mid, now(), kind, price, units, amount, fee, equity, note]);
}
async function teo(uid: string, action: string, result = "") { await logEvent(uid, "Teo (trading)", action, result); }
const needsUsd = async (m: any, pos: any[]) => (usdOf(m) > 0 || pos.some((p) => p.quote === "USD") ? audPerUsd() : 1);

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
    [uid, m.capital, m.floor, m.target, JSON.stringify({ cash: m.capital, usd: 0 }), JSON.stringify({ core: CORE, costs: COSTS }), liveFrom]);
  await logEvent(uid, "Vos", `Creaste un mandato con dinero real: ${aud(m.capital)}, piso ${aud(m.floor)}, objetivo ${aud(m.target)}`, `Opera desde ${liveFrom.toISOString()}; hasta entonces, ensayo. La primera orden real requiere tu aprobación.`);
}

export async function liveEquity(m: any) {
  const pos = await openPositions(m.id), k = await needsUsd(m, pos);
  let v = cashTotal(m, k);
  const marks: Record<string, number> = {};
  for (const p of pos) {
    const px = await ticker(p.pair), fx = fxOf(p.quote, k);
    if (px) { marks[p.asset] = px; v += p.units * px * fx; } else v += p.units * p.entry * fx;
  }
  return { equity: v, positions: pos, marks, k };
}

// Todo lo que el control de riesgo necesita para una compra, leído de Kraken en el momento. Montos en AUD.
async function buyContext(uid: string, m: any, asset: string) {
  clearTickerCache();
  const p = await resolve(asset), allowed = await allowedAssets(uid);
  const liq = (await liquidity([p]))[p.asset];
  if (!liq) throw new KrakenError(`No hay precio para ${asset}.`);
  const { equity, positions, k } = await liveEquity(m);
  const kk = p.quote === "USD" && k === 1 ? await audPerUsd() : k, fx = fxOf(p.quote, kk);
  const priceQ = liq.ask || liq.price;
  // Los decimales del par se aplican al precio en su moneda; en AUD no se vuelve a redondear.
  const meta = { ordermin: p.ordermin, costmin: p.costmin * fx, lotDecimals: p.lotDecimals, pairDecimals: 12 };
  return { p, allowed, liq, pos: riskPos(positions, kk), equity, meta, priceQ, fx, k: kk };
}
const roundQ = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

type TradeIn = { asset: string; amount_aud: number; stop_loss: number; take_profit?: number | null; rationale: string };

// Revisa la compra contra los límites. stop y take profit vienen en la moneda de cotización del par.
async function vet(uid: string, m: any, asset: string, amountAud: number, slQ: number, tpQ: number | null) {
  const x = await buyContext(uid, m, asset);
  const sl = roundQ(slQ, x.p.pairDecimals), tp = tpQ === null ? null : roundQ(tpQ, x.p.pairDecimals);
  const c = checkBuy({ floor: Number(m.floor), cash: cashTotal(m, x.k), positions: x.pos, asset, amountAud, price: x.priceQ * x.fx, sl: sl * x.fx, tp: tp === null ? null : tp * x.fx, meta: x.meta, allowed: x.allowed, liq: x.liq, equity: x.equity });
  return { x, c, sl, tp };
}

export async function placeTrade(uid: string, t: TradeIn) {
  const u = await currentUser();
  if (u.paused) throw new Error("El sistema está en pausa: no se abren operaciones.");
  const m = await liveMandate(uid);
  if (!m) throw new Error("No hay un mandato con dinero real en curso.");
  if (m.status !== "active") throw new Error("El mandato está en pausa.");
  const asset = t.asset.toUpperCase();
  if (!t.rationale || t.rationale.trim().length < 20) throw new Error("Explicá el plan de la operación en al menos una oración.");
  const { x, c, sl, tp } = await vet(uid, m, asset, t.amount_aud, t.stop_loss, t.take_profit ?? null);
  if (!c.ok) throw new Error(c.error);
  const Q = x.p.quote, pair = x.p.pair;
  const summary = `Comprar ${c.volume} ${asset} (~${aud(t.amount_aud)}) a mercado en ${pair}, precio ~${x.priceQ} ${Q}. Stop ${sl} ${Q}${tp ? `, take profit ${tp} ${Q}` : ""}. Peor caso del mandato: ${aud(c.worst)}.`;

  if (m.live_from && new Date(m.live_from).getTime() > now()) {
    await addOrder({ pair, type: "buy", ordertype: "market", volume: String(c.volume) }, true);
    await q("insert into trading_intents (user_id, mandate_id, asset, quote, amount_aud, sl, tp, rationale, status, result) values ($1,$2,$3,$4,$5,$6,$7,$8,'dryrun',$9)",
      [uid, m.id, asset, Q, t.amount_aud, sl, tp, t.rationale, "Ensayo: Kraken validó la orden sin ejecutarla"]);
    await teo(uid, `Ensayo: ${summary}`, "Kraken validó la orden. No se envió: el mandato opera desde " + new Date(m.live_from).toISOString());
    return { estado: "ensayo", detalle: summary, nota: "Kraken validó la orden sin ejecutarla. Las órdenes reales empiezan en la fecha de inicio del mandato." };
  }
  if (m.approve_first) {
    const pending = await q("select id from trading_intents where mandate_id=$1 and status='pending'", [m.id]);
    if (pending.length) throw new Error("Ya hay una orden esperando la aprobación del usuario.");
    const loss = t.amount_aud - c.volume * sl * x.fx * (1 - COSTS.fee - slipFor(asset));
    const pr = await q("insert into proposals (user_id,agent_code,level,title,evidence,benefit,effort,risk,next_step) values ($1,'M','urg',$2,$3,$4,$5,$6,$7) returning id",
      [uid, `Primera orden real: comprar ${asset}`, `${summary} Plan: ${t.rationale}`.slice(0, 400), "Empieza el mandato con un stop cargado en Kraken", "1 minuto", `Pérdida máxima de esta operación en el stop: ${aud(loss)}`, "Aprobar envía la orden a Kraken; después Teo opera solo dentro de los límites"]);
    await q("insert into trading_intents (user_id, mandate_id, asset, quote, amount_aud, sl, tp, rationale, status, proposal_id) values ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)",
      [uid, m.id, asset, Q, t.amount_aud, sl, tp, t.rationale, pr[0].id]);
    await teo(uid, `Propuso la primera orden real: ${summary}`, "Espera tu aprobación en Decisiones");
    return { estado: "esperando_aprobacion", detalle: summary };
  }
  return executeBuy(uid, m, { asset, amount_aud: t.amount_aud, sl, tp, rationale: t.rationale }, c.volume, x.priceQ);
}

// Si a la moneda de cotización le falta saldo, convierte desde la otra con el par AUD/USD.
async function ensureQuote(uid: string, m: any, quote: Quote, need: number) {
  const have = balOf(m, quote);
  if (have >= need) return;
  const k = await audPerUsd(), meta = await pairMeta("AUDUSD"), short = need - have;
  const p = quote === "USD"
    ? { type: "sell", volume: roundDown(short * k * 1.004, meta.lotDecimals) } // vende AUD, recibe USD
    : { type: "buy", volume: roundDown(short * 1.004 + 10 ** -meta.lotDecimals, meta.lotDecimals) }; // compra AUD con USD
  if (p.volume < meta.ordermin) p.volume = meta.ordermin;
  const o = await addOrder({ pair: "AUDUSD", type: p.type, ordertype: "market", volume: String(p.volume) });
  const f = o.txid ? await waitFilled(o.txid) : null;
  if (!f || f.volExec <= 0) throw new Error("No se pudo convertir entre AUD y USD en Kraken.");
  // En AUDUSD el volumen es AUD y el costo es USD.
  if (quote === "USD") { await setBal(m, "AUD", audOf(m) - f.volExec); await setBal(m, "USD", usdOf(m) + f.cost - f.fee); }
  else { await setBal(m, "USD", usdOf(m) - f.cost - f.fee); await setBal(m, "AUD", audOf(m) + f.volExec); }
  await fill(uid, m.id, "fx", f.price, f.volExec, f.volExec, f.fee * k, cashTotal(m, k), quote === "USD" ? `Cambió AUD ${f.volExec} a USD ${r8(f.cost - f.fee)}` : `Cambió USD ${r8(f.cost + f.fee)} a AUD ${f.volExec}`);
}

async function executeBuy(uid: string, m: any, t: { asset: string; amount_aud: number; sl: number; tp: number | null; rationale: string }, volume: number, refPrice: number) {
  const pr = await resolve(t.asset), pair = pr.pair, Q = pr.quote;
  const k = Q === "USD" ? await audPerUsd() : 1;
  await ensureQuote(uid, m, Q, volume * refPrice * 1.008);
  const o = await addOrder({ pair, type: "buy", ordertype: "market", volume: String(volume) });
  if (!o.txid) throw new Error("Kraken no devolvió el número de orden.");
  const f = await waitFilled(o.txid);
  if (f.volExec <= 0) throw new Error(`La compra no se ejecutó (estado: ${f.status}). Revisá Kraken.`);
  const spentQ = f.cost + f.fee, units = roundDown(f.volExec, pr.lotDecimals), spentAud = spentQ * fxOf(Q, k);
  await setBal(m, Q, balOf(m, Q) - spentQ);
  let slTx: string | null = null;
  try {
    slTx = (await addOrder({ pair, type: "sell", ordertype: "stop-loss", price: String(t.sl), volume: String(units) })).txid;
  } catch (e: any) {
    // Sin stop no se puede quedar abierta: se vende de inmediato.
    const s = await addOrder({ pair, type: "sell", ordertype: "market", volume: String(units) });
    const sf = s.txid ? await waitFilled(s.txid) : null;
    await setBal(m, Q, balOf(m, Q) + (sf ? sf.cost - sf.fee : 0));
    await teo(uid, `No se pudo cargar el stop de ${t.asset} y se vendió de inmediato`, e?.message || "");
    throw new Error("Kraken rechazó el stop-loss y la posición se cerró por seguridad: " + (e?.message || ""));
  }
  const price = f.price || refPrice;
  await q("insert into trading_positions (user_id, mandate_id, asset, pair, quote, units, entry, cost_aud, sl, tp, sl_txid, rationale) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [uid, m.id, t.asset, pair, Q, units, price, spentAud, t.sl, t.tp, slTx, t.rationale]);
  const eq = (await liveEquity(m)).equity;
  await fill(uid, m.id, "buy", price, units, spentAud, f.fee * fxOf(Q, k), eq, `${t.asset} (${pair}): stop ${t.sl} ${Q}${t.tp ? `, take profit ${t.tp} ${Q}` : ""}. ${t.rationale}`.slice(0, 400));
  await teo(uid, `Compró ${units} ${t.asset} a ${price} ${Q}`, `Costo ${aud(spentAud)}, stop ${t.sl} ${Q} cargado en Kraken${t.tp ? `, take profit ${t.tp} ${Q}` : ""}`);
  return { estado: "ejecutada", activo: t.asset, par: pair, unidades: units, precio: price, moneda: Q, costo_aud: spentAud, stop: t.sl, take_profit: t.tp, caja_aud: audOf(m), caja_usd: usdOf(m) };
}

// Se llama cuando el usuario aprueba la propuesta de la primera orden.
export async function executeIntentForProposal(uid: string, proposalId: string) {
  const it = (await q("select * from trading_intents where proposal_id=$1 and status='pending'", [proposalId]))[0];
  if (!it) return null;
  const m = await liveMandate(uid);
  try {
    if (!m || m.status !== "active") throw new Error("El mandato ya no está activo.");
    if ((await currentUser()).paused) throw new Error("El sistema está en pausa.");
    // Se vuelve a controlar con el precio de ahora: entre la propuesta y tu aprobación pudo moverse.
    const { x, c, sl, tp } = await vet(uid, m, it.asset, Number(it.amount_aud), Number(it.sl), it.tp === null ? null : Number(it.tp));
    if (!c.ok) throw new Error("Con el precio actual ya no cumple los límites: " + c.error);
    const r = await executeBuy(uid, m, { asset: it.asset, amount_aud: Number(it.amount_aud), sl, tp, rationale: it.rationale }, c.volume, x.priceQ);
    await q("update trading_intents set status='executed', result=$2 where id=$1", [it.id, `Compró ${r.unidades} ${it.asset} a ${r.precio} ${r.moneda}`]);
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

async function booked(uid: string, m: any, p: any, f: { cost: number; fee: number; price: number }, kind: string, reason: string) {
  const k = p.quote === "USD" ? await audPerUsd() : 1, fx = fxOf(p.quote, k), backQ = f.cost - f.fee, backAud = backQ * fx;
  await setBal(m, p.quote, balOf(m, p.quote) + backQ);
  await q("update trading_positions set status='closed', close_reason=$2, exit_price=$3, proceeds_aud=$4, closed_at=now() where id=$1", [p.id, reason, f.price, backAud]);
  await fill(uid, m.id, kind, f.price, p.units, backAud, f.fee * fx, cashTotal(m, k), `${p.asset}: ${reason}`);
  await teo(uid, kind === "stop" ? `Se ejecutó el stop de ${p.asset} a ${f.price} ${p.quote}` : `Vendió ${p.units} ${p.asset} a ${f.price} ${p.quote}`, `${kind === "stop" ? "" : reason + ". "}Resultado: ${aud(backAud - p.cost)}`);
  return backAud;
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
  return booked(uid, m, p, f, kind, reason);
}
async function closeFromStop(uid: string, m: any, p: any, st: { cost: number; fee: number; price: number }) {
  return booked(uid, m, p, st, "stop", "stop-loss ejecutado en Kraken");
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
  const k = await needsUsd(m, pos), fx = fxOf(p.quote, k);
  const meta = await pairMeta(p.pair), price = await ticker(p.pair);
  if (!price) throw new KrakenError(`No hay precio para ${p.asset}.`);
  const sl = roundQ(newSl, meta.pairDecimals);
  const c = checkStopMove(Number(m.floor), cashTotal(m, k), riskPos(pos, k), p.asset, sl * fx, price * fx);
  if (!c.ok) throw new Error(c.error);
  // Primero se carga el stop nuevo y después se cancela el viejo, para no quedar nunca sin protección.
  const nt = (await addOrder({ pair: p.pair, type: "sell", ordertype: "stop-loss", price: String(sl), volume: String(p.units) })).txid;
  if (p.sl_txid) { try { await cancelOrder(p.sl_txid); } catch { /* ya no existía */ } }
  await q("update trading_positions set sl=$2, sl_txid=$3 where id=$1", [p.id, sl, nt]);
  await teo(uid, `Movió el stop de ${p.asset} de ${p.sl} a ${sl} ${p.quote}`, `Peor caso del mandato: ${aud(c.worst)}`);
  return { estado: "stop_actualizado", activo: p.asset, stop: sl, moneda: p.quote };
}

// Al objetivo: cada saldo pasa a USDC por su par (USDC/AUD y USDC/USD).
async function toUsdc(uid: string, m: any) {
  const got: string[] = [];
  for (const Q of ["AUD", "USD"] as Quote[]) {
    const bal = balOf(m, Q), pair = "USDC" + Q;
    if (bal < 5) continue;
    try {
      const px = await ticker(pair); if (!px) throw new Error(`Kraken no ofrece ${pair}.`);
      const meta = await pairMeta(pair), vol = roundDown((bal * (1 - COSTS.fee)) / (px * 1.002), meta.lotDecimals);
      const o = await addOrder({ pair, type: "buy", ordertype: "market", volume: String(vol) });
      const f = o.txid ? await waitFilled(o.txid) : null;
      if (!f || f.volExec <= 0) throw new Error(`La compra de USDC con ${Q} no se ejecutó.`);
      await setBal(m, Q, bal - f.cost - f.fee);
      await fill(uid, m.id, "target", f.price, f.volExec, f.cost + f.fee, f.fee, f.cost, `Pasó ${Q} ${r8(f.cost + f.fee)} a ${f.volExec} USDC`);
      got.push(`${f.volExec} USDC`);
    } catch (e: any) { await teo(uid, `No se pudo pasar el saldo en ${Q} a USDC; queda en ${Q}`, e?.message || ""); }
  }
  return got.length ? got.join(" + ") : null;
}

async function finish(uid: string, m: any, status: "target" | "floor" | "ended", reason: string) {
  for (const p of await openPositions(m.id)) await sellPosition(uid, m, p, reason, status === "floor" ? "floor" : "sell");
  const k = usdOf(m) > 0 ? await audPerUsd() : 1, total = cashTotal(m, k);
  let usdc: string | null = null;
  if (status === "target") usdc = await toUsdc(uid, m);
  await q("update trading_mandates set status=$2, ended_at=now(), book = jsonb_set(book, '{endValue}', to_jsonb($3::float8)) where id=$1", [m.id, status, total]);
  if (status !== "ended")
    await q("insert into proposals (user_id,agent_code,level,title,evidence,benefit,effort,risk,next_step) values ($1,'M',$2,$3,$4,$5,$6,$7,$8)",
      [uid, status === "target" ? "rev" : "urg", status === "target" ? "El mandato real llegó al objetivo" : "El mandato real tocó el piso",
        `Se cerraron todas las posiciones. Resultado: ${aud(total)}${usdc ? `, pasado a ${usdc}` : " en AUD/USD"} sobre un capital de ${aud(Number(m.capital))}.`,
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
        await teo(uid, `El stop de ${p.asset} no estaba en Kraken y se volvió a cargar`, `Stop ${p.sl} ${p.quote}`);
      } else { await sellPosition(uid, m, p, "Stop ausente y precio debajo del stop"); notes.push(`${p.asset} vendido sin stop`); }
      continue;
    }
    if (px && p.tp && px >= p.tp) { await sellPosition(uid, m, p, `Take profit alcanzado (${p.tp} ${p.quote})`); notes.push(`take profit de ${p.asset}`); }
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
    let pair = asset, quote = "";
    try {
      const rp = await resolve(asset); pair = rp.pair; quote = rp.quote;
      const h = await ohlcDaily(pair), n = h.length, c = h.map((x) => x.c), last = c[n - 1];
      const sma = (k: number) => c.slice(-k).reduce((a, b) => a + b, 0) / k;
      let atr = 0; for (let i = n - 14; i < n; i++) atr += Math.max(h[i].h - h[i].l, Math.abs(h[i].h - h[i - 1].c), Math.abs(h[i].l - h[i - 1].c)); atr /= 14;
      const ch = (k: number) => last / c[n - 1 - k] - 1;
      const live = await ticker(pair);
      out.push({ moneda: asset, par: pair, cotiza_en: quote, precio_actual: live, cierre_diario: last, cambio_1d: ch(1), cambio_7d: ch(7), cambio_30d: ch(30), media_20d: sma(20), media_50d: sma(50), media_200d: n >= 200 ? sma(200) : null,
        atr_14d: atr, atr_pct: atr / last, maximo_30d: Math.max(...h.slice(-30).map((x) => x.h)), minimo_30d: Math.min(...h.slice(-30).map((x) => x.l)) });
    } catch (e: any) { out.push({ moneda: asset, par: pair, error: e?.message || "sin datos" }); }
  }
  return out;
}

export async function liveState(uid: string, m: any) {
  const { equity, positions, marks, k } = await liveEquity(m);
  const intents = await q("select asset, quote, amount_aud::float8 as amount, sl::float8 as sl, tp::float8 as tp, rationale, status, result, created_at from trading_intents where mandate_id=$1 order by created_at desc limit 20", [m.id]);
  const closed = await q("select asset, units::float8 as units, entry::float8 as entry, exit_price::float8 as exit, cost_aud::float8 as cost, proceeds_aud::float8 as proceeds, close_reason, closed_at from trading_positions where mandate_id=$1 and status='closed' order by closed_at desc limit 30", [m.id]);
  return {
    equity, cash: cashTotal(m, k), cashAud: audOf(m), cashUsd: usdOf(m), audPerUsd: k, liveFrom: m.live_from, rehearsal: !!(m.live_from && new Date(m.live_from).getTime() > now()), approveFirst: m.approve_first,
    allowed: await allowedAssets(m.user_id),
    watch: await watchlist(m.user_id),
    positions: positions.map((p) => ({ asset: p.asset, pair: p.pair, quote: p.quote, fx: fxOf(p.quote, k), units: p.units, entry: p.entry, cost: p.cost, sl: p.sl, tp: p.tp, mark: marks[p.asset] ?? null, rationale: p.rationale, opened: p.opened_at })),
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
