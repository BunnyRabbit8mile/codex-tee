# codex-tee

Transparent tee proxy between Codex++ and DeepSeek. Traces every API call to Langfuse with full cache metrics.

```
Codex++ (57321) ──→ codex-tee (57322) ──→ DeepSeek API
                         │
                         ├──→ Langfuse        (fire-and-forget)
                         └──→ custom sinks
```

## Quick Start

```bash
# 1. Set Langfuse credentials
set LANGFUSE_PUBLIC_KEY=pk-lf-...
set LANGFUSE_SECRET_KEY=sk-lf-...

# 2. Start the tee
start-tee.bat
# → [tee] 127.0.0.1:57322 → https://api.deepseek.com

# 3. Configure Codex++ upstream to http://127.0.0.1:57322/v1
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

Then register it in `config.js` → `sinks` array.

## Architecture

- **Zero latency**: pass-through `Transform` stream — data flows upstream → client without buffering
- **Fire-and-forget sinks**: traces run async, never block the response
- **Model rewrite**: translates gpt-* model names to DeepSeek equivalents for sub-agent spawns
- **Cache metrics**: extracts prompt_cache_hit_tokens / prompt_cache_miss_tokens from DeepSeek responses
- **Pluggable**: add/remove sinks in `config.js`, one line each


