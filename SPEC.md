# codex-tee — Design Document

> Transparent observability proxy for Codex and upstream LLM APIs, with local SQLite tracing and a Vue dashboard viewer.

---

## 1. Overview

codex-tee is a lightweight Node.js proxy that sits between Codex (via Codex++) and an upstream LLM API. It passively intercepts every API call, rewrites GPT model names to upstream equivalents, and traces all requests — including cache metrics — to a local SQLite database. A bundled Vue 3 + ECharts dashboard provides real-time observability through a web UI.

### Design Goals

| Goal | Rationale |
|---|---|
| Zero latency overhead | Pass-through stream — data flows immediately, never buffered |
| Non-blocking tracing | Fire-and-forget sink — a slow DB write never delays responses |
| Local observability | SQLite via node:sqlite (Node 26 built-in), zero external dependencies |
| Full cache visibility | Extract cached/cache-miss/reasoning token metrics for cost analysis |
| Model name translation | Codex sends gpt-* for sub-agents; tee rewrites to upstream equivalents |
| Built-in dashboard | Vue + ECharts viewer reads directly from SQLite, no separate frontend deployment |

---

## 2. Architecture

```
+-------+   :57321   +------------+   :57322    +-----------+   Qianfan API   +----------+
| Codex | --------> |  Codex++   | --------> | codex-tee | ---------------> | Qianfan  |
| (app) |           | (Electron) |           | (Node.js) |                  |   API    |
+-------+           +------------+           +-----------+                  +----------+
                                                  |
                                                  | trace (fire-and-forget)
                                                  v
                                            +-----------+
                                            | SQLite DB |
                                            | traces.db |
                                            +-----------+
                                                  ▲
                                                  │ SQL (read-only)
                                            +-----------+
                                            |  Viewer   |  :57325
                                            | (Hono+Vue)|
                                            +-----------+
```

### Port Assignments

| Hop | Component | Listen | Upstream | Role |
|---|---|---|---|---|
| 1 | Codex | — | 127.0.0.1:57321/v1 | Desktop client |
| 2 | Codex++ | 127.0.0.1:57321 | 127.0.0.1:57322/v1 | Widget injection + pass-through |
| 3 | codex-tee | 127.0.0.1:57322 | https://qianfan.baidubce.com/v2/tokenplan/personal | Trace + model rewrite + forward |
| 4 | Qianfan API | qianfan.baidubce.com | — | LLM provider |
| 5 | viewer | 127.0.0.1:57325 | — (reads SQLite) | Dashboard API + static files |

---

## 3. Component Design

### 3.1 server.js — HTTP Proxy

Entry point. Creates an HTTP server on `config.listen`, forwards requests to `config.upstream`, and pipes responses through a TeeStream.

**Key behaviors:**
- `GET /_health` returns `{"status":"ok"}` for health checks
- All other requests are forwarded to upstream with model rewrite applied
- Response body is tee'd through a Transform stream that captures bytes and flushes to sinks on end
- On upstream error, responds 502 and dispatches an error trace to sinks

**Design decisions:**
- **Why Transform stream?** A Transform stream passes chunks through immediately while simultaneously collecting them. This means zero buffering latency — the client sees streaming responses in real time.
- **Why not pipe + buffer?** Buffer-then-forward adds latency proportional to response size. For long SSE streams this is unacceptable.

### 3.2 TeeStream — Passthrough with Capture

Extends Transform. On each chunk, pushes it downstream immediately and appends it to an internal buffer (up to `max_mirror_bytes`). On flush, concatenates buffer and dispatches to sinks with timing metadata.

```
clientRes <── TeeStream <── upstreamRes
                |
                +── capture chunks (up to max_mirror_bytes)
                |
                +── on end: dispatch({ method, path, reqBody, resBody, durationMs, ... })
```

### 3.3 sinks/ — Observability Sinks

Each sink exports `{ ingest(trace): void }`. Sinks are loaded from `config.sinks` array and dispatched in parallel via `registry.js`.

```
server.js → TeeStream._flush() → registry.dispatch() ──→ sqlite.js
```

**Fire-and-forget pattern:** The registry calls `Promise.resolve(sink.ingest(trace)).catch(...)` — sinks never block the response stream. The SQLite sink itself is synchronous (`node:sqlite` is a sync API), but errors are caught and logged, never thrown to the caller.

### 3.4 sinks/sqlite.js — SQLite Trace Sink

Stores every trace in a local SQLite database using Node 26's built-in `node:sqlite` module (zero native dependencies).

| Feature | Detail |
|---|---|
| Database | `outputs/traces.db` |
| Mode | WAL journal, synchronous=NORMAL |
| Lazy init | DB connection created on first ingest, reused thereafter |
| Graceful shutdown | `process.on("exit")` closes the DB connection |

**Schema:**

```sql
CREATE TABLE traces (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  ts_epoch INTEGER NOT NULL,
  method TEXT,
  path TEXT,
  model TEXT,
  res_status INTEGER,
  duration_ms INTEGER,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,
  cache_miss_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,
  input_json TEXT,
  output_json TEXT
);
```

Indexes on `ts_epoch DESC`, `res_status`, `model` for fast dashboard queries.

**Trace ingestion:** Parses request/response bodies via `trace-parser.js`, extracts cache metrics and model name, then inserts a row with `INSERT OR REPLACE`. Errors are caught and logged — never propagated.

### 3.5 sinks/trace-parser.js — Shared Parsing Logic

Extracted from the former Langfuse sink to avoid duplication. Provides:

| Function | Purpose |
|---|---|
| `parseBody(body, headers)` | Parses JSON body, or SSE stream → reconstructed output object |
| `parseSSE(body)` | Splits SSE stream into parsed JSON chunks |
| `buildSSEOutput(chunks)` | Reconstructs full text, model, finish_reason, and usage from SSE chunks |
| `extractCache(outputs)` | Normalizes cache/token metrics from various response formats |
| `extractModel(reqBody, resHeaders, resBody, reqObj?)` | Extracts model name from request body or SSE metadata; accepts pre-parsed body to avoid redundant JSON.parse |

Named constants: `MAX_CONTENT_CHARS = 100_000`, `MAX_RAW_CHARS = 1_000` for output truncation.

### 3.6 sinks/registry.js — Sink Dispatcher

Loads all sinks from config and dispatches traces to each in parallel. Never awaits — all sinks are fire-and-forget.

### 3.7 config.js — Central Configuration

```js
{
  listen:   { host: "127.0.0.1", port: 57322 },
  upstream: { base_url: "https://qianfan.baidubce.com/v2/tokenplan/personal" },
  model_rewrite: {
    "gpt-5.4": "qianfan-code-latest",
    "gpt-5.4-mini": "qianfan-code-latest",
    "gpt-5.5": "qianfan-code-latest",
    "gpt-5.3-codex": "qianfan-code-latest",
    "gpt-5.2": "qianfan-code-latest",
  },
  default_model: "qianfan-code-latest",
  sinks: [require("./sinks/sqlite")],
  max_mirror_bytes: 1 * 1024 * 1024,
}
```

### 3.8 Model Rewrite Rules

Codex sends gpt-* model names for sub-agent spawns. Codex++ doesn't translate these. codex-tee rewrites them before forwarding:

| Input | Output |
|---|---|
| gpt-5.4 | qianfan-code-latest |
| gpt-5.4-mini | qianfan-code-latest |
| gpt-5.5 | qianfan-code-latest |
| gpt-5.3-codex | qianfan-code-latest |
| gpt-5.2 | qianfan-code-latest |
| gpt-* (other) | qianfan-code-latest (default) |

Matching priority: exact match → longest prefix match → gpt-* fallback.

---

## 4. Viewer

### 4.1 viewer/server.js — Hono API + Static Server

Serves the Vue dashboard and provides a read-only API over the SQLite database.

| Endpoint | Description |
|---|---|
| `GET /api/stats` | Aggregate: total, success, errors, avg latency, total tokens, cache hit rate |
| `GET /api/charts/timeline?hours=24` | Time-bucketed (per-minute) request and token counts |
| `GET /api/charts/models` | Request count grouped by model |
| `GET /api/charts/status` | Request count grouped by HTTP status |
| `GET /api/traces?limit=200&offset=0` | Paginated trace summaries; excludes `GET /v1/models` polling |
| `GET /api/trace/:id` | Full trace detail with input/output JSON |
| `GET /*` | Static file serving from `viewer/dist/` (SPA fallback to index.html) |

**Message truncation:** The `/api/trace/:id` endpoint applies `truncateMessages()` to the input — keeps all `system` role messages plus the latest 50 non-system messages, preserving original order. Full untruncated data remains in the database. The response includes `_truncated` metadata: `{ original_count, displayed_count, hidden_count }`.

**Performance:** Static file serving uses async `fs.promises.readFile`. The stats endpoint uses a single aggregate SQL query instead of multiple round-trips.

### 4.2 viewer/src/App.vue — Vue 3 Dashboard

Single-file component with ECharts visualizations.

**Layout:**
- Top bar: title, trace count, search filter, refresh button
- Stats row: 6 cards (total, success, errors, avg latency, total tokens, cache hit %)
- Charts row: timeline (requests + tokens), status pie, model pie
- Main row: trace list (left, 340px) + detail panel (right)

**Detail panel:**
- Input section: renders each message with role label, markdown content (via `marked`), reasoning blocks (purple italic), and tool call details
- Output section: rendered markdown + raw JSON
- Both sections collapsible, with independent vertical scroll

**Message rendering:** `renderMsg()` normalizes CR/LF, strips XML wrapper tags (`*_instructions>`, `<app-context>`, `<collaboration_mode>`, etc.), escapes remaining HTML tags, then parses as GFM markdown via `marked`.

**Auto-refresh:** Polls all API endpoints every 10 seconds. Interval cleared on component unmount.

### 4.3 viewer/vite.config.js — Build Configuration

Vite builds the Vue SFC to `viewer/dist/`. API proxy configured for dev mode (`/api` → `localhost:57325`).

---

## 5. Data Flow

### 5.1 Chat Completion (Streaming)

```
1. Codex → POST /v1/chat/completions (model: "gpt-5.5")
2. codex-tee rewrites model to "qianfan-code-latest"
3. codex-tee → POST https://qianfan.baidubce.com/.../v1/chat/completions
4. Qianfan → SSE stream (data: {...})
5. TeeStream passes each chunk to Codex immediately
6. TeeStream captures chunks in buffer
7. Stream ends → TeeStream._flush()
8. registry.dispatch() → sqlite.ingest(trace)
9. SQLite sink parses bodies, extracts cache metrics, inserts row
```

### 5.2 Dashboard Query

```
1. Browser → GET /api/traces?limit=200
2. viewer/server.js → SELECT * FROM traces ... LIMIT ? OFFSET ?
3. Returns { traces: [...], total: N }
4. Browser → GET /api/trace/:id
5. viewer/server.js → SELECT * FROM traces WHERE id = ?
6. truncateMessages(input) → returns display-safe input with _truncated metadata
7. Browser renders markdown content, tool calls, reasoning blocks
```

### 5.3 Error Handling

| Scenario | Behavior |
|---|---|
| Upstream timeout (120s) | Respond 502 to client |
| Upstream connection error | Respond 502, trace error to SQLite |
| Sink throws exception | Caught by registry, logged — no impact on client |
| SQLite ingest failure | Caught in ingest(), logged — no retry, no impact |
| Viewer DB not found | API returns empty/zero results, static files still served |

---

## 6. Cache Metrics

The upstream API returns usage data in various formats. `extractCache()` normalizes these:

| Metric | Source |
|---|---|
| prompt_tokens | usage.prompt_tokens |
| completion_tokens | usage.completion_tokens |
| total_tokens | usage.total_tokens |
| cached_tokens | usage.prompt_tokens_details.cached_tokens OR usage.prompt_cache_hit_tokens |
| cache_miss_tokens | usage.prompt_cache_miss_tokens |
| reasoning_tokens | usage.completion_tokens_details.reasoning_tokens |

All metrics are stored as columns in the `traces` table and surfaced in the dashboard stats cards and timeline chart.

---

## 7. Project Structure

```
codex-tee/
├── config.js              # Central configuration
├── server.js              # HTTP proxy + TeeStream + model rewrite
├── package.json           # type: commonjs
├── sinks/
│   ├── sqlite.js          # SQLite trace sink (node:sqlite, WAL)
│   ├── trace-parser.js    # Shared SSE/JSON parsing, cache extraction
│   └── registry.js        # Fire-and-forget sink dispatcher
├── viewer/
│   ├── server.js          # Hono API + static file server (:57325)
│   ├── vite.config.js     # Vite build config
│   ├── index.html
│   └── src/
│       ├── App.vue        # Vue 3 SFC dashboard
│       └── main.js        # Vue app entry
├── outputs/               # (gitignored)
│   └── traces.db          # SQLite database
├── start-tee.bat          # Windows launcher
├── launcher.vbs           # Silent VBScript launcher
├── watchdog.ps1           # Process watchdog
├── README.md
└── SPEC.md                # This design document
```

---

## 8. NPM Scripts

| Script | Command | Description |
|---|---|---|
| `start` | `node server.js` | Start the tee proxy |
| `viewer` | `node --use-system-ca viewer/server.js` | Start the viewer (:57325) |
| `viewer:dev` | `vite --config viewer/vite.config.js` | Vite dev server (:57326) with API proxy |
| `viewer:build` | `vite build --config viewer/vite.config.js` | Build Vue dashboard to `viewer/dist/` |

---

## 9. Requirements

- **Node.js 26+** — uses built-in `node:sqlite` module
- **npm dependencies:** hono, @hono/node-server, vue, vue-echarts, echarts, marked, vite, @vitejs/plugin-vue
- **No external services** — SQLite is a local file, viewer is a local HTTP server
