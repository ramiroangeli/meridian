# Meridiano

Finanzas personales entre países, con agentes. Versión 0.2: base de datos, conector MCP y tablero en vivo.

## Cómo funciona

- **Este sistema** guarda los datos, aplica los permisos, registra cada acción y muestra el tablero y la sala 3D.
- **Tu Claude** es el motor de los agentes. Se conecta por MCP, lee datos, registra ejecuciones y deja propuestas.
- **Vos** aprobás, rechazás o posponés desde el tablero. El conector no puede aprobar, pausar ni cambiar permisos.

No hay llamadas a una API de modelo: el costo de IA es la suscripción de Claude de cada usuario.

## Probarlo en tu computadora

```bash
npm install
npm run build && npm start        # http://localhost:3000
npm test                          # 18 comprobaciones de punta a punta, con el servidor en marcha
```

Sin `DATABASE_URL` usa una base Postgres embebida en `.data/` y carga datos de ejemplo. En local, el tablero queda abierto y el token del conector es `dev-token`.

## Desplegar en Vercel

1. Subí el repo a GitHub e importalo en Vercel.
2. Agregá una base Postgres (Supabase o Neon). Definí `DATABASE_URL` con la cadena de conexión del pooler; con la integración de Vercel alcanza `POSTGRES_URL`.
3. Definí `APP_PASSWORD`, `SESSION_SECRET` y `MCP_TOKEN` (ver `.env.example`). Usá valores largos y aleatorios.
4. En el primer pedido se crean las tablas y los datos de ejemplo.

## Conectar Claude

Agregá un conector personalizado con la dirección `https://TU-DOMINIO/api/k/TU_MCP_TOKEN/mcp` y pedile: "revisá el estado del sistema en Meridiano".

| Herramienta | Qué hace |
| --- | --- |
| `get_system_status` | Pausa, reglas de operación, antigüedad de cada dato |
| `get_overview`, `list_accounts`, `list_transactions` | Lectura de patrimonio, cuentas y movimientos |
| `record_balance`, `import_transactions` | Registra saldos y movimientos; descarta duplicados |
| `list_agents`, `start_agent_run`, `finish_agent_run` | Ficha de cada agente y registro de sus ejecuciones |
| `create_proposal`, `list_proposals`, `list_events` | Propuestas para tu decisión e historial |

## Estructura

```
lib/schema.ts      tablas (todas con user_id, listas para varios usuarios)
lib/seed.ts        datos de ejemplo
lib/state.ts       arma el estado que consume el tablero
lib/mcp-tools.ts   herramientas del conector
lib/auth.ts        sesión del tablero y token del conector
app/api/           estado, ingreso, pausa, propuestas, conector MCP
public/tablero.html  tablero
public/oficina.js    oficina 3D: nueve salas por área, personas animadas según su estado
lib/org.ts         organigrama: persona, puesto, área y modelo sugerido de cada agente
scripts/e2e.mjs    prueba de punta a punta
```

## Límites conocidos de esta versión

- Probado con la base embebida. El camino con Postgres real (`pg`) todavía no se ejecutó.
- El conector se probó con el cliente MCP oficial, no con la app de Claude.
- El token en la URL sirve para un solo usuario. Antes de sumar terceros hay que pasar a OAuth.
- Los límites de la política de inversión, el calendario fiscal y los costos son valores de ejemplo.
- No hay importador de CSV en el tablero: los movimientos entran por el conector.

## Cómo se coordinan los agentes

Los chats de Claude no se hablan entre sí. Se coordinan a través de Meridiano, como un equipo que trabaja con tickets:

1. Un chat o una tarea programada "se pone el uniforme" de un agente con `get_agent_brief`: recibe sus instrucciones, el protocolo de trabajo y su bandeja.
2. Trabaja, y si necesita a otra área deja una tarea con `assign_task`. Si algo requiere dinero o una decisión, deja una propuesta para el usuario.
3. El agente destinatario encuentra la tarea en su bandeja la próxima vez que corre y la mueve con `update_task` (en curso, hecha o bloqueada).
4. El usuario ve todo en Tareas y en la Oficina 3D, puede asignar o cancelar tareas, y es el único que aprueba propuestas.

Límites contra bucles: 40 tareas entre agentes por día, 12 abiertas por agente, sin duplicados ni autoasignación, y nada se mueve con el sistema en pausa.

## Kraken y vigilancia

- `lib/kraken.ts`: cliente de solo lectura (saldos y órdenes abiertas). No tiene funciones para operar ni retirar.
- `lib/rules.ts`: reglas sin IA. Caída de más de 15% en 7 días despierta a Freya; suba de más de 25%, a Elio; una orden abierta hace más de 7 días, a Gael; datos con más de 35 días, a Lía; reserva fiscal corta, a Inés.
- `lib/watch.ts`: sincroniza, guarda la foto mensual del patrimonio, corre las reglas y deja tareas (máximo 10 por día, sin duplicados).
- `vercel.json`: corre la vigilancia todos los días a las 20:00 UTC. También se puede correr desde Sistema o con la herramienta `refresh_data`.

Variables nuevas en Vercel: `KRAKEN_API_KEY`, `KRAKEN_API_SECRET` (clave exclusiva para Meridiano, solo con permisos de consulta) y `CRON_SECRET`.

Pruebas: `npm run test:unit` (firma de Kraken contra el ejemplo oficial y reglas) y `npm test` con el servidor en marcha. Con `E2E_RESET=1` y un Kraken simulado se prueba también el paso a datos reales.

## Trading (modo simulado)

- `lib/strategy.ts`: motor puro. Tendencia diaria sobre BTC/AUD: entra con cierre sobre la media de 50 días y el máximo de 20; sale bajo la media o por stop (móvil de 3 ATR, nunca por debajo del precio que protege el piso). Decide al cierre y ejecuta en la apertura siguiente, con 0,4% de comisión y 0,1% de deslizamiento.
- Mandato: capital, piso y objetivo los fija solo el usuario. Al objetivo vende todo y pasa a USDC; sin margen sobre el piso, termina en AUD. Un hueco de precio puede perforar el piso y queda registrado.
- `odds()`: Monte Carlo por bloques con el historial diario real de Kraken, con y sin la tendencia del período, contra comprar y mantener.
- `lib/trading.ts`: el paso diario lo corre la vigilancia. No hay código que envíe órdenes reales.
- Agente M, Teo Varela (Head of Trading), con las herramientas `get_trading_status` y `simulate_trading_plan`.

## Mandato con dinero real (Teo)

- Dos claves de Kraken: `KRAKEN_API_KEY/SECRET` (solo consulta) y `KRAKEN_TRADE_KEY/SECRET` (crear, modificar y cancelar órdenes; **nunca** retiro ni depósito).
- Se crea desde Trading → "Mandato con dinero real", escribiendo `DINERO REAL`. Antes de la fecha de inicio, toda orden se envía con `validate=true` (Kraken la valida sin ejecutarla).
- La primera orden real queda como propuesta en Decisiones; aprobarla la ejecuta, controlando de nuevo los límites al precio del momento.
- Límites en `lib/risk.ts` (los aplica el código, no el agente): BTC, ETH, SOL y XRP contra AUD al contado; una posición por moneda; stop-loss obligatorio cargado en Kraken; patrimonio con todos los stops ejecutados ≥ piso; mover un stop hacia abajo solo si el peor caso sigue sobre el piso; al objetivo vende todo y compra USDC; al piso vende todo y se detiene; la pausa global bloquea compras.
- Solo vende unidades registradas en el mandato: no toca el resto de tus monedas.
- Herramientas MCP de Teo: `market_snapshot`, `place_trade`, `close_position`, `update_stop`, `refresh_trading`, `check_trading_keys`.
- Pruebas: `npm run test:unit` (incluye `scripts/risk-test.mjs`) y `npm test` con el Kraken simulado (órdenes, stops, take profit, objetivo y USDC).
