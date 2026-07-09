# Tee Proxy — Architecture Specification

> Version 1.0 | 2026-07-09 | Replaces Codex++ proxy layer

---

## 1. Overview

Tee Proxy sits between the Codex desktop client and the DeepSeek API, providing:

- **Transparent forwarding** — Codex API requests pass through unchanged
- **Observability** — Every API call is traced to LangSmith with full usage metadata
- **Cache analysis** — DeepSeek-specific `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` are captured per turn
- **Future: UI widgets** — Context size, cache hit rate, and token cost displayed inside Codex

### Why replace Codex++?

Codex++ loses connectivity after laptop sleep/wake cycles. Tee Proxy is a headless Python process that survives sleep, and can be registered as a Windows background service for auto-recovery.

---

## 2. Network Topology

```
+-------+      HTTP       +-----------+      HTTP       +------------+
| Codex | --------------> | Tee Proxy | --------------> |  DeepSeek  |
| (app) |     :57321      |  (Python) |   api.deepseek  |   API      |
+-------+                 +-----------+      .com        +------------+
                              │
                              │ trace (out-of-band)
                              ▼
                        +-----------+
                        | LangSmith |
                        |  (SaaS)   |
                        +-----------+
```

### Port Assignments

| Component      | Address               | Role                          |
|----------------|-----------------------|-------------------------------|
| Codex          | → `127.0.0.1:57321`   | Client, configured via `config.toml` `base_url` |
| Tee Proxy      | `127.0.0.1:57321`     | Listener + forwarder           |
| DeepSeek API   | `https://api.deepseek.com` | Upstream LLM provider     |
| LangSmith      | `https://api.smith.langchain.com` | Trace backend    |

---

## 3. Proxy Endpoints

### 3.1 Forwarded Endpoints

All paths under `/v1/` are forwarded verbatim to DeepSeek:

| Method | Path                       | Forwarded To                         |
|--------|----------------------------|--------------------------------------|
| POST   | `/v1/chat/completions`     | `https://api.deepseek.com/v1/chat/completions` |
| POST   | `/v1/embeddings`           | `https://api.deepseek.com/v1/embeddings` |
| GET    | `/v1/models`               | `https://api.deepseek.com/v1/models` |
| *      | `/v1/*` (any)              | `https://api.deepseek.com/v1/*`      |

**Behavior:**
- Request headers, body, and method are preserved
- Response status, headers, and body are returned unchanged
- Streaming (SSE) responses are proxied transparently
- Non-streaming responses are fully buffered before trace + return
- Upstream failures return HTTP 502 with `{"error": "<message>"}`

### 3.2 Tee Proxy Native Endpoints

| Method | Path          | Auth | Response                                        |
|--------|---------------|------|-------------------------------------------------|
| GET    | `/_health`    | None | `{"status":"ok","target":"https://api.deepseek.com"}` |
| GET    | `/stats`      | None | (planned) Per-turn cache & token summary         |
| GET    | `/stats/ws`   | None | (planned) WebSocket push for live widgets        |

---

## 4. Data Pipeline

```
Request arrives
    │
    ▼
┌──────────────────────────────────────┐
│ 1. Read request (method, path, body) │
└──────────────┬───────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│ 2. Forward to DeepSeek via HTTP      │
│    (preserve all headers + body)     │
└──────────────┬───────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│ 3. Receive response                  │
│    - Non-stream: read full body      │
│    - Stream: collect SSE chunks,     │
│      extract usage from last chunk   │
└──────────────┬───────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│ 4. Extract metrics                   │
│    prompt_tokens, completion_tokens  │
│    prompt_cache_hit_tokens           │
│    prompt_cache_miss_tokens          │
│    prompt_tokens_details.cached_     │
│      tokens (OpenAI compat)          │
└──────────────┬───────────────────────┘
               │
       ┌───────┴───────┐
       ▼               ▼
┌─────────────┐  ┌──────────────┐
│ 5a. Console  │  │ 5b. LangSmith│
│   log        │  │   trace      │
│ [turn 001]   │  │ create_run() │
│ hit= miss=   │  │ + metadata   │
└─────────────┘  └──────────────┘
       │               │
       ▼               ▼
┌──────────────────────────────────────┐
│ 6. Return response to Codex          │
│    (unchanged)                       │
└──────────────────────────────────────┘
```

### Metrics Captured (per turn)

| Field                  | Source                | Description                          |
|------------------------|-----------------------|--------------------------------------|
| `prompt_tokens`        | `usage`               | Total input tokens                   |
| `completion_tokens`    | `usage`               | Total output tokens                  |
| `cached_tokens`        | `prompt_tokens_details` | OpenAI-standard cached count        |
| `cache_hit_tokens`     | `usage` (DeepSeek)    | Tokens served from KV-cache          |
| `cache_miss_tokens`    | `usage` (DeepSeek)    | Tokens that missed cache             |
| `cache_hit_rate_pct`   | computed              | `hit / (hit + miss) * 100`           |
| `model`                | request body          | Model name (e.g., deepseek-v4-pro)   |
| `latency_ms`           | measured              | Round-trip time proxy → DeepSeek     |
| `turn`                 | counter               | Monotonic turn number per session    |

---

## 5. LangSmith Integration

### Configuration

```python
LANGSMITH_API_KEY = "lsv2_pt_..."  # hardcoded fallback + env override
LANGSMITH_PROJECT = "codex-cache-analysis"
```

### Trace Structure

```
Project: codex-cache-analysis
  ├── Run: turn_001
  │     run_type: llm
  │     inputs: {"messages": [...]}
  │     outputs: {"choices": [...]}
  │     extra.metadata:
  │       ├── turn: 1
  │       ├── model: "deepseek-v4-pro"
  │       ├── prompt_tokens: 8500
  │       ├── completion_tokens: 1200
  │       ├── cached_tokens: 2300
  │       ├── cache_hit_tokens: 2300
  │       ├── cache_miss_tokens: 6200
  │       ├── cache_hit_rate_pct: 27.1
  │       └── latency_ms: 3200
  ├── Run: turn_002
  │     ...
```

---

## 6. Project Files

```
tee-proxy/
├── proxy.py              # Main proxy server (Python stdlib only)
├── run_proxy.py           # Launcher (DETACHED_PROCESS, survives parent exit)
├── start_proxy.bat        # Windows batch launcher (sets env vars)
├── test_proxy.py          # Integration test script
├── outputs/               # Logs & artifacts
└── SPEC.md                # This document
```

---

## 7. Deployment

### Manual Start
```powershell
python run_proxy.py
```

### Batch Start
```cmd
start_proxy.bat
```

### Auto-Start (planned)
Register as Windows Scheduled Task:
- Trigger: At system startup + on resume from sleep
- Action: `pythonw.exe run_proxy.py`
- This eliminates the sleep/wake disconnection problem

---

## 8. Future: Widget Integration

Planned three widgets injected into Codex UI:

| Widget           | Data Source       | Display                            |
|------------------|-------------------|-------------------------------------|
| Context Size     | `prompt_tokens` vs model limit | Progress bar + number      |
| Cache Hit Rate   | `cache_hit / (hit+miss)`     | Percentage + sparkline     |
| Token Cost       | Tokens × DeepSeek pricing    | ¥ cost per turn + session total |

Widgets will poll `GET /stats` or use a WebSocket connection to `ws://127.0.0.1:57321/stats/ws` for live updates. Injection mechanism TBD (retain Codex++ script loader, or build standalone overlay).

