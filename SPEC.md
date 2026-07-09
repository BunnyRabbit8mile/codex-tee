# Tee Proxy — Architecture Specification

> Version 1.0 | 2026-07-09 | Current: observability layer · Future: replaces Codex++

---

## 1. Current Architecture (Codex++ Still Active)

```
+-------+   :57321   +------------+   api.deepseek.com   +------------+
| Codex | --------> |  Codex++   | -------------------> |  DeepSeek  |
| (app) |           | (Electron) |                       |   API      |
+-------+           +------------+                       +------------+
                         │
                         │ widget injection
                         ▼
                    +----------+
                    | Codex UI |
                    | (widgets)|
                    +----------+
```

| Component   | Address                    | Role                              |
|-------------|----------------------------|-----------------------------------|
| Codex       | → `127.0.0.1:57321/v1`     | Desktop client, reads `config.toml` |
| Codex++     | `127.0.0.1:57321`          | Proxy + widget injector + script engine |
| DeepSeek    | `https://api.deepseek.com` | Upstream LLM                      |

### Problems with Codex++

- Laptop sleep/wake breaks the Electron → Codex IPC, requiring manual restart
- Auto-resets `config.toml` `base_url` on every launch
- Opaque internals — no visibility into proxy behavior

---

## 2. Tee Proxy: Current Role

Tee Proxy is an **observability sidecar** inserted between Codex and Codex++:

```
+-------+   :5000    +-----------+   :57321   +------------+   api.deepseek   +------------+
| Codex | --------> | Tee Proxy | --------> |  Codex++   | --------------> |  DeepSeek  |
| (app) |           | (Python)  |           | (Electron) |                  |   API      |
+-------+           +-----------+           +------------+                  +------------+
                         │
                         │ out-of-band trace
                         ▼
                    +-----------+
                    | LangSmith |
                    |  (SaaS)   |
                    +-----------+
```

| Component   | Address                    | Role                              |
|-------------|----------------------------|-----------------------------------|
| Codex       | → `127.0.0.1:5000/v1`      | `config.toml` `base_url`          |
| Tee Proxy   | `127.0.0.1:5000`           | Trace every API call, forward to Codex++ |
| Codex++     | `127.0.0.1:57321`          | Forward to DeepSeek + widget injection |
| DeepSeek    | `https://api.deepseek.com` | Upstream LLM                      |
| LangSmith   | `https://api.smith.langchain.com` | Trace backend            |

### Caveat

Codex++ rewrites `config.toml` `base_url` to `:57321` on every launch. When this happens, Tee Proxy is bypassed until the config is manually restored to `:5000`.

---

## 3. Tee Proxy Endpoints

### 3.1 Forwarded (pass-through to Codex++)

| Method | Path                    | Forwarded To                              |
|--------|-------------------------|-------------------------------------------|
| POST   | `/v1/chat/completions`  | `http://127.0.0.1:57321/v1/chat/completions` |
| *      | `/v1/*`                 | `http://127.0.0.1:57321/v1/*`             |

### 3.2 Native

| Method | Path       | Response                                           |
|--------|------------|----------------------------------------------------|
| GET    | `/_health` | `{"status":"ok","target":"http://127.0.0.1:57321"}` |
| GET    | `/stats`   | (planned) Per-turn cache & token summary            |

---

## 4. Data Pipeline

```
Request: Codex → :5000/v1/chat/completions
    │
    ▼
┌─────────────────────────────────────────┐
│ 1. Tee Proxy receives request           │
│    Preserves all headers + body         │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ 2. Forward to Codex++ (:57321)          │
│    HTTP proxy, no modification          │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ 3. Codex++ forwards to DeepSeek         │
│    (handles auth, model routing)        │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ 4. Response flows back:                 │
│    DeepSeek → Codex++ → Tee Proxy       │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ 5. Tee Proxy extracts usage from body   │
│    ├─ prompt_tokens                     │
│    ├─ completion_tokens                 │
│    ├─ prompt_cache_hit_tokens  (DS)     │
│    ├─ prompt_cache_miss_tokens (DS)     │
│    └─ cached_tokens (OpenAI compat)     │
└──────────────┬──────────────────────────┘
               │
       ┌───────┴───────┐
       ▼               ▼
┌─────────────┐  ┌──────────────┐
│ Console log │  │ LangSmith    │
│ [turn 001]  │  │ trace.run()  │
│ hit= miss=  │  │ + metadata   │
└─────────────┘  └──────────────┘
       │               │
       ▼               ▼
┌─────────────────────────────────────────┐
│ 6. Return unchanged response to Codex   │
└─────────────────────────────────────────┘
```

---

## 5. Metrics Captured (per turn)

| Field                 | Source                    | Description                         |
|-----------------------|---------------------------|-------------------------------------|
| `prompt_tokens`       | `usage`                   | Total input tokens                  |
| `completion_tokens`   | `usage`                   | Total output tokens                 |
| `cached_tokens`       | `prompt_tokens_details`   | OpenAI-standard cached count        |
| `cache_hit_tokens`    | `usage` (DeepSeek)        | Tokens served from KV-cache         |
| `cache_miss_tokens`   | `usage` (DeepSeek)        | Tokens that missed cache            |
| `cache_hit_rate_pct`  | computed                  | `hit / (hit+miss) × 100`            |
| `model`               | request body              | e.g. `deepseek-v4-pro`             |
| `latency_ms`          | measured                  | Proxy → Codex++ → DeepSeek RTT     |
| `turn`                | counter                   | Monotonic per proxy session         |

---

## 6. LangSmith Integration

| Setting              | Value                                              |
|----------------------|----------------------------------------------------|
| Project              | `codex-cache-analysis`                             |
| Auth                 | `LANGSMITH_API_KEY` env var                        |
| Trace granularity    | One `run` per `/v1/chat/completions` call          |
| Run type             | `llm`                                              |

### Trace Structure

```
Project: codex-cache-analysis
  Run: turn_001
    inputs:  {"messages": [...]}
    outputs: {"choices": [...]}
    extra.metadata:
      turn: 1
      model: "deepseek-v4-pro"
      prompt_tokens: 8500
      completion_tokens: 1200
      cache_hit_tokens: 2300
      cache_miss_tokens: 6200
      cache_hit_rate_pct: 27.1
      latency_ms: 3200
```

---

## 7. Project Files

```
tee-proxy/
├── proxy.py           # Proxy server (Python stdlib, zero deps beyond langsmith)
├── run_proxy.py        # Launcher with DETACHED_PROCESS flag
├── start_proxy.bat     # Windows batch launcher
├── test_proxy.py       # Integration smoke test
├── SPEC.md             # This document
└── outputs/            # Logs & artifacts
```

---

## 8. Future Roadmap: Replace Codex++

```
Phase 1 (now):     Tee Proxy as observability sidecar
                   Codex → :5000 (trace) → :57321 → DeepSeek

Phase 2 (planned): Tee Proxy replaces Codex++ proxy layer
                   Codex → :57321 (trace + forward) → DeepSeek
                   - Proxy listens on :57321
                   - Codex++ proxy process disabled
                   - Retain Codex++ script loader for widgets (or build overlay)

Phase 3 (planned): Widgets
                   - Context size, cache hit rate, token cost
                   - Poll /stats or WebSocket
                   - Injection via retained Codex++ loader or standalone overlay
```
