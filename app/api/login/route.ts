import { passwordOk, sessionValue } from "@/lib/auth";
export const runtime = "nodejs";
export async function POST(req: Request) {
  const { password } = await req.json().catch(() => ({ password: "" }));
  if (typeof password !== "string" || !passwordOk(password)) return Response.json({ error: "Contraseña incorrecta" }, { status: 401 });
  const res = Response.json({ ok: true });
  res.headers.set("set-cookie", `mer_s=${sessionValue()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
  return res;
}
