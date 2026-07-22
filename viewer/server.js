// viewer/server.js — Hono-based trace viewer + dashboard API
// Reads traces from SQLite (node:sqlite). Serves Vite-built Vue dashboard.
// Usage: node --use-system-ca viewer/server.js

const { Hono } = require("hono");
const { serve } = require("@hono/node-server");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DB_PATH = path.join(__dirname, "..", "outputs", "traces.db");
const DIST_DIR = path.join(__dirname, "dist");

const MAX_DISPLAY_MESSAGES = 50;

// Keep all system messages + latest N non-system messages, preserving order.
// Full data stays in DB; this only affects what the API returns for display.
function truncateMessages(input) {
  if (!input || !Array.isArray(input.messages) || input.messages.length <= MAX_DISPLAY_MESSAGES) return input;
  const keepIndices = new Set();
  const nonSystemIndices = [];
  input.messages.forEach((m, i) => {
    if (m.role === "system") keepIndices.add(i);
    else nonSystemIndices.push(i);
  });
  const startIdx = Math.max(0, nonSystemIndices.length - MAX_DISPLAY_MESSAGES);
  for (let i = startIdx; i < nonSystemIndices.length; i++) keepIndices.add(nonSystemIndices[i]);
  const messages = input.messages.filter((_, i) => keepIndices.has(i));
  return {
    ...input,
    messages,
    _truncated: {
      original_count: input.messages.length,
      displayed_count: messages.length,
      hidden_count: input.messages.length - messages.length,
    },
  };
}
const PORT = 57325;

const db = fs.existsSync(DB_PATH) ? new DatabaseSync(DB_PATH, { readOnly: true }) : null;

// Exclude noisy GET /v1/models polling requests from all queries
const NOT_MODELS_POLL = "(method != 'GET' OR path != '/v1/models')";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function fileResponse(c, filepath, fallbackMime) {
  try {
    const content = await fs.promises.readFile(filepath);
    const mime = MIME[path.extname(filepath).toLowerCase()] || fallbackMime || "application/octet-stream";
    return c.body(content, 200, { "content-type": mime });
  } catch {
    return c.text("Not found", 404);
  }
}

function rowToSummary(r) {
  return {
    id: r.id, timestamp: r.ts, method: r.method, path: r.path,
    model: r.model, resStatus: r.res_status, durationMs: r.duration_ms,
    cache: {
      prompt_tokens: r.prompt_tokens,
      completion_tokens: r.completion_tokens,
      total_tokens: r.total_tokens,
      cached_tokens: r.cached_tokens,
      cache_miss_tokens: r.cache_miss_tokens,
      reasoning_tokens: r.reasoning_tokens,
    },
  };
}

const app = new Hono();

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

app.onError((err, c) => {
  console.error("[viewer] error:", err.message);
  return c.json({ error: err.message }, 500);
});

app.get("/api/stats", (c) => {
  if (!db) return c.json({ total: 0, success: 0, errors: 0, avgLatency: 0, totalTokens: 0, cacheHitRate: 0 });
  const r = db.prepare(
    "SELECT COUNT(*) as total, SUM(CASE WHEN res_status < 400 THEN 1 ELSE 0 END) as success, " +
    "AVG(duration_ms) as avgLatency, SUM(total_tokens) as totalTokens, " +
    "SUM(prompt_tokens) as promptTokens, SUM(cached_tokens) as cachedTokens " +
    "FROM traces WHERE " + NOT_MODELS_POLL
  ).get();
  const total = r.total || 0;
  const success = r.success || 0;
  const hitRate = r.promptTokens > 0 ? (r.cachedTokens / r.promptTokens * 100) : 0;
  return c.json({ total, success, errors: total - success, avgLatency: Math.round(r.avgLatency || 0), totalTokens: r.totalTokens || 0, cacheHitRate: +hitRate.toFixed(1) });
});

app.get("/api/charts/timeline", (c) => {
  if (!db) return c.json([]);
  const hours = parseInt(c.req.query("hours") || "24");
  const since = Date.now() - hours * 3600 * 1000;
  const rows = db.prepare(
    "SELECT (ts_epoch / 60000) * 60000 as bucket, COUNT(*) c, " +
    "SUM(prompt_tokens) pt, SUM(completion_tokens) ct, SUM(cached_tokens) kt " +
    "FROM traces WHERE ts_epoch > ? AND " + NOT_MODELS_POLL + " " +
    "GROUP BY bucket ORDER BY bucket"
  ).all(since);
  return c.json(rows.map(r => ({
    ts: r.bucket, count: r.c,
    promptTokens: r.pt || 0, completionTokens: r.ct || 0, cachedTokens: r.kt || 0,
  })));
});

app.get("/api/charts/models", (c) => {
  if (!db) return c.json([]);
  const rows = db.prepare("SELECT model, COUNT(*) c FROM traces WHERE " + NOT_MODELS_POLL + " GROUP BY model ORDER BY c DESC").all();
  return c.json(rows.map(r => ({ name: r.model, value: r.c })));
});

app.get("/api/charts/status", (c) => {
  if (!db) return c.json([]);
  const rows = db.prepare("SELECT res_status, COUNT(*) c FROM traces WHERE " + NOT_MODELS_POLL + " GROUP BY res_status ORDER BY res_status").all();
  return c.json(rows.map(r => ({ name: String(r.res_status), value: r.c })));
});

app.get("/api/traces", (c) => {
  if (!db) return c.json({ traces: [], total: 0 });
  const limit = Math.min(parseInt(c.req.query("limit") || "200"), 500);
  const offset = parseInt(c.req.query("offset") || "0");
  const rows = db.prepare(
    "SELECT * FROM traces WHERE " + NOT_MODELS_POLL + " ORDER BY ts_epoch DESC LIMIT ? OFFSET ?"
  ).all(limit, offset);
  const total = db.prepare("SELECT COUNT(*) as c FROM traces WHERE " + NOT_MODELS_POLL).get().c;
  return c.json({ traces: rows.map(rowToSummary), total });
});

app.get("/api/trace/:id", (c) => {
  if (!db) return c.json({ error: "db not available" }, 500);
  const id = c.req.param("id");
  const r = db.prepare("SELECT * FROM traces WHERE id = ?").get(id);
  if (!r) return c.json({ error: "not found" }, 404);
  return c.json({
    ...rowToSummary(r),
    input: truncateMessages(safeJsonParse(r.input_json, {})),
    output: safeJsonParse(r.output_json, {}),
  });
});

app.get("/*", async (c) => {
  const p = c.req.path === "/" ? "/index.html" : c.req.path;
  const fp = path.join(DIST_DIR, p);
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) return fileResponse(c, fp);
  return fileResponse(c, path.join(DIST_DIR, "index.html"));
});

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  console.log("[trace-viewer] http://127.0.0.1:" + info.port);
  console.log("[trace-viewer] DB: " + (db ? DB_PATH : "(none)"));
  console.log("[trace-viewer] dist: " + (fs.existsSync(DIST_DIR) ? DIST_DIR : "(not built — run: npm run viewer:build)"));
});