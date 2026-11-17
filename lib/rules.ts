// Reglas de vigilancia: código común, sin IA. Deciden cuándo vale la pena despertar a un agente.
export type Alert = { to: string; title: string; detail: string; priority: "alta" | "normal" | "baja" };
export type WatchInput = {
  now: number;
  accounts: { name: string; asOf: number | null }[];
  prices: { asset: string; now: number; weekAgo: number | null }[];
  openOrders: { pair: string; side: string; opened: number }[];
  reserve: number | null;
  taxDue: number;
  syncError: string | null;
};
const DAY = 86_400_000;
export const THRESHOLDS = { staleDays: 35, dropPct: 0.15, risePct: 0.25, orderDays: 7 };
const fmt = (n: number) => new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(Math.round(n));

export function evaluate(i: WatchInput): Alert[] {
  const out: Alert[] = [];
  if (i.syncError) out.push({ to: "L", priority: "alta", title: "Falla la sincronización con Kraken", detail: i.syncError });
  for (const a of i.accounts)
    if (a.asOf !== null && i.now - a.asOf > THRESHOLDS.staleDays * DAY)
      out.push({ to: "L", priority: "normal", title: `Datos vencidos: ${a.name}`, detail: `El último saldo tiene ${Math.floor((i.now - a.asOf) / DAY)} días. Hay que actualizarlo o pedírselo al usuario.` });
  for (const p of i.prices) {
    if (!p.weekAgo) continue;
    const ch = p.now / p.weekAgo - 1;
    if (ch <= -THRESHOLDS.dropPct) out.push({ to: "F", priority: "alta", title: `${p.asset} cayó más de ${THRESHOLDS.dropPct * 100}% en 7 días`, detail: `Precio hace 7 días: AUD ${fmt(p.weekAgo)}. Hoy: AUD ${fmt(p.now)} (${(ch * 100).toFixed(1)}%). Medir volatilidad y efecto en la cartera; no es una orden de compra ni de venta.` });
    else if (ch >= THRESHOLDS.risePct) out.push({ to: "E", priority: "normal", title: `${p.asset} subió más de ${THRESHOLDS.risePct * 100}% en 7 días`, detail: `Precio hace 7 días: AUD ${fmt(p.weekAgo)}. Hoy: AUD ${fmt(p.now)} (+${(ch * 100).toFixed(1)}%). Revisar si corresponde aplicar la regla de toma de ganancias de la política.` });
  }
  const old = i.openOrders.filter((o) => o.opened && i.now - o.opened > THRESHOLDS.orderDays * DAY);
  if (old.length) out.push({ to: "G", priority: "normal", title: `Orden abierta en Kraken hace más de ${THRESHOLDS.orderDays} días`, detail: old.map((o) => `${o.side} ${o.pair}, abierta hace ${Math.floor((i.now - o.opened) / DAY)} días`).join("; ") + ". Confirmar con el usuario si sigue vigente." });
  if (i.reserve !== null && i.taxDue > 0 && i.reserve < i.taxDue)
    out.push({ to: "I", priority: "alta", title: "Reserva fiscal por debajo del impuesto estimado", detail: `Reserva AUD ${fmt(i.reserve)} contra impuesto estimado AUD ${fmt(i.taxDue)}. Faltan AUD ${fmt(i.taxDue - i.reserve)}.` });
  return out;
}
