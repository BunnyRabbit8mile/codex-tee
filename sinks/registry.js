// sinks/registry.js — dispatches traces to all configured sinks (fire-and-forget).
const config = require("../config");

/** Fire-and-forget dispatch to every configured sink.
 *  Uses setImmediate to defer sink execution to the next event-loop tick,
 *  so synchronous sinks (e.g. SQLite) never block the response stream.
 *  Each sink receives a TraceCtx object. Errors are logged, never thrown. */
function dispatch(trace) {
  for (const sink of config.sinks) {
    setImmediate(() => {
      try {
        const ret = sink.ingest(trace);
        if (ret && typeof ret.catch === "function") {
          ret.catch((err) => console.error("[tee] sink error:", err.message));
        }
      } catch (err) {
        console.error("[tee] sink dispatch error:", err.message);
      }
    });
  }
}

module.exports = { dispatch };
