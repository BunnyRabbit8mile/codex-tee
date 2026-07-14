// Langfuse sink — parses SSE, extracts cache metrics, sends traces via Langfuse SDK.

const { Langfuse } = require("langfuse");
const config = require("../config");

const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY || config.langfuse?.publicKey;
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY || config.langfuse?.secretKey;
const HOST = process.env.LANGFUSE_HOST || config.langfuse?.host || "https://cloud.langfuse.com";
const PROJECT = process.env.LANGFUSE_PROJECT || config.langfuse?.project || "codex-tee";

let enabled = !!(PUBLIC_KEY && SECRET_KEY);
if (!enabled) console.warn("[tee/langfuse] LANGFUSE_PUBLIC_KEY+SECRET_KEY not set — disabled");

const langfuse = enabled ? new Langfuse({
  publicKey: PUBLIC_KEY,
  secretKey: SECRET_KEY,
  baseUrl: HOST,
  flushAt: 5,
  flushInterval: 5000,
}) : null;

// ── SSE parser ───────────────────────────────────────────

function isSSE(headers, body) {
  const ct = headers["content-type"] || "";
  return ct.includes("text/event-stream") ||
    (typeof body === "string" && (body.startsWith("data:") || body.startsWith("event:")));
}

function parseSSE(body) {
  const chunks = [];
  for (const line of body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
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
  return { model: model || "unknown", content: text.substring(0, 50000), finish_reason: finish || undefined, tokens: Object.keys(usage).length ? usage : undefined };
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

// ── ingest ───────────────────────────────────────────────

async function ingest(trace) {
  if (!enabled) return;
  const { method, path, reqHeaders, reqBody, resStatus, resHeaders, resBody, durationMs } = trace;

  const inputs = parseBody(reqBody, {});
  const outputs = resStatus >= 400
    ? { error: parseBody(resBody, resHeaders) }
    : parseBody(resBody, resHeaders);
  const cache = resStatus < 400 ? extractCache(outputs) : {};
  const model = extractModel(reqBody, resHeaders, resBody);

  try {
    const langfuseTrace = langfuse.trace({
      name: runName(path),
      sessionId: PROJECT,
    });

    langfuseTrace.generation({
      name: runName(path),
      model,
      input: inputs,
      output: outputs,
      usage: {
        promptTokens: cache.prompt_tokens || 0,
        completionTokens: cache.completion_tokens || 0,
        totalTokens: cache.total_tokens || 0,
      },
      level: resStatus >= 400 ? "ERROR" : "DEFAULT",
      statusMessage: resStatus >= 400 ? "HTTP " + resStatus : undefined,
      metadata: {
        method,
        path,
        duration_ms: durationMs,
        status: resStatus,
        cache_cached_tokens: cache.cached_tokens || 0,
        cache_miss_tokens: cache.cache_miss_tokens || 0,
        cache_hit_ratio: cache.prompt_tokens > 0
          ? +(cache.cached_tokens / cache.prompt_tokens).toFixed(4)
          : 0,
        reasoning_tokens: cache.reasoning_tokens || 0,
      },
    }).end();
  }
  catch (err) { console.error("[tee/langfuse] ingest failed:", err.message); }
}

// Graceful shutdown
process.on("SIGINT", () => { langfuse?.shutdownAsync?.(); process.exit(); });
process.on("SIGTERM", () => { langfuse?.shutdownAsync?.(); process.exit(); });

module.exports = { ingest };




