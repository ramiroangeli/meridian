import { createHash, timingSafeEqual } from "node:crypto";

const onVercel = !!process.env.VERCEL;
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export function sessionValue(): string | null {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return null;
  return createHash("sha256").update(pw + "|" + (process.env.SESSION_SECRET || "meridiano")).digest("hex");
}

// Tablero: cookie de sesión. En local sin APP_PASSWORD queda abierto; desplegado, cerrado.
export function webAuthed(req: Request): boolean {
  const want = sessionValue();
  if (!want) return !onVercel;
  const m = /(?:^|;\s*)mer_s=([a-f0-9]+)/.exec(req.headers.get("cookie") || "");
  return !!m && same(m[1], want);
}

export function passwordOk(pw: string): boolean {
  const real = process.env.APP_PASSWORD;
  return !!real && same(pw, real);
}

// Conector MCP: token largo en la URL, porque los conectores personalizados no envían cabeceras propias.
export function mcpTokenOk(token: string): boolean {
  const real = process.env.MCP_TOKEN || (onVercel ? "" : "dev-token");
  return real.length >= 9 && same(token, real);
}

export const denied = () => Response.json({ error: "No autorizado" }, { status: 401 });
