# codex-tee — Design Document

> Transparent observability proxy for Codex → DeepSeek, powered by Langfuse tracing.

---

## 1. Overview

codex-tee is a lightweight Node.js proxy that sits between Codex CLI (via Codex++) and the DeepSeek API. It passively intercepts every API call, rewrites GPT model names to DeepSeek equivalents, and traces all requests — including cache metrics — to Langfuse for real-time observability.

### Design Goals

| Goal | Rationale |
|---|---|
| Zero latency overhead | Pass-through stream — data flows immediately, never buffered |
| Non-blocking tracing | Fire-and-forget sinks — a slow observability backend never delays responses |
| Pluggable sinks | Add/remove observability backends in one line of config |
| Full cache visibility | Extract DeepSeek cache hit/miss metrics for cost analysis |
| Model name translation | Codex sends gpt-* for sub-agents; tee rewrites to DeepSeek equivalents |

---

## 2. Architecture

`
+-------+   :57321   +------------+   :57322    +-----------+   api.deepseek   +------------+
| Codex | --------> |  Codex++   | --------> | codex-tee | --------------> |  DeepSeek  |
| (app) |           | (Electron) |           | (Node.js) |                  |   API      |
+-------+           +------------+           +-----------+                  +------------+
                         |                        |
                         | widget injection       | trace
                         v                        v
                    +----------+             +-----------+
                    | Codex UI |             | Langfuse  |
                    +----------+             +-----------+
`

### Port Assignments

| Hop | Component | Listen | Upstream | Role |
|---|---|---|---|---|
| 1 | Codex | — | 127.0.0.1:57321/v1 | Desktop client |
| 2 | Codex++ | 127.0.0.1:57321 | 127.0.0.1:57322/v1 | Widget injection + pass-through |
| 3 | codex-tee | 127.0.0.1:57322 | https://api.deepseek.com | Trace + model rewrite + forward |
| 4 | DeepSeek | pi.deepseek.com | — | LLM provider |

---

## 3. Component Design

### 3.1 server.js — HTTP Proxy

Entry point. Creates an HTTP server on config.listen, forwards requests to config.upstream, and pipes responses through a TeeStream.

**Key behaviors:**
- GET /_health returns {"status":"ok"} for health checks
- All other requests are forwarded to upstream with model rewrite applied
- Response body is tee'd through a Transform stream that captures bytes and flushes to sinks on end

**Design decisions:**
- **Why Transform stream?** A Transform stream passes chunks through immediately while simultaneously collecting them. This means zero buffering latency — the client sees streaming responses in real time.
- **Why not pipe + buffer?** Buffer-then-forward adds latency proportional to response size. For long SSE streams this is unacceptable.

### 3.2 TeeStream — Passthrough with Capture

Extends Transform. On each chunk, pushes it downstream immediately and appends it to an internal buffer (up to max_mirror_bytes). On flush, concatenates buffer and dispatches to sinks with timing metadata.

`
clientRes <── TeeStream <── upstreamRes
                |
                +── capture chunks (up to max_mirror_bytes)
                |
                +── on end: dispatch({ method, path, headers, body, durationMs })
`

### 3.3 sinks/ — Observability Sinks

Each sink exports { ingest(trace): void | Promise<void> }. Sinks are loaded from config.sinks array and dispatched in parallel via egistry.js.

`
server.js → TeeStream._flush() → registry.dispatch() ──┬── langfuse.js (production)
                                                        ├── demo.js     (debug)
                                                        └── custom...   (user-defined)
`

**Fire-and-forget pattern:** The registry calls Promise.resolve(sink.ingest(trace)).catch(...) — sinks never block the response stream.

### 3.4 sinks/langfuse.js — Langfuse Tracing

Uses the langfuse SDK to send structured traces via the Langfuse API.

| Feature | Detail |
|---|---|
| Auth | LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY |
| Endpoint | LANGFUSE_HOST (default: https://cloud.langfuse.com) |
| Project | LANGFUSE_PROJECT (default: codex-tee) |

**Trace structure per request:**
`
Trace { name: "chat.completions", sessionId: PROJECT }
  └── Generation {
        name, model,
        input:  { messages, ... },
        output: { choices, ... } | { error: ... },
        usage:  { promptTokens, completionTokens, totalTokens },
        metadata: { method, path, duration_ms, status, cache_*, reasoning_tokens }
      }
`

**SSE parsing:** For streaming responses, the sink parses SSE chunks, reconstructs the full output text, and extracts the model name from chunk metadata.

**Error handling:** Requests returning HTTP ≥ 400 are traced with level: "ERROR" and statusMessage.

### 3.5 sinks/demo.js — Console Debug

Logs request metadata to stdout. Useful for local development.

### 3.6 sinks/registry.js — Sink Dispatcher

Loads all sinks from config and dispatches traces to each in parallel. Never awaits — all sinks are fire-and-forget.

### 3.7 config.js — Central Configuration

`js
{
  listen:   { host, port },       // proxy listen address
  upstream: { base_url },         // upstream API
  model_rewrite: { ... },         // GPT → DeepSeek model mapping
  default_model: "...",           // fallback for unknown gpt-* models
  sinks: [ ... ],                 // observability sinks
  max_mirror_bytes: 1_048_576,   // max response body capture (1 MB)
}
`

### 3.8 Model Rewrite Rules

Codex sends gpt-* model names for sub-agent spawns. Codex++ doesn't translate these. codex-tee rewrites them before forwarding:

| Input | Output |
|---|---|
| gpt-5.4 | deepseek-v4-pro |
| gpt-5.4-mini | deepseek-v4-flash |
| gpt-5.5 | deepseek-v4-pro |
| gpt-5.3-codex | deepseek-v4-pro |
| gpt-5.2 | deepseek-v4-pro |
| gpt-* (other) | deepseek-v4-pro (default) |

Matching priority: exact match → longest prefix match → gpt-* fallback.

---

## 4. Data Flow

### 4.1 Chat Completion (Streaming)

`
1. Codex → POST /v1/chat/completions (model: "gpt-5.5")
2. codex-tee rewrites model to "deepseek-v4-pro"
3. codex-tee → POST https://api.deepseek.com/v1/chat/completions
4. DeepSeek → SSE stream (data: {...})
5. TeeStream passes each chunk to Codex immediately
6. TeeStream captures chunks in buffer
7. Stream ends → TeeStream._flush()
8. registry.dispatch() → langfuse.ingest(trace)
9. Langfuse SDK sends trace asynchronously
`

### 4.2 Error Handling

| Scenario | Behavior |
|---|---|
| Upstream timeout (120s) | Respond 502 to client |
| Upstream connection error | Respond 502, trace with error metadata |
| Sink throws exception | Caught by registry, logged to console — no impact on client |
| Langfuse SDK failure | Caught in ingest(), logged — no retry, no impact |
| Missing Langfuse credentials | Sink self-disables with console warning |

---

## 5. Cache Metrics

DeepSeek returns usage.prompt_cache_hit_tokens and usage.prompt_cache_miss_tokens. codex-tee extracts and traces:

| Metric | Source |
|---|---|
| prompt_tokens | usage.prompt_tokens |
| completion_tokens | usage.completion_tokens |
| cached_tokens | usage.prompt_tokens_details.cached_tokens or usage.prompt_cache_hit_tokens |
| cache_miss_tokens | usage.prompt_cache_miss_tokens |
| cache_hit_ratio | cached_tokens / prompt_tokens (computed) |
| easoning_tokens | usage.completion_tokens_details.reasoning_tokens |

All cache metrics appear as metadata on each Langfuse generation, filterable in the Langfuse UI.

---

## 6. Project Structure

`
codex-tee/
├── config.js           # Central configuration
├── server.js           # HTTP proxy + SSE streaming + TeeStream
├── package.json        # npm metadata (dep: langfuse)
├── sinks/
│   ├── langfuse.js     # Langfuse trace sink (production)
│   ├── demo.js         # Console debug sink
│   └── registry.js     # Sink loader + dispatcher
├── start-tee.bat       # Windows launcher with env vars
├── launcher.vbs        # Silent VBScript launcher (no console window)
├── README.md           # Quick start guide
└── SPEC.md             # This design document
`

---

## 7. Deployment

### Start
`cmd
start-tee.bat
`
This sets environment variables and runs 
ode --use-system-ca server.js.

### Silent Start
`cmd
wscript launcher.vbs
`
Launches without a visible console window.

### Stop
`powershell
Stop-Process -Name node -Force
`

### Auto-start (planned)
Windows Scheduled Task triggered on system startup and resume from sleep.

---

## 8. Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| LANGFUSE_PUBLIC_KEY | Yes | — | Langfuse public key (pk-lf-...) |
| LANGFUSE_SECRET_KEY | Yes | — | Langfuse secret key (sk-lf-...) |
| LANGFUSE_HOST | No | https://cloud.langfuse.com | Langfuse API host |
| LANGFUSE_PROJECT | No | codex-tee | Project name in Langfuse UI |

