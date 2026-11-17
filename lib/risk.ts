// Límites duros del mandato real. Código puro: lo que no pase acá no llega a Kraken, diga lo que diga el agente.

export const ALLOWED: Record<string, string> = { BTC: "XBTAUD", ETH: "ETHAUD", SOL: "SOLAUD", XRP: "XRPAUD" };
export const COSTS = { fee: 0.004, slip: 0.003 }; // comisión taker supuesta y deslizamiento de un stop de mercado
export const LIMITS = { maxPositions: 4, minStopGap: 0.005, maxStopGap: 0.5 };

export type Pos = { asset: string; units: number; sl: number };
export type PairMeta = { ordermin: number; costmin: number; lotDecimals: number; pairDecimals: number };
export type BuyCheck = { floor: number; cash: number; positions: Pos[]; asset: string; amountAud: number; price: number; sl: number; tp: number | null; meta: PairMeta };

// Patrimonio si todos los stops abiertos se ejecutaran a la vez, con costos.
export function worstCase(cash: number, positions: Pos[]) {
  return cash + positions.reduce((t, p) => t + p.units * p.sl * (1 - COSTS.fee - COSTS.slip), 0);
}

export const roundDown = (x: number, d: number) => Math.floor(x * 10 ** d) / 10 ** d;
export const roundTo = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const fmt = (n: number) => "AUD " + new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(n);

export function checkBuy(c: BuyCheck): { ok: true; volume: number; sl: number; tp: number | null; worst: number } | { ok: false; error: string } {
  if (!ALLOWED[c.asset]) return { ok: false, error: `${c.asset} no está entre las monedas permitidas: ${Object.keys(ALLOWED).join(", ")}.` };
  if (c.positions.some((p) => p.asset === c.asset)) return { ok: false, error: `Ya hay una posición abierta en ${c.asset}. Cerrala o ajustá su stop; no se suman compras.` };
  if (c.positions.length >= LIMITS.maxPositions) return { ok: false, error: `Máximo ${LIMITS.maxPositions} posiciones a la vez.` };
  if (!(c.amountAud > 0)) return { ok: false, error: "El monto tiene que ser positivo." };
  if (c.amountAud > c.cash + 1e-9) return { ok: false, error: `El mandato tiene ${fmt(c.cash)} disponibles; no alcanza para ${fmt(c.amountAud)}.` };
  if (!(c.sl > 0) || c.sl > c.price * (1 - LIMITS.minStopGap)) return { ok: false, error: `El stop tiene que quedar al menos ${LIMITS.minStopGap * 100}% debajo del precio actual (${c.price}).` };
  if (c.sl < c.price * (1 - LIMITS.maxStopGap)) return { ok: false, error: `El stop está a más de ${LIMITS.maxStopGap * 100}% del precio: demasiado lejos.` };
  if (c.tp !== null && !(c.tp > c.price * 1.005)) return { ok: false, error: "El take profit tiene que quedar arriba del precio actual." };
  const volume = roundDown((c.amountAud * (1 - COSTS.fee)) / (c.price * 1.002), c.meta.lotDecimals);
  if (volume < c.meta.ordermin) return { ok: false, error: `El volumen ${volume} ${c.asset} es menor al mínimo de Kraken (${c.meta.ordermin}).` };
  if (volume * c.price < c.meta.costmin) return { ok: false, error: `La orden es menor al mínimo de Kraken (${fmt(c.meta.costmin)}).` };
  const sl = roundTo(c.sl, c.meta.pairDecimals), tp = c.tp === null ? null : roundTo(c.tp, c.meta.pairDecimals);
  const worst = worstCase(c.cash - c.amountAud, [...c.positions, { asset: c.asset, units: volume, sl }]);
  if (worst < c.floor) return { ok: false, error: `Con este stop, si todos los stops se ejecutan el mandato quedaría en ${fmt(worst)}, debajo del piso de ${fmt(c.floor)}. Subí el stop o achicá el monto.` };
  return { ok: true, volume, sl, tp, worst };
}

// Mover un stop: solo hacia arriba, o hacia abajo si el peor caso sigue sobre el piso.
export function checkStopMove(floor: number, cash: number, positions: Pos[], asset: string, newSl: number, price: number) {
  const p = positions.find((x) => x.asset === asset);
  if (!p) return { ok: false as const, error: `No hay posición abierta en ${asset}.` };
  if (!(newSl > 0) || newSl > price * (1 - LIMITS.minStopGap)) return { ok: false as const, error: "El stop tiene que quedar debajo del precio actual." };
  const worst = worstCase(cash, positions.map((x) => (x.asset === asset ? { ...x, sl: newSl } : x)));
  if (newSl < p.sl && worst < floor) return { ok: false as const, error: `Bajar el stop dejaría el peor caso en ${fmt(worst)}, debajo del piso.` };
  return { ok: true as const, worst };
}

export type MandateEnd = "target" | "floor" | null;
export function mandateEnd(equity: number, floor: number, target: number): MandateEnd {
  return equity >= target ? "target" : equity <= floor ? "floor" : null;
}
