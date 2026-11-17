import { createHash, createHmac } from "node:crypto";

// Cliente mínimo de Kraken: solo lectura. No hay ninguna función para operar ni retirar.
export const base = () => process.env.KRAKEN_API_BASE || "https://api.kraken.com";
export const krakenConfigured = () => !!(process.env.KRAKEN_API_KEY && process.env.KRAKEN_API_SECRET);
export const tradeConfigured = () => !!(process.env.KRAKEN_TRADE_KEY && process.env.KRAKEN_TRADE_SECRET);

export class KrakenError extends Error {}

// Firma oficial de Kraken: HMAC-SHA512(ruta + SHA256(nonce + cuerpo)) con el secreto decodificado en base64.
export function krakenSign(path: string, nonce: string, body: string, secretB64: string): string {
  const digest = createHash("sha256").update(nonce + body).digest();
  return createHmac("sha512", Buffer.from(secretB64, "base64")).update(Buffer.concat([Buffer.from(path), digest])).digest("base64");
}

let lastNonce = 0;
function nonce() { const n = Math.max(Date.now() * 1000, lastNonce + 1); lastNonce = n; return String(n); }

const ERRORS: [RegExp, string][] = [
  [/Invalid key/i, "La clave de API no es válida. Revisá KRAKEN_API_KEY en Vercel."],
  [/Invalid signature/i, "La firma no coincide. Revisá que KRAKEN_API_SECRET esté completo."],
  [/Invalid nonce/i, "Kraken rechazó el nonce. Usá una clave exclusiva para Meridiano, distinta de la del CLI de tu Mac."],
  [/Permission denied/i, "La clave no tiene permiso para consultar fondos u órdenes."],
  [/Rate limit|Too many/i, "Kraken pidió esperar por exceso de consultas. Se reintenta en la próxima vigilancia."],
  [/Insufficient funds/i, "Kraken rechazó la orden por fondos insuficientes."],
  [/Unknown asset pair/i, "Kraken no ofrece ese par."],
  [/Unknown order/i, "Kraken no encuentra esa orden."],
];
export function explain(raw: string) { for (const [re, msg] of ERRORS) if (re.test(raw)) return msg; return "Kraken respondió: " + raw; }

// "read" usa la clave de solo lectura; "trade", la de operación (sin permiso de retiro).
async function priv(path: string, params: Record<string, string> = {}, which: "read" | "trade" = "read"): Promise<any> {
  const key = which === "trade" ? process.env.KRAKEN_TRADE_KEY : process.env.KRAKEN_API_KEY;
  const secret = which === "trade" ? process.env.KRAKEN_TRADE_SECRET : process.env.KRAKEN_API_SECRET;
  if (!key || !secret) throw new KrakenError(which === "trade" ? "Faltan KRAKEN_TRADE_KEY y KRAKEN_TRADE_SECRET en Vercel." : "Faltan KRAKEN_API_KEY y KRAKEN_API_SECRET en Vercel.");
  const n = nonce(), body = new URLSearchParams({ nonce: n, ...params }).toString();
  let res: Response;
  try {
    res = await fetch(base() + path, { method: "POST", body, signal: AbortSignal.timeout(12_000),
      headers: { "API-Key": key, "API-Sign": krakenSign(path, n, body, secret), "Content-Type": "application/x-www-form-urlencoded" } });
  } catch { throw new KrakenError("No se pudo conectar con Kraken."); }
  const j: any = await res.json().catch(() => ({ error: ["respuesta ilegible (HTTP " + res.status + ")"] }));
  if (j.error?.length) throw new KrakenError(explain(j.error.join(", ")));
  return j.result;
}

const tickCache = new Map<string, number | null>();
export async function ticker(pair: string): Promise<number | null> {
  if (tickCache.has(pair)) return tickCache.get(pair)!;
  let p: number | null = null;
  try {
    const r = await fetch(`${base()}/0/public/Ticker?pair=${encodeURIComponent(pair)}`, { signal: AbortSignal.timeout(8_000) });
    const j: any = await r.json();
    if (!j.error?.length && j.result) { const first: any = Object.values(j.result)[0]; const v = Number(first?.c?.[0]); if (v > 0) p = v; }
  } catch { p = null; }
  tickCache.set(pair, p);
  return p;
}
export function clearTickerCache() { tickCache.clear(); }

const LEGACY: Record<string, string> = { XXBT: "XBT", XETH: "ETH", XXRP: "XRP", XLTC: "LTC", XXLM: "XLM", XXMR: "XMR", XZEC: "ZEC", XETC: "ETC", XXDG: "XDG", XMLN: "MLN", XREP: "REP", ZUSD: "USD", ZEUR: "EUR", ZAUD: "AUD", ZGBP: "GBP", ZCAD: "CAD", ZJPY: "JPY", ZCHF: "CHF" };
export const FIAT = new Set(["AUD", "USD", "EUR", "GBP", "CAD", "JPY", "CHF"]);
const STABLE = new Set(["USDC", "USDT", "USDG", "DAI", "PYUSD", "RLUSD", "EURC"]);
// Kraken usa nombres heredados (XXBT, ZAUD) y sufijos para saldos en staking o flexibles (XBT.F).
export function normAsset(k: string) { const b = k.split(".")[0]; return LEGACY[b] || b; }
export function displayAsset(b: string) { return b === "XBT" ? "BTC" : b === "XDG" ? "DOGE" : b; }
export function assetClass(d: string) { return d === "BTC" ? "Bitcoin" : FIAT.has(d) ? "Efectivo" : STABLE.has(d) ? "Stablecoins" : "Otras cripto"; }

// Tipos de cambio expresados como unidades de moneda por 1 AUD, igual que fx_rates.
export async function fxPerAud(): Promise<{ USD: number; EUR: number } | null> {
  const audusd = await ticker("AUDUSD"), eurusd = await ticker("EURUSD");
  if (!audusd || !eurusd) return null;
  return { USD: audusd, EUR: audusd / eurusd };
}

export async function priceAud(b: string, fx: { USD: number; EUR: number } | null): Promise<number | null> {
  if (b === "AUD") return 1;
  if (b === "USD") return fx ? 1 / fx.USD : null;
  if (b === "EUR") return fx ? 1 / fx.EUR : null;
  const direct = await ticker(b + "AUD"); if (direct) return direct;
  const usd = await ticker(b + "USD"); if (usd && fx) return usd / fx.USD;
  return null;
}

export type Holding = { asset: string; base: string; amount: number };
export type OpenOrder = { id: string; pair: string; side: string; type: string; price: string; volume: string; opened: number };

export async function fetchKraken(): Promise<{ holdings: Holding[]; open: OpenOrder[] }> {
  const bal = (await priv("/0/private/Balance")) || {};
  const agg = new Map<string, number>();
  for (const [k, v] of Object.entries(bal)) { const b = normAsset(k); agg.set(b, (agg.get(b) || 0) + Number(v)); }
  const holdings = [...agg.entries()].filter(([, a]) => a > 0).map(([b, a]) => ({ asset: displayAsset(b), base: b, amount: a }));
  const oo = (await priv("/0/private/OpenOrders"))?.open || {};
  const open = Object.entries(oo).map(([id, o]: [string, any]) => ({ id, pair: o.descr?.pair || "", side: o.descr?.type || "", type: o.descr?.ordertype || "", price: o.descr?.price || "", volume: String(o.vol ?? ""), opened: Number(o.opentm || 0) * 1000 }));
  return { holdings, open };
}

// Velas diarias públicas (hasta 720 días). La última es el día en curso y se descarta por incompleta.
export async function ohlcDaily(pair = "XBTAUD"): Promise<{ t: number; o: number; h: number; l: number; c: number }[]> {
  let j: any;
  try { const r = await fetch(`${base()}/0/public/OHLC?pair=${encodeURIComponent(pair)}&interval=1440`, { signal: AbortSignal.timeout(15_000) }); j = await r.json(); }
  catch { throw new KrakenError("No se pudo leer el historial de precios de Kraken."); }
  if (j.error?.length) throw new KrakenError(explain(j.error.join(", ")));
  const key = Object.keys(j.result || {}).find((k) => k !== "last");
  const rows: any[] = key ? j.result[key] : [];
  const candles = rows.map((r) => ({ t: Number(r[0]) * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4] }));
  candles.pop();
  return candles;
}

// ---------- Operación (clave de trading) ----------
export type Meta = { ordermin: number; costmin: number; lotDecimals: number; pairDecimals: number };
export async function pairMeta(pair: string): Promise<Meta> {
  let j: any;
  try { const r = await fetch(`${base()}/0/public/AssetPairs?pair=${encodeURIComponent(pair)}`, { signal: AbortSignal.timeout(10_000) }); j = await r.json(); }
  catch { throw new KrakenError("No se pudo leer la configuración del par en Kraken."); }
  if (j.error?.length) throw new KrakenError(explain(j.error.join(", ")));
  const v: any = Object.values(j.result || {})[0];
  if (!v) throw new KrakenError("Kraken no ofrece el par " + pair + ".");
  return { ordermin: Number(v.ordermin || 0), costmin: Number(v.costmin || 0), lotDecimals: Number(v.lot_decimals ?? 8), pairDecimals: Number(v.pair_decimals ?? 2) };
}
export async function balanceWith(which: "read" | "trade") { return (await priv("/0/private/Balance", {}, which)) || {}; }
export async function addOrder(p: Record<string, string>, validate = false): Promise<{ txid: string | null; descr: string }> {
  const r = await priv("/0/private/AddOrder", validate ? { ...p, validate: "true" } : p, "trade");
  return { txid: r?.txid?.[0] ?? null, descr: r?.descr?.order ?? "" };
}
export async function cancelOrder(txid: string) { return priv("/0/private/CancelOrder", { txid }, "trade"); }
export type OrderInfo = { status: string; volExec: number; cost: number; fee: number; price: number };
export async function queryOrder(txid: string): Promise<OrderInfo | null> {
  const r = await priv("/0/private/QueryOrders", { txid }, "trade");
  const o: any = r?.[txid]; if (!o) return null;
  return { status: o.status, volExec: Number(o.vol_exec || 0), cost: Number(o.cost || 0), fee: Number(o.fee || 0), price: Number(o.price || 0) };
}
// Espera a que una orden de mercado se complete (normalmente es inmediato).
export async function waitFilled(txid: string, tries = 6): Promise<OrderInfo> {
  let last: OrderInfo | null = null;
  for (let i = 0; i < tries; i++) {
    last = await queryOrder(txid);
    if (last && (last.status === "closed" || last.status === "canceled" || last.status === "expired")) return last;
    await new Promise((r) => setTimeout(r, 700));
  }
  return last ?? { status: "unknown", volExec: 0, cost: 0, fee: 0, price: 0 };
}
