// sinks/trace-parser.js — shared parsing logic for HTTP trace bodies
const MAX_CONTENT_CHARS = 100_000;
const MAX_RAW_CHARS = 1_000;

// Extracted from local-file.js/langfuse.js to avoid duplication.

function isSSE(headers, body) {
  const ct = (headers && headers["content-type"]) || "";
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
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
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
          if (ct.type === "output_text") text += ct.text;
        }
      }
    }
    if (c.model) model = c.model;
    if (c.usage) deepMerge(usage, c.usage);
  }
  return {
    model: model || "unknown",
    content: text.substring(0, MAX_CONTENT_CHARS),
    finish_reason: finish || undefined,
    tokens: Object.keys(usage).length ? usage : undefined,
  };
}

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

function parseBody(body, headers) {
  if (!body) return {};
  try { return JSON.parse(body); } catch {}
  if (isSSE(headers, body)) {
    const chunks = parseSSE(body);
    return chunks.length ? buildSSEOutput(chunks) : { raw_sse: body.substring(0, MAX_RAW_CHARS) };
  }
  return { raw: body.substring(0, MAX_RAW_CHARS) };
}

function extractModel(reqBody, resHeaders, resBody, reqObj) {
  // Use pre-parsed body if available to avoid double JSON.parse
  if (reqObj && reqObj.model) return reqObj.model;
  if (!reqObj) { try { reqObj = JSON.parse(reqBody || "{}"); } catch { reqObj = {}; } }
  if (reqObj.model) return reqObj.model;
  if (isSSE(resHeaders, resBody)) {
    for (const c of parseSSE(resBody)) if (c.model) return c.model;
  }
  return "unknown";
}

module.exports = { isSSE, parseSSE, deepMerge, buildSSEOutput, extractCache, parseBody, extractModel };