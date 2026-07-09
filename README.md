# codex-tee

OpenAI-compatible tee proxy. Sits between Codex CLI and Codex++, mirrors traffic to pluggable observability sinks.

```
Codex CLI  ──→  tee (57322)  ──→  Codex++ (57321)  ──→  LLM
                  │
                  ├──→ LangSmith        (fire-and-forget)
                  ├──→ custom-sink-A
                  └──→ custom-sink-B
```

## Quick Start

```bash
# 1. Set LangSmith credentials (optional)
set LANGSMITH_API_KEY=lsv2_your_key_here
set LANGSMITH_PROJECT=codex-tee

# 2. Start the tee
node server.js
# → [tee] listening on http://127.0.0.1:57322

# 3. Point Codex CLI at the tee
# In ~/.codex/config.toml:
#   base_url = "http://127.0.0.1:57322/v1"
```

## Adding a new sink

Create `sinks/my-sink.js`:

```js
async function ingest(trace) {
  // trace = { method, path, reqHeaders, reqBody, resStatus, resHeaders, resBody, durationMs }
  await fetch("https://my-observability.com/ingest", {
    method: "POST",
    body: JSON.stringify(trace),
  });
}
module.exports = { ingest };
```

Then register it in `config.js` → `sinks` array:

```js
sinks: [
  require("./sinks/langsmith"),
  require("./sinks/my-sink"),   // ← add here
],
```

## Architecture

- **Zero latency**: the tee is a pass-through `Transform` stream — data flows upstream → client without buffering
- **Fire-and-forget sinks**: mirrors run async, never block the response
- **Built-in Node.js only**: no npm install required
- **Pluggable**: add/remove sinks in `config.js`, one line each
