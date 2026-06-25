/**
 * Normalized, provider-neutral chat types. Every adapter maps the provider's
 * wire format to/from these, so the orchestration engine never sees a
 * provider-specific shape. Add a new provider = implement `LLMProvider`.
 */

export type LLMRole = 'system' | 'user' | 'assistant' | 'tool';

/** JSON Schema for a tool's parameters (kept loose on purpose). */
export type JSONSchema = Record<string, unknown>;

export interface LLMToolCall {
  /** Provider-assigned id, echoed back on the matching tool result message. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMMessage {
  role: LLMRole;
  content: string;
  /** Present on assistant turns that request tools. */
  toolCalls?: LLMToolCall[];
  /** Present on `role: 'tool'` messages — links the result to its call. */
  toolCallId?: string;
  /** Tool name on tool-result messages (some providers require it). */
  name?: string;
}

export interface LLMToolDef {
  name: string;
  description: string;
  parameters: JSONSchema;
}

/**
 * Provider-neutral structured-output request. When set AND the active provider
 * supports it (e.g. Groq / OpenAI `response_format: json_schema`), the model is
 * constrained to emit JSON matching `schema`. Providers that don't support it
 * simply ignore it, and a provider that REJECTS it triggers a one-shot retry with
 * the constraint stripped — so callers must still defensively parse the output.
 */
export interface ResponseFormat {
  type: 'json_schema';
  /** Schema label (e.g. "brochure_composer_output"); ^[a-zA-Z0-9_-]+$. */
  name: string;
  schema: JSONSchema;
  /** OpenAI strict mode. Leave unset for permissive schemas (omittable fields). */
  strict?: boolean;
}

export interface ChatRequest {
  model: string;
  messages: LLMMessage[];
  tools?: LLMToolDef[];
  temperature?: number;
  maxTokens?: number;
  /** Optional schema-constrained output (additive; ignored by providers/models that lack it). */
  responseFormat?: ResponseFormat;
}

export interface ChatResponse {
  message: LLMMessage;
  usage: { inputTokens: number; outputTokens: number };
  finishReason: 'stop' | 'tool_calls' | 'length';
  model: string;
}

/**
 * The one interface every LLM backend implements. The orchestration engine
 * depends on this — never on a concrete SDK.
 */
export interface LLMProvider {
  /** Stable id, e.g. "moonshot", "anthropic". */
  readonly id: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}
