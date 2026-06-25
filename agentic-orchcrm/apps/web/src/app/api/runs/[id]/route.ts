/** GET /api/runs/:id — full detail for one run (trace + per-agent usage + result). */
import { getStore } from '@/lib/engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const detail = getStore().getRunDetail(id);
  if (!detail) return Response.json({ error: 'Run not found.' }, { status: 404 });
  return Response.json(detail);
}
