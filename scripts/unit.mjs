// Pruebas unitarias sin servidor: firma de Kraken (ejemplo oficial de su documentación) y reglas de vigilancia.
// Uso: node --experimental-strip-types scripts/unit.mjs
import { krakenSign, normAsset, displayAsset, assetClass } from "../lib/kraken.ts";
import { evaluate } from "../lib/rules.ts";
let fails = 0;
const check = (n, c, x = "") => { console.log((c ? "ok   " : "FALLA") + " " + n + (x ? "  " + x : "")); if (!c) fails++; };

const sig = krakenSign("/0/private/AddOrder", "1616492376594",
  "nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25",
  "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==");
check("firma coincide con el ejemplo oficial de Kraken", sig === "4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==", sig.slice(0, 20));
check("nombres de activos", normAsset("XXBT") === "XBT" && normAsset("XBT.F") === "XBT" && normAsset("ZAUD") === "AUD" && normAsset("HYPE") === "HYPE" && displayAsset("XBT") === "BTC");
check("clases de activo", assetClass("BTC") === "Bitcoin" && assetClass("AUD") === "Efectivo" && assetClass("USDC") === "Stablecoins" && assetClass("HYPE") === "Otras cripto");

const now = Date.UTC(2026, 10, 17), D = 86_400_000;
const base = { now, accounts: [], prices: [], openOrders: [], reserve: null, taxDue: 0, syncError: null };
check("sin novedades no genera alertas", evaluate(base).length === 0);
const drop = evaluate({ ...base, prices: [{ asset: "BTC", now: 80000, weekAgo: 100000 }] });
check("caída de 20% despierta a Freya", drop.length === 1 && drop[0].to === "F" && drop[0].priority === "alta");
check("caída de 10% no alcanza el umbral", evaluate({ ...base, prices: [{ asset: "BTC", now: 90000, weekAgo: 100000 }] }).length === 0);
check("suba de 30% despierta a Elio", evaluate({ ...base, prices: [{ asset: "HYPE", now: 130, weekAgo: 100 }] })[0]?.to === "E");
check("sin precio de hace 7 días no hay alerta", evaluate({ ...base, prices: [{ asset: "BTC", now: 1, weekAgo: null }] }).length === 0);
check("dato de 40 días despierta a Lía", evaluate({ ...base, accounts: [{ name: "Banco ES", asOf: now - 40 * D }, { name: "Kraken: BTC", asOf: now }] }).map((a) => a.to).join() === "L");
check("orden de 9 días despierta a Gael", evaluate({ ...base, openOrders: [{ pair: "XBTAUD", side: "buy", opened: now - 9 * D }, { pair: "XBTAUD", side: "buy", opened: now - D }] })[0]?.to === "G");
check("reserva corta despierta a Inés", evaluate({ ...base, reserve: 4400, taxDue: 4650 })[0]?.title.startsWith("Reserva fiscal"));
check("reserva suficiente no alerta", evaluate({ ...base, reserve: 5000, taxDue: 4650 }).length === 0);
check("error de sincronización es prioridad alta", evaluate({ ...base, syncError: "clave inválida" })[0]?.priority === "alta");
console.log(fails ? `\n${fails} fallas` : "\nTodo en orden");
process.exit(fails ? 1 : 0);
