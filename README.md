# codex-tee

Transparent tee proxy between Codex and upstream LLM APIs. Mirrors every API call to a local SQLite database with full cache metrics, and serves a Vue + ECharts dashboard for trace inspection.

```
Codex (57321) ──→ codex-tee (57322) ──→ Qianfan API
                         │
                         └──→ SQLite sink → outputs/traces.db
                                                   ▲
                                                   │ SQL queries (read-only)
                                        viewer (57325) → Hono API + Vite/Vue/ECharts dashboard
```

## Quick Start

### Start the proxy

```bash
start-tee.bat
# → [tee] 192.168.124.6:57322 → https://qianfan.baidubce.com
```

Configure Codex upstream to `http://192.168.124.6:57322/v1`.

### Start the viewer

```bash
npm run viewer:build   # build Vue dashboard (first time or after UI changes)
npm run viewer         # start viewer server
# → [trace-viewer] http://127.0.0.1:57325
```

### Dev mode (hot reload)

```bash
npm run viewer:dev     # Vite dev server on :57326, proxies API to :57325
```

## Architecture

- **Zero latency**: pass-through `Transform` stream — data flows upstream to client without buffering
- **Fire-and-forget sink**: traces are written to SQLite synchronously via `node:sqlite` (Node 26 built-in, zero native deps)
- **Model rewrite**: translates `gpt-*` model names to Qianfan equivalents for sub-agent spawns
- **Cache metrics**: extracts cached/cache-miss/reasoning token counts from response usage data
- **Message truncation**: viewer displays latest 50 non-system messages + all system messages; full data preserved in DB
- **Local dashboard**: Vue 3 SFC + ECharts, served by Hono, reads from SQLite (read-only)

## Adding a new sink

Create `sinks/my-sink.js`:

```js
function ingest(trace) {
  // trace = { method, path, reqHeaders, reqBody, resStatus, resHeaders, resBody, durationMs, startTime }
  // Call getDB() if you need shared DB access, or write to your own backend
}
module.exports = { ingest };
```

Then register it in `config.js` → `sinks` array.

## Viewer API

| Endpoint | Description |
|---|---|
| `GET /api/stats` | Aggregate stats: total, success, errors, avg latency, tokens, cache hit rate |
| `GET /api/charts/timeline?hours=24` | Time-bucketed request/token counts |
| `GET /api/charts/models` | Request count by model |
| `GET /api/charts/status` | Request count by HTTP status |
| `GET /api/traces?limit=200&offset=0` | Paginated trace list (excludes `GET /v1/models` polling) |
| `GET /api/trace/:id` | Full trace detail with input/output JSON (input messages truncated for display) |

## Project Structure

```
codex-tee/
├── config.js              # Central configuration (upstream, model rewrite, sinks)
├── server.js              # HTTP proxy + TeeStream + model rewrite
├── package.json
├── sinks/
│   ├── sqlite.js          # SQLite trace sink (node:sqlite, WAL mode)
│   ├── trace-parser.js    # Shared SSE/JSON parsing, cache extraction, model detection
│   └── registry.js        # Fire-and-forget sink dispatcher
├── viewer/
│   ├── server.js          # Hono API + static file server
│   ├── vite.config.js     # Vite build config
│   ├── index.html
│   └── src/
│       ├── App.vue        # Vue 3 SFC dashboard (stats, charts, trace list+detail)
│       └── main.js        # Vue app entry
├── outputs/
│   └── traces.db          # SQLite database (gitignored)
├── start-tee.bat          # Windows launcher
├── launcher.vbs           # Silent VBScript launcher
├── README.md
└── SPEC.md                # Design document
```

## Requirements

- Node.js 26+ (uses built-in `node:sqlite`)
- npm dependencies: `hono`, `@hono/node-server`, `vue`, `vue-echarts`, `echarts`, `marked`, `dompurify`, `vite`, `@vitejs/plugin-vue`
