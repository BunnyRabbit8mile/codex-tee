// sinks/sqlite.js — stores every trace in a local SQLite database.
// Uses Node 26 built-in node:sqlite (zero native deps).

const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const crypto = require("crypto");
const { parseBody, extractCache, extractModel } = require("./trace-parser");

const DB_PATH = path.join(__dirname, "..", "outputs", "traces.db");

let _db = null;
let _insertStmt = null;

function getDB() {
  if (_db) return { db: _db, insertStmt: _insertStmt };
  _db = new DatabaseSync(DB_PATH);
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA synchronous = NORMAL");
  _db.exec(`CREATE TABLE IF NOT EXISTS traces (
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
  )`);
  _db.exec("CREATE INDEX IF NOT EXISTS idx_traces_ts ON traces(ts_epoch DESC)");
  _db.exec("CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(res_status)");
  _db.exec("CREATE INDEX IF NOT EXISTS idx_traces_model ON traces(model)");
  _insertStmt = _db.prepare(`INSERT OR REPLACE INTO traces
    (id, ts, ts_epoch, method, path, model, res_status, duration_ms,
     prompt_tokens, completion_tokens, total_tokens, cached_tokens, cache_miss_tokens, reasoning_tokens,
     input_json, output_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  return { db: _db, insertStmt: _insertStmt };
}

function ingest(trace) {
  try {
  const { method, path: reqPath, reqBody, resStatus, resHeaders, resBody, durationMs, startTime } = trace;

  const inputs = parseBody(reqBody, {});
  const outputs = resStatus >= 400
    ? { error: parseBody(resBody, resHeaders) }
    : parseBody(resBody, resHeaders);
  const cache = resStatus < 400 ? extractCache(outputs) : {};
  const model = extractModel(reqBody, resHeaders, resBody, inputs);

  const id = crypto.randomUUID();
  const ts = startTime ? new Date(startTime) : new Date();

  const { insertStmt } = getDB();
  insertStmt.run(
    id,
    ts.toISOString(),
    ts.getTime(),
    method,
    reqPath,
    model,
    resStatus,
    durationMs || 0,
    cache.prompt_tokens || 0,
    cache.completion_tokens || 0,
    cache.total_tokens || 0,
    cache.cached_tokens || 0,
    cache.cache_miss_tokens || 0,
    cache.reasoning_tokens || 0,
    JSON.stringify(inputs),
    JSON.stringify(outputs)
  );
  } catch (err) {
    console.error("[tee/sqlite] ingest failed:", err.message);
  }
}


process.on("exit", () => { if (_db) _db.close(); });
module.exports = { ingest, DB_PATH };