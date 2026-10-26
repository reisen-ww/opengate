/**
 * fallback.mjs — DeepSeek 官方 API 兜底上游
 *
 * 免费层（OpenCode Zen）不可用时的有偿兜底：
 *   - delegate_timeout（上游风控挂起，504）
 *   - 上游 429/502/503/vendor 包装的 upstream_error
 * key 只从本机 ~/.dsh/.credentials.yaml 读（不进 git、不进 config.json），
 * 花的是用户自己的余额，所以 QUEUE_FULL（网关自身排队满）和客户端主动
 * 取消不触发，避免无意义烧钱。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

let cachedKey = null;

async function deepseekKey() {
  if (cachedKey) return cachedKey;
  const raw = await readFile(join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
  const m = raw.match(/DEEPSEEK_API_KEY\s*:\s*"?([A-Za-z0-9_-]+)"?/);
  if (!m) return null;
  cachedKey = m[1];
  return cachedKey;
}

/** 判定一个上游错误是否应当走 DeepSeek 兜底（纯函数）。 */
export function shouldFallback(err, { signal } = {}) {
  if (!err) return false;
  if (signal?.aborted) return false; // 客户端自己取消的，不兜底
  if (err.code === "QUEUE_FULL") return false; // 网关自身排队满，不烧钱
  if (err.code === "delegate_timeout") return true; // 上游挂起（风控实锤）
  if (err.status === 429 || err.status === 502 || err.status === 503) return true;
  if (err.code === "upstream_error") return true; // vendor 包装的普通上游错误
  return false;
}

/**
 * DeepSeek 官方 API 兜底调用。返回 runDelegated 同款结果结构，
 * 并按同样的规则做 onDelta 回放（无流式增量，统一完整回放）。
 */
export async function runDeepSeekFallback({ cfg, model, messages, tools, temperature, maxTokens, topP, eff, onDelta, signal }) {
  const key = await deepseekKey();
  if (!key) {
    const err = new Error("DeepSeek 兜底未配置：~/.dsh/.credentials.yaml 缺少 DEEPSEEK_API_KEY");
    err.status = 502;
    err.code = "fallback_unavailable";
    throw err;
  }
  const fb = cfg.fallback ?? {};
  const fbModel = fb.model ?? "deepseek-chat";
  const cap = fb.maxTokensCap ?? 4096;
  const asked = Number(maxTokens);
  const body = {
    model: fbModel,
    messages,
    stream: false,
    max_tokens: Math.min(Number.isFinite(asked) && asked > 0 ? asked : 1024, cap),
    ...(temperature != null ? { temperature } : {}),
    ...(topP != null ? { top_p: topP } : {}),
    ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
  };
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`DeepSeek 兜底失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status === 402 ? 402 : 502; // 402=余额不足，如实透传
    err.code = "fallback_error";
    throw err;
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message ?? {};
  const text = msg.content ?? "";
  const toolCalls = msg.tool_calls ?? [];
  const reasoning = msg.reasoning_content ?? "";
  if (reasoning) onDelta?.({ type: "reasoning", text: reasoning });
  if (text) onDelta?.({ type: "text", text });
  toolCalls.forEach((tc, index) => onDelta?.({ type: "tool", toolCall: tc, index }));
  console.error(`[fallback] 免费层失败已切 DeepSeek (model=${model} → ${fbModel}, usage=${data.usage?.total_tokens ?? "?"} tokens)`);
  return {
    id: data.id ?? null,
    text,
    reasoning,
    toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : (data.choices?.[0]?.finish_reason ?? "stop"),
    usage: data.usage ?? null,
    attempts: 1,
    effort: eff,
    viaFallback: true,
  };
}
