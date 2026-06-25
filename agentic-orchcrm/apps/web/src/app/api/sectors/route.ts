/** GET /api/sectors — the available sector packs and their agent rosters. */
import { listSectorPacks, BROCHURE_STYLE_LIST, BROCHURE_TEMPLATE_STYLES } from '@agentic-os/sectors';

export const runtime = 'nodejs';

export function GET() {
  // Picker labels come from BOTH the art-direction styles (HTML designer path) and
  // the brochure-engine templates (brochure_json path).
  const labelOf = new Map<string, string>(
    [...BROCHURE_STYLE_LIST, ...BROCHURE_TEMPLATE_STYLES].map((s) => [s.key, s.name]),
  );
  const packs = listSectorPacks().map((p) => ({
    key: p.key,
    name: p.name,
    description: p.description,
    coordinatorKey: p.coordinatorKey,
    // Style picker data (empty for sectors that don't offer styles).
    styles: (p.finalize?.styles ?? []).map((k) => ({ key: k, label: labelOf.get(k) ?? k })),
    defaultStyleKey: p.finalize?.defaultStyleKey,
    producesPdf: Boolean(p.finalize),
    agents: p.agents.map((a) => ({
      key: a.key,
      name: a.name,
      title: a.title,
      description: a.description,
      tier: a.tier,
      tools: a.tools,
      delegatesTo: a.delegatesTo ?? [],
    })),
  }));
  return Response.json({ packs });
}
