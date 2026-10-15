/**
 * OpenGate 端到端验收脚本。
 *
 * 用法：node verify.mjs [baseUrl]
 *
 * 覆盖全部对外协议面（OpenAI / Anthropic / Responses）、思考强度暴露与降级、
 * 以及错误处理。改完代码跑一遍就知道有没有砸东西。
 *
 * 为什么不用 curl：Windows 下 curl 对 SSE 长连接和中文输出处理很糟，
 * 而且断言逻辑用 JS 写才清晰。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(path.join(HERE, "config.json"), "utf8"));

const BASE = process.argv[2] ?? `http://${cfg.listen}`;
const KEY = cfg.apiKey;
const MODEL = cfg.defaultModel;

const H = { "content-type": "application/json", authorization: `Bearer ${KEY}` };
const AH = { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" };

const pass = [];
const fail = [];
const chk = (name, cond, detail = "") => {
  (cond ? pass : fail).push(`${name} ${detail}`);
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? `  ${detail}` : ""}`);
};

const post = (p, body, headers = H) =>
  fetch(BASE + p, {
    method: "POST", headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.requestTimeoutMs),
  });

console.log(`OpenGate 验收 @ ${BASE}\n`);

// --- 1. 模型清单与思考强度暴露 -------------------------------------------
console.log("=== 1. /v1/models 能力暴露 ===");
{
  const r = await fetch(`${BASE}/v1/models`, { headers: H, signal: AbortSignal.timeout(60_000) });
  const j = await r.json();
  chk("models 200", r.status === 200, `n=${j.data?.length}`);
  chk("模型数 > 0", (j.data?.length ?? 0) > 0);

  // 关键回归：档位必须如实反映模型能力。2.6f 不能开 max 是用户的核心诉求。
  const sb = j.data.find((m) => m.id === "space-bunny-free");
  if (sb) chk("space-bunny 暴露 max", sb.reasoning_efforts?.includes("max"), JSON.stringify(sb.reasoning_efforts));
  const mi = j.data.find((m) => m.id === MODEL);
  if (mi) chk(`${MODEL} 不暴露 max`, !mi.reasoning_efforts?.includes("max"), JSON.stringify(mi.reasoning_efforts));
}

// --- 2. OpenAI 非流式 ----------------------------------------------------
console.log("\n=== 2. OpenAI 非流式 ===");
{
  const r = await post("/v1/chat/completions", {
    model: MODEL, max_tokens: 60,
    messages: [{ role: "user", content: "只回复两个字：你好" }],
  });
  const j = await r.json();
  const txt = j.choices?.[0]?.message?.content ?? "";
  chk("HTTP 200", r.status === 200, j.error?.message ?? "");
  chk("有正文", txt.length > 0, JSON.stringify(txt.slice(0, 40)));
  chk("有 usage", (j.usage?.total_tokens ?? 0) > 0, JSON.stringify(j.usage ?? null));
}

// --- 3. OpenAI 流式 ------------------------------------------------------
console.log("\n=== 3. OpenAI 流式 SSE ===");
{
  const r = await post("/v1/chat/completions", {
    model: MODEL, stream: true,
    messages: [{ role: "user", content: "数到三" }],
  });
  const t = await r.text();
  const chunks = t.split("\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
    .filter(Boolean);
  const txt = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
  chk("HTTP 200", r.status === 200);
  chk("有 SSE 分片", chunks.length > 0, `${chunks.length} 片`);
  chk("有增量文本", txt.length > 0, JSON.stringify(txt.slice(0, 40)));
  chk("以 [DONE] 收尾", t.trimEnd().endsWith("data: [DONE]"));
}

// --- 4. 工具调用 ---------------------------------------------------------
console.log("\n=== 4. 工具调用 ===");
{
  // 模型是否调用工具是**它自己的决定**：偶尔会直接回一段文本而不调。
  // 那是合法的模型行为，不是网关故障。所以这里最多试 3 次，
  // 任何一次拿到结构合法的 tool_calls 就算通道没问题。
  let got = null;
  let lastText = "";
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 3 && !got; attempt++) {
    const r = await post("/v1/chat/completions", {
      model: MODEL,
      messages: [{ role: "user", content: "北京天气如何？必须调用 get_weather 工具，不要直接回答。" }],
      tools: [{
        type: "function",
        function: {
          name: "get_weather", description: "查天气",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      }],
      tool_choice: "auto",
    });
    const j = await r.json();
    lastStatus = r.status;
    const calls = j.choices?.[0]?.message?.tool_calls ?? [];
    lastText = j.choices?.[0]?.message?.content ?? "";
    if (calls.length) got = { calls, finish: j.choices[0].finish_reason };
    else if (attempt < 3) console.log(`  · 第 ${attempt} 次模型选择不调工具（返回文本），重试…`);
  }

  chk("HTTP 200", lastStatus === 200);
  chk("有 tool_calls", got !== null, got ? got.calls[0].function.name : `3 次均未触发工具调用，最后返回：${JSON.stringify(lastText.slice(0, 40))}`);
  if (got) {
    chk("finish_reason=tool_calls", got.finish === "tool_calls", got.finish);
    let argsOk = true;
    try { JSON.parse(got.calls[0].function.arguments); } catch { argsOk = false; }
    chk("arguments 是合法 JSON", argsOk, got.calls[0].function.arguments);
  }
}

// --- 5. Anthropic --------------------------------------------------------
console.log("\n=== 5. Anthropic /v1/messages ===");
{
  const r = await post("/v1/messages", {
    model: MODEL, max_tokens: 60,
    messages: [{ role: "user", content: "只回复两个字：你好" }],
  }, AH);
  const j = await r.json();
  const txt = j.content?.[0]?.text ?? "";
  chk("HTTP 200", r.status === 200, j.error?.message ?? "");
  chk("有 content", txt.length > 0, JSON.stringify(txt.slice(0, 40)));
  chk("有 stop_reason", typeof j.stop_reason === "string", j.stop_reason);
  chk("有 usage.input_tokens", (j.usage?.input_tokens ?? 0) > 0);
}

// --- 6. Responses --------------------------------------------------------
console.log("\n=== 6. OpenAI /v1/responses ===");
{
  const r = await post("/v1/responses", { model: MODEL, input: "只回复两个字：你好" });
  const j = await r.json();
  const txt = j.output?.flatMap((o) => o.content ?? []).find((c) => c.type === "output_text")?.text ?? "";
  chk("HTTP 200", r.status === 200, j.error?.message ?? "");
  chk("有 output_text", txt.length > 0, JSON.stringify(txt.slice(0, 40)));
}

// --- 7. 思考强度降级 -----------------------------------------------------
console.log("\n=== 7. 思考强度裁剪 ===");
{
  const cases = [
    ["space-bunny-free", "max", "max"],
    [MODEL, "max", null],          // 该模型不声明档位 → 不传
    ["step-5-preview-free", "xhigh", "high"], // 只到 high → 降级
  ];
  for (const [m, req, want] of cases) {
    const r = await post("/v1/chat/completions", {
      model: m, reasoning_effort: req, max_tokens: 50,
      messages: [{ role: "user", content: "只回复：好" }],
    });
    const j = await r.json();
    chk(`${m} effort=${req}`, r.status === 200, j.error?.message ?? "");
  }
  // 从日志核实真实生效值（响应体不带该字段，它是运维信息不是协议字段）
  await new Promise((s) => setTimeout(s, 500));
  const lg = await fetch(`${BASE}/v1/logs?limit=6`, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json());
  const byModel = Object.fromEntries((lg.data ?? []).map((l) => [l.model, l]));
  if (byModel["space-bunny-free"]) {
    chk("space-bunny max 未被降级", byModel["space-bunny-free"].effortDowngraded === false,
      `applied=${byModel["space-bunny-free"].effortApplied}`);
  }
  if (byModel["step-5-preview-free"]) {
    chk("step-5 xhigh 降级为 high",
      byModel["step-5-preview-free"].effortApplied === "high" && byModel["step-5-preview-free"].effortDowngraded === true,
      `applied=${byModel["step-5-preview-free"].effortApplied}`);
  }
}

// --- 8. 错误处理 ---------------------------------------------------------
console.log("\n=== 8. 错误处理 ===");
{
  const r = await post("/v1/chat/completions", { model: "no-such-model-xyz", messages: [{ role: "user", content: "hi" }] });
  const j = await r.json();
  chk("未知模型 → 404", r.status === 404, j.error?.code ?? "");
  chk("错误码 model_not_found", j.error?.code === "model_not_found", j.error?.code ?? "");
}
{
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
  });
  chk("错误 key → 401", r.status === 401);
}
{
  const r = await fetch(`${BASE}/v1/models`, { headers: { authorization: "Bearer wrong" } });
  chk("无 key 查模型 → 401", r.status === 401);
}

// --- 汇总 -------------------------------------------------------------------
console.log(`\n${"─".repeat(46)}`);
console.log(`结果：${pass.length} 通过 / ${fail.length} 失败`);
if (fail.length) {
  console.log("\n失败项：");
  fail.forEach((f) => console.log(`  ✗ ${f}`));
  process.exitCode = 1;
} else {
  console.log("全部通过 ✅");
}
