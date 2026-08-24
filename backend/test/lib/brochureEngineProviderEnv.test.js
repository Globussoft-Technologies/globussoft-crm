/**
 * Unit tests for backend/lib/brochureEngineProviderEnv.js
 *
 * Scope: verify that a resolved CRM AI provider config is translated into the exact
 * env vars the agentic brochure engine subprocess expects, and that all other
 * provider keys are blanked out to prevent the engine from falling back to a
 * different provider.
 */

import { describe, it, expect } from "vitest";
import { buildEngineEnv, ENGINE_PROVIDER_KEYS, ENGINE_MODEL_KEYS } from "../../lib/brochureEngineProviderEnv";

describe("brochureEngineProviderEnv — buildEngineEnv", () => {
  it("returns null when config is missing or has no apiKey", () => {
    expect(buildEngineEnv(null)).toBeNull();
    expect(buildEngineEnv(undefined)).toBeNull();
    expect(buildEngineEnv({ providerId: "openai" })).toBeNull();
    expect(buildEngineEnv({ apiKey: "" })).toBeNull();
  });

  it("blanks out every engine provider key except the active one and override", () => {
    const env = buildEngineEnv({
      providerId: "openai",
      family: "openai-compatible",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      source: "byok",
      accessType: "byok",
    });
    for (const key of ENGINE_PROVIDER_KEYS) {
      if (key === "OPENAI_API_KEY") {
        expect(env[key]).toBe("sk-test");
      } else if (key === "PROVIDER_OVERRIDE") {
        expect(env[key]).toBe("openai");
      } else {
        expect(env[key]).toBe("");
      }
    }
    for (const key of ENGINE_MODEL_KEYS) {
      expect(env[key]).toBe("gpt-4o-mini");
    }
  });

  it("maps OpenAI BYOK to OPENAI_API_KEY + PROVIDER_OVERRIDE=openai", () => {
    const env = buildEngineEnv({
      providerId: "openai",
      family: "openai-compatible",
      apiKey: "sk-openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      source: "byok",
      accessType: "byok",
    });
    expect(env.OPENAI_API_KEY).toBe("sk-openai");
    expect(env.PROVIDER_OVERRIDE).toBe("openai");
    expect(env.OPENAI_COMPATIBLE_API_KEY).toBe("");
    for (const key of ENGINE_MODEL_KEYS) expect(env[key]).toBe("gpt-4o-mini");
  });

  it("maps Groq BYOK to GROQ_API_KEY + PROVIDER_OVERRIDE=groq", () => {
    const env = buildEngineEnv({
      providerId: "groq",
      family: "openai-compatible",
      apiKey: "gsk_test",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b-versatile",
      source: "byok",
      accessType: "byok",
    });
    expect(env.GROQ_API_KEY).toBe("gsk_test");
    expect(env.PROVIDER_OVERRIDE).toBe("groq");
    expect(env.OPENAI_API_KEY).toBe("");
    for (const key of ENGINE_MODEL_KEYS) expect(env[key]).toBe("llama-3.3-70b-versatile");
  });

  it("maps Moonshot BYOK to MOONSHOT_API_KEY + baseUrl + PROVIDER_OVERRIDE=moonshot", () => {
    const env = buildEngineEnv({
      providerId: "moonshot",
      family: "openai-compatible",
      apiKey: "mk-test",
      baseUrl: "https://api.moonshot.ai/v1",
      model: "kimi-k2.6",
      source: "byok",
      accessType: "byok",
    });
    expect(env.MOONSHOT_API_KEY).toBe("mk-test");
    expect(env.MOONSHOT_BASE_URL).toBe("https://api.moonshot.ai/v1");
    expect(env.PROVIDER_OVERRIDE).toBe("moonshot");
    for (const key of ENGINE_MODEL_KEYS) expect(env[key]).toBe("kimi-k2.6");
  });

  it("maps xAI BYOK to XAI_API_KEY + baseUrl + PROVIDER_OVERRIDE=xai", () => {
    const env = buildEngineEnv({
      providerId: "xai",
      family: "openai-compatible",
      apiKey: "xai-test",
      baseUrl: "https://api.x.ai/v1",
      model: "grok-3-mini",
      source: "byok",
      accessType: "byok",
    });
    expect(env.XAI_API_KEY).toBe("xai-test");
    expect(env.XAI_BASE_URL).toBe("https://api.x.ai/v1");
    expect(env.PROVIDER_OVERRIDE).toBe("xai");
    for (const key of ENGINE_MODEL_KEYS) expect(env[key]).toBe("grok-3-mini");
  });

  it("maps Gemini to the openai-compatible slot with the OpenAI-compatible endpoint", () => {
    const env = buildEngineEnv({
      providerId: "gemini",
      family: "gemini",
      apiKey: "AIza-test",
      baseUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-2.5-flash",
      source: "byok",
      accessType: "byok",
    });
    expect(env.OPENAI_COMPATIBLE_API_KEY).toBe("AIza-test");
    expect(env.OPENAI_COMPATIBLE_BASE_URL).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai",
    );
    expect(env.PROVIDER_OVERRIDE).toBe("openai-compatible");
    expect(env.GEMINI_API_KEY).toBeUndefined();
    for (const key of ENGINE_MODEL_KEYS) expect(env[key]).toBe("gemini-2.5-flash");
  });

  it("preserves a user-supplied Gemini OpenAI-compatible baseUrl", () => {
    const env = buildEngineEnv({
      providerId: "gemini",
      family: "gemini",
      apiKey: "AIza-test",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
      model: "gemini-2.5-flash",
      source: "byok",
      accessType: "byok",
    });
    expect(env.OPENAI_COMPATIBLE_BASE_URL).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai",
    );
  });

  it("maps other OpenAI-compatible providers to the openai-compatible slot", () => {
    const env = buildEngineEnv({
      providerId: "deepseek",
      family: "openai-compatible",
      apiKey: "ds-test",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      source: "byok",
      accessType: "byok",
    });
    expect(env.OPENAI_COMPATIBLE_API_KEY).toBe("ds-test");
    expect(env.OPENAI_COMPATIBLE_BASE_URL).toBe("https://api.deepseek.com");
    expect(env.PROVIDER_OVERRIDE).toBe("openai-compatible");
    for (const key of ENGINE_MODEL_KEYS) expect(env[key]).toBe("deepseek-chat");
  });

  it("handles CRM-managed OpenAI the same as BYOK OpenAI", () => {
    const env = buildEngineEnv({
      providerId: "openai",
      family: "openai-compatible",
      apiKey: "sk-crm-managed",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      source: "internal",
      accessType: "crm-managed",
    });
    expect(env.OPENAI_API_KEY).toBe("sk-crm-managed");
    expect(env.PROVIDER_OVERRIDE).toBe("openai");
    for (const key of ENGINE_MODEL_KEYS) expect(env[key]).toBe("gpt-4o-mini");
  });

  it("maps Anthropic to ANTHROPIC_API_KEY + PROVIDER_OVERRIDE=anthropic", () => {
    const env = buildEngineEnv({
      providerId: "claude",
      family: "anthropic",
      apiKey: "sk-ant-test",
      baseUrl: "https://api.anthropic.com",
      model: "claude-3-5-sonnet-latest",
      source: "byok",
      accessType: "byok",
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(env.PROVIDER_OVERRIDE).toBe("anthropic");
    for (const key of ENGINE_MODEL_KEYS) expect(env[key]).toBe("claude-3-5-sonnet-latest");
  });
});
