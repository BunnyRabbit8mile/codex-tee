// Demo sink — logs every trace to console. Use as a template for your own sinks.
//
// A sink must export: { ingest(trace): void | Promise<void> }
//
// trace shape:
//   { method, path, reqHeaders, reqBody, resStatus, resHeaders, resBody, durationMs, startTime }

async function ingest(trace) {
  const short = trace.resBody ? trace.resBody.slice(0, 120) : "";
  console.log(
    `[tee/demo] ${trace.method} ${trace.path} → ${trace.resStatus} (${trace.durationMs}ms) | body preview: ${short}...`
  );
}

module.exports = { ingest };
