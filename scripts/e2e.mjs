// Prueba de punta a punta contra un servidor en marcha: tablero + conector MCP.
// Uso: BASE=http://localhost:3111 MCP_TOKEN=dev-token node scripts/e2e.mjs
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import http from "node:http";
import { createHash, createHmac } from "node:crypto";
const BASE = process.env.BASE || "http://localhost:3000", TOKEN = process.env.MCP_TOKEN || "dev-token";
let fails = 0;
const check = (name, cond, extra = "") => { console.log((cond ? "ok   " : "FALLA") + " " + name + (extra ? "  " + extra : "")); if (!cond) fails++; };
const state = async () => (await fetch(BASE + "/api/state")).json();
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

const bad = await fetch(BASE + "/api/k/token-equivocado/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check("token incorrecto es rechazado", bad.status === 401);

const client = new Client({ name: "e2e", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/api/k/${TOKEN}/mcp`)));
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const t = r.content[0].text; return { err: !!r.isError, text: t, data: r.isError ? null : JSON.parse(t) }; };

const tools = (await client.listTools()).tools.map((t) => t.name);
check("lista de herramientas", tools.length === 17, tools.join(", "));
check("no expone aprobar ni pausar", !tools.some((t) => /approve|resolve|pause/.test(t)));

let s0 = await state();
check("tablero lee la base", s0.accounts.length === 11 && s0.agents.length === 12, `${s0.accounts.length} cuentas, ${s0.agents.length} agentes`);
const ov = (await call("get_overview")).data;
const net = s0.accounts.reduce((t, a) => t + a.aud, 0) - s0.liabs.reduce((t, a) => t + a.aud, 0);
check("patrimonio coincide entre conector y tablero", ov.patrimonio_neto === Math.round(net), `${ov.patrimonio_neto}`);

if (s0.paused) await post("/api/pause", { paused: false });
const run = await call("start_agent_run", { agent_code: "C", task: "Prueba de punta a punta" });
check("agente inicia ejecución", !run.err);
check("tablero muestra al agente ejecutándose", (await state()).agents.find((a) => a.c === "C").st === "run");
await call("finish_agent_run", { run_id: run.data.run_id, status: "done", result: "Prueba completada" });
check("tablero muestra al agente completado", (await state()).agents.find((a) => a.c === "C").st === "done");

const ext = "e2e-" + Date.now();
const rows = [{ posted_on: "2026-11-10", amount: -42.5, description: "Supermercado", kind: "expense", essential: true, external_id: ext }];
const i1 = (await call("import_transactions", { account: "Banco AU principal", rows })).data;
const i2 = (await call("import_transactions", { account: "Banco AU principal", rows })).data;
check("importación y descarte de duplicados", i1.nuevos === 1 && i2.nuevos === 0 && i2.duplicados === 1);

const title = "Prueba: propuesta " + Date.now();
const prop = await call("create_proposal", { agent_code: "C", level: "idea", title, evidence: "Generada por la prueba automática.", benefit: "Ninguno", effort: "Ninguno", risk: "Ninguno", next_step: "Rechazar" });
check("agente crea propuesta", !prop.err);
check("propuesta duplicada es rechazada", (await call("create_proposal", { agent_code: "C", level: "idea", title, evidence: "Generada por la prueba automática.", benefit: "x", effort: "x", risk: "x", next_step: "x" })).err);
check("propuesta aparece en el tablero", (await state()).props.some((p) => p.id === prop.data.proposal_id));
check("persona la resuelve desde el tablero", (await post("/api/proposals/" + prop.data.proposal_id, { action: "reject" })).ok);
check("no se resuelve dos veces", (await post("/api/proposals/" + prop.data.proposal_id, { action: "approve" })).status === 409);
check("queda en el historial", (await state()).history.some((h) => h.what.includes(title)));

// ---------- tareas entre agentes ----------
const brief = (await call("get_agent_brief", { agent_code: "I" })).data;
check("brief trae instrucciones, protocolo y bandeja", brief.instrucciones.length > 50 && brief.protocolo.length >= 5 && Array.isArray(brief.bandeja), `${brief.persona}, ${brief.bandeja.length} en bandeja`);
const ttitle = "Prueba: revisar vencimiento " + Date.now();
const t1 = await call("assign_task", { from_agent: "B", to_agent: "I", title: ttitle, detail: "La reserva quedó corta, confirmar fecha.", priority: "alta" });
check("Bruno asigna tarea a Inés", !t1.err, t1.text.slice(0, 60));
check("tarea duplicada rechazada", (await call("assign_task", { from_agent: "B", to_agent: "I", title: ttitle, detail: "otra vez lo mismo" })).err);
check("no se asigna a sí mismo", (await call("assign_task", { from_agent: "B", to_agent: "B", title: "Autoasignación prueba", detail: "no debería" })).err);
const inbox = (await call("get_agent_brief", { agent_code: "I" })).data.bandeja;
check("aparece en la bandeja de Inés", inbox.some((t) => t.id === t1.data.task_id));
check("otro agente no puede cerrarla", (await call("update_task", { task_id: t1.data.task_id, agent_code: "H", status: "done", result: "no me corresponde" })).err);
check("done sin resultado es rechazado", (await call("update_task", { task_id: t1.data.task_id, agent_code: "I", status: "done", result: "" })).err);
await call("update_task", { task_id: t1.data.task_id, agent_code: "I", status: "in_progress" });
let st = await state();
check("tablero muestra la tarea en curso con su arco", st.tasks.some((t) => t.id === t1.data.task_id && t.st === "in_progress") && st.agents.find((a) => a.c === "I").inbox >= 1);
await call("update_task", { task_id: t1.data.task_id, agent_code: "I", status: "done", result: "Vence el 28/11; alcanza con transferir AUD 250" });
check("Inés la completa y queda en el historial", (await state()).history.some((h) => h.what.includes("Completó: " + ttitle)));
check("no se reabre una tarea cerrada", (await call("update_task", { task_id: t1.data.task_id, agent_code: "I", status: "in_progress" })).err);
const ut = "Prueba usuario " + Date.now();
check("el usuario asigna desde el tablero", (await post("/api/tasks", { to: "H", title: ut, detail: "monto de referencia", priority: "normal" })).ok);
check("título vacío rechazado", (await post("/api/tasks", { to: "H", title: "", detail: "" })).status === 400);
const mine = (await state()).tasks.find((t) => t.t === ut);
check("la tarea del usuario llega a Hana", mine && mine.from === "user" && mine.to === "H");
check("el usuario la cancela", (await post("/api/tasks/" + mine.id, {})).ok && (await state()).tasks.find((t) => t.id === mine.id).st === "cancelled");

await post("/api/pause", { paused: true });
check("en pausa, no se asignan tareas", (await call("assign_task", { from_agent: "B", to_agent: "I", title: "En pausa prueba", detail: "no debería" })).err);
const blocked = await call("start_agent_run", { agent_code: "C", task: "No debería iniciar" });
check("en pausa, el agente no puede iniciar", blocked.err, blocked.text.slice(0, 40));
check("en pausa, no se crean propuestas", (await call("create_proposal", { agent_code: "C", level: "idea", title: title + " b", evidence: "prueba en pausa", benefit: "x", effort: "x", risk: "x", next_step: "x" })).err);
await post("/api/pause", { paused: false });
check("reanudado", (await state()).paused === false);

// ---------- datos reales: solo con E2E_RESET=1, porque borra los datos de ejemplo ----------
if (process.env.E2E_RESET === "1") {
  const SECRET = process.env.KRAKEN_API_SECRET, D = 86400;
  const sign = (path, nonce, body) => createHmac("sha512", Buffer.from(SECRET, "base64")).update(Buffer.concat([Buffer.from(path), createHash("sha256").update(nonce + body).digest()])).digest("base64");
  const PRICES = { XBTAUD: 140000, HYPEUSD: 40, AUDUSD: 0.65, EURUSD: 1.08, USDCUSD: 1, BABYUSD: 0.02 };
  let privateCalls = 0, badSig = 0;
  const mock = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      const u = new URL(req.url, "http://x"), send = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
      if (u.pathname === "/0/public/Ticker") { const p = PRICES[u.searchParams.get("pair")]; return send(p ? { error: [], result: { X: { c: [String(p), "1"] } } } : { error: ["EQuery:Unknown asset pair"] }); }
      privateCalls++;
      const nonce = new URLSearchParams(body).get("nonce");
      if (req.headers["api-key"] !== "testkey" || req.headers["api-sign"] !== sign(u.pathname, nonce, body)) { badSig++; return send({ error: ["EAPI:Invalid signature"] }); }
      if (u.pathname === "/0/private/Balance") return send({ error: [], result: { ZAUD: "2000.2063", XXBT: "0.05715759", "XBT.F": "0.001", HYPE: "24.7474144", USDC: "0.20040232", BABY: "0.59172" } });
      if (u.pathname === "/0/private/OpenOrders") return send({ error: [], result: { open: { "OABC-1": { opentm: Date.now() / 1000 - 9 * D, vol: "0.04", descr: { pair: "XBTAUD", type: "buy", ordertype: "limit", price: "90000" } } } } });
      send({ error: ["EGeneral:Unknown method"] });
    });
  }).listen(Number(process.env.MOCK_KRAKEN_PORT || 3199));

  check("en modo ejemplo la vigilancia no toca nada", ((await (await post("/api/sync", {})).json()).summary || "").startsWith("Datos de ejemplo"));
  check("reset exige confirmación", (await post("/api/reset", { confirm: "borrar" })).status === 400);
  check("reset con BORRAR", (await post("/api/reset", { confirm: "BORRAR" })).ok);
  let r = await state();
  check("quedan cero cuentas, tareas y propuestas", r.accounts.length === 0 && r.tasks.length === 0 && r.props.length === 0 && !r.user.demo);
  check("los 12 agentes se conservan, sin ejecuciones", r.agents.length === 12 && r.agents.every((a) => a.st === "idea"));
  check("no se puede resetear dos veces", (await post("/api/reset", { confirm: "BORRAR" })).status === 409);
  const sync = await (await post("/api/sync", {})).json();
  check("sincroniza Kraken con firma válida", sync.ok && privateCalls === 2 && badSig === 0, sync.summary);
  r = await state();
  const names = r.accounts.map((a) => a.n).sort().join(", ");
  check("3 activos, sin polvo", names === "Kraken: AUD, Kraken: BTC, Kraken: HYPE", names);
  const btc = r.accounts.find((a) => a.n === "Kraken: BTC"), hype = r.accounts.find((a) => a.n === "Kraken: HYPE");
  check("BTC suma saldo flexible y valúa en AUD", Math.abs(btc.nat - 0.05815759) < 1e-9 && Math.abs(btc.aud - 0.05815759 * 140000) < 0.01, String(Math.round(btc.aud)));
  check("HYPE se valúa por USD convertido a AUD", Math.abs(hype.aud - 24.7474144 * 40 / 0.65) < 0.01, String(Math.round(hype.aud)));
  check("tipos de cambio actualizados desde Kraken", Math.abs(r.fx.USD - 0.65) < 1e-9 && Math.abs(r.fx.EUR - 0.65 / 1.08) < 1e-9);
  check("fuente Kraken al día", r.sources.kraken && r.sources.kraken.ok && r.sources.krakenConfigured);
  const gt = r.tasks.filter((t) => t.from === "sistema");
  check("la orden vieja despierta a Gael", gt.length === 1 && gt[0].to === "G", gt.map((t) => t.t).join("; "));
  check("foto mensual del patrimonio", r.nwHist.length === 1 && Math.abs(r.nwHist[0] - r.accounts.reduce((t, a) => t + a.aud, 0)) < 0.01);
  await post("/api/sync", {});
  check("una segunda revisión no duplica tareas", (await state()).tasks.filter((t) => t.from === "sistema").length === 1);
  check("refresh_data respeta 5 minutos entre corridas", (await call("refresh_data")).err);
  check("cron sin secreto rechazado", (await fetch(BASE + "/api/cron/watch")).status === 401);
  check("cron con secreto corre", (await fetch(BASE + "/api/cron/watch", { headers: { authorization: "Bearer " + process.env.CRON_SECRET } })).ok);
  mock.close();
}

await client.close();
console.log(fails ? `\n${fails} fallas` : "\nTodo en orden");
process.exit(fails ? 1 : 0);
