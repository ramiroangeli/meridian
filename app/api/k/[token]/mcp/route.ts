import { createMcpHandler } from "mcp-handler";
import { registerTools, registerTaskTools, registerWatchTools, registerTradingTools } from "@/lib/mcp-tools";
import { mcpTokenOk } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Un pedido MCP normal tarda segundos; este tope evita conexiones colgadas de 5 minutos.
export const maxDuration = 60;

const handler = createMcpHandler((server) => { registerTools(server); registerTaskTools(server); registerWatchTools(server); registerTradingTools(server); });

async function guarded(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!mcpTokenOk(token)) return new Response("No autorizado", { status: 401 });
  return handler(req);
}
export { guarded as GET, guarded as POST, guarded as DELETE };
