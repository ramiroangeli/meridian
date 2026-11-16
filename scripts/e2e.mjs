// Prueba de punta a punta contra un servidor en marcha: tablero + conector MCP.
// Uso: BASE=http://localhost:3111 MCP_TOKEN=dev-token node scripts/e2e.mjs
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
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
check("lista de herramientas", tools.length === 12, tools.join(", "));
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

await post("/api/pause", { paused: true });
const blocked = await call("start_agent_run", { agent_code: "C", task: "No debería iniciar" });
check("en pausa, el agente no puede iniciar", blocked.err, blocked.text.slice(0, 40));
check("en pausa, no se crean propuestas", (await call("create_proposal", { agent_code: "C", level: "idea", title: title + " b", evidence: "prueba en pausa", benefit: "x", effort: "x", risk: "x", next_step: "x" })).err);
await post("/api/pause", { paused: false });
check("reanudado", (await state()).paused === false);

await client.close();
console.log(fails ? `\n${fails} fallas` : "\nTodo en orden");
process.exit(fails ? 1 : 0);
