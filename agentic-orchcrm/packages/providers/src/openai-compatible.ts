/**
 * Adapter for any OpenAI-compatible Chat Completions API.
 *
 * Moonshot/Kimi, OpenAI, Together, Groq, DeepSeek, and local vLLM all speak
 * this protocol, so this single class backs most providers — you only vary the
 * base URL and key. Anthropic is the notable exception (native format) and gets
 * its own adapter when its key is added.
 */
import { ProviderError } from '@agentic-os/shared';
import type {
  ChatRequest,
  ChatResponse,
  LLMMessage,
  LLMProvider,
  LLMToolCall,
} from './types.js';

interface OpenAICompatibleOptions {
  id: string;
  apiKey: string;
  baseUrl: string;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    // Newer OpenAI reasoning models (gpt-5*, o-series) require `max_completion_tokens`
    // (not `max_tokens`) and reject a non-default `temperature`. Detect them and emit
    // the right params up front; the retry loop also self-heals if a model we didn't
    // recognise rejects these params.
    const reasoning = isReasoningModel(req.model);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map(toWireMessage),
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              },
            })),
            tool_choice: 'auto',
          }
        : {}),
      ...(req.responseFormat
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: req.responseFormat.name,
                schema: req.responseFormat.schema,
                ...(req.responseFormat.strict !== undefined ? { strict: req.responseFormat.strict } : {}),
              },
            },
          }
        : {}),
    };
    if (!reasoning) body.temperature = req.temperature ?? 0.3;
    body[reasoning ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens ?? 4096;

    const json = (await this.requestWithRetry(body)) as WireResponse;
    const choice = json.choices?.[0];
    if (!choice) throw new ProviderError(`${this.id} returned no choices`);

    const toolCalls: LLMToolCall[] | undefined = choice.message.tool_calls?.map(
      (tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: safeParse(tc.function.arguments),
      }),
    );

    return {
      message: {
        role: 'assistant',
        content: choice.message.content ?? '',
        ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      },
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      },
      finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : choice.finish_reason === 'length' ? 'length' : 'stop',
      model: json.model ?? req.model,
    };
  }

  /**
   * POST with retry on 429 / 5xx, honoring server-suggested retry delays. This
   * makes provider rate limits (e.g. Gemini free tier's 5 req/min) non-fatal —
   * the loop waits and retries instead of failing the whole run.
   */
  private async requestWithRetry(body: unknown, maxAttempts = 5): Promise<unknown> {
    let lastErr = '';
    let lastStatus = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (res.ok) return res.json();

      const text = await res.text().catch(() => '');
      lastErr = text.slice(0, 500);
      lastStatus = res.status;

      // tool_use_failed: the model emitted a malformed/leaked tool call (a known
      // STOCHASTIC glitch on some Groq models — e.g. llama's broken <function=…>
      // format or gpt-oss leaking a <|channel|> token into the tool name).
      // Re-sampling at a higher temperature almost always yields a clean call,
      // so treat it as retryable rather than failing the whole run.
      const toolGlitch = res.status === 400 && /tool_use_failed/i.test(text);
      // Some providers/models don't support `response_format: json_schema` and 400 on
      // it. Since structured output is a best-effort QUALITY boost (the caller still
      // parses defensively), strip it and retry once rather than failing the run.
      // Only strip on a 400 that actually blames the schema/response_format — never
      // mask an unrelated 400 (bad model, invalid param) that would just fail again.
      const hasSchema = !!body && typeof body === 'object' && 'response_format' in (body as object);
      const schemaReject =
        res.status === 400 &&
        !toolGlitch &&
        hasSchema &&
        /response_format|json[_ ]?schema|\bschema\b|structured\s*output|not\s*supported|unsupported/i.test(text);
      // Param self-heal: a model (e.g. an OpenAI gpt-5 / o-series reasoning model we
      // didn't recognise) rejects `max_tokens` (wants `max_completion_tokens`) or a
      // non-default `temperature`. Swap/strip the offending param and retry once.
      const b = (body && typeof body === 'object' ? (body as Record<string, unknown>) : {}) as Record<string, unknown>;
      const maxTokReject = res.status === 400 && 'max_tokens' in b && /max_tokens|max_completion_tokens/i.test(text);
      const tempReject =
        res.status === 400 &&
        'temperature' in b &&
        /temperature.*(unsupported|not\s*support|does not support|only.*default)|unsupported.*temperature/i.test(text);
      const paramFix = maxTokReject || tempReject;
      const retryable = res.status === 429 || res.status >= 500 || toolGlitch || schemaReject || paramFix;
      if (!retryable || attempt === maxAttempts - 1) break;

      if (paramFix) {
        if (maxTokReject) {
          b.max_completion_tokens = b.max_tokens;
          delete b.max_tokens;
        }
        if (tempReject) delete b.temperature;
      } else if (schemaReject) {
        delete (body as Record<string, unknown>).response_format;
      } else if (toolGlitch && body && typeof body === 'object') {
        const bt = body as { temperature?: number };
        bt.temperature = Math.min((bt.temperature ?? 0.3) + 0.25, 1);
      }
      await sleep(paramFix ? 50 : schemaReject ? 100 : toolGlitch ? 300 : retryDelayMs(res, text, attempt));
    }
    throw new ProviderError(`${this.id} chat failed (${lastStatus}): ${lastErr}`, lastStatus);
  }
}

/**
 * OpenAI reasoning models (gpt-5*, o1/o3/o4*) need `max_completion_tokens` instead of
 * `max_tokens` and only accept the default temperature. Match the bare model id even if
 * it carries a "provider/" prefix (e.g. "openai/gpt-oss-…" must NOT match — only gpt-5*).
 */
function isReasoningModel(model: string): boolean {
  const id = String(model || '').replace(/^[^/]+\//, '').toLowerCase();
  return /^(gpt-5|o[1-9])/.test(id);
}

// ── wire <-> normalized mapping ──────────────────────────────────────────────

function toWireMessage(m: LLMMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Choose a retry delay: the `Retry-After` header, else a server "retry in Xs" /
 * `retryDelay` hint from the body, else exponential backoff with jitter.
 * Capped at 30s so a single call can't stall the run indefinitely.
 */
function retryDelayMs(res: Response, body: string, attempt: number): number {
  const cap = 30_000;
  const header = res.headers.get('retry-after');
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return Math.min(secs * 1000, cap);
  }
  const m = body.match(/retry in ([\d.]+)s/i) ?? body.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i);
  if (m && m[1]) {
    const secs = Number(m[1]);
    if (Number.isFinite(secs)) return Math.min(Math.ceil(secs * 1000) + 500, cap);
  }
  return Math.min(1000 * 2 ** attempt + Math.floor(Math.random() * 400), cap);
}

interface WireResponse {
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: Array<{
    finish_reason?: string;
    message: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
}
