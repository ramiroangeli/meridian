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
