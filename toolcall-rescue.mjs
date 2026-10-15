/**
 * 被动工具调用救援：把模型"用文本假装调工具"的输出转回正规 tool_calls。
 *
 * 背景：上游 tools 参数已正确透传（真实 opencode 链路），但免费小模型
 * 偶发不走 function_call 通道，而是把调用写成文本，常见两种形状：
 *   A. Qwen 系:  <tool_call>{"name":"x","arguments":{...}}</tool_call>
 *   B. 仿 exec:  <tool_call><function=NAME>...body...</function></tool_call>
 *      （body 里可能是 JSON，也可能是一段裸文本/参数标记）
 *
 * 三重门禁，缺一不转（把误伤面压到零）：
 *   1. 请求必须带了 tools（没带 tools 的请求，正文里出现 XML 是合法内容）
 *   2. 响应里一个正规 tool_call 都没有（有就不动 —— 正规通道优先）
 *   3. 解析出的工具名必须在本请求的 tools 里（防幻觉工具名）
 *
 * 纯函数、零依赖，~100 行。
 */

/** 从 tools 定义里取名字集合。 */
function toolNames(tools) {
  const names = new Set();
  for (const t of tools ?? []) {
    const n = t?.function?.name ?? t?.name;
    if (typeof n === "string" && n) names.add(n);
  }
  return names;
}

/** 尝试解析参数 JSON；失败返回 null。 */
function parseArgs(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* 不是 JSON */ }
  // 常见小错：尾逗号
  try { return JSON.parse(s.replace(/,\s*([}\]])/g, "$1")); } catch { return null; }
}

/** 从 <function=NAME> 的 body 里抠参数。 */
function parseFunctionBody(body) {
  const text = String(body ?? "").trim();
  // 1) body 本身是 JSON
  const asJson = parseArgs(text);
  if (asJson && typeof asJson === "object" && !Array.isArray(asJson)) return asJson;
  // 2) <parameter ...> 标记对
  const params = {};
  const re = /<parameter\s+(?:name\s*=\s*"?([\w.-]+)"?|=\s*"?([\w.-]+)"?)\s*>([\s\S]*?)<\/parameter>/g;
  let m, hit = false;
  while ((m = re.exec(text))) {
    hit = true;
    const key = m[1] ?? m[2];
    const val = m[3].trim();
    const parsed = parseArgs(val);
    params[key] = parsed ?? val;
  }
  if (hit) return params;
  // 3) 兜底：整段裸文本塞进 input（客户端 schema 校验会拦住不匹配的，但至少调用可见）
  return text ? { input: text } : {};
}

/**
 * 扫描文本，提取伪工具调用。
 * @param {string} text 模型正文
 * @param {Array} tools 请求里带的 tools（用于白名单校验）
 * @returns {{ toolCalls: Array, text: string } | null} null = 没有可救援内容
 */
export function rescueToolCalls(text, tools) {
  if (!text || typeof text !== "string") return null;
  const allowed = toolNames(tools);
  if (!allowed.size) return null;
  // 快速预检：没有这些标记就直接返回，不付正则成本
  if (!/<tool_call|<function=/.test(text)) return null;

  const calls = [];
  // A 形状：<tool_call>{json}</tool_call>
  const reA = /<tool_call>\s*([\[{][\s\S]*?[\]}])\s*<\/tool_call>/g;
  // B 形状：<tool_call><function=NAME>…</function></tool_call>（function 体不含 </function>）
  const reB = /<tool_call>\s*<function=([\w.-]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g;
  // C 形状：裸 <function=NAME>…</function>（没有 tool_call 包装）
  const reC = /<function=([\w.-]+)>([\s\S]*?)<\/function>/g;

  const ranges = [];
  const push = (name, args, start, end) => {
    if (!allowed.has(name)) return;       // 白名单外 → 当普通文本，不转
    calls.push({
      id: `call_${Math.random().toString(36).slice(2, 10)}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args ?? {}) },
    });
    ranges.push([start, end]);
  };

  let m;
  while ((m = reA.exec(text))) {
    const obj = parseArgs(m[1]);
    const name = obj?.name ?? (obj?.function?.name ?? null);
    if (!name) continue;
    const args = obj?.arguments ?? obj?.parameters ?? obj?.input ?? {};
    push(String(name), typeof args === "string" ? (parseArgs(args) ?? { input: args }) : args, m.index, m.index + m[0].length);
  }
  while ((m = reB.exec(text))) push(m[1], parseFunctionBody(m[2]), m.index, m.index + m[0].length);
  if (!calls.length) {
    while ((m = reC.exec(text))) push(m[1], parseFunctionBody(m[2]), m.index, m.index + m[0].length);
  }
  if (!calls.length) return null;

  // 从正文里剥掉已转换的片段（多个调用可能交错，倒序删）
  let cleaned = text;
  ranges.sort((a, b) => b[0] - a[0]);
  for (const [s, e] of ranges) cleaned = cleaned.slice(0, s) + cleaned.slice(e);
  cleaned = cleaned.trim();

  return { toolCalls: calls, text: cleaned };
}
