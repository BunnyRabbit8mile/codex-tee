// codex-tee — thin proxy between Codex++ and DeepSeek
//   Codex++ (57321) → tee (57322) → DeepSeek API
//   Sees Chat Completions format → full cache metrics
//
// Usage: node --use-system-ca server.js

const http = require("http");
const https = require("https");
const { Transform } = require("stream");
const config = require("./config");
const { dispatch } = require("./sinks/registry");

const { host, port } = config.listen;
const upstreamUrl = new URL(config.upstream.base_url);
const upstreamHost = upstreamUrl.hostname;
const upstreamPort = upstreamUrl.port || (upstreamUrl.protocol === "https:" ? 443 : 80);
const upstreamIsHttps = upstreamUrl.protocol === "https:";
const upstreamBasePath = upstreamUrl.pathname.replace(/\/+$/, "");

function cloneHeaders(hdrs) {
  const out = {};
  for (const [k, v] of Object.entries(hdrs)) out[k] = v;
  return out;
}

function bufferBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => { chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ── model rewrite ────────────────────────────────────────

function rewriteModel(bodyObj) {
  if (!bodyObj || !bodyObj.model) return bodyObj;
  const rewrite = config.model_rewrite || {};
  if (rewrite[bodyObj.model]) {
    bodyObj.model = rewrite[bodyObj.model];
  } else {
    for (const [pattern, target] of Object.entries(rewrite)) {
      if (bodyObj.model.startsWith(pattern)) { bodyObj.model = target; break; }
    }
    if (bodyObj.model.startsWith("gpt-") && config.default_model) {
      bodyObj.model = config.default_model;
    }
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
    const resBody = Buffer.concat(this.chunks).toString("utf-8");
    dispatch({ ...this.traceBase, resBody, durationMs: Date.now() - this.traceBase.startTime });
    callback();
  }
}

// ── proxy ────────────────────────────────────────────────

function forwardUpstream(clientReq, reqBody, traceBase) {
  return new Promise((resolve, reject) => {
    const fwdHeaders = cloneHeaders(clientReq.headers);
    delete fwdHeaders["host"];
    delete fwdHeaders["connection"];
    delete fwdHeaders["transfer-encoding"];

    const transport = upstreamIsHttps ? https : http;
    const upstreamReq = transport.request({
      hostname: upstreamHost,
      port: upstreamPort,
      path: upstreamBasePath + clientReq.url,
      method: clientReq.method,
      headers: {
        ...fwdHeaders,
        host: upstreamHost,
        "content-length": Buffer.byteLength(reqBody),
      },
      rejectUnauthorized: false,
    });

    upstreamReq.on("response", (upstreamRes) => {
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
  const startTime = Date.now();
  const rawBody = await bufferBody(clientReq);
  const rewrittenBody = maybeRewriteBody(rawBody);

  const traceBase = {
    method: clientReq.method,
    path: clientReq.url,
    reqHeaders: cloneHeaders(clientReq.headers),
    reqBody: rawBody.toString("utf-8"),   // original for LangSmith
    startTime,
  };

  try {
    const { statusCode, headers, stream, trace } = await forwardUpstream(clientReq, rewrittenBody, traceBase);
    clientRes.writeHead(statusCode, headers);
    stream.pipe(new TeeStream(trace)).pipe(clientRes);
  } catch (err) {
    console.error("[tee] upstream error:", err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "content-type": "application/json" });
      clientRes.end(JSON.stringify({ error: "upstream unavailable", detail: err.message }));
    } else { clientRes.end(); }
    dispatch({ ...traceBase, resStatus: 502, resHeaders: {}, resBody: JSON.stringify({ error: err.message }), durationMs: Date.now() - startTime });
  }
}

const server = http.createServer(handleRequest);

server.listen(port, host, () => {
  console.log("[tee] " + host + ":" + port + " → " + upstreamUrl.protocol + "//" + upstreamHost);
  console.log("[tee] sinks: " + config.sinks.length + "  |  model rewrite: " + Object.keys(config.model_rewrite || {}).length + " rules");
});
