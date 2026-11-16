import { createMcpHandler } from "mcp-handler";
import { registerTools } from "@/lib/mcp-tools";
import { mcpTokenOk } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = createMcpHandler((server) => registerTools(server));

async function guarded(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!mcpTokenOk(token)) return new Response("No autorizado", { status: 401 });
  return handler(req);
}
export { guarded as GET, guarded as POST, guarded as DELETE };
