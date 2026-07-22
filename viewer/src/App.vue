<template>
  <div class="app">
    <header class="topbar">
      <h1>codex-tee Trace Dashboard</h1>
      <span class="stat-count">{{ stats.total }} traces</span>
      <input v-model="search" placeholder="Search model, path..." class="search">
      <button @click="refresh" class="refresh-btn">Refresh</button>
    </header>
    <section class="stats-row">
      <div class="stat-card" v-for="card in statCards" :key="card.label">
        <div class="stat-value" :style="{ color: card.color }">{{ card.value }}</div>
        <div class="stat-label">{{ card.label }}</div>
      </div>
    </section>
    <section class="charts-row">
      <div class="chart-card">
        <h3>Requests and Tokens (24h)</h3>
        <v-chart :option="timelineOption" autoresize style="height:260px" />
      </div>
      <div class="chart-card">
        <h3>Status Distribution</h3>
        <v-chart :option="statusOption" autoresize style="height:260px" />
      </div>
      <div class="chart-card">
        <h3>Model Distribution</h3>
        <v-chart :option="modelOption" autoresize style="height:260px" />
      </div>
    </section>
    <section class="main-row">
      <div class="trace-list">
        <div class="list-header">Traces</div>
        <div class="trace-item" v-for="t in filteredTraces" :key="t.id" :class="{ active: t.id === activeId }" @click="selectTrace(t)">
          <div class="ti-r1">
            <span class="ti-time">{{ fmtTimeShort(t.timestamp) }}</span>
            <span class="ti-method">{{ t.method }}</span>
            <span class="ti-path" :title="t.path">{{ fmtPath(t.path) }}</span>
            <span class="ti-status" :class="t.resStatus >= 400 ? 's4xx' : 's2xx'">{{ t.resStatus }}</span>
          </div>
          <div class="ti-r2">
            <span class="ti-model">{{ t.model }}</span>
            <span class="ti-dur">{{ fmtDur(t.durationMs) }}</span>
            <span v-if="t.cache && t.cache.cached_tokens" class="ti-cache">cache {{ cachePct(t.cache) }}%</span>
          </div>
        </div>
      </div>
      <div class="detail-panel">
        <div v-if="!detail" class="empty">Select a trace</div>
        <div v-if="detail" class="detail-scroll">
          <div class="detail-header">
            <h2>{{ detail.method }} {{ fmtPath(detail.path) }}</h2>
            <div class="meta">
              <span class="tag">{{ fmtTime(detail.timestamp) }}</span>
              <span class="tag">{{ detail.model }}</span>
              <span class="tag" :class="detail.resStatus >= 400 ? 's4xx' : 's2xx'">{{ detail.resStatus }}</span>
              <span class="tag">{{ fmtDur(detail.durationMs) }}</span>
            </div>
          </div>
          <div class="section">
            <div class="section-title" @click="showInput = !showInput"><span>{{ showInput ? 'v' : '>' }}</span> Input</div>
            <div class="section-body" v-show="showInput">
              <template v-if="detail.input && detail.input.messages">
                <div v-if="detail.input._truncated" class="truncation-notice">
                  Showing {{ detail.input._truncated.displayed_count }} of {{ detail.input._truncated.original_count }} messages
                  ({{ detail.input._truncated.hidden_count }} older messages hidden, stored in DB)
                </div>
                <div v-for="(msg, i) in detail.input.messages" :key="i" class="msg-block">
                  <div class="msg-role">{{ msg.role }} #{{ i + 1 }}{{ msg.tool_call_id ? ' (tool result)' : '' }}</div>
                  <div v-if="msg.reasoning_content" class="reasoning-block" v-html="renderMsg(msg.reasoning_content)"></div>
                  <div v-if="msg.content && msg.content !== ''" class="md-output" v-html="renderMsg(msg.content)"></div>
                  <div v-if="msg.tool_calls" class="tool-calls-block">
                    <div v-for="tc in msg.tool_calls" :key="tc.id" class="tool-call-item">
                      <div class="tool-call-header">{{ tc.function.name }}</div>
                      <pre class="tool-call-args">{{ fmtToolArgs(tc.function.arguments) }}</pre>
                    </div>
                  </div>
                </div>
              </template>
              <div v-else class="json-block">{{ JSON.stringify(detail.input, null, 2) }}</div>
            </div>
          </div>
          <div class="section">
            <div class="section-title" @click="showOutput = !showOutput"><span>{{ showOutput ? 'v' : '>' }}</span> Output</div>
            <div class="section-body" v-show="showOutput">
              <div v-if="detail.output && detail.output.content" class="md-output" v-html="renderedOutput"></div>
              <div class="json-block">{{ JSON.stringify(detail.output, null, 2) }}</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from "vue";
import { use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { LineChart, PieChart, BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent, LegendComponent, TitleComponent } from "echarts/components";
import VChart from "vue-echarts";
import { marked } from "marked";

use([CanvasRenderer, LineChart, PieChart, BarChart, GridComponent, TooltipComponent, LegendComponent, TitleComponent]);

const stats = reactive({ total: 0, success: 0, errors: 0, avgLatency: 0, totalTokens: 0, cacheHitRate: 0 });
const traces = ref([]);
const search = ref("");
const activeId = ref(null);
const detail = ref(null);
const showInput = ref(true);
const showOutput = ref(true);

const timelineData = ref([]);
const modelData = ref([]);
const statusData = ref([]);

const filteredTraces = computed(() => {
  const q = search.value.toLowerCase();
  if (!q) return traces.value;
  return traces.value.filter(t => (t.model || "").toLowerCase().includes(q) || (t.path || "").toLowerCase().includes(q));
});

const statCards = computed(() => [
  { label: "Total Traces", value: stats.total, color: "#58a6ff" },
  { label: "Success", value: stats.success, color: "#3fb950" },
  { label: "Errors", value: stats.errors, color: "#f85149" },
  { label: "Avg Latency", value: fmtDur(stats.avgLatency), color: "#d2991d" },
  { label: "Total Tokens", value: fmtNum(stats.totalTokens), color: "#a371f7" },
  { label: "Cache Hit", value: stats.cacheHitRate + "%", color: "#3fb950" },
]);

const timelineOption = computed(() => ({
  tooltip: { trigger: "axis" },
  legend: { data: ["Requests", "Prompt Tokens", "Cached Tokens"], textStyle: { color: "#8b949e" } },
  grid: { left: 50, right: 20, top: 40, bottom: 30 },
  xAxis: { type: "category", data: timelineData.value.map(d => new Date(d.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })), axisLabel: { color: "#8b949e", fontSize: 10 } },
  yAxis: [{ type: "value", name: "Requests", axisLabel: { color: "#8b949e" } }, { type: "value", name: "Tokens", axisLabel: { color: "#8b949e" } }],
  series: [
    { name: "Requests", type: "bar", data: timelineData.value.map(d => d.count), itemStyle: { color: "#58a6ff" } },
    { name: "Prompt Tokens", type: "line", yAxisIndex: 1, data: timelineData.value.map(d => d.promptTokens), smooth: true, itemStyle: { color: "#d2991d" } },
    { name: "Cached Tokens", type: "line", yAxisIndex: 1, data: timelineData.value.map(d => d.cachedTokens), smooth: true, itemStyle: { color: "#3fb950" } },
  ],
}));

const statusOption = computed(() => ({
  tooltip: { trigger: "item" },
  legend: { bottom: 0, textStyle: { color: "#8b949e" } },
  series: [{ type: "pie", radius: ["40%", "70%"], data: statusData.value, label: { color: "#c9d1d9" }, itemStyle: { borderColor: "#0d1117", borderWidth: 2 } }],
}));

const modelOption = computed(() => ({
  tooltip: { trigger: "item" },
  legend: { bottom: 0, textStyle: { color: "#8b949e" } },
  series: [{ type: "pie", radius: "65%", data: modelData.value, label: { color: "#c9d1d9" } }],
}));

const renderedOutput = computed(() => {
  if (!detail.value || !detail.value.output || !detail.value.output.content) return "";
  try { return marked.parse(detail.value.output.content, { breaks: true, gfm: true }); }
  catch { return "<pre>" + esc(detail.value.output.content) + "</pre>"; }
});

function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
function fmtTime(ts) { return ts ? new Date(ts).toLocaleString("zh-CN") : "--"; }
function fmtTimeShort(ts) { return ts ? new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--"; }
function fmtPath(p) { return (p || "").replace(/^\/+v1\/+/, ""); }
function fmtDur(ms) { return ms != null ? (ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms") : "--"; }
function fmtNum(n) { return (n || 0).toLocaleString(); }
function cachePct(c) { return c && c.prompt_tokens ? ((c.cached_tokens || 0) / c.prompt_tokens * 100).toFixed(1) : 0; }

function renderMsg(content) {
  if (!content) return "";
  let text = typeof content === "string" ? content : "";
  if (Array.isArray(content)) {
    text = content.map(p => { if (p.type === "text") return p.text || ""; if (p.type === "image_url") return "[image]"; return "[" + p.type + "]"; }).join("\n");
  }
  if (!text) return JSON.stringify(content, null, 2);
  // Normalize line endings: CR LF and lone CR -> LF
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Remove XML wrapper tags (they break markdown structure)
  text = text.replace(/<\/?[a-zA-Z_][a-zA-Z0-9_-]*_instructions>/g, "");
  text = text.replace(/<\/?(app-context|collaboration_mode|model_switch|permissions)[^>]*>/g, "");
  // Escape any remaining HTML-like tags
  text = text.replace(/<(\/?[a-zA-Z_][a-zA-Z0-9_-]*)>/g, "&lt;$1&gt;");
  try { return marked.parse(text, { breaks: true, gfm: true }); }
  catch { return "<pre style='white-space:pre-wrap'>" + esc(text) + "</pre>"; }
}

function fmtToolArgs(argsStr) {
  try { return JSON.stringify(JSON.parse(argsStr), null, 2); }
  catch { return argsStr || ""; }
}

async function selectTrace(t) {
  activeId.value = t.id;
  try {
    const r = await fetch("/api/trace/" + t.id);
    if (!r.ok) throw new Error();
    detail.value = await r.json();
    showInput.value = true; showOutput.value = true;
  } catch { detail.value = null; }
}

async function refresh() {
  const safe = (p) => p.then(r => r.ok ? r.json() : null).catch(() => null);
  const [s, tl, tr, md, st] = await Promise.all([
    safe(fetch("/api/stats")),
    safe(fetch("/api/charts/timeline?hours=24")),
    safe(fetch("/api/traces?limit=200")),
    safe(fetch("/api/charts/models")),
    safe(fetch("/api/charts/status")),
  ]);
  if (s) Object.assign(stats, s);
  if (tl) timelineData.value = tl;
  if (tr) traces.value = tr.traces !== undefined ? tr.traces : tr;
  if (md) modelData.value = md;
  if (st) statusData.value = st;
}

let refreshTimer = null;
onMounted(() => { refresh(); refreshTimer = setInterval(refresh, 10000); });
onUnmounted(() => { if (refreshTimer) clearInterval(refreshTimer); });
</script>

<style>
:root { --bg: #0d1117; --bg2: #161b22; --bg3: #21262d; --border: #30363d; --text: #c9d1d9; --text2: #8b949e; --green: #3fb950; --red: #f85149; --yellow: #d2991d; --blue: #58a6ff; --purple: #a371f7; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
.app { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
.topbar { height: 44px; display: flex; align-items: center; padding: 0 16px; gap: 16px; background: var(--bg2); border-bottom: 1px solid var(--border); flex-shrink: 0; }
.topbar h1 { font-size: 14px; font-weight: 600; }
.stat-count { font-size: 12px; color: var(--text2); }
.search { margin-left: auto; width: 200px; height: 28px; padding: 0 10px; font-size: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); outline: none; }
.refresh-btn { height: 28px; padding: 0 12px; font-size: 12px; background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; color: var(--text); cursor: pointer; }
.refresh-btn:hover { border-color: var(--blue); }
.stats-row { display: flex; gap: 12px; padding: 12px 16px; flex-shrink: 0; }
.stat-card { flex: 1; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }
.stat-value { font-size: 22px; font-weight: 700; font-family: "Cascadia Code", monospace; }
.stat-label { font-size: 11px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.05em; margin-top: 2px; }
.charts-row { display: flex; gap: 12px; padding: 0 16px 12px; flex-shrink: 0; }
.chart-card { flex: 1; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
.chart-card h3 { font-size: 12px; font-weight: 600; color: var(--text2); margin-bottom: 8px; }
.main-row { flex: 1; display: flex; gap: 12px; padding: 0 16px 16px; min-height: 0; }
.trace-list { width: 340px; flex-shrink: 0; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; overflow-y: auto; }
.list-header { padding: 10px 14px; font-size: 12px; font-weight: 600; color: var(--text2); border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg2); }
.trace-item { padding: 10px 14px; border-bottom: 1px solid var(--border); cursor: pointer; }
.trace-item:hover { background: var(--bg3); }
.trace-item.active { background: var(--bg3); border-left: 3px solid var(--blue); padding-left: 11px; }
.ti-r1 { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.ti-time { font-size: 11px; color: var(--text2); font-family: monospace; }
.ti-method { font-size: 10px; font-weight: 700; color: var(--green); background: rgba(63,185,80,.12); padding: 1px 5px; border-radius: 3px; }
.ti-path { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.ti-status { font-size: 10px; font-weight: 700; padding: 1px 5px; border-radius: 3px; }
.ti-status.s2xx { color: var(--green); background: rgba(63,185,80,.12); }
.ti-status.s4xx { color: var(--red); background: rgba(248,81,73,.12); }
.ti-r2 { display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--text2); }
.ti-model { font-family: monospace; font-size: 10px; color: var(--purple); background: rgba(163,113,247,.1); padding: 1px 6px; border-radius: 3px; }
.ti-cache { color: var(--green); }
.detail-panel { flex: 1; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; min-width: 0; }
.empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text2); }
.detail-scroll { flex: 1; overflow-y: auto; padding: 16px 20px; }
.detail-header { margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
.detail-header h2 { font-size: 14px; font-family: monospace; word-break: break-all; margin-bottom: 8px; }
.meta { display: flex; flex-wrap: wrap; gap: 8px; }
.tag { font-family: monospace; font-size: 11px; padding: 2px 8px; border-radius: 4px; background: var(--bg3); }
.tag.s2xx { color: var(--green); }
.tag.s4xx { color: var(--red); }
.section { margin-bottom: 12px; }
.section-title { padding: 8px 12px; background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; }
.section-body { margin-top: 8px; max-height: 400px; overflow-y: auto; }
.json-block { font-family: "Cascadia Code", monospace; font-size: 12px; line-height: 1.55; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 14px 16px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
.md-output { font-size: 13px; line-height: 1.65; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 16px 20px; }
.md-output h1, .md-output h2, .md-output h3 { margin: 12px 0 6px; font-weight: 600; }
.md-output h1 { font-size: 18px; } .md-output h2 { font-size: 15px; } .md-output h3 { font-size: 13px; }
.md-output p { margin: 6px 0; }
.md-output pre { background: var(--bg3); padding: 10px; border-radius: 6px; overflow-x: auto; }
.md-output code { font-family: "Cascadia Code", monospace; font-size: 12px; }
.msg-block { margin-bottom: 12px; }
.msg-role { font-size: 10px; color: var(--text2); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
.truncation-notice { font-size: 11px; color: var(--yellow); background: rgba(210,153,29,.08); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; }
.show-all { display: inline-block; margin-top: 8px; color: var(--blue); font-size: 12px; text-decoration: none; }

.reasoning-block { font-size: 12px; line-height: 1.6; color: var(--text2); background: rgba(163,113,247,.06); border: 1px solid var(--border); border-left: 3px solid var(--purple); border-radius: 6px; padding: 10px 14px; margin-bottom: 8px; font-style: italic; }
.tool-calls-block { margin-bottom: 8px; }
.tool-call-item { background: var(--bg); border: 1px solid var(--border); border-left: 3px solid var(--green); border-radius: 6px; padding: 8px 12px; margin-bottom: 6px; }
.tool-call-header { font-size: 12px; font-weight: 600; color: var(--green); font-family: monospace; margin-bottom: 4px; }
.tool-call-args { font-family: "Cascadia Code", monospace; font-size: 11px; line-height: 1.5; color: var(--text); background: var(--bg3); padding: 8px 10px; border-radius: 4px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; margin: 0; }
</style>