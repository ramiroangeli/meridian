import { SCHEMA, TABLES } from "./schema";
import { seed } from "./seed";

export type Run = (text: string, params?: unknown[]) => Promise<any[]>;
const g = globalThis as unknown as { __meridiano?: Promise<Run> };

async function connect(): Promise<Run> {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (url) {
    const { Pool } = await import("pg");
    // Los proveedores gestionados (Supabase, Neon) exigen TLS. Se quita sslmode de la URL y se configura acá,
    // porque el certificado del pooler de Supabase no valida contra las autoridades por defecto de Node.
    const local = /localhost|127\.0\.0\.1/.test(url);
    const clean = url.replace(/([?&])sslmode=[^&]*&?/, "$1").replace(/[?&]$/, "");
    const pool = new Pool({ connectionString: clean, max: 3, connectionTimeoutMillis: 10_000, query_timeout: 20_000, ssl: local ? undefined : { rejectUnauthorized: false } });
    return async (t, p) => (await pool.query(t, p as any[])).rows;
  }
  if (process.env.VERCEL) throw new Error("Falta DATABASE_URL: conectá una base Postgres al proyecto.");
  // Desarrollo local sin instalar nada: Postgres embebido en una carpeta.
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = process.env.PGLITE_DIR || ".data/pg";
  (await import("node:fs")).mkdirSync(dir, { recursive: true });
  const db = new PGlite(dir);
  return async (t, p) => (await db.query(t, p as any[])).rows as any[];
}

async function init(): Promise<Run> {
  const run = await connect();
  for (const s of SCHEMA) await run(s);
  // Sin políticas, RLS bloquea el acceso por la API de datos de Supabase; la app entra como dueña de las tablas.
  for (const t of TABLES) await run(`alter table ${t} enable row level security`);
  const n = await run("select count(*)::int as n from users");
  if (n[0].n === 0) await seed(run);
  return run;
}

export async function q(text: string, params?: unknown[]): Promise<any[]> {
  if (!g.__meridiano) g.__meridiano = init().catch((e) => { g.__meridiano = undefined; throw e; });
  return (await g.__meridiano)(text, params);
}

// Un solo usuario por ahora. Cuando haya varios, esto sale de la sesión.
export async function currentUser() {
  const u = await q("select id, name, email, base_currency, paused, demo from users order by created_at limit 1");
  return u[0] as { id: string; name: string; email: string; base_currency: string; paused: boolean; demo: boolean };
}

export async function logEvent(userId: string, actor: string, action: string, result = "") {
  await q("insert into events (user_id, actor, action, result) values ($1,$2,$3,$4)", [userId, actor, action, result]);
}

// Traduce errores de conexión a un mensaje accionable, sin exponer credenciales.
export function dbHint(e: any): { code: string; hint: string } {
  const code = String(e?.code || "desconocido");
  const map: Record<string, string> = {
    "28P01": "La contraseña dentro de DATABASE_URL no coincide con la de la base.",
    ENOTFOUND: "La dirección del servidor en DATABASE_URL es inválida. Suele pasar si la contraseña tiene símbolos como @ # / ? o %: usá una solo de letras y números.",
    ECONNREFUSED: "El servidor rechazó la conexión. Revisá el puerto (6543 para el pooler de Supabase).",
    ETIMEDOUT: "La base no respondió a tiempo. Revisá que el proyecto de Supabase esté activo.",
    "XX000": "El pooler no reconoce el usuario. En Supabase el usuario es postgres.IDPROYECTO.",
  };
  const hint = map[code] || (String(e?.message || "").includes("DATABASE_URL") ? "Falta DATABASE_URL en las variables del proyecto." : "Error de base de datos. Revisá los registros de Vercel.");
  return { code, hint };
}
