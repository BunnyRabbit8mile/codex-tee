// LangSmith sink — parses SSE, extracts cache metrics, sends clean traces.
// Requires: node --use-system-ca server.js

const https = require("https");

const API_KEY = process.env.LANGSMITH_API_KEY;
const PROJECT = process.env.LANGSMITH_PROJECT || "codex-tee";
const LANGSMITH_HOST = "api.smith.langchain.com";

let enabled = !!API_KEY;
if (!enabled) console.warn("[tee/langsmith] LANGSMITH_API_KEY not set — disabled");

// ── SSE parser ───────────────────────────────────────────

function isSSE(headers, body) {
  const ct = headers["content-type"] || "";
  return ct.includes("text/event-stream") ||
    (typeof body === "string" && (body.startsWith("data:") || body.startsWith("event:")));
}

function parseSSE(body) {
  const chunks = [];
  for (const line of body.replace(/\r$/, "").split("\n")) {
    if (!line || line.startsWith(":")) continue;
    let payload = null;
    if (line.startsWith("data: ")) payload = line.slice(6).trim();
    else if (line.startsWith("data:")) payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try { chunks.push(JSON.parse(payload)); } catch {}
  }
  return chunks;
}

function deepMerge(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      target[k] = deepMerge(target[k] || {}, v);
    } else { target[k] = v; }
  }
  return target;
}

function buildSSEOutput(chunks) {
  let text = "", model = "", finish = "";
  const usage = {};
  for (const c of chunks) {
    if (c.choices) {
      const ch = c.choices[0];
      if (ch?.delta?.content) text += ch.delta.content;
      if (ch?.finish_reason) finish = ch.finish_reason;
    }
    if (c.type === "response.output_text.delta" && c.delta) text += c.delta;
    if (c.type === "response.completed" && c.response) {
      for (const out of (c.response.output || [])) {
        if (out.content) for (const ct of out.content) {
          if (ct.type === "output_text") text = ct.text;
        }
      }
    }
    if (c.model) model = c.model;
    if (c.usage) deepMerge(usage, c.usage);
  }
  return { model: model || "unknown", content: text.substring(0, 2000), finish_reason: finish || undefined, tokens: Object.keys(usage).length ? usage : undefined };
}

// ── cache metrics ────────────────────────────────────────

function extractCache(outputs) {
  const t = outputs?.tokens || outputs?.usage || {};
  const d = t.prompt_tokens_details || {};
  return {
    prompt_tokens: t.prompt_tokens || 0,
    completion_tokens: t.completion_tokens || 0,
    total_tokens: t.total_tokens || 0,
    cached_tokens: d.cached_tokens || t.prompt_cache_hit_tokens || 0,
    cache_miss_tokens: t.prompt_cache_miss_tokens || 0,
    reasoning_tokens: (t.completion_tokens_details || {}).reasoning_tokens || 0,
  };
}

// ── body parsing ─────────────────────────────────────────

function parseBody(body, headers) {
  if (!body) return {};
  try { return JSON.parse(body); } catch {}
  if (isSSE(headers, body)) {
    const chunks = parseSSE(body);
    return chunks.length ? buildSSEOutput(chunks) : { raw_sse: body.substring(0, 500) };
  }
  return { raw: body.substring(0, 500) };
}

// ── helpers ──────────────────────────────────────────────

function runName(path) {
  if (path.includes("responses")) return "responses";
  if (path.includes("chat/completions")) return "chat.completions";
  return path.replace(/^\/+v1\/+/, "").replace(/\/+$/, "") || "api_call";
}

function extractModel(reqBody, resHeaders, resBody) {
  try { const r = JSON.parse(reqBody || "{}"); if (r.model) return r.model; } catch {}
  if (isSSE(resHeaders, resBody)) for (const c of parseSSE(resBody)) if (c.model) return c.model;
  return "unknown";
}

function postRun(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: LANGSMITH_HOST, path: "/api/v1/runs", method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY, "Content-Length": Buffer.byteLength(data) },
      timeout: 10000,
    }, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => res.statusCode >= 200 && res.statusCode < 300 ? resolve(body) : reject(new Error("LangSmith " + res.statusCode + ": " + body)));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

// ── ingest ───────────────────────────────────────────────

async function ingest(trace) {
  if (!enabled) return;
  const { method, path, reqHeaders, reqBody, resStatus, resHeaders, resBody, durationMs } = trace;
  const now = new Date().toISOString();
  const startTime = new Date(Date.now() - durationMs).toISOString();

  const inputs = parseBody(reqBody, {});
  const outputs = resStatus >= 400
    ? { error: parseBody(resBody, resHeaders) }
    : parseBody(resBody, resHeaders);
  const cache = resStatus < 400 ? extractCache(outputs) : {};

  const payload = {
    name: runName(path),
    run_type: "llm",
    inputs,
    outputs,
    error: resStatus >= 400 ? "HTTP " + resStatus : undefined,
    start_time: startTime,
    end_time: now,
    session_name: PROJECT,
    extra: {
      metadata: {
        method, path,
        duration_ms: durationMs,
        model: extractModel(reqBody, resHeaders, resBody),
        status: resStatus,
        // Cache — filterable in LangSmith UI
        cache_prompt_tokens: cache.prompt_tokens || 0,
        cache_cached_tokens: cache.cached_tokens || 0,
        cache_miss_tokens: cache.cache_miss_tokens || 0,
        cache_hit_ratio: cache.prompt_tokens > 0
          ? (cache.cached_tokens / cache.prompt_tokens).toFixed(4)
          : "0",
        completion_tokens: cache.completion_tokens || 0,
        reasoning_tokens: cache.reasoning_tokens || 0,
      },
    },
  };

  try { await postRun(payload); }
  catch (err) { console.error("[tee/langsmith] ingest failed:", err.message); }
}

module.exports = { ingest };

