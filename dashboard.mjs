/**
 * dashboard.mjs — 单页状态面板（零依赖，手写 HTML）
 *
 * 为什么需要：/v1/stats 是给机器看的 JSON，人要看"现在活着吗、哪个模型
 * 能用、刚才失败了几次"。对标 new-api 的日志页，但只有一个文件、无需登录。
 *
 * 设计取舍：
 *  - 服务端渲染，前端只做 10 秒轮询刷新。不引前端框架。
 *  - **不需要鉴权**：只监听本机时无风险；如果改成 0.0.0.0 监听，
 *    面板会显示警告并提示风险。
 */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

const fmtMs = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);
const fmtNum = (n) => Number(n ?? 0).toLocaleString("en-US");

function modelsTable(models, caps) {
  const rows = models.map((id) => {
    const c = caps[id] ?? { reasoning: false, efforts: [] };
    const efforts = c.efforts.length
      ? c.efforts.map((e) => `<span class="pill">${esc(e)}</span>`).join("")
      : '<span class="muted">—</span>';
    return `<tr><td class="mono">${esc(id)}</td><td>${c.reasoning ? "✅" : "—"}</td><td>${efforts}</td></tr>`;
  }).join("");
  return `<table><thead><tr><th>模型</th><th>思考</th><th>支持的强度</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function availabilityTable(avail) {
  const entries = Object.entries(avail?.models ?? {});
  if (entries.length === 0) return '<p class="muted">暂无探测数据。</p>';
  const rows = entries.map(([id, v]) => {
    const state = v.state ?? v.status ?? "?";
    const cls = state === "alive" ? "ok" : state === "dead" ? "bad" : "warn";
    const reason = v.reason ? `<span class="muted">${esc(v.reason)}</span>` : "";
    return `<tr><td class="mono">${esc(id)}</td><td class="${cls}">${esc(state)}</td><td>${reason}</td></tr>`;
  }).join("");
  return `<table><thead><tr><th>模型</th><th>状态</th><th>原因</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function logsTable(logs) {
  if (!logs.length) return '<p class="muted">还没有请求记录。</p>';
  const rows = logs.slice().reverse().map((l) => {
    const bad = typeof l.status === "number" && l.status >= 400;
    const effort = l.effortRequested
      ? `${esc(l.effortRequested)}${l.effortDowngraded ? ` → <b>${esc(l.effortApplied)}</b>` : ""}`
      : '<span class="muted">—</span>';
    return `<tr class="${bad ? "rowbad" : ""}">
      <td class="mono small">${esc((l.t ?? "").replace("T", " ").slice(0, 19))}</td>
      <td class="mono">${esc(l.model ?? "?")}</td>
      <td class="mono small">${esc(l.endpoint ?? "")}</td>
      <td class="${bad ? "bad" : "ok"}">${esc(l.status)}</td>
      <td>${fmtMs(l.durationMs ?? 0)}</td>
      <td>${l.promptTokens ?? "—"} / ${l.completionTokens ?? "—"}</td>
      <td>${effort}</td>
      <td class="small">${l.error ? `<span class="bad">${esc(l.error)}</span>` : (l.stream ? "流式" : "非流式")}</td>
    </tr>`;
  }).join("");
  return `<table><thead><tr>
    <th>时间</th><th>模型</th><th>端点</th><th>状态</th><th>耗时</th>
    <th>入/出 token</th><th>思考强度</th><th>备注</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * 渲染整页。
 * @param {object} d { stats, models, caps, availability, limits, cfg, version, logs }
 */
export function renderDashboard(d) {
  const s = d.stats ?? {};
  const exposeLan = !/^(127\.0\.0\.1|localhost|::1)/.test(d.cfg?.listen ?? "");
  const alive = Object.values(d.availability?.models ?? {})
    .filter((v) => (v.state ?? v.status) === "alive").length;

  const cards = [
    ["运行时长", `${Math.floor((s.uptimeSeconds ?? 0) / 60)} 分钟`],
    ["总请求", fmtNum(s.requests?.total)],
    ["成功 / 失败", `${fmtNum(s.requests?.ok)} / ${fmtNum(s.requests?.failed)}`],
    ["进行中", `${s.active ?? 0}（峰值 ${s.peakActive ?? 0}）`],
    ["延迟 P50 / P95", `${fmtMs(s.latencyMs?.p50 ?? 0)} / ${fmtMs(s.latencyMs?.p95 ?? 0)}`],
    ["token 累计", fmtNum(s.tokens?.total)],
    ["可用模型", `${alive} 个存活`],
    ["暴露模型", `${(d.models ?? []).length} 个`],
  ].map(([k, v]) => `<div class="card"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join("");

  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>OpenGate 状态面板</title>
<style>
  :root { color-scheme: light dark; --fg:#1a1a1a; --bg:#fff; --muted:#777; --line:#e3e3e3; --ok:#0a7d33; --bad:#c62828; --warn:#b26a00; --card:#fafafa; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e8e8; --bg:#16181c; --muted:#9aa0a6; --line:#2c2f36; --ok:#4ade80; --bad:#f87171; --warn:#fbbf24; --card:#1d2026; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--fg);
    font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  h1 { font-size:19px; margin:0 0 4px; }
  h2 { font-size:15px; margin:28px 0 10px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  .sub { color:var(--muted); font-size:12px; margin-bottom:18px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:10px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 12px; }
  .card .k { font-size:11px; color:var(--muted); }
  .card .v { font-size:16px; font-weight:600; margin-top:2px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; font-weight:600; color:var(--muted); font-size:11px;
    text-transform:uppercase; letter-spacing:.4px; padding:6px 8px; border-bottom:1px solid var(--line); }
  td { padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  tr.rowbad td { background:rgba(198,40,40,.06); }
  .mono { font-family:ui-monospace,Consolas,monospace; font-size:12px; }
  .small { font-size:11px; }
  .muted { color:var(--muted); }
  .ok { color:var(--ok); } .bad { color:var(--bad); } .warn { color:var(--warn); }
  .pill { display:inline-block; padding:1px 7px; margin:1px 3px 1px 0; border-radius:10px;
    border:1px solid var(--line); font-size:11px; font-family:ui-monospace,monospace; }
  .banner { padding:10px 14px; border-radius:8px; background:rgba(198,40,40,.1);
    border:1px solid var(--bad); color:var(--bad); margin-bottom:16px; font-size:13px; }
  .wrap { max-width:1180px; margin:0 auto; }
  footer { margin-top:36px; color:var(--muted); font-size:11px; }
</style></head><body><div class="wrap">

<h1>OpenGate 状态面板</h1>
<div class="sub">v${esc(d.version)} · 上游 ${esc(d.cfg?.upstream ?? "")} · 监听 ${esc(d.cfg?.listen)}
  · 每 10 秒自动刷新</div>

${exposeLan ? `<div class="banner">⚠️ 正在监听 ${esc(d.cfg.listen)}（非本机回环）。
  同一网络下的任何人都能用这个 key 白嫖你的额度。若非必要，请把 config.json 的
  listen 改回 127.0.0.1:8787。</div>` : ""}

<div class="cards">${cards}</div>

<h2>模型能力</h2>
${modelsTable(d.models ?? [], d.caps ?? {})}

<h2>可用性探测</h2>
<p class="muted small">轮询试打每个免费模型，判定"现在能不能用"。探测会消耗少量额度，默认每小时一轮。</p>
${availabilityTable(d.availability)}

<h2>最近请求（最新 ${(d.logs ?? []).length} 条）</h2>
${logsTable(d.logs ?? [])}

<h2>并发闸门</h2>
<pre class="mono small">${esc(JSON.stringify(d.limits ?? {}, null, 2))}</pre>

<footer>
  机器可读版本：<a href="/v1/stats">/v1/stats</a> ·
  <a href="/metrics">/metrics</a>（Prometheus）·
  <a href="/v1/logs?limit=100">/v1/logs</a> ·
  <a href="/healthz">/healthz</a>
</footer>

</div></body></html>`;
}
