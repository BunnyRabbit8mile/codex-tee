// Sink registry: loads all sinks from config and dispatches to them in parallel.
const config = require("../config");

/** Fire-and-forget dispatch to every configured sink.
 *  Each sink receives a TraceCtx object. */
async function dispatch(trace) {
  for (const sink of config.sinks) {
    try {
      // Never await — sinks are fire-and-forget
      Promise.resolve(sink.ingest(trace)).catch((err) =>
        console.error("[tee] sink error:", err.message)
      );
    } catch (err) {
      console.error("[tee] sink dispatch error:", err.message);
    }
  }
}

module.exports = { dispatch };
