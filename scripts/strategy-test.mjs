// Pruebas del motor de trading con caminos sintéticos. Uso: node --experimental-strip-types scripts/strategy-test.mjs
import { run, step, newBook, odds, zeroEdge, DEFAULTS, WARMUP } from "../lib/strategy.ts";
let fails = 0;
const check = (n, c, x = "") => { console.log((c ? "ok   " : "FALLA") + " " + n + (x ? "  " + x : "")); if (!c) fails++; };
const D = 86_400_000, M = { capital: 2000, floor: 1200, target: 5000 };
// Genera velas a partir de una lista de cierres, con rango diario de ±1%.
const mk = (closes, gapAt = -1, gapTo = 0) => closes.map((c, i) => { const pc = i ? closes[i - 1] : c, o = i === gapAt ? gapTo : pc; return { t: i * D, o, h: Math.max(o, c) * 1.01, l: Math.min(o, c) * 0.99, c }; });
const W = WARMUP(DEFAULTS);
const flat = Array.from({ length: W + 5 }, (_, i) => 100000 + (i % 3) * 50);

// 1. Tendencia fuerte: entra y llega al objetivo
const up = mk([...flat, ...Array.from({ length: 200 }, (_, i) => 100150 * Math.pow(1.02, i + 1))]);
const r1 = run(up, M);
check("con tendencia fuerte llega al objetivo", r1.status === "target" && r1.equity >= 5000 * 0.99, `${r1.status}, AUD ${r1.equity.toFixed(0)}, ${r1.days} días`);
const buy = r1.fills.find((f) => f.kind === "buy");
check("la compra se ejecuta en la apertura del día siguiente a la señal", buy && up.findIndex((c) => c.t === buy.t) > W);
check("al llegar al objetivo todo pasa a USDC", r1.fills.at(-1).kind === "target" && /USDC/.test(r1.fills.at(-1).note));
check("descuenta comisiones", r1.fills.filter((f) => f.fee > 0).length >= 2);

// 2. Entra y después se desploma: el stop protege el piso
const crash = mk([...flat, ...Array.from({ length: 8 }, (_, i) => 100150 * Math.pow(1.03, i + 1)), ...Array.from({ length: 40 }, (_, i) => 126000 * Math.pow(0.94, i + 1))]);
const r2 = run(crash, M);
check("en una caída el patrimonio no baja del piso sin hueco", r2.equity >= 1200, `${r2.status}, AUD ${r2.equity.toFixed(0)}`);
check("sale por stop", r2.fills.some((f) => f.kind === "stop" || f.kind === "sell"));

// 3. Hueco de precio: abre muy por debajo del stop y perfora el piso
const gapIdx = W + 5 + 8;
const gap = mk([...flat, ...Array.from({ length: 8 }, (_, i) => 100150 * Math.pow(1.03, i + 1)), 40000, 39000, 38000], gapIdx, 40000);
const r3 = run(gap, M);
check("un hueco perfora el piso y queda registrado", r3.status === "floor" && r3.equity < 1200 && r3.fills.some((f) => /apertura/.test(f.note)), `AUD ${r3.equity.toFixed(0)}`);

// 4. Sin señal no opera
const r4 = run(mk(Array.from({ length: 200 }, (_, i) => 100000 - i * 10)), M);
check("en baja suave no compra", !r4.fills.some((f) => f.kind === "buy") && r4.status === "active" && Math.abs(r4.equity - 2000) < 1e-9);

// 5. Un mandato terminado no vuelve a operar
const b = newBook(M); b.status = "target"; b.endValue = 5100;
check("terminado no opera", step(up, W + 10, b, M).length === 0);

// 6. Monte Carlo: reproducible y probabilidades que suman 1
const hist = mk(Array.from({ length: 400 }, (_, i) => 100000 * Math.exp(Math.sin(i / 15) * 0.2 + i * 0.001)));
const o1 = odds(hist, M, { paths: 200, horizonDays: 365, seed: 3 }), o2 = odds(hist, M, { paths: 200, horizonDays: 365, seed: 3 });
check("Monte Carlo reproducible con semilla", JSON.stringify(o1) === JSON.stringify(o2));
check("probabilidades suman 1", Math.abs(o1.target + o1.floor + o1.open - 1) < 1e-9 && Math.abs(o1.hold.target + o1.hold.floor + o1.hold.open - 1) < 1e-9, `objetivo ${(o1.target * 100).toFixed(1)}%, piso ${(o1.floor * 100).toFixed(1)}%`);
const on = odds(hist, M, { paths: 200, horizonDays: 365, seed: 3, neutral: true });
check("sin tendencia el objetivo es igual o menos probable", on.target <= o1.target + 0.02, `${(on.target * 100).toFixed(1)}% contra ${(o1.target * 100).toFixed(1)}%`);
check("referencia sin ventaja: 21,1%", Math.abs(zeroEdge(M) - 800 / 3800) < 1e-12);
const t0 = Date.now(); odds(hist, M, { paths: 1000, horizonDays: 730 }); const ms = Date.now() - t0;
check("1.000 caminos de 2 años en menos de 15 s", ms < 15000, `${ms} ms`);
console.log(fails ? `\n${fails} fallas` : "\nTodo en orden");
process.exit(fails ? 1 : 0);
