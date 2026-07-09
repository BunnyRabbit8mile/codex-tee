// codex-tee — proxy between Codex++ and DeepSeek
//   Rewrites gpt-* model names for sub-agent spawns
module.exports = {
  listen: { host: "127.0.0.1", port: 57322 },

  // DeepSeek API
  upstream: { base_url: "https://api.deepseek.com" },

  // Rewrite gpt-* model names that Codex++ doesn't translate for sub-agents
  model_rewrite: {
    "gpt-5.4": "deepseek-v4-pro",
    "gpt-5.4-mini": "deepseek-v4-flash",
    "gpt-5.5": "deepseek-v4-pro",
    "gpt-5.3-codex": "deepseek-v4-pro",
    "gpt-5.2": "deepseek-v4-pro",
  },
  default_model: "deepseek-v4-pro",

  sinks: [require("./sinks/langsmith")],
  max_mirror_bytes: 1 * 1024 * 1024,
};
