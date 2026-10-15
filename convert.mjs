/**
 * convert.mjs — 协议转换：Anthropic Messages ⇄ OpenAI Chat Completions
 *
 * 为什么自己写而不是复用插件：插件的 messages chunk 转的是 DSH 内部
 * chunk 结构（block-start / text-delta / finish），不是 Anthropic wire format。
 * 这一层是纯格式映射，无状态、无上游知识，风险低。
 *
 * 已知有损点（声明为技术债）：
 *  - Anthropic 的 `thinking` 块 → OpenAI 无等价物，降级为忽略（但会保留 reasoning 到正文前）
 *  - Anthropic 的 `tool_use`/`tool_result` 块 → OpenAI tool_calls / role:tool
 *  - OpenAI 的 `logprobs`、`seed`、`response_format` → Anthropic 无等价物，丢弃
 */

const STOP_REASON_MAP = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  content_filter: "stop_sequence",
  function_call: "tool_use",
};

/** Anthropic 请求体 → OpenAI chat completions 请求体 */
export function anthropicToOpenAI(body) {
  const messages = [];

  // Anthropic 的 system 是顶层字段；OpenAI 是 messages 里的 role
  if (typeof body.system === "string" && body.system.length > 0) {
    messages.push({ role: "system", content: body.system });
  } else if (Array.isArray(body.system)) {
    const text = body.system
      .filter((b) => b?.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (text) messages.push({ role: "system", content: text });
  }

  for (const m of body.messages ?? []) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    // 按块类型拆：tool_result 必须变成独立的 role:tool 消息
    const parts = [];
    const toolCalls = [];
    const toolResults = [];

    for (const block of m.content) {
      switch (block?.type) {
        case "text":
          parts.push({ type: "text", text: block.text ?? "" });
          break;
        case "image": {
          // Anthropic: {type:image, source:{type:base64, media_type, data}}
          const src = block.source ?? {};
          if (src.type === "base64") {
            parts.push({
              type: "image_url",
              image_url: { url: `data:${src.media_type};base64,${src.data}` },
            });
          } else if (src.type === "url") {
            parts.push({ type: "image_url", image_url: { url: src.url } });
          }
          break;
        }
        case "tool_use":
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
          break;
        case "tool_result":
          toolResults.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content:
              typeof block.content === "string"
                ? block.content
                : (block.content ?? [])
                    .filter((c) => c?.type === "text")
                    .map((c) => c.text)
                    .join("\n"),
          });
          break;
        case "thinking":
        case "redacted_thinking":
          // 无 OpenAI 等价物：保留为正文前置说明，避免信息全丢
          if (block.thinking) parts.push({ type: "text", text: `[thinking]\n${block.thinking}\n[/thinking]` });
          break;
        default:
          break;
      }
    }

    if (parts.length > 0 || toolCalls.length > 0) {
      const msg = { role: m.role };
      if (parts.length === 1 && parts[0].type === "text") msg.content = parts[0].text;
      else if (parts.length > 0) msg.content = parts;
      else msg.content = null;
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      messages.push(msg);
    }
    messages.push(...toolResults);
  }

  const out = {
    model: body.model,
    messages,
    stream: body.stream === true,
  };
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;

  // Anthropic tools → OpenAI tools
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc.type === "auto") out.tool_choice = "auto";
    else if (tc.type === "any") out.tool_choice = "required";
    else if (tc.type === "tool" && tc.name) {
      out.tool_choice = { type: "function", function: { name: tc.name } };
    } else if (tc.type === "none") out.tool_choice = "none";
  }
  return out;
}

/** 从 OpenAI 流式 delta 里提取文本，用于聚合非流式响应 */
export function extractDelta(delta) {
  const out = { text: "", reasoning: "", toolCalls: null };
  if (!delta) return out;
  if (typeof delta.content === "string") out.text = delta.content;
  if (typeof delta.reasoning === "string") out.reasoning = delta.reasoning;
  if (typeof delta.reasoning_content === "string") out.reasoning = delta.reasoning_content;
  if (Array.isArray(delta.tool_calls)) out.toolCalls = delta.tool_calls;
  return out;
}

/** 把聚合后的结果包成 OpenAI 非流式响应 */
export function openAINonStream({ id, model, text, reasoning, toolCalls, finishReason, usage }) {
  const message = { role: "assistant", content: text || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls?.length) message.tool_calls = toolCalls;
  return {
    id: id || `chatcmpl-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason || "stop", logprobs: null }],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** 把聚合后的结果包成 Anthropic 非流式响应 */
export function anthropicNonStream({ id, model, text, reasoning, toolCalls, finishReason, usage }) {
  const content = [];
  if (reasoning) content.push({ type: "thinking", thinking: reasoning, signature: "" });
  if (text) content.push({ type: "text", text });
  for (const tc of toolCalls ?? []) {
    let input = {};
    try {
      input = JSON.parse(tc.function?.arguments || "{}");
    } catch {
      input = { _raw: tc.function?.arguments };
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
  }
  return {
    id: id || `msg_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: STOP_REASON_MAP[finishReason] ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
    },
  };
}

export { STOP_REASON_MAP };
