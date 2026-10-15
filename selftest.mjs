/**
 * selftest.mjs — 网关自测（8 段）
 *   1 鉴权 · 2 模型列表 · 3 OpenAI 非流式 · 4 OpenAI 流式
 *   5 Anthropic 非流式 · 6 Anthropic 流式 · 7 Responses API · 8 思考强度
 * 用 Node 自己的 fetch 当客户端，绕开 PowerShell 的引号问题。
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(await readFile(join(HERE, "config.json"), "utf8"));
const BASE = `http://${cfg.listen}`;
const KEY = cfg.apiKey;
const MODEL = process.argv[2] || cfg.defaultModel;

const pass = (s) => console.log(`  ✅ ${s}`);
const fail = (s) => { console.log(`  ❌ ${s}`); failures++; };
let failures = 0;

function head(t) { console.log(`\n════ ${t} ════`); }
const authHeaders = () => ({ Authorization: `Bearer ${KEY}` });

// ---------------------------------------------------------------- 1. 鉴权
head("1) 鉴权");
{
  const r = await fetch(`${BASE}/v1/models`);
  r.status === 401 ? pass("无 key → 401") : fail(`无 key 应 401，实际 ${r.status}`);
  const r2 = await fetch(`${BASE}/v1/models`, { headers: { Authorization: "Bearer wrong" } });
  r2.status === 401 ? pass("错 key → 401") : fail(`错 key 应 401，实际 ${r2.status}`);
  const r3 = await fetch(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${KEY}` } });
  r3.status === 200 ? pass("对 key → 200") : fail(`对 key 应 200，实际 ${r3.status}`);
}
{
  const r = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": "wrong", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
  });
  r.status === 401 ? pass("Anthropic 错 key → 401") : fail(`Anthropic 错 key 应 401，实际 ${r.status}`);
}

// ---------------------------------------------------------------- 2. 模型列表
head("2) 模型列表");
{
  const r = await fetch(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${KEY}` } });
  const j = await r.json();
  console.log("  模型数:", j.data.length);
  console.log("  " + j.data.map((m) => m.id).join("\n  "));
  j.data.length > 0 ? pass("返回非空列表") : fail("模型列表为空");
  j.data.some((m) => m.id === MODEL) ? pass(`含目标模型 ${MODEL}`) : fail(`列表不含 ${MODEL}`);
}

// ---------------------------------------------------------------- 3. OpenAI 非流式
head(`3) OpenAI 非流式 (${MODEL})`);
{
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, stream: false,
      messages: [{ role: "user", content: "reply with exactly: PONG" }],
    }),
  });
  console.log("  HTTP", r.status);
  const txt = await r.text();
  if (r.status !== 200) { fail(`HTTP ${r.status}: ${txt.slice(0, 300)}`); }
  else {
    const j = JSON.parse(txt);
    const content = j.choices?.[0]?.message?.content ?? "";
    console.log("  content   :", JSON.stringify(content.slice(0, 200)));
    console.log("  reasoning :", JSON.stringify((j.choices?.[0]?.message?.reasoning_content ?? "").slice(0, 100)));
    console.log("  finish    :", j.choices?.[0]?.finish_reason);
    content.length > 0 ? pass("有正文输出") : fail("正文为空");
  }
}

// ---------------------------------------------------------------- 4. OpenAI 流式
head(`4) OpenAI 流式 (${MODEL})`);
{
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, stream: true,
      messages: [{ role: "user", content: "count 1 to 3" }],
    }),
  });
  console.log("  HTTP", r.status, " content-type:", r.headers.get("content-type"));
  if (r.status !== 200) { fail(`HTTP ${r.status}`); }
  else {
    const text = await r.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data:"));
    let content = "";
    for (const l of lines) {
      const p = l.slice(5).trim();
      if (!p || p === "[DONE]") continue;
      try { content += JSON.parse(p).choices?.[0]?.delta?.content ?? ""; } catch {}
    }
    console.log("  SSE 行数:", lines.length);
    console.log("  聚合正文:", JSON.stringify(content.slice(0, 200)));
    lines.some((l) => l.includes("[DONE]")) ? pass("收到 [DONE]") : fail("缺少 [DONE]");
    content.length > 0 ? pass("流式有正文") : fail("流式正文为空");
  }
}

// ---------------------------------------------------------------- 5. Anthropic 非流式
head(`5) Anthropic 非流式 (${MODEL})`);
{
  const r = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 200,
      messages: [{ role: "user", content: "reply with exactly: PONG" }],
    }),
  });
  console.log("  HTTP", r.status);
  const txt = await r.text();
  if (r.status !== 200) { fail(`HTTP ${r.status}: ${txt.slice(0, 300)}`); }
  else {
    const j = JSON.parse(txt);
    console.log("  type      :", j.type, " role:", j.role, " stop_reason:", j.stop_reason);
    console.log("  content   :", JSON.stringify(j.content));
    console.log("  usage     :", JSON.stringify(j.usage));
    j.type === "message" ? pass("Anthropic 响应结构正确") : fail("type 不是 message");
    j.content?.some((c) => c.type === "text" && c.text) ? pass("含 text 块") : fail("无 text 块");
  }
}

// ---------------------------------------------------------------- 6. Anthropic 流式
head(`6) Anthropic 流式 (${MODEL})`);
{
  const r = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 200, stream: true,
      messages: [{ role: "user", content: "count 1 to 3" }],
    }),
  });
  console.log("  HTTP", r.status);
  if (r.status !== 200) { fail(`HTTP ${r.status}`); }
  else {
    const text = await r.text();
    const events = [...text.matchAll(/^event: (\S+)/gm)].map((m) => m[1]);
    const uniq = [...new Set(events)];
    let content = "";
    for (const m of text.matchAll(/^data: (.+)$/gm)) {
      try {
        const d = JSON.parse(m[1]);
        if (d.type === "content_block_delta" && d.delta?.type === "text_delta") content += d.delta.text;
      } catch {}
    }
    console.log("  事件序列:", uniq.join(" → "));
    console.log("  聚合正文:", JSON.stringify(content.slice(0, 200)));
    uniq.includes("message_start") && uniq.includes("message_stop")
      ? pass("Anthropic SSE 事件完整") : fail("事件缺失");
    content.length > 0 ? pass("流式有正文") : fail("流式正文为空");
  }
}

// ════════════════════════════════════════════════════════════ 7) Responses API

async function sectionResponses() {
  console.log("\n════ 7) OpenAI Responses API (/v1/responses) ════");

  // 非流式
  const r = await fetch(`${BASE}/v1/responses`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: "reply with exactly: PONG", stream: false }),
  });
  console.log("  非流式 HTTP", r.status);
  const j = await r.json();
  const types = (j.output ?? []).map((o) => o.type);
  const text = (j.output ?? []).filter((o) => o.type === "message")
    .flatMap((o) => o.content ?? []).map((c) => c.text ?? "").join("");
  console.log("  object    :", j.object, " status:", j.status);
  console.log("  output 类型:", types.join(", ") || "(空)");
  console.log("  正文      :", JSON.stringify(text.slice(0, 120)));
  j.object === "response" ? pass("响应结构正确") : fail("object 不是 response");
  text.length > 0 ? pass("含输出文本") : fail("输出文本为空");

  // 流式
  const rs = await fetch(`${BASE}/v1/responses`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: "count 1 2 3", stream: true }),
  });
  console.log("  流式 HTTP", rs.status, " content-type:", rs.headers.get("content-type"));
  const raw = await rs.text();
  const evs = raw.split("\n").filter((l) => l.startsWith("event: "))
    .map((l) => l.slice(7).trim());
  const uniq = [...new Set(evs)];
  let sText = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const d = JSON.parse(line.slice(6));
      if (d.type === "response.output_text.delta") sText += d.delta;
    } catch {}
  }
  console.log("  事件数    :", evs.length);
  console.log("  事件序列  :", uniq.join(" → "));
  console.log("  聚合正文  :", JSON.stringify(sText.slice(0, 200)));
  (uniq.includes("response.created") && uniq.includes("response.completed"))
    ? pass("Responses SSE 事件完整") : fail("事件缺失");
  sText.length > 0 ? pass("流式有正文") : fail("流式正文为空");
}

// ════════════════════════════════════════════════════════════ 8) 思考强度

async function sectionEffort() {
  console.log("\n════ 8) 思考强度（reasoning_effort）════");

  // 能力暴露
  const rm = await fetch(`${BASE}/v1/models`, { headers: authHeaders() });
  const jm = await rm.json();
  const caps = new Map((jm.data ?? []).map((m) => [m.id, m.reasoning_efforts ?? []]));
  console.log("  能力暴露:");
  for (const [id, eff] of caps) console.log(`    ${id.padEnd(30)} [${eff.join(",")}]`);

  const target = caps.get(MODEL) ?? [];
  target.length > 0 ? pass(`${MODEL} 暴露了档位`) : fail(`${MODEL} 未暴露档位`);

  // 关键回归：给不支持的模型传 max，必须不空转、不报错
  const hasMax = target.includes("max");
  console.log(`  ${MODEL} ${hasMax ? "支持" : "不支持"} max → 测 ${hasMax ? "max" : "max(应降级)"}`);
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "reply with exactly: OK" }],
      reasoning_effort: "max",
      stream: false,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  console.log("  HTTP", r.status);
  if (r.status === 200) {
    const j = await r.json();
    const c = j.choices?.[0]?.message?.content ?? "";
    console.log("  正文:", JSON.stringify(c.slice(0, 120)));
    c.length > 0 ? pass("传 max 仍正常出字（已自动裁剪）") : fail("正文为空（空转）");
  } else {
    fail(`传 max 返回 ${r.status}`);
  }
}

await sectionResponses();
await sectionEffort();

console.log(`\n${failures === 0 ? "🎉 全部通过" : `⚠️  ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
