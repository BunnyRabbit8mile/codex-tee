// codex-tee — transparent tee proxy between Codex++ and Qianfan
//   Codex++ (57321) → tee (57322) → Qianfan API
//   Sees Chat Completions format → full cache metrics
//
// Usage: node --use-system-ca server.js

const http = require("http");
const https = require("https");
const { Transform, pipeline } = require("stream");
const config = require("./config");
const { dispatch } = require("./sinks/registry");

const { host, port } = config.listen;
const upstreamUrl = new URL(config.upstream.base_url);
const upstreamHost = upstreamUrl.hostname;
const upstreamPort = upstreamUrl.port || (upstreamUrl.protocol === "https:" ? 443 : 80);
const upstreamIsHttps = upstreamUrl.protocol === "https:";
const upstreamBasePath = upstreamUrl.pathname.replace(/\/+$/, "");

function upstreamPath(clientUrl) {
  let p = clientUrl;
  if (upstreamBasePath) p = p.replace(/^\/v1/, "");
  return upstreamBasePath + p;
}
const UPSTREAM_TIMEOUT_MS = 120_000;
const MAX_REQ_BODY = 10 * 1024 * 1024; // 10MB

function cloneHeaders(hdrs) {
  const out = {};
  for (const [k, v] of Object.entries(hdrs)) out[k] = v;
  return out;
}

function bufferBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on("data", (c) => {
      if (rejected) return;
      size += c.length;
      if (size > MAX_REQ_BODY) {
        rejected = true;
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

// ── model rewrite ────────────────────────────────────────

function rewriteModel(bodyObj) {
  if (!bodyObj || !bodyObj.model) return bodyObj;
  const rewrite = config.model_rewrite || {};
  // Exact match first
  if (rewrite[bodyObj.model]) {
    bodyObj.model = rewrite[bodyObj.model];
    return bodyObj;
  }
  // Prefix match (sorted longest-first to avoid shorter patterns stealing matches)
  const patterns = Object.keys(rewrite).sort((a, b) => b.length - a.length);
  for (const pattern of patterns) {
    if (bodyObj.model.startsWith(pattern)) { bodyObj.model = rewrite[pattern]; return bodyObj; }
  }
  if (bodyObj.model.startsWith("gpt-") && config.default_model) {
    bodyObj.model = config.default_model;
  }
  return bodyObj;
}

function maybeRewriteBody(rawBody) {
  try {
    const obj = JSON.parse(rawBody.toString("utf-8"));
    return Buffer.from(JSON.stringify(rewriteModel(obj)), "utf-8");
  } catch { return rawBody; }
}

// ── tee stream ───────────────────────────────────────────

class TeeStream extends Transform {
  constructor(traceBase) {
    super();
    this.traceBase = traceBase;
    this.chunks = [];
    this.byteCount = 0;
    this.dispatched = false;
  }
  _transform(chunk, _encoding, callback) {
    if (this.byteCount < config.max_mirror_bytes) {
      this.chunks.push(chunk);
      this.byteCount += chunk.length;
    }
    this.push(chunk);
    callback();
  }
  _flush(callback) {
    this._dispatch();
    callback();
  }
  _destroy(err, callback) {
    if (!this.dispatched) this._dispatch();
    callback(err);
  }
  _dispatch() {
    if (this.dispatched) return;
    this.dispatched = true;
    const resBody = Buffer.concat(this.chunks).toString("utf-8");
    dispatch({ ...this.traceBase, resBody, durationMs: Date.now() - this.traceBase.startTime });
  }
}

// ── proxy ────────────────────────────────────────────────

function forwardUpstream(clientReq, reqBody, traceBase) {
  return new Promise((resolve, reject) => {
    const fwdHeaders = cloneHeaders(clientReq.headers);
    delete fwdHeaders["host"];
    delete fwdHeaders["connection"];
    delete fwdHeaders["transfer-encoding"];

    console.log("[tee] →", upstreamHost, clientReq.method, clientReq.url);
    const transport = upstreamIsHttps ? https : http;
    const upstreamReq = transport.request({
      hostname: upstreamHost,
      port: upstreamPort,
      path: upstreamPath(clientReq.url),
      method: clientReq.method,
      headers: {
        ...fwdHeaders,
        host: upstreamHost,
        "content-length": Buffer.byteLength(reqBody),
      },
      timeout: UPSTREAM_TIMEOUT_MS,
    });

    upstreamReq.on("timeout", () => {
      upstreamReq.destroy(new Error("upstream timeout"));
    });

    upstreamReq.on("response", (upstreamRes) => {
      console.log("status:", upstreamRes.statusCode);
      resolve({
        statusCode: upstreamRes.statusCode,
        headers: upstreamRes.headers,
        stream: upstreamRes,
        trace: {
          ...traceBase,
          resStatus: upstreamRes.statusCode,
          resHeaders: cloneHeaders(upstreamRes.headers),
        },
      });
    });

    upstreamReq.on("error", reject);
    upstreamReq.write(reqBody);
    upstreamReq.end();
  });
}

async function handleRequest(clientReq, clientRes) {
  console.log(clientReq.method, clientReq.url);
  // Health check
  if (clientReq.method === "GET" && clientReq.url === "/_health") {
    clientRes.writeHead(200, { "content-type": "application/json" });
    clientRes.end(JSON.stringify({ status: "ok" }));
    return;
  }

  const startTime = Date.now();
  let rawBody = null;

  try {
    rawBody = await bufferBody(clientReq);
    const rewrittenBody = maybeRewriteBody(rawBody);

    const traceBase = {
      method: clientReq.method,
      path: clientReq.url,
      reqHeaders: cloneHeaders(clientReq.headers),
      reqBody: rawBody.toString("utf-8"),
      startTime,
    };

    const { statusCode, headers, stream, trace } = await forwardUpstream(clientReq, rewrittenBody, traceBase);
    clientRes.writeHead(statusCode, headers);
    pipeline(stream, new TeeStream(trace), clientRes, (err) => {
      if (err && err.code !== "ERR_STREAM_PREMATURE_CLOSE" && err.code !== "ABORTED" && err.message !== "aborted") {
        console.error("[tee] stream pipeline error:", err.message);
      }
    });
  } catch (err) {
    console.error("[tee] upstream error:", err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "content-type": "application/json" });
      clientRes.end(JSON.stringify({ error: "upstream unavailable", detail: err.message }));
    } else { clientRes.end(); }
    dispatch({ method: clientReq.method, path: clientReq.url, reqHeaders: cloneHeaders(clientReq.headers), reqBody: rawBody ? rawBody.toString("utf-8") : "", resStatus: 502, resHeaders: {}, resBody: JSON.stringify({ error: err.message }), startTime, durationMs: Date.now() - startTime });
  }
}

const server = http.createServer(handleRequest);

server.listen(port, host, () => {
  console.log("[tee] " + host + ":" + port + " → " + upstreamUrl.protocol + "//" + upstreamHost);
  console.log("[tee] sinks: " + config.sinks.length + "  |  model rewrite: " + Object.keys(config.model_rewrite || {}).length + " rules");
});


