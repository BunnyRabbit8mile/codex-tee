# Tee Proxy — Architecture Specification

> Version 1.0 | 2026-07-09 | Observability layer between Codex++ and DeepSeek

---

## 1. Current Architecture

```
+-------+   :57321   +------------+   :5000    +-----------+   api.deepseek   +------------+
| Codex | --------> |  Codex++   | --------> | Tee Proxy | --------------> |  DeepSeek  |
| (app) |           | (Electron) |           | (Python)  |                  |   API      |
+-------+           +------------+           +-----------+                  +------------+
                         │                        │
                         │ widget injection       │ out-of-band trace
                         ▼                        ▼
                    +----------+             +-----------+
                    | Codex UI |             | LangSmith |
                    | (widgets)|             |  (SaaS)   |
                    +----------+             +-----------+
```

### Port Assignments

| Hop | Component   | Listen Address        | Upstream             | Role                        |
|-----|-------------|-----------------------|----------------------|-----------------------------|
| 1   | Codex       | —                     | `127.0.0.1:57321/v1` | Desktop client              |
| 2   | Codex++     | `127.0.0.1:57321`     | `127.0.0.1:5000/v1`  | Widget injection + forwarding |
| 3   | Tee Proxy   | `127.0.0.1:5000`      | `https://api.deepseek.com` | Trace + forward to LLM |
| 4   | DeepSeek    | `api.deepseek.com:443` | —                    | LLM provider                |

### Configuration

| File / Setting              | Key                          | Value                              |
|-----------------------------|------------------------------|------------------------------------|
| `config.toml`               | `base_url`                   | `http://127.0.0.1:57321/v1`        |
| Codex++ upstream (UI)       | API endpoint                 | `http://127.0.0.1:5000/v1`         |
| Tee Proxy `proxy.py`        | `TARGET`                     | `https://api.deepseek.com`         |

### Why this order?

Codex++ sits first because:
- It auto-resets `config.toml` to `:57321` — if Tee Proxy were first, Codex++ would break the chain on restart
- It handles widget injection into Codex UI — we still need this until Phase 3
- Tee Proxy only needs to trace + forward, which it can do from any position in the chain

---

## 2. Tee Proxy: Role & Responsibilities

Tee Proxy is a **transparent observability layer**. It does not modify requests or responses — only reads them.

| Responsibility          | How                                              |
|-------------------------|--------------------------------------------------|
| Forward requests        | Pass-through to DeepSeek, preserve all headers    |
| Extract metrics         | Parse `usage` from response body                  |
| Console logging         | Print turn number, model, hit/miss per request    |
| LangSmith tracing       | `create_run()` with full metadata per turn         |
| Health check            | `GET /_health` returns target + status             |

---

## 3. Proxy Endpoints

### 3.1 Forwarded (pass-through to DeepSeek)

| Method | Path                    | → `https://api.deepseek.com`            |
|--------|-------------------------|------------------------------------------|
| POST   | `/v1/chat/completions`  | `/v1/chat/completions`                   |
| *      | `/v1/*`                 | `/v1/*`                                  |

Behavior: headers, body, method preserved. Response returned unchanged. Streaming (SSE) proxied transparently.

### 3.2 Native

| Method | Path       | Response                                              |
|--------|------------|-------------------------------------------------------|
| GET    | `/_health` | `{"status":"ok","target":"https://api.deepseek.com"}`  |

---

## 4. Data Pipeline (per request)

```
Codex → :57321 → Codex++ → :5000 → Tee Proxy
                                        │
                               ┌────────┴────────┐
                               │ 1. Receive req  │
                               │ 2. Forward to   │
                               │    DeepSeek      │
                               │ 3. Receive resp │
                               │ 4. Extract usage│
                               └────────┬────────┘
                                        │
                          ┌─────────────┼─────────────┐
                          ▼             ▼             ▼
                     Console        LangSmith      Codex++
                     [turn N]       trace.run()    ← response
                     hit/miss       + metadata     (unchanged)
                                                     │
                                                     ▼
                                                   Codex
```

---

## 5. Metrics Captured

| Field                 | Source                    | Description                         |
|-----------------------|---------------------------|-------------------------------------|
| `prompt_tokens`       | `usage`                   | Total input tokens                  |
| `completion_tokens`   | `usage`                   | Total output tokens                 |
| `cached_tokens`       | `prompt_tokens_details`   | OpenAI-standard cached count        |
| `cache_hit_tokens`    | `usage` (DeepSeek)        | Tokens served from KV-cache         |
| `cache_miss_tokens`   | `usage` (DeepSeek)        | Tokens that missed cache            |
| `cache_hit_rate_pct`  | computed                  | `hit / (hit+miss) × 100`            |
| `model`               | request body              | e.g. `deepseek-v4-pro`             |
| `latency_ms`          | measured                  | Proxy → DeepSeek round-trip         |
| `turn`                | counter                   | Monotonic per proxy session         |

---

## 6. LangSmith Integration

| Setting              | Value                         |
|----------------------|-------------------------------|
| Project              | `codex-cache-analysis`        |
| Auth                 | `LANGSMITH_API_KEY` env var   |
| Trace unit            | One `run` per chat completion |

Trace metadata includes all 9 metrics from §5.

---

## 7. Project Files

```
tee-proxy/
├── proxy.py           # Main server (Python stdlib, only langsmith as dep)
├── run_proxy.py        # Launcher with DETACHED_PROCESS flag
├── start_proxy.bat     # Windows batch launcher
├── test_proxy.py       # Smoke test
├── SPEC.md             # This document
└── outputs/            # Logs
```

---

## 8. Roadmap

| Phase | Goal                                      | Status    |
|-------|-------------------------------------------|-----------|
| 1     | Tee Proxy between Codex++ and DeepSeek    | ✅ current |
| 2     | Replace Codex++ proxy · Tee Proxy on :57321 | planned  |
| 3     | Widgets: context / cache / cost in Codex UI | planned  |
