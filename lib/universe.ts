import { base, explain, normAsset, displayAsset, ticker, KrakenError } from "./kraken";
import { q } from "./db";

// Universo operable: todos los pares al contado de Kraken que cotizan en AUD o en USD, menos monedas fiat y estables.
// BTC, ETH, SOL y XRP se operan contra AUD; el resto, contra USD si existe (ahí está la liquidez) y si no contra AUD.
// Las de CORE siempre están permitidas; el resto, solo si el investigador (N) las puso en la lista vigente.
export const CORE = ["BTC", "ETH", "SOL", "XRP"];
const NOT_TRADED = new Set(["AUD", "USD", "EUR", "GBP", "CAD", "CHF", "JPY", "USDT", "USDC", "DAI", "PYUSD", "USDG", "TUSD", "USDS", "RLUSD", "EURC", "EURT", "FDUSD", "USDE", "USDQ", "USDR", "AUDX", "AUDD", "USD1", "EURQ", "EURR", "GHO", "FRAX", "LUSD", "USDP", "GUSD", "UST", "AUSD", "FIDD", "BRL1", "EUROP", "USDF", "TBTC"]);
export const LIQ = { minVolAud: 150_000, maxSpread: 0.006, maxWeight: 0.35, watchDays: 4, maxWatch: 10 };

export type Quote = "AUD" | "USD";
export type Pair = { asset: string; pair: string; key: string; quote: Quote; ordermin: number; costmin: number; lotDecimals: number; pairDecimals: number };
let cache: { at: number; map: Record<string, Pair> } | null = null;

export async function universe(): Promise<Record<string, Pair>> {
  if (cache && Date.now() - cache.at < 3600_000) return cache.map;
  let j: any;
  try { const r = await fetch(`${base()}/0/public/AssetPairs`, { signal: AbortSignal.timeout(15_000) }); j = await r.json(); }
  catch { throw new KrakenError("No se pudo leer la lista de pares de Kraken."); }
  if (j.error?.length) throw new KrakenError(explain(j.error.join(", ")));
  const both: Record<string, Partial<Record<Quote, Pair>>> = {};
  for (const [key, v] of Object.entries<any>(j.result || {})) {
    const quote = normAsset(v.quote) as Quote;
    if ((quote !== "AUD" && quote !== "USD") || (v.status && v.status !== "online") || String(v.altname).endsWith(".d")) continue;
    const asset = displayAsset(normAsset(v.base));
    if (NOT_TRADED.has(asset)) continue;
    (both[asset] ||= {})[quote] ||= { asset, pair: v.altname, key, quote, ordermin: Number(v.ordermin || 0), costmin: Number(v.costmin || 0), lotDecimals: Number(v.lot_decimals ?? 8), pairDecimals: Number(v.pair_decimals ?? 2) };
  }
  const map: Record<string, Pair> = {};
  for (const [asset, q] of Object.entries(both)) {
    const pick = CORE.includes(asset) ? q.AUD ?? q.USD : q.USD ?? q.AUD;
    if (pick) map[asset] = pick;
  }
  cache = { at: Date.now(), map };
  return map;
}
export async function resolve(asset: string): Promise<Pair> {
  const u = await universe(), p = u[asset.toUpperCase()];
  if (!p) throw new Error(`${asset} no cotiza contra AUD ni USD al contado en Kraken (o es una moneda estable).`);
  return p;
}

// AUD por cada USD, del par AUD/USD de Kraken.
export async function audPerUsd(): Promise<number> {
  const r = await ticker("AUDUSD");
  if (!r) throw new KrakenError("No se pudo leer el tipo de cambio AUD/USD de Kraken.");
  return 1 / r;
}
export const fxOf = (quote: string, k: number) => (quote === "USD" ? k : 1);

export type Liq = { price: number; bid: number; ask: number; spread: number; volAud: number; change24h: number | null };
// Ticker de varios pares en una consulta (hasta 40 por llamada).
export async function liquidity(pairs: Pair[]): Promise<Record<string, Liq>> {
  const out: Record<string, Liq> = {}, byKey: Record<string, Pair> = {};
  const k = pairs.some((p) => p.quote === "USD") ? await audPerUsd() : 1;
  for (const p of pairs) { byKey[p.key] = p; byKey[p.pair] = p; }
  for (let i = 0; i < pairs.length; i += 40) {
    const chunk = pairs.slice(i, i + 40);
    let j: any;
    try { const r = await fetch(`${base()}/0/public/Ticker?pair=${chunk.map((p) => p.pair).join(",")}`, { signal: AbortSignal.timeout(15_000) }); j = await r.json(); }
    catch { throw new KrakenError("No se pudieron leer los precios de Kraken."); }
    if (j.error?.length && !j.result) throw new KrakenError(explain(j.error.join(", ")));
    for (const [key, t] of Object.entries<any>(j.result || {})) {
      const p = byKey[key]; if (!p) continue;
      const bid = +t.b[0], ask = +t.a[0], price = +t.c[0], mid = (bid + ask) / 2, open = Number(t.o);
      out[p.asset] = { price, bid, ask, spread: mid > 0 ? (ask - bid) / mid : 1, volAud: Number(t.v[1]) * Number(t.p[1]) * fxOf(p.quote, k), change24h: open > 0 ? price / open - 1 : null };
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
  for (const it of items) { const p = u[it.asset.toUpperCase()]; if (p) pairs.push(p); else rejected.push(`${it.asset}: no cotiza contra AUD ni USD al contado`); }
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

// Barrido del universo para el investigador: liquidez y cambio 24 h de cada par (precios en la moneda de cotización).
export async function scanMarket(minVolAud = LIQ.minVolAud) {
  const u = Object.values(await universe()), liq = await liquidity(u);
  const rows = u.map((p) => ({ moneda: p.asset, par: p.pair, cotiza_en: p.quote, ...(liq[p.asset] || {}) })).filter((r: any) => r.volAud !== undefined);
  rows.sort((a: any, b: any) => b.volAud - a.volAud);
  return {
    pares: u.length, nota: "Precios en la moneda de cotización de cada par (cotiza_en); volumen convertido a AUD.", filtros: { volumen_24h_min_aud: LIQ.minVolAud, spread_max: LIQ.maxSpread },
    candidatas: rows.filter((r: any) => r.volAud >= minVolAud && r.spread <= LIQ.maxSpread).map((r: any) => ({ moneda: r.moneda, par: r.par, cotiza_en: r.cotiza_en, precio: r.price, volumen_24h_aud: Math.round(r.volAud), spread_pct: +(r.spread * 100).toFixed(3), cambio_24h: r.change24h })),
    descartadas_por_liquidez: rows.filter((r: any) => !(r.volAud >= minVolAud && r.spread <= LIQ.maxSpread)).length,
  };
}
