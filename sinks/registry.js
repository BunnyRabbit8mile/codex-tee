// sinks/registry.js — dispatches traces to all configured sinks (fire-and-forget).
const config = require("../config");

/** Fire-and-forget dispatch to every configured sink.
 *  Each sink receives a TraceCtx object. Errors are logged, never thrown. */
function dispatch(trace) {
  for (const sink of config.sinks) {
    try {
      Promise.resolve(sink.ingest(trace)).catch((err) =>
        console.error("[tee] sink error:", err.message)
      );
    } catch (err) {
      console.error("[tee] sink dispatch error:", err.message);
    }
  }
}

module.exports = { dispatch };