// codex-tee — proxy between Codex++ and Qianfan
//   Rewrites gpt-* model names for sub-agent spawns
module.exports = {
  listen: { host: "192.168.124.6", port: 57322 },

  // Qianfan API
  upstream: { base_url: "https://qianfan.baidubce.com/v2/tokenplan/personal" },

  // Rewrite gpt-* model names that Codex++ doesn't translate for sub-agents
  model_rewrite: {
    "gpt-5.4": "qianfan-code-latest",
    "gpt-5.4-mini": "qianfan-code-latest",
    "gpt-5.5": "qianfan-code-latest",
    "gpt-5.3-codex": "qianfan-code-latest",
    "gpt-5.2": "qianfan-code-latest",
  },
  default_model: "qianfan-code-latest",
  sinks: [require("./sinks/sqlite")],
  max_mirror_bytes: 1 * 1024 * 1024,
};



