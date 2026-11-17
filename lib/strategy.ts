// Motor de trading: código puro, sin base de datos ni red. Lo usan el simulado diario, el backtest y el Monte Carlo,
// así que las tres cosas aplican exactamente las mismas reglas.
//
// Estrategia "Tendencia diaria" sobre BTC/AUD, solo compra (sin apalancamiento ni ventas en corto):
// - Entra cuando el cierre supera la media de 50 días y además el máximo de cierre de los 20 días previos.
// - Sale cuando el cierre cae debajo de la media de 50 días, o si toca el stop.
// - Stop = el más alto entre un stop móvil (máximo desde la entrada menos 3 ATR) y el stop que protege el piso.
// - Las órdenes decididas al cierre se ejecutan en la apertura siguiente (sin mirar el futuro).
// Mandato: si el patrimonio llega al objetivo, vende todo y pasa a USDC; si queda sin margen sobre el piso, termina.

export type Candle = { t: number; o: number; h: number; l: number; c: number };
export type Params = { smaN: number; breakoutN: number; atrN: number; atrMult: number; feePct: number; slipPct: number; floorBuffer: number; endFeePct: number };
export const DEFAULTS: Params = { smaN: 50, breakoutN: 20, atrN: 14, atrMult: 3, feePct: 0.004, slipPct: 0.001, floorBuffer: 0.01, endFeePct: 0.002 };
export const WARMUP = (p: Params) => Math.max(p.smaN, p.breakoutN, p.atrN) + 2;

export type Mandate = { capital: number; floor: number; target: number };
export type Status = "active" | "floor" | "target";
export type Book = { cash: number; units: number; stop: number | null; peak: number | null; entry: number | null; pending: "buy" | "sell" | null; status: Status; endValue: number | null };
export type FillKind = "buy" | "sell" | "stop" | "target" | "floor";
export type Fill = { t: number; kind: FillKind; price: number; units: number; aud: number; fee: number; equity: number; note: string };

export function newBook(m: Mandate): Book { return { cash: m.capital, units: 0, stop: null, peak: null, entry: null, pending: null, status: "active", endValue: null }; }
export const equityAt = (b: Book, price: number) => (b.status === "active" ? b.cash + b.units * price : b.endValue ?? b.cash);

function smaAt(h: Candle[], i: number, n: number) { let s = 0; for (let k = i - n + 1; k <= i; k++) s += h[k].c; return s / n; }
function maxCloseBefore(h: Candle[], i: number, n: number) { let m = -Infinity; for (let k = i - n; k < i; k++) m = Math.max(m, h[k].c); return m; }
function atrAt(h: Candle[], i: number, n: number) {
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += Math.max(h[k].h - h[k].l, Math.abs(h[k].h - h[k - 1].c), Math.abs(h[k].l - h[k - 1].c));
  return s / n;
}
// Precio al que vender todo deja el patrimonio en el piso más el margen, ya descontados costos.
function floorStop(b: Book, m: Mandate, p: Params) { return b.units > 0 ? (m.floor * (1 + p.floorBuffer) - b.cash) / (b.units * (1 - p.feePct) * (1 - p.slipPct)) : null; }

function sellAll(b: Book, px: number, p: Params) {
  const gross = b.units * px, fee = gross * p.feePct, units = b.units;
  b.cash += gross - fee; b.units = 0; b.stop = null; b.peak = null; b.entry = null; b.pending = null;
  return { gross, fee, units };
}

// Procesa la vela i (un día). Devuelve lo que se ejecutó ese día.
export function step(h: Candle[], i: number, b: Book, m: Mandate, p: Params = DEFAULTS): Fill[] {
  if (b.status !== "active") return [];
  const d = h[i], out: Fill[] = [];
  // 1. Órdenes decididas ayer al cierre: se ejecutan en la apertura de hoy.
  if (b.pending === "buy" && b.cash > 0) {
    const px = d.o * (1 + p.slipPct), fee = b.cash * p.feePct, units = (b.cash - fee) / px, spent = b.cash;
    b.units = units; b.cash = 0; b.entry = px; b.peak = d.o; b.pending = null;
    const trail = d.o - p.atrMult * atrAt(h, i - 1, p.atrN);
    b.stop = Math.max(trail, floorStop(b, m, p) ?? -Infinity);
    out.push({ t: d.t, kind: "buy", price: px, units, aud: spent, fee, equity: 0, note: `Stop inicial ${b.stop.toFixed(0)}` });
  } else if (b.pending === "sell" && b.units > 0) {
    const px = d.o * (1 - p.slipPct), r = sellAll(b, px, p);
    out.push({ t: d.t, kind: "sell", price: px, units: r.units, aud: r.gross - r.fee, fee: r.fee, equity: 0, note: "El cierre quedó debajo de la media de 50 días" });
  }
  b.pending = null;
  // 2. Stop durante el día. Si el precio abre por debajo del stop, se vende a la apertura: un hueco puede perforar el piso.
  if (b.units > 0 && b.stop !== null && d.l <= b.stop) {
    const gap = d.o < b.stop, px = (gap ? d.o : b.stop) * (1 - p.slipPct), r = sellAll(b, px, p);
    out.push({ t: d.t, kind: "stop", price: px, units: r.units, aud: r.gross - r.fee, fee: r.fee, equity: 0, note: gap ? "Abrió por debajo del stop: se vendió a la apertura" : "Tocó el stop" });
  }
  // 3. Controles del mandato al cierre.
  let eq = b.cash + b.units * d.c;
  if (eq >= m.target) {
    if (b.units > 0) { const px = d.c * (1 - p.slipPct), r = sellAll(b, px, p); out.push({ t: d.t, kind: "sell", price: px, units: r.units, aud: r.gross - r.fee, fee: r.fee, equity: 0, note: "Objetivo alcanzado: venta total" }); }
    const conv = b.cash * p.endFeePct; b.endValue = b.cash - conv; b.status = "target";
    out.push({ t: d.t, kind: "target", price: 1, units: b.endValue, aud: b.endValue, fee: conv, equity: b.endValue, note: "Todo pasa a USDC y el mandato se detiene" });
  } else if (eq <= m.floor || (b.units === 0 && eq <= m.floor * (1 + 2 * p.floorBuffer))) {
    if (b.units > 0) { const px = d.c * (1 - p.slipPct), r = sellAll(b, px, p); out.push({ t: d.t, kind: "sell", price: px, units: r.units, aud: r.gross - r.fee, fee: r.fee, equity: 0, note: "Piso alcanzado: venta total" }); }
    b.endValue = b.cash; b.status = "floor";
    out.push({ t: d.t, kind: "floor", price: 1, units: 0, aud: b.cash, fee: 0, equity: b.cash, note: "Sin margen sobre el piso: el mandato se detiene en AUD" });
  } else if (i >= WARMUP(p)) {
    // 4. Señales para mañana.
    const ma = smaAt(h, i, p.smaN);
    if (b.units === 0 && d.c > ma && d.c >= maxCloseBefore(h, i, p.breakoutN)) b.pending = "buy";
    if (b.units > 0) {
      b.peak = Math.max(b.peak ?? d.c, d.c);
      const trail = b.peak - p.atrMult * atrAt(h, i, p.atrN);
      b.stop = Math.max(b.stop ?? -Infinity, trail, floorStop(b, m, p) ?? -Infinity);
      if (d.c < ma) b.pending = "sell";
    }
  }
  eq = equityAt(b, d.c);
  for (const f of out) f.equity = eq;
  return out;
}

export type RunResult = { status: Status; equity: number; days: number; fills: Fill[]; curve: { t: number; equity: number }[]; maxDrawdown: number };
export function run(h: Candle[], m: Mandate, p: Params = DEFAULTS, from = WARMUP(p), maxDays = Infinity): RunResult {
  const b = newBook(m), fills: Fill[] = [], curve: { t: number; equity: number }[] = [];
  let peak = m.capital, mdd = 0, i = from;
  for (; i < h.length && i - from < maxDays; i++) {
    fills.push(...step(h, i, b, m, p));
    const eq = equityAt(b, h[i].c); curve.push({ t: h[i].t, equity: eq });
    peak = Math.max(peak, eq); mdd = Math.max(mdd, 1 - eq / peak);
    if (b.status !== "active") { i++; break; }
  }
  return { status: b.status, equity: equityAt(b, h[Math.min(i, h.length) - 1].c), days: i - from, fills, curve, maxDrawdown: mdd };
}

// ---------- Monte Carlo por bloques ("máquina del tiempo") ----------
export function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

export type Odds = { paths: number; horizonDays: number; target: number; floor: number; open: number; medianDaysToEnd: number | null; medianEquityIfOpen: number | null; hold: { target: number; floor: number; open: number } };

// Arma caminos de precios con bloques de días reales (conserva rachas y volatilidad).
// neutral=true quita la tendencia promedio del período, para no suponer que el pasado se repite.
export function odds(h: Candle[], m: Mandate, opt: { paths?: number; horizonDays?: number; block?: number; seed?: number; neutral?: boolean } = {}, p: Params = DEFAULTS): Odds {
  const N = opt.paths ?? 1000, H = opt.horizonDays ?? 730, B = opt.block ?? 10, rand = rng(opt.seed ?? 7), W = WARMUP(p);
  let rel: number[][] = [];
  for (let k = 1; k < h.length; k++) { const pc = h[k - 1].c; rel.push([h[k].o / pc, h[k].h / pc, h[k].l / pc, h[k].c / pc]); }
  if (opt.neutral) { const mu = rel.reduce((s, r) => s + Math.log(r[3]), 0) / rel.length, f = Math.exp(mu); rel = rel.map((r) => r.map((x) => x / f)); }
  const warm = h.slice(-W);
  let tgt = 0, flr = 0, opn = 0, hT = 0, hF = 0, hO = 0; const daysEnd: number[] = [], eqOpen: number[] = [];
  for (let n = 0; n < N; n++) {
    const path: Candle[] = warm.map((c) => ({ ...c }));
    let pc = path[path.length - 1].c, t = path[path.length - 1].t;
    while (path.length < W + H) {
      let j = Math.floor(rand() * rel.length);
      do { const r = rel[j]; t += 86_400_000; path.push({ t, o: pc * r[0], h: pc * r[1], l: pc * r[2], c: pc * r[3] }); pc = pc * r[3]; j = (j + 1) % rel.length; }
      while (rand() > 1 / B && path.length < W + H);
    }
    const res = run(path, m, p, W, H);
    if (res.status === "target") { tgt++; daysEnd.push(res.days); } else if (res.status === "floor") { flr++; daysEnd.push(res.days); } else { opn++; eqOpen.push(res.equity); }
    // Referencia: comprar BTC el primer día y no tocarlo, con el mismo piso y objetivo.
    const units = (m.capital * (1 - p.feePct)) / (path[W].o * (1 + p.slipPct)); let out = 0;
    for (let i = W; i < path.length; i++) { const e = units * path[i].c; if (e >= m.target) { out = 1; break; } if (e <= m.floor) { out = -1; break; } }
    if (out === 1) hT++; else if (out === -1) hF++; else hO++;
  }
  return { paths: N, horizonDays: H, target: tgt / N, floor: flr / N, open: opn / N, medianDaysToEnd: median(daysEnd), medianEquityIfOpen: median(eqOpen), hold: { target: hT / N, floor: hF / N, open: hO / N } };
}

// Sin ventaja (deriva cero y sin costos), la probabilidad de tocar el objetivo antes que el piso es la distancia al piso sobre el rango total.
export const zeroEdge = (m: Mandate) => (m.capital - m.floor) / (m.target - m.floor);
