/**
 * convert-responses.mjs — OpenAI Responses API ⇄ Chat Completions 转换
 *
 * 背景：Codex CLI / ChatGPT Work / 新版 OpenAI SDK 走的是 Responses API
 * （POST /v1/responses），不是 Chat Completions。OpenGate 原本只有后者，
 * 所以这些客户端会拿到 404。
 *
 * 上游 OpenCode Zen 只提供 chat completions（除 muse-spark 外），
 * 因此这里的做法是：Responses 请求 → 内部转成 chat completions → 跑完
 * → 再包装回 Responses 形状。
 *
 * 有损点（技术债）：
 *  - Responses 的 `store`、`previous_response_id`（服务端会话）→ 无状态，忽略
 *  - `include`、`prompt_cache_key`、`truncation` → 忽略
 *  - reasoning 的 encrypted_content → 只回 summary_text
 */

/** Responses 请求体 → Chat Completions 请求体 */
export function responsesToChat(body) {
  const messages = [];

  // instructions 等价于 system
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions });
  }

  const input = body.input;

  // input 可以是纯字符串
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") {
        // 少数客户端会混入裸字符串
        if (typeof item === "string") messages.push({ role: "user", content: item });
        continue;
      }

      // 已经是 message 形状
      if (item.type === "message" || item.role) {
        messages.push({ role: item.role ?? "user", content: flattenContent(item.content) });
        continue;
      }

      // 函数调用结果（工具返回值）
      if (item.type === "function_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: item.call_id,
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
        });
        continue;
      }

      // 模型发起的函数调用（多轮时客户端会回传）
      if (item.type === "function_call") {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [{
            id: item.call_id ?? item.id,
            type: "function",
            function: { name: item.name, arguments: item.arguments ?? "{}" },
          }],
        });
        continue;
      }

      // reasoning 项：无 chat 等价物，丢弃（回传它没有意义）
      if (item.type === "reasoning") continue;
    }
  }

  const out = { model: body.model, messages, stream: body.stream === true };

  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (typeof body.max_output_tokens === "number") out.max_tokens = body.max_output_tokens;

  // Responses 的 tools 是扁平结构 {type, name, description, parameters}
  // chat 的 tools 是嵌套结构 {type, function:{name, description, parameters}}
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools
      .filter((t) => t && (t.type === "function" || t.name))
      .map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters ?? { type: "object", properties: {} },
        },
      }));
  }

  // tool_choice 映射
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc === "auto" || tc === "none" || tc === "required") out.tool_choice = tc;
    else if (typeof tc === "object" && tc.name) {
      out.tool_choice = { type: "function", function: { name: tc.name } };
    }
  }

  return out;
}

/** Responses 的 content 可能是字符串、数组或 null → 归一成 chat 的 content */
function flattenContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);

  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    switch (c.type) {
      case "input_text":
      case "output_text":
      case "text":
        parts.push({ type: "text", text: c.text ?? "" });
        break;
      case "input_image":
      case "image_url":
        if (c.image_url) parts.push({ type: "image_url", image_url: { url: c.image_url } });
        break;
      default:
        if (typeof c.text === "string") parts.push({ type: "text", text: c.text });
        break;
    }
  }
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  if (parts.length === 0) return "";
  return parts;
}

/** 生成 Responses 形状的 output 数组 */
export function buildResponseOutput({ text, reasoning, toolCalls, msgId }) {
  const output = [];

  if (reasoning) {
    output.push({
      type: "reasoning",
      id: `rs_${msgId}`,
      summary: [{ type: "summary_text", text: reasoning }],
    });
  }

  if (text) {
    output.push({
      type: "message",
      id: msgId,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }

  for (const tc of toolCalls ?? []) {
    output.push({
      type: "function_call",
      id: `fc_${tc.id}`,
      call_id: tc.id,
      name: tc.function?.name ?? "",
      arguments: tc.function?.arguments ?? "{}",
      status: "completed",
    });
  }

  return output;
}

/** 聚合结果 → Responses 非流式响应体 */
export function responsesNonStream({ id, model, text, reasoning, toolCalls, usage, status = "completed" }) {
  const msgId = `msg_${(id ?? Date.now().toString(36)).replace(/[^a-zA-Z0-9]/g, "").slice(-24)}`;
  return {
    id: id ?? `resp_${Date.now().toString(36)}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: buildResponseOutput({ text, reasoning, toolCalls, msgId }),
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
      total_tokens: usage?.total_tokens ?? ((usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0)),
    },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
  };
}
