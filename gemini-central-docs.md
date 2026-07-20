# `internal/gemini` — Gemini proxy client

A small Go client for calling Gemini's `generateContent` REST API through the
internal proxy (`GEMINI_PROXY_BASE_URL`), with a shared RPM limiter and metrics
counters. It mirrors the request/response shape the `google-genai` SDK
produces, so it's wire-compatible with that API's `v1beta` format.

The proxy itself is just an HTTP endpoint — `{GEMINI_PROXY_BASE_URL}/v1beta/models/{model}:generateContent`,
authenticated with a plain `Authorization: Bearer <GEMINI_PROXY_API_KEY>` header
(not the public API's `x-goog-api-key`, though this client sends both for
compatibility). Anything that can POST JSON can call it — this doc shows the Go
package here plus equivalent raw-HTTP usage in Python and Node.js.

| Language | How | Where |
|---|---|---|
| **Go** | `internal/gemini` package (this doc) | in-process, this repo's `deploy/` service |
| **Python** | `google-genai` SDK with a custom `base_url`, or plain `requests` | `search_service_v2/agent/gemini_agent.py` |
| **Node.js** | plain `fetch` (no official SDK wraps this proxy) | any Node client |

## Go — via `internal/gemini`

### Setup

Build one `Client` per process and share it across call sites, along with one
`RateLimiter` and one `Metrics` instance:

```go
limiter := gemini.NewRateLimiter(cfg.GeminiRPM)
metrics := gemini.NewMetrics(limiter)
client := gemini.NewClient(
    cfg.GeminiProxyBaseURL,
    cfg.GeminiProxyAPIKey,
    cfg.GeminiModel,      // chat model, e.g. "gemini-2.5-flash-lite"
    cfg.GeminiEmbedModel, // embed model (reserved for future embedContent support)
    limiter,
    metrics,
)
```

`limiter` and `metrics` are safe for concurrent use — pass the same pointers
to every `Client` / call site so RPM budget and token counters stay global.

### Making a call

```go
resp, err := client.GenerateContent(ctx, &gemini.GenerateContentRequest{
    Contents: []gemini.Content{
        {Role: "user", Parts: []gemini.Part{{Text: "Hello"}}},
    },
    GenerationConfig: &gemini.GenerationConfig{
        ThinkingConfig: &gemini.ThinkingConfig{ThinkingBudget: 512},
    },
})
if err != nil {
    // 4xx/5xx from the proxy surface as *apiError; transient statuses
    // (429/500/502/503/504) are already retried internally with backoff.
    return err
}

text := resp.Text()                 // non-thought text of the first candidate
calls := resp.FunctionCalls()       // tool calls the model wants to make
usage := resp.Usage(turn)           // normalized token counts for this call
metrics.RecordAICall(usage, -1)     // -1 = not cache-tracked; 0/1 = miss/hit
```

`GenerateContent` blocks on `limiter.Acquire()` before every attempt (including
retries), so it never exceeds the configured RPM — callers don't need their
own throttling.

### Tool calling

Declare tools via `Tool.FunctionDeclarations` and read the model's requested
calls off the response:

```go
req := &gemini.GenerateContentRequest{
    Contents: history,
    Tools: []gemini.Tool{{
        FunctionDeclarations: []gemini.FunctionDeclaration{{
            Name:        "search_ads",
            Description: "Search live ads by filter",
            Parameters: &gemini.Schema{
                Type:       "OBJECT",
                Properties: map[string]*gemini.Schema{"keyword": {Type: "STRING"}},
            },
        }},
    }},
}

resp, _ := client.GenerateContent(ctx, req)
for _, call := range resp.FunctionCalls() {
    // dispatch by call.Name, decode call.Args, then append a
    // gemini.Content{Role: "function", Parts: []gemini.Part{{
    //     FunctionResponse: &gemini.FunctionResponse{Name: call.Name, Response: result},
    // }}} to history before the next turn.
}
```

A `GoogleSearch` tool (grounding) cannot be combined with
`FunctionDeclarations` or a `ResponseSchema` in the same call — use it in a
standalone request (see `internal/agent/grounding.go` for an example).

### Structured output

Set `ResponseMIMEType: "application/json"` and a `ResponseSchema` on
`GenerationConfig` to force JSON output matching a shape, then
`json.Unmarshal([]byte(resp.Text()), &out)`.

### Metrics

`metrics.Snapshot()` returns a JSON-friendly map (served at `/metrics`) and
`metrics.Prometheus()` renders the same counters in Prometheus text format
(served at `/metrics/prometheus`): call counts, cumulative input/output/
thinking tokens, cache hit/miss counts, and current RPM vs. the configured
limit.

## Python — via `google-genai` SDK

This is how `search_service_v2/agent/gemini_agent.py` talks to the same proxy:
point the official SDK's client at the proxy's `base_url` and pass the bearer
key both as `api_key` and as an explicit header (config.py:108-118).

```python
import os
from google import genai
from google.genai import types

client = genai.Client(
    api_key=os.environ["GEMINI_PROXY_API_KEY"],
    http_options=types.HttpOptions(
        base_url=os.environ.get(
            "GEMINI_PROXY_BASE_URL",
            "https://gemini-central-beta-v1-pn-ds-01.poweradspy.ai/nx/direct",
        ),
        headers={"Authorization": f"Bearer {os.environ['GEMINI_PROXY_API_KEY']}"},
    ),
)

resp = client.models.generate_content(
    model="gemini-2.5-flash-lite",
    contents="Hello",
    config=types.GenerateContentConfig(
        thinking_config=types.ThinkingConfig(thinking_budget=512),
    ),
)
print(resp.text)
print(resp.usage_metadata.total_token_count)
```

Tool calling and structured output work exactly as documented for the
`google-genai` SDK upstream — `config=types.GenerateContentConfig(tools=[...])`
and `response_mime_type="application/json"` / `response_schema=...`
respectively — since the proxy is wire-compatible with the SDK's normal
request/response shape.

### Python — plain `requests` (no SDK)

Equivalent without the SDK, for a lighter dependency footprint:

```python
import os
import requests

BASE_URL = os.environ.get(
    "GEMINI_PROXY_BASE_URL",
    "https://gemini-central-beta-v1-pn-ds-01.poweradspy.ai/nx/direct",
)
MODEL = "gemini-2.5-flash-lite"
API_KEY = os.environ["GEMINI_PROXY_API_KEY"]

resp = requests.post(
    f"{BASE_URL}/v1beta/models/{MODEL}:generateContent",
    headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}",
        "x-goog-api-key": API_KEY,
    },
    json={
        "contents": [{"role": "user", "parts": [{"text": "Hello"}]}],
        "generationConfig": {"thinkingConfig": {"thinkingBudget": 512}},
    },
    timeout=120,
)
resp.raise_for_status()
data = resp.json()
text = "".join(
    p["text"]
    for p in data["candidates"][0]["content"]["parts"]
    if "text" in p and not p.get("thought")
)
print(text)
```

## Node.js — via `fetch`

There's no dedicated SDK for this internal proxy in Node, so call the REST
endpoint directly — same headers, same JSON body shape as the Go and Python
examples above:

```js
const BASE_URL = process.env.GEMINI_PROXY_BASE_URL
  ?? "https://gemini-central-beta-v1-pn-ds-01.poweradspy.ai/nx/direct";
const MODEL = "gemini-2.5-flash-lite";
const API_KEY = process.env.GEMINI_PROXY_API_KEY;

async function generateContent(prompt) {
  const res = await fetch(`${BASE_URL}/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_KEY}`,
      "x-goog-api-key": API_KEY,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { thinkingConfig: { thinkingBudget: 512 } },
    }),
  });

  if (!res.ok) {
    throw new Error(`gemini proxy status ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  return parts.filter(p => p.text && !p.thought).map(p => p.text).join("");
}

const text = await generateContent("Hello");
console.log(text);
```

Function calls come back as `data.candidates[0].content.parts[].functionCall`
(`{name, args}`); append a `{role: "function", parts: [{functionResponse: {name, response}}]}`
turn to `contents` before the next call, same as the Go and Python flows.

Transient statuses (`429`, `500`, `502`, `503`, `504`) are worth retrying with
backoff in any language — the Go client does this internally (`maxRetries: 4`,
exponential backoff starting at 2s); replicate that in Python/Node clients
that see meaningful proxy load.
