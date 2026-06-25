/**
 * GET /api/config — safe, read-only view of the active configuration for the
 * Settings page. NEVER returns secrets — only which providers are configured
 * (by name), base URLs, model routing, limits, and mode.
 */
import { getEngine } from '@/lib/engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  const { config } = getEngine().deps;
  const p = config.providers;

  const providers = [
    p.moonshot.apiKey ? { id: 'moonshot', baseUrl: p.moonshot.baseUrl } : null,
    p.xai.apiKey ? { id: 'xai', baseUrl: p.xai.baseUrl } : null,
    p.groq.apiKey ? { id: 'groq', baseUrl: p.groq.baseUrl } : null,
    p.openaiCompatible.apiKey ? { id: 'openai-compatible', baseUrl: p.openaiCompatible.baseUrl } : null,
    p.openai.apiKey ? { id: 'openai', baseUrl: 'https://api.openai.com/v1' } : null,
    p.anthropic.apiKey ? { id: 'anthropic', baseUrl: 'native' } : null,
  ].filter(Boolean);

  return Response.json({
    providers,
    models: config.models,
    orchestration: config.orchestration,
    security: config.security,
    billing: config.billing,
  });
}
