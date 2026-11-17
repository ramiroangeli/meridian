import { base, explain, normAsset, displayAsset, KrakenError } from "./kraken";
import { q } from "./db";

// Universo operable: todos los pares al contado de Kraken que cotizan en AUD, menos monedas fiat y estables.
// Las de CORE siempre están permitidas; el resto, solo si el investigador (N) las puso en la lista vigente.
export const CORE = ["BTC", "ETH", "SOL", "XRP"];
const NOT_TRADED = new Set(["AUD", "USD", "EUR", "GBP", "CAD", "CHF", "JPY", "USDT", "USDC", "DAI", "PYUSD", "USDG", "TUSD", "USDS", "RLUSD", "EURC", "EURT", "FDUSD", "USDE", "USDQ", "USDR"]);
export const LIQ = { minVolAud: 150_000, maxSpread: 0.006, maxWeight: 0.35, watchDays: 4, maxWatch: 10 };

export type Pair = { asset: string; pair: string; key: string; ordermin: number; costmin: number; lotDecimals: number; pairDecimals: number };
let cache: { at: number; map: Record<string, Pair> } | null = null;

export async function universe(): Promise<Record<string, Pair>> {
  if (cache && Date.now() - cache.at < 3600_000) return cache.map;
  let j: any;
  try { const r = await fetch(`${base()}/0/public/AssetPairs`, { signal: AbortSignal.timeout(15_000) }); j = await r.json(); }
  catch { throw new KrakenError("No se pudo leer la lista de pares de Kraken."); }
  if (j.error?.length) throw new KrakenError(explain(j.error.join(", ")));
  const map: Record<string, Pair> = {};
  for (const [key, v] of Object.entries<any>(j.result || {})) {
    if (normAsset(v.quote) !== "AUD" || (v.status && v.status !== "online") || String(v.altname).endsWith(".d")) continue;
    const asset = displayAsset(normAsset(v.base));
    if (NOT_TRADED.has(asset) || map[asset]) continue;
    map[asset] = { asset, pair: v.altname, key, ordermin: Number(v.ordermin || 0), costmin: Number(v.costmin || 0), lotDecimals: Number(v.lot_decimals ?? 8), pairDecimals: Number(v.pair_decimals ?? 2) };
  }
  cache = { at: Date.now(), map };
  return map;
}
export async function resolve(asset: string): Promise<Pair> {
  const u = await universe(), p = u[asset.toUpperCase()];
  if (!p) throw new Error(`${asset} no cotiza contra AUD al contado en Kraken (o es una moneda estable).`);
  return p;
}

export type Liq = { price: number; bid: number; ask: number; spread: number; volAud: number; change24h: number | null };
// Ticker de varios pares en una consulta (hasta 40 por llamada).
export async function liquidity(pairs: Pair[]): Promise<Record<string, Liq>> {
  const out: Record<string, Liq> = {}, byKey: Record<string, Pair> = {};
  for (const p of pairs) { byKey[p.key] = p; byKey[p.pair] = p; }
  for (let i = 0; i < pairs.length; i += 40) {
    const chunk = pairs.slice(i, i + 40);
    let j: any;
    try { const r = await fetch(`${base()}/0/public/Ticker?pair=${chunk.map((p) => p.pair).join(",")}`, { signal: AbortSignal.timeout(15_000) }); j = await r.json(); }
    catch { throw new KrakenError("No se pudieron leer los precios de Kraken."); }
    if (j.error?.length && !j.result) throw new KrakenError(explain(j.error.join(", ")));
    for (const [k, t] of Object.entries<any>(j.result || {})) {
      const p = byKey[k]; if (!p) continue;
      const bid = +t.b[0], ask = +t.a[0], price = +t.c[0], mid = (bid + ask) / 2, open = Number(t.o);
      out[p.asset] = { price, bid, ask, spread: mid > 0 ? (ask - bid) / mid : 1, volAud: Number(t.v[1]) * Number(t.p[1]), change24h: open > 0 ? price / open - 1 : null };
    }
  }
  return out;
}
export const liquid = (l: Liq | undefined) => !!l && l.volAud >= LIQ.minVolAud && l.spread <= LIQ.maxSpread;

export async function watchlist(uid: string) {
  return q("select asset, pair, thesis, agent_code, created_at, expires_at from trading_watchlist where user_id=$1 and expires_at > now() order by created_at", [uid]);
}
export async function allowedAssets(uid: string) {
  const w = await watchlist(uid);
  return [...new Set([...CORE, ...w.map((x: any) => x.asset)])];
}

// El investigador reemplaza la lista entera. Solo entran monedas que hoy pasan los filtros de liquidez.
export async function setWatchlist(uid: string, agent: string, items: { asset: string; thesis: string }[]) {
  if (items.length > LIQ.maxWatch) throw new Error(`Máximo ${LIQ.maxWatch} monedas en la lista.`);
  const u = await universe(), pairs: Pair[] = [], rejected: string[] = [];
  for (const it of items) { const p = u[it.asset.toUpperCase()]; if (p) pairs.push(p); else rejected.push(`${it.asset}: no cotiza contra AUD al contado`); }
  const liq = await liquidity(pairs), ok: { p: Pair; thesis: string }[] = [];
  for (const p of pairs) {
    const l = liq[p.asset], th = items.find((i) => i.asset.toUpperCase() === p.asset)!.thesis;
    if (!liquid(l)) rejected.push(`${p.asset}: ${!l ? "sin precio" : l.volAud < LIQ.minVolAud ? `volumen 24 h AUD ${Math.round(l.volAud)} (mínimo ${LIQ.minVolAud})` : `spread ${(l.spread * 100).toFixed(2)}% (máximo ${LIQ.maxSpread * 100}%)`}`);
    else ok.push({ p, thesis: th });
  }
  await q("delete from trading_watchlist where user_id=$1", [uid]);
  for (const x of ok)
    await q(`insert into trading_watchlist (user_id, asset, pair, thesis, agent_code, expires_at) values ($1,$2,$3,$4,$5, now() + interval '${LIQ.watchDays} days')`, [uid, x.p.asset, x.p.pair, x.thesis, agent]);
  return { lista: ok.map((x) => x.p.asset), rechazadas: rejected, vence_en_dias: LIQ.watchDays };
}

// Barrido del universo para el investigador: liquidez y cambio 24 h de cada par AUD.
export async function scanMarket(minVolAud = LIQ.minVolAud) {
  const u = Object.values(await universe()), liq = await liquidity(u);
  const rows = u.map((p) => ({ moneda: p.asset, par: p.pair, ...(liq[p.asset] || {}) })).filter((r: any) => r.volAud !== undefined);
  rows.sort((a: any, b: any) => b.volAud - a.volAud);
  return {
    pares_aud: u.length, filtros: { volumen_24h_min_aud: LIQ.minVolAud, spread_max: LIQ.maxSpread },
    candidatas: rows.filter((r: any) => r.volAud >= minVolAud && r.spread <= LIQ.maxSpread).map((r: any) => ({ moneda: r.moneda, precio: r.price, volumen_24h_aud: Math.round(r.volAud), spread_pct: +(r.spread * 100).toFixed(3), cambio_24h: r.change24h })),
    descartadas_por_liquidez: rows.filter((r: any) => !(r.volAud >= minVolAud && r.spread <= LIQ.maxSpread)).length,
  };
}
