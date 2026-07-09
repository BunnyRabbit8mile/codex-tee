# codex-tee — Architecture Specification

> Node.js transparent proxy · Codex++ → Tee → DeepSeek · LangSmith observability

---

## 1. Architecture

```
+-------+   :57321   +------------+   :57322    +-----------+   api.deepseek   +------------+
| Codex | --------> |  Codex++   | --------> | codex-tee | --------------> |  DeepSeek  |
| (app) |           | (Electron) |           | (Node.js) |                  |   API      |
+-------+           +------------+           +-----------+                  +------------+
                         │                        │
                         │ widget injection       │ trace
                         ▼                        ▼
                    +----------+             +-----------+
                    | Codex UI |             | LangSmith |
                    +----------+             +-----------+
```

### Port Assignments

| Hop | Component   | Listen            | Upstream                    | Role                      |
|-----|-------------|-------------------|-----------------------------|---------------------------|
| 1   | Codex       | —                 | `127.0.0.1:57321/v1`        | Desktop client            |
| 2   | Codex++     | `127.0.0.1:57321` | `127.0.0.1:57322/v1`        | Widget injection + pass-through |
| 3   | codex-tee   | `127.0.0.1:57322` | `https://api.deepseek.com`  | Trace + model rewrite + forward |
| 4   | DeepSeek    | `api.deepseek.com` | —                           | LLM provider              |

---

## 2. codex-tee Responsibilities

| Feature               | Detail                                              |
|-----------------------|-----------------------------------------------------|
| Request forwarding    | POST `/v1/chat/completions` → DeepSeek, headers preserved |
| Streaming (SSE)       | Transparent chunk-by-chunk pass-through             |
| Model name rewriting  | GPT model names → DeepSeek equivalents for sub-agent spawns |
| LangSmith tracing     | Full prompt/completion + all cache metrics per turn |
| Health check          | `GET /_health` → `{"status":"ok"}`                  |
| Config hot-reload     | Watches `config.js`, reloads on change              |

---

## 3. Model Rewrite Rules

Codex sends `gpt-*` model names for sub-agent spawns. Codex++ doesn't translate these. codex-tee rewrites them:

| Input              | Output              |
|--------------------|---------------------|
| `gpt-5.4`          | `deepseek-v4-pro`   |
| `gpt-5.4-mini`     | `deepseek-v4-flash` |
| `gpt-5.5`          | `deepseek-v4-pro`   |
| `gpt-5.3-codex`    | `deepseek-v4-pro`   |
| `gpt-5.2`          | `deepseek-v4-pro`   |
| * (any other)      | `deepseek-v4-pro` (default) |

---

## 4. LangSmith Integration

| Setting     | Value                              |
|-------------|------------------------------------|
| Project     | `codex-tee`                        |
| Trace ID    | `turn-{n}-{timestamp}` per request |
| Auth        | `LANGSMITH_API_KEY` env var or in `sinks/langsmith.js` |

### Metrics Captured

| Field                 | Source                  |
|-----------------------|-------------------------|
| `prompt_tokens`       | `usage`                 |
| `completion_tokens`   | `usage`                 |
| `cached_tokens`       | `prompt_tokens_details` |
| `cache_hit_tokens`    | `usage` (DeepSeek)      |
| `cache_miss_tokens`   | `usage` (DeepSeek)      |
| `cache_hit_rate_pct`  | computed                |
| `model`               | request body (rewritten)|
| `latency_ms`          | measured                |

---

## 5. Sinks Architecture

```
server.js
    │
    ├── sinks/langsmith.js    → LangSmith trace (production)
    ├── sinks/demo.js          → Console pretty-print (debug)
    └── sinks/registry.js     → Sink loader
```

Sinks are pluggable modules. Each receives `{request, response, metrics, latency_ms}` per turn. Add new sinks to `config.js` `sinks` array.

---

## 6. Project Files

```
tee-proxy/
├── config.js          # Listen port, upstream, model rewrite rules, sinks
├── server.js          # HTTP proxy + SSE streaming
├── package.json       # npm metadata (dep: langsmith)
├── sinks/
│   ├── langsmith.js   # LangSmith trace sink
│   ├── demo.js        # Console debug sink
│   └── registry.js    # Sink loader
├── start-tee.bat      # Windows launcher
├── launcher.vbs       # Silent VBScript launcher (no console window)
├── SPEC.md            # This document
└── README.md          # Usage instructions
```

---

## 7. Deployment

### Start
```cmd
start-tee.bat
```
or silently:
```cmd
wscript launcher.vbs
```

### Stop
```powershell
Stop-Process -Name node -Force  # (only if codex-tee is the sole node process)
```

### Auto-start (planned)
Windows Scheduled Task: trigger on system startup + resume from sleep.

