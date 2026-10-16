/**
 * server.mjs — OpenGate：本地免费网关
 *
 * 上游：OpenCode Zen 匿名免费通道（零凭据，Bearer public）
 * 门禁算法：**不自己实现**，直接复用 opencode2dsh 插件的 lib/（见 zen.mjs 注释）
 *
 * 暴露协议：
 *   POST /v1/chat/completions   OpenAI Chat Completions（含流式）
 *   POST /v1/messages           Anthropic Messages（含流式）
 *   GET  /v1/models             两个协议共用的模型列表
 *   GET  /healthz               健康检查（免鉴权）
 *
 * 设计约束（来自上游）：上游只接受 stream:true。
 * 因此客户端要非流式时，本网关仍以流式拉取上游，再在本地聚合后一次性返回。
 */
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPlugin, getCatalog, buildUpstreamRequest, fetchUpstream, iterateSSE, seedOf, modelEfforts, resolveEffort } from "./zen.mjs";
import { DelegateRuntime } from "./delegate.mjs";
import { rescueToolCalls } from "./toolcall-rescue.mjs";
import { AvailabilityProbe } from "./probe.mjs";
import {
  anthropicToOpenAI,
  extractDelta,
  openAINonStream,
  anthropicNonStream,
  STOP_REASON_MAP,
} from "./convert.mjs";
import { responsesToChat, responsesNonStream } from "./convert-responses.mjs";
import { Metrics } from "./metrics.mjs";
import { Gate } from "./limiter.mjs";
import { renderDashboard } from "./dashboard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, "config.json");
const VERSION = "1.1.0";

// ---------------------------------------------------------------- 配置

async function loadConfig() {
  let cfg = {};
  if (existsSync(CONFIG_PATH)) {
    cfg = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  }
  // 首次运行生成随机本地 key（用户要求：生成本地 key）
  if (!cfg.apiKey) {
    cfg.apiKey = "og_" + randomBytes(24).toString("hex");
    await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
    console.log(`\n[init] 已生成新的本地 API Key 并写入 config.json：\n       ${cfg.apiKey}\n`);
  }
  cfg.listen ??= "127.0.0.1:8787";
  // 默认必须是委托模式：直连通道过不了凭据门禁，会让开箱即用的用户全模型失败。
  cfg.upstream ??= "delegate";
  cfg.defaultModel ??= "mimo-v2.6-flash-free";
  cfg.requestTimeoutMs ??= 300000;
  return cfg;
}

// ---------------------------------------------------------------- 工具

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function openAIError(res, status, message, type = "invalid_request_error", code = null) {
  sendJSON(res, status, { error: { message, type, code, param: null } });
}

function anthropicError(res, status, message, type = "invalid_request_error") {
  sendJSON(res, status, { type: "error", error: { type, message } });
}

async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** 常量时间比较，避免 key 泄露时序 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 鉴权：同时接受 OpenAI 的 Authorization: Bearer 和 Anthropic 的 x-api-key */
function isAuthorized(req, cfg) {
  const auth = req.headers["authorization"] ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const xApiKey = String(req.headers["x-api-key"] ?? "").trim();
  return safeEqual(bearer, cfg.apiKey) || safeEqual(xApiKey, cfg.apiKey);
}

// ---------------------------------------------------------------- 模型列表

/** 可用性探测器实例，在启动流程里初始化。null 表示未启用。 */
let probe = null;

/** 可观测性 + 并发闸门，在启动流程里初始化。 */
let metrics = null;
let gate = null;

/**
 * 模型能力缓存。
 *
 * 为什么需要：`/v1/models` 要为每个模型查一次 reasoningCapability，
 * 原来是 `for + await` 串行 —— 7 个模型就是 7 次 await，
 * 客户端拉一次列表要等好几百毫秒。
 *
 * 缓存策略（**这里有个坑**）：能力来自 models.dev 元数据。网关刚启动时
 * catalog 还没刷新完，此时查任何模型都会得到"空能力"。如果把这个空结果
 * 也按 5 分钟缓存，客户端在整个启动窗口内都会看到"不暴露任何档位"。
 * 因此：**非空结果长缓存，空结果只短缓存**，等 catalog 就绪后自动自愈。
 *
 * 并发合并：同一时刻多个请求只触发一次计算（避免击穿）。
 */
const CAP_TTL_MS = 300_000;     // 拿到能力：5 分钟
const CAP_TTL_EMPTY_MS = 3_000; // 空结果：3 秒后重试（等 catalog 就绪）
const capCache = new Map();   // id -> { at, value, ttl }
const capInflight = new Map(); // id -> Promise

async function cachedEfforts(id, cfg = null) {
  const hit = capCache.get(id);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;

  const running = capInflight.get(id);
  if (running) return running;

  // 委托模式：档位取自真实 opencode 的 catalog（variants[*].reasoningEffort），
  // 这才是"思考强度暴露明白"的准确来源 —— 实测 space-bunny-free 支持 max，
  // 而 mimo-v2.6-flash-free 只到 high。
  const source = cfg?.upstream === "delegate"
    ? delegateEfforts(id, cfg)
    : modelEfforts(id);

  const p = source
    .then((v) => {
      const empty = !v?.reasoning || (v.efforts ?? []).length === 0;
      capCache.set(id, { at: Date.now(), value: v, ttl: empty ? CAP_TTL_EMPTY_MS : CAP_TTL_MS });
      return v;
    })
    .catch(() => ({ reasoning: false, efforts: [] }))
    .finally(() => capInflight.delete(id));
  capInflight.set(id, p);
  return p;
}

/** 委托模式的思考强度查询。 */
async function delegateEfforts(id, cfg) {
  const known = await delegateCatalog(cfg);
  const bare = String(id).replace(/^opencode\//, "");
  const hit = known.find((m) => m.id === id || m.id.endsWith(`/${bare}`));
  if (!hit?.supportsReasoning) return { reasoning: false, efforts: [] };
  return { reasoning: true, efforts: hit.supportedEfforts ?? [] };
}

/** 批量取能力：并发而不是串行。 */
async function cachedEffortsBatch(ids, cfg = null) {
  return Promise.all(ids.map((id) => cachedEfforts(id, cfg)));
}

/** 探测候选集：只探免费模型。
 *  付费模型没余额，探了必然失败 —— 既浪费额度又拖慢探测。
 *
 *  注意：不能只依赖 catalog.list()。catalog 首次刷新要几秒到几十秒，
 *  在那之前 list() 只返回 3 个静态兜底模型，会导致探测范围严重缩水。
 *  因此始终以"上游实时列表 + 免费启发式"为主，catalog 结果只作补充。 */
async function probeCandidates() {
  // 委托模式：catalog 里出现的就是真实可用的，直连探测会因凭据门禁
  // 把好模型误判为 gated，所以不参与探测。
  if (cfg.upstream === "delegate") return [];

  const p = plugin;
  const ids = new Set();
  try {
    // 主来源：上游实时在售列表
    const all = await p.fetchZenModels(p.ZEN_BASE_URL, fetch, p.opencodeUserAgent());
    for (const id of all) {
      if (/(^|-)free$/i.test(id) || id === "big-pickle") ids.add(id);
    }
  } catch (e) {
    console.error("[probe] 拉取上游列表失败:", e?.message ?? e);
  }
  try {
    // 补充来源：catalog（可能包含上游未列出的免费模型）
    const catalog = await getCatalog(cfg);
    for (const id of catalog.list() ?? []) ids.add(id);
  } catch {}
  return [...ids].filter((id) => !p.FREE_LANE_BLOCKLIST.has(id));
}

async function listModels(cfg) {
  // 委托模式：模型清单来自真实 opencode 的 provider catalog，不去问 Zen。
  if (cfg.upstream === "delegate") {
    let ids = [];
    try {
      const known = await delegateCatalog(cfg);
      ids = known.map((m) => m.id.replace(/^opencode\//, ""));
    } catch (err) {
      console.error("[models] 委托 catalog 失败:", err?.message ?? err);
    }
    if (cfg.modelDenylist?.length) {
      const deny = new Set(cfg.modelDenylist);
      ids = ids.filter((id) => !deny.has(id));
    }
    if (cfg.modelAllowlist?.length) {
      const allow = new Set(cfg.modelAllowlist);
      ids = ids.filter((id) => allow.has(id));
    }
    return ids.sort();
  }

  const p = await loadPlugin();
  const catalog = await getCatalog(cfg);
  let ids = [];
  try {
    ids = catalog.list() ?? [];
  } catch (err) {
    console.error("[models] catalog.list 失败:", err?.message ?? err);
  }
  // 兜底：catalog 还没就绪时，直接用上游实时列表
  if (ids.length === 0) {
    try {
      const live = await p.fetchZenModels(p.ZEN_BASE_URL, fetch, p.opencodeUserAgent());
      ids = live.filter((id) => !p.FREE_LANE_BLOCKLIST.has(id));
    } catch (err) {
      console.error("[models] 上游实时列表也失败:", err?.message ?? err);
    }
  }
  if (cfg.modelDenylist?.length) {
    const deny = new Set(cfg.modelDenylist);
    ids = ids.filter((id) => !deny.has(id));
  }
  if (cfg.modelAllowlist?.length) {
    const allow = new Set(cfg.modelAllowlist);
    ids = ids.filter((id) => allow.has(id));
  }
  // 可用性探测过滤：把"在售但调不通"的模型（如 cat-jam-free）剔除
  if (probe) ids = probe.filter(ids);
  return ids.sort();
}

/**
 * 校验客户端请求的模型是否可用，并解析出真正要发给上游的名字。
 *
 * 为什么需要：三个推理端点原来**完全不校验**模型名。客户端拼错一个字，
 * 请求就一路打到上游，白烧一次配额，最后返回语义错误的 `502 upstream_error`。
 * 正确行为是本地就回 `404 model_not_found`。
 *
 * 兼容 provider 前缀：opencodex 把模型名写成 `Og/mimo-v2.6-flash-free`，
 * 而上游只认裸名。若整名查不到、去掉最后一段前缀后能查到，就采用裸名。
 *
 * 返回 `{ model }` 表示可用；`{ model: null, available }` 表示不可用。
 * 客户端没指定模型时不校验（走 defaultModel，避免把配置问题算到用户头上）。
 */
async function resolveModelName(cfg, raw) {
  const requested = String(raw ?? "").trim();
  if (!requested) return { model: cfg.defaultModel, requested: null, explicit: false };

  const ids = await listModels(cfg);
  if (ids.includes(requested)) return { model: requested, requested, explicit: true };

  const slash = requested.lastIndexOf("/");
  if (slash > 0) {
    const bare = requested.slice(slash + 1);
    if (ids.includes(bare)) return { model: bare, requested, explicit: true };
  }
  return { model: null, requested, explicit: true, available: ids };
}

/** 探测一个模型是否真能出字。返回 { status, bodyText }，不抛异常。 */
async function probeOne(modelId) {
  if (cfg.upstream === "delegate") return { status: 0, bodyText: "delegate 模式不探测" };
  const p = await loadPlugin();
  try {
    if (p.isResponsesModel(modelId)) {
      // Responses 通道：直接打上游，形状不同
      const session = p.canonicalSessionID(`probe ${modelId}`);
      const res = await fetch(`${p.ZEN_BASE_URL}/v1/responses`, {
        method: "POST",
        headers: {
          ...p.disguiseHeaders({
            session,
            request: p.randomID("req", 16),
            project: p.stableID("prj", "opencode2dsh:default-project"),
            parentSession: "",
          }),
          authorization: "Bearer public",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: modelId, stream: true, input: [{ role: "user", content: "ok" }] }),
        signal: AbortSignal.timeout(45_000),
      });
      return { status: res.status, bodyText: res.status === 200 ? "" : await res.text() };
    }
    const req = await buildUpstreamRequest({
      model: modelId,
      messages: [{ role: "user", content: "ok" }],
      conversationSeed: `probe ${modelId}`,
    });
    const res = await fetch(req.url, {
      method: "POST", headers: req.headers, body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(45_000),
    });
    if (res.status !== 200) return { status: res.status, bodyText: await res.text() };
    // 200 还不够：要确认真的吐了内容
    let got = "";
    for await (const ev of iterateSSE(res)) {
      got += ev.choices?.[0]?.delta?.content ?? "";
      if (got.length > 0) break;
    }
    return { status: got.length > 0 ? 200 : 502, bodyText: got.length > 0 ? "" : "empty stream" };
  } catch (e) {
    return { status: 0, bodyText: String(e?.message ?? e) };
  }
}

// ---------------------------------------------------------------- 上游调用（流式消费）

/**
 * 跑一次上游调用，把 SSE 事件通过 onDelta 回调交出去。
 * 返回 { text, reasoning, toolCalls, finishReason, usage, id }。
 *
 * 为什么要有外层重试：
 *   上游偶发返回 HTTP 200 但**流是空的**（实测到过：finish_reason=stop、
 *   正文和 reasoning 全空）。fetchUpstream 只对 HTTP 错误码重试，
 *   空流它看不见，会把一个空响应当成功返回给客户端。
 *
 * 重试的安全边界：
 *   一旦已经通过 onDelta 向客户端发过任何内容，就不能再重试了 ——
 *   重试会导致客户端收到重复内容。所以只在"还没吐出任何东西"时重试。
 */
async function runUpstream({ cfg, model, messages, tools, temperature, maxTokens, topP, reasoningEffort, onDelta, signal }) {
  const seed = seedOf(messages);
  const maxAttempts = Math.max(1, cfg.retry?.maxAttempts ?? 4);
  const baseDelay = cfg.retry?.baseDelayMs ?? 800;

  // 先算一次思考强度裁剪结果：客户端可能传了模型不支持的档位（如 2.6f 传 max）
  const eff = cfg.upstream === "delegate"
    ? await resolveDelegateEffort(cfg, model, reasoningEffort)
    : await resolveEffort(model, reasoningEffort);
  if (eff.downgraded) {
    console.error(`[effort] ${model}: 请求 ${eff.requested} 不支持，降级为 ${eff.applied}（支持: ${eff.supported.join("/") || "无"}）`);
  }

  // 并发闸门：上游是匿名共享池，自己打自己会触发 429。
  // 拿不到槽位就抛 429（不无限排队）。
  let release = null;
  if (gate) {
    try {
      release = await gate.enter(model);
    } catch (e) {
      const err = new Error(e.message);
      err.status = e.status ?? 429;
      err.code = e.code ?? "QUEUE_FULL";
      err.effort = eff;
      throw err;
    }
  }

  try {
    if (cfg.upstream === "delegate") {
      return await runDelegated({ cfg, model, messages, tools, temperature, maxTokens, topP, eff, reasoningEffort, onDelta, signal });
    }
    return await runUpstreamInner({ cfg, model, messages, tools, temperature, maxTokens, topP, seed, maxAttempts, baseDelay, eff, reasoningEffort, onDelta, signal });
  } finally {
    release?.();
  }
}

// ---------------------------------------------------------------- 委托上游

/** 进程内单例：opencode 冷启动约 4s，全局只付一次。 */
let delegateRt = null;
function getDelegate(cfg) {
  if (!delegateRt) {
    delegateRt = new DelegateRuntime({
      dataDir: cfg.delegate?.dataDir ?? HERE,
      log: (m) => console.error(m),
    });
  }
  return delegateRt;
}

/** 委托模式下已就绪的模型清单（含不可用项，供 effort 查询）。 */
async function delegateCatalog(cfg, { forceRefresh = false } = {}) {
  const rt = getDelegate(cfg);
  await rt.start();
  // 冷启动必刷；周期刷新走 forceRefresh —— 之前这里写成"非空就不刷"，
  // 定时器每轮只是读旧缓存还打"刷新完成"日志，上游上新模型永远看不到。
  // backend.models() 拉到空列表会自己抛错并保留现有列表，安全。
  if (forceRefresh || !rt.catalog.all().length) await rt.refresh();
  return rt.catalog.all();
}

/**
 * 委托模式的思考强度裁剪。
 *
 * 与 zen.mjs 的 resolveEffort 语义一致，但档位来源换成 BridgeCatalog ——
 * 那才是 opencode 自己声明的 `variants[*].reasoningEffort`，比插件元数据准。
 * 实测：space-bunny-free 支持 max，mimo-v2.6-flash-free 只到 high。
 */
async function resolveDelegateEffort(cfg, model, requested) {
  const known = await delegateCatalog(cfg);
  const bare = String(model).replace(/^opencode\//, "");
  const hit = known.find((m) => m.id === model || m.id.endsWith(`/${bare}`));

  const supported = hit?.supportsReasoning ? (hit.supportedEfforts ?? []) : [];
  if (!hit?.supportsReasoning) {
    return { wire: undefined, requested, applied: undefined, downgraded: false, supported: [] };
  }
  if (requested === undefined || requested === null || requested === "") {
    return { wire: undefined, requested, applied: undefined, downgraded: false, supported };
  }

  let id = String(requested).toLowerCase().trim();
  if (id === "none" || id === "off" || id === "disabled") id = "off";
  if (id === "min" || id === "minimum") id = "minimal";
  if (id === "med" || id === "middle") id = "medium";

  if (supported.includes(id)) {
    return { wire: id === "off" ? "none" : id, requested, applied: id, downgraded: false, supported };
  }

  // 就近降级：取不超过请求档位里最强的一个；都比请求弱就取最强的
  const order = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const want = order.indexOf(id);
  const cands = supported.filter((s) => order.includes(s)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const applied = want >= 0
    ? ([...cands].reverse().find((s) => order.indexOf(s) <= want) ?? cands[cands.length - 1])
    : cands[cands.length - 1];

  if (!applied) {
    return { wire: undefined, requested, applied: undefined, downgraded: true, supported };
  }
  return {
    wire: applied === "off" ? "none" : applied,
    requested, applied,
    downgraded: applied !== id,
    supported,
  };
}

/**
 * 走委托上游：把请求交给真实 opencode 进程。
 *
 * 为什么需要它：Zen 免费层现在校验 auth.json 里的 `oc_sk_` 凭据，
 * 纯代码客户端拿不到，只有真正的 opencode 二进制能过（见 delegate.mjs）。
 *
 * 结果通过 onDelta 回放给调用方，所以 6 个协议处理器完全不用改 ——
 * 它们照旧消费 runUpstream 的返回值。
 */
async function runDelegated({ cfg, model, messages, tools, temperature, maxTokens, topP, eff, reasoningEffort, onDelta, signal }) {
  const rt = getDelegate(cfg);
  await rt.start();

  // 模型清单只拉一次，之后靠 refreshSeconds 定时刷新
  if (!rt.catalog.all().length) await rt.refresh();

  // 客户端传的模型名可能是 zen 风格（big-pickle），也可能带 provider 前缀
  const known = rt.catalog.all();
  const bare = String(model).replace(/^opencode\//, "");
  const hit = known.find((m) => m.id === model || m.id === `opencode/${bare}` || m.id.endsWith(`/${bare}`));
  if (!hit) {
    const err = new Error(`模型 ${model} 在委托上游不可用`);
    err.status = 404;
    err.code = "model_not_found";
    err.effort = eff;
    throw err;
  }

  const body = {
    model: hit.id,
    messages,
    stream: false,
    max_tokens: maxTokens,
    temperature,
    top_p: topP,
    ...(eff?.wire ? { reasoning_effort: eff.wire } : {}),
    ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
  };

  let res;
  // 流式增量：注册探针，把 opencode 事件流的文本增量实时转发给 onDelta。
  // 只在客户端要 stream 时注册；非流式请求不注册（转发无意义）。
  let offDelta = null;
  const streamed = { text: 0, reasoning: 0 };
  if (onDelta) {
    offDelta = rt.onTapDelta((d) => {
      if (streamed[d.type] !== undefined) streamed[d.type] += d.text.length;
      onDelta(d);
    });
  }
  try {
    res = await rt.complete(body, signal);
  } catch (e) {
    const err = new Error(e?.message ?? String(e));
    err.status = e?.status ?? 502;
    err.code = e?.code ?? "upstream_error";
    err.effort = eff;
    throw err;
  } finally {
    offDelta?.();
  }

  const choice = res.result?.choices?.[0];
  const msg = choice?.message ?? {};
  let text = msg.content ?? "";
  let toolCalls = msg.tool_calls ?? [];
  const reasoning = msg.reasoning_content ?? msg.reasoning ?? "";

  // 被动工具调用救援：免费小模型偶发不走 function_call 通道，把调用写成
  // 文本（<tool_call>… / <function=…>）。三重门禁后才转换：
  // 请求带 tools + 响应零 tool_calls + 解析出的工具名在请求 tools 白名单里。
  // 流式路径文本可能已发出，救援结果主要供非流式与 finish_reason 语义修正。
  if (!toolCalls.length && tools?.length && text) {
    const rescued = rescueToolCalls(text, tools);
    if (rescued) {
      toolCalls = rescued.toolCalls;
      text = rescued.text;
      console.error(`[rescue] 文本工具调用已转换: ${toolCalls.map((t) => t.function.name).join(", ")} (model=${model})`);
    }
  }

  // 收尾回放。注意：流式增量是 opencode 的原始 part 文本（可能带模型的结构化
  // 尾巴），而 result.text 是 vendor 解析信封后的干净文本 —— 两者不是前缀关系，
  // 不能按长度差补尾巴（会把信封字面量漏进正文）。所以规则很简单：
  // 该类型流过增量就信任事件流不再补；一个增量都没收到（丢帧/非文本）才完整回放。
  // 救援过的文本（流式路径）也不回放：客户端已见到原文，结果集仍携带转换后的 toolCalls。
  if (reasoning && streamed.reasoning === 0) onDelta?.({ type: "reasoning", text: reasoning });
  if (text && streamed.text === 0) onDelta?.({ type: "text", text });
  toolCalls.forEach((tc, index) => onDelta?.({ type: "tool", toolCall: tc, index }));

  return {
    id: res.result?.id ?? null,
    text,
    reasoning,
    toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : (choice?.finish_reason ?? "stop"),
    usage: res.result?.usage ?? null,
    attempts: 1,
    effort: eff,
  };
}

async function runUpstreamInner({ cfg, model, messages, tools, temperature, maxTokens, topP, seed, maxAttempts, baseDelay, eff, reasoningEffort, onDelta, signal }) {
  let lastResult = null;
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    // 每次尝试都重建请求：换新的 request id（session 保持不变以复用缓存）
    const req = await buildUpstreamRequest({
      model, messages, tools, temperature, maxTokens, topP, conversationSeed: seed,
      reasoningEffort: eff.applied ?? reasoningEffort,
    });

    const res = await fetchUpstream(req, cfg.retry);

    let text = "";
    let reasoning = "";
    const toolAcc = new Map();
    let finishReason = null;
    let usage = null;
    let id = null;
    let emitted = false;   // 是否已经向客户端发过内容

    const timeout = setTimeout(() => {
      try { res.body?.cancel?.(); } catch {}
    }, cfg.requestTimeoutMs);
    let onAbort = null;
    if (signal) {
      onAbort = () => { try { res.body?.cancel?.(); } catch {} };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      for await (const ev of iterateSSE(res)) {
        id ??= ev.id ?? null;
        if (ev.usage) usage = ev.usage;

        const choice = ev.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const d = extractDelta(choice.delta);
        if (d.reasoning) {
          reasoning += d.reasoning;
          emitted = true;
          onDelta?.({ type: "reasoning", text: d.reasoning });
        }
        if (d.text) {
          text += d.text;
          emitted = true;
          onDelta?.({ type: "text", text: d.text });
        }
        if (d.toolCalls) {
          for (const tc of d.toolCalls) {
            const idx = tc.index ?? 0;
            const cur = toolAcc.get(idx) ?? { id: tc.id, type: "function", function: { name: "", arguments: "" } };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.function.name = tc.function.name;
            if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
            toolAcc.set(idx, cur);
            emitted = true;
            onDelta?.({ type: "tool", toolCall: cur, index: idx });
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      // 不移除会随每次重试在同一条 signal 上堆积监听器（重试一次就多一个）
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }

    lastResult = {
      id, text, reasoning,
      toolCalls: [...toolAcc.values()].filter((t) => t.function.name),
      finishReason: finishReason ?? "stop",
      usage,
    };

    const hasContent = text.length > 0 || reasoning.length > 0 || lastResult.toolCalls.length > 0;

    // 无论是正常完成还是已发过内容的空流，都要带上可观测性字段
    const done = () => ({ ...lastResult, attempts, effort: eff });

    // 正常有内容 → 完成
    if (hasContent) return done();

    // 空响应。已经发过东西就不能重试（会重复）
    if (emitted) return done();

    if (attempt < maxAttempts) {
      const delay = baseDelay * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      console.error(`[upstream] 第 ${attempt} 次返回空流，${delay}ms 后重试`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    console.error(`[upstream] ${maxAttempts} 次尝试后仍是空流，放弃`);
  }

  // 附上可观测性字段：调用方（记录指标时）要用
  return { ...lastResult, attempts, effort: eff };
}

// ---------------------------------------------------------------- OpenAI 端点

async function handleOpenAI(req, res, cfg, body) {
  // 模型校验：拼错的模型名不该打到上游去白烧配额
  const picked = await resolveModelName(cfg, body.model);
  if (!picked.model) {
    return openAIError(
      res, 404,
      `模型不存在或不可用: ${picked.requested}。可用模型: ${(picked.available ?? []).join(", ")}`,
      "invalid_request_error", "model_not_found",
    );
  }
  const model = picked.model;
  const stream = body.stream === true;
  const messages = body.messages ?? [];

  if (!Array.isArray(messages) || messages.length === 0) {
    return openAIError(res, 400, "messages 不能为空");
  }

  const upstreamTools = Array.isArray(body.tools) ? body.tools : undefined;

  if (!stream) {
    // 上游只支持流式，这里本地聚合
    const result = await runUpstream({
      cfg, model, messages, tools: upstreamTools,
      temperature: body.temperature, maxTokens: body.max_tokens, topP: body.top_p,
      reasoningEffort: body.reasoning_effort,
    });
    res._ogDetail = { model, stream: false, usage: result.usage, attempts: result.attempts, effort: result.effort };
    return sendJSON(res, 200, openAINonStream({
      id: result.id, model, text: result.text, reasoning: result.reasoning,
      toolCalls: result.toolCalls, finishReason: result.finishReason, usage: result.usage,
    }));
  }

  // 流式：先建立上游连接，成功后再写响应头，这样错误能以 HTTP 状态码返回
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const id = `chatcmpl-${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  const frame = (delta, finish = null) =>
    `data: ${JSON.stringify({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;

  try {
    res.write(frame({ role: "assistant", content: "" }));
    const result = await runUpstream({
      cfg, model, messages, tools: upstreamTools,
      temperature: body.temperature, maxTokens: body.max_tokens, topP: body.top_p,
      reasoningEffort: body.reasoning_effort,
      onDelta: (d) => {
        if (d.type === "reasoning") res.write(frame({ reasoning_content: d.text }));
        else if (d.type === "text") res.write(frame({ content: d.text }));
        else if (d.type === "tool") {
          res.write(frame({
            tool_calls: [{
              index: d.index,
              id: d.toolCall.id,
              type: "function",
              function: d.toolCall.function,
            }],
          }));
        }
      },
    });

    // 全部重试后仍然空 → 明确报错，不要假装成功（否则客户端拿到空回复却以为正常）
    const empty = !result.text && !result.reasoning && result.toolCalls.length === 0;
    res._ogDetail = {
      model, stream: true, usage: result.usage,
      attempts: result.attempts, effort: result.effort,
      error: empty ? "upstream_empty" : null,
    };
    if (empty) {
      res.write(`data: ${JSON.stringify({
        error: { message: "上游连续返回空响应，请重试", type: "upstream_empty" },
      })}\n\n`);
    }
    res.write(frame({}, "stop"));
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    // 响应头已发出，只能用 SSE error 事件告知
    console.error("[openai/stream]", err?.message ?? err);
    res.write(`data: ${JSON.stringify({ error: { message: String(err?.message ?? err), type: "upstream_error" } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

// ---------------------------------------------------------------- Anthropic 端点

async function handleAnthropic(req, res, cfg, body) {
  const oai = anthropicToOpenAI(body);
  const picked = await resolveModelName(cfg, oai.model);
  if (!picked.model) {
    return anthropicError(
      res, 404,
      `模型不存在或不可用: ${picked.requested}。可用模型: ${(picked.available ?? []).join(", ")}`,
      "not_found_error",
    );
  }
  const model = picked.model;
  const stream = body.stream === true;

  if (!Array.isArray(oai.messages) || oai.messages.length === 0) {
    return anthropicError(res, 400, "messages 不能为空");
  }

  if (!stream) {
    const result = await runUpstream({
      cfg, model, messages: oai.messages, tools: oai.tools,
      temperature: oai.temperature, maxTokens: oai.max_tokens, topP: oai.top_p,
      reasoningEffort: body.thinking?.effort ?? body.reasoning_effort,
    });
    res._ogDetail = { model, stream: false, usage: result.usage, attempts: result.attempts, effort: result.effort };
    return sendJSON(res, 200, anthropicNonStream({
      id: result.id, model, text: result.text, reasoning: result.reasoning,
      toolCalls: result.toolCalls, finishReason: result.finishReason, usage: result.usage,
    }));
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const msgId = `msg_${randomBytes(12).toString("hex")}`;
  const ev = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    ev("message_start", {
      type: "message_start",
      message: {
        id: msgId, type: "message", role: "assistant", model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

    let blockIndex = -1;
    let thinkingOpen = false;
    let textOpen = false;
    const toolBlocks = new Map();

    const result = await runUpstream({
      cfg, model, messages: oai.messages, tools: oai.tools,
      temperature: oai.temperature, maxTokens: oai.max_tokens, topP: oai.top_p,
      reasoningEffort: body.thinking?.effort ?? body.reasoning_effort,
      onDelta: (d) => {
        if (d.type === "reasoning") {
          if (!thinkingOpen) {
            if (textOpen) { ev("content_block_stop", { type: "content_block_stop", index: blockIndex }); textOpen = false; }
            blockIndex++;
            ev("content_block_start", {
              type: "content_block_start", index: blockIndex,
              content_block: { type: "thinking", thinking: "", signature: "" },
            });
            thinkingOpen = true;
          }
          ev("content_block_delta", {
            type: "content_block_delta", index: blockIndex,
            delta: { type: "thinking_delta", thinking: d.text },
          });
        } else if (d.type === "text") {
          if (!textOpen) {
            if (thinkingOpen) { ev("content_block_stop", { type: "content_block_stop", index: blockIndex }); thinkingOpen = false; }
            blockIndex++;
            ev("content_block_start", {
              type: "content_block_start", index: blockIndex,
              content_block: { type: "text", text: "" },
            });
            textOpen = true;
          }
          ev("content_block_delta", {
            type: "content_block_delta", index: blockIndex,
            delta: { type: "text_delta", text: d.text },
          });
        } else if (d.type === "tool") {
          const key = d.index ?? 0;
          if (!toolBlocks.has(key)) {
            if (thinkingOpen) { ev("content_block_stop", { type: "content_block_stop", index: blockIndex }); thinkingOpen = false; }
            if (textOpen) { ev("content_block_stop", { type: "content_block_stop", index: blockIndex }); textOpen = false; }
            blockIndex++;
            toolBlocks.set(key, blockIndex);
            ev("content_block_start", {
              type: "content_block_start", index: blockIndex,
              content_block: { type: "tool_use", id: d.toolCall.id ?? `toolu_${key}`, name: d.toolCall.function.name ?? "", input: {} },
            });
          }
          const bi = toolBlocks.get(key);
          if (d.toolCall.function?.arguments) {
            ev("content_block_delta", {
              type: "content_block_delta", index: bi,
              delta: { type: "input_json_delta", partial_json: d.toolCall.function.arguments },
            });
          }
        }
      },
    });

    if (thinkingOpen || textOpen) ev("content_block_stop", { type: "content_block_stop", index: blockIndex });
    for (const bi of toolBlocks.values()) ev("content_block_stop", { type: "content_block_stop", index: bi });

    // 全部重试后仍然空 → 明确报错，不要假装成功
    if (blockIndex < 0) {
      ev("error", {
        type: "error",
        error: { type: "upstream_empty", message: "上游连续返回空响应，请重试" },
      });
    }
    res._ogDetail = {
      model, stream: true, usage: result.usage,
      attempts: result.attempts, effort: result.effort,
      error: blockIndex < 0 ? "upstream_empty" : null,
    };

    ev("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    });
    ev("message_stop", { type: "message_stop" });
    res.end();
  } catch (err) {
    console.error("[anthropic/stream]", err?.message ?? err);
    ev("error", { type: "error", error: { type: "upstream_error", message: String(err?.message ?? err) } });
    res.end();
  }
}

// ---------------------------------------------------------------- Responses 端点

/**
 * POST /v1/responses —— OpenAI Responses API
 *
 * 为什么需要它：Codex CLI / ChatGPT Work / 新版 OpenAI SDK 走的是
 * Responses API，不是 chat completions。opencodex 用 openai-chat adapter
 * 转发时，客户端仍会打 /v1/responses，缺这个端点就 404。
 *
 * 实现方式：Responses 请求 → 内部转 chat completions → 跑上游
 *          → 结果包装回 Responses 形状。
 */
async function handleResponses(req, res, cfg, body) {
  const oai = responsesToChat(body);
  const picked = await resolveModelName(cfg, oai.model);
  if (!picked.model) {
    return openAIError(
      res, 404,
      `模型不存在或不可用: ${picked.requested}。可用模型: ${(picked.available ?? []).join(", ")}`,
      "invalid_request_error", "model_not_found",
    );
  }
  const model = picked.model;
  const stream = body.stream === true;

  if (!Array.isArray(oai.messages) || oai.messages.length === 0) {
    return openAIError(res, 400, "input 不能为空");
  }

  // ---- 非流式 ----
  if (!stream) {
    const result = await runUpstream({
      cfg, model, messages: oai.messages, tools: oai.tools,
      temperature: oai.temperature, maxTokens: oai.max_tokens, topP: oai.top_p,
    });
    const empty = !result.text && !result.reasoning && result.toolCalls.length === 0;
    res._ogDetail = {
      model, stream: false, usage: result.usage,
      attempts: result.attempts, effort: result.effort,
      error: empty ? "upstream_empty" : null,
    };
    return sendJSON(res, 200, responsesNonStream({
      id: result.id, model, text: result.text, reasoning: result.reasoning,
      toolCalls: result.toolCalls, usage: result.usage,
      status: empty ? "incomplete" : "completed",
    }));
  }

  // ---- 流式 ----
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const respId = `resp_${randomBytes(12).toString("hex")}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

  const baseResp = {
    id: respId, object: "response", created_at: createdAt,
    status: "in_progress", model, output: [], parallel_tool_calls: true,
    tool_choice: "auto", tools: [], usage: null, error: null,
    incomplete_details: null, instructions: null, metadata: {},
  };

  let seq = 0;
  const nextSeq = () => seq++;

  try {
    ev("response.created", { sequence_number: nextSeq(), response: baseResp });
    ev("response.in_progress", { sequence_number: nextSeq(), response: baseResp });

    // 输出项索引管理：reasoning / message / function_call 各占一个 output_index
    let outIndex = -1;
    let msgItemId = null;
    let reasoningItemId = null;
    let textBuf = "";
    const toolItems = new Map();

    const result = await runUpstream({
      cfg, model, messages: oai.messages, tools: oai.tools,
      temperature: oai.temperature, maxTokens: oai.max_tokens, topP: oai.top_p,
      reasoningEffort: body.thinking?.effort ?? body.reasoning_effort,
      onDelta: (d) => {
        if (d.type === "reasoning") {
          if (!reasoningItemId) {
            outIndex++;
            reasoningItemId = `rs_${randomBytes(8).toString("hex")}`;
            ev("response.output_item.added", {
              sequence_number: nextSeq(), output_index: outIndex,
              item: { type: "reasoning", id: reasoningItemId, summary: [] },
            });
          }
          ev("response.reasoning_summary_text.delta", {
            sequence_number: nextSeq(), item_id: reasoningItemId,
            output_index: outIndex, summary_index: 0, delta: d.text,
          });
        } else if (d.type === "text") {
          if (!msgItemId) {
            outIndex++;
            msgItemId = `msg_${randomBytes(8).toString("hex")}`;
            ev("response.output_item.added", {
              sequence_number: nextSeq(), output_index: outIndex,
              item: { type: "message", id: msgItemId, status: "in_progress", role: "assistant", content: [] },
            });
            ev("response.content_part.added", {
              sequence_number: nextSeq(), item_id: msgItemId, output_index: outIndex,
              content_index: 0, part: { type: "output_text", text: "", annotations: [] },
            });
          }
          textBuf += d.text;
          ev("response.output_text.delta", {
            sequence_number: nextSeq(), item_id: msgItemId, output_index: outIndex,
            content_index: 0, delta: d.text,
          });
        } else if (d.type === "tool") {
          const key = d.index ?? 0;
          if (!toolItems.has(key)) {
            outIndex++;
            const itemId = `fc_${randomBytes(8).toString("hex")}`;
            toolItems.set(key, { itemId, outIndex, name: d.toolCall.function?.name ?? "", args: "" });
            ev("response.output_item.added", {
              sequence_number: nextSeq(), output_index: outIndex,
              item: {
                type: "function_call", id: itemId, call_id: d.toolCall.id ?? itemId,
                name: d.toolCall.function?.name ?? "", arguments: "", status: "in_progress",
              },
            });
          }
          const t = toolItems.get(key);
          if (d.toolCall.function?.arguments) {
            t.args += d.toolCall.function.arguments;
            ev("response.function_call_arguments.delta", {
              sequence_number: nextSeq(), item_id: t.itemId, output_index: t.outIndex,
              delta: d.toolCall.function.arguments,
            });
          }
        }
      },
    });

    // 收尾：把各输出项标成完成
    const finalOutput = [];

    if (reasoningItemId) {
      const item = { type: "reasoning", id: reasoningItemId, summary: [] };
      ev("response.output_item.done", { sequence_number: nextSeq(), output_index: 0, item });
      finalOutput.push(item);
    }
    if (msgItemId) {
      ev("response.output_text.done", {
        sequence_number: nextSeq(), item_id: msgItemId, output_index: outIndex,
        content_index: 0, text: textBuf,
      });
      const part = { type: "output_text", text: textBuf, annotations: [] };
      ev("response.content_part.done", {
        sequence_number: nextSeq(), item_id: msgItemId, output_index: outIndex,
        content_index: 0, part,
      });
      const item = { type: "message", id: msgItemId, status: "completed", role: "assistant", content: [part] };
      ev("response.output_item.done", { sequence_number: nextSeq(), output_index: outIndex, item });
      finalOutput.push(item);
    }
    for (const [, t] of toolItems) {
      const item = {
        type: "function_call", id: t.itemId, call_id: t.itemId,
        name: t.name, arguments: t.args, status: "completed",
      };
      ev("response.output_item.done", { sequence_number: nextSeq(), output_index: t.outIndex, item });
      finalOutput.push(item);
    }

    const empty = finalOutput.length === 0;
    if (empty) {
      ev("error", { sequence_number: nextSeq(), code: "upstream_empty", message: "上游连续返回空响应，请重试", param: null });
    }
    res._ogDetail = {
      model, stream: true, usage: result.usage,
      attempts: result.attempts, effort: result.effort,
      error: empty ? "upstream_empty" : null,
    };

    ev("response.completed", {
      sequence_number: nextSeq(),
      response: { ...baseResp, status: empty ? "incomplete" : "completed", output: finalOutput },
    });
    res.end();
  } catch (err) {
    console.error("[responses/stream]", err?.message ?? err);
    ev("error", { sequence_number: nextSeq(), code: "upstream_error", message: String(err?.message ?? err), param: null });
    res.end();
  }
}

// ---------------------------------------------------------------- 主服务

const cfg = await loadConfig();

/**
 * 插件句柄。
 *
 * 委托模式（`upstream: "delegate"`）**完全不需要** @opencode2dsh 插件的 lib/：
 * 模型清单、思考档位、请求组装全部走真实 opencode。
 * 而那个插件只存在于 DSH 的 profile 目录里，外部用户根本没有 ——
 * 原来这里无条件 `await loadPlugin()`，会让任何非 DSH 环境在启动时直接崩掉。
 *
 * 所以改成惰性：委托模式下返回一个不含插件信息的占位对象，
 * 只有真的要走直连通道时才去解析插件目录（那时缺插件才是真错误）。
 */
const plugin = cfg.upstream === "delegate"
  ? { libDir: "(委托模式，未加载插件)", ZEN_BASE_URL: "https://opencode.ai/zen", opencodeUserAgent: () => "opencode/1.18.31" }
  : await loadPlugin();

// 可用性探测器：定期实调，把"在售但调不通"的模型剔出列表。
// 委托模式下关闭 —— catalog 本身就是权威清单，而直连探测过不了凭据门禁，
// 会把真正可用的模型全部误标为 gated（实测踩过这个坑）。
probe = new AvailabilityProbe({
  probeOne,
  enabled: cfg.upstream === "delegate" ? false : cfg.probe?.enabled !== false,
  intervalMs: cfg.probe?.intervalSeconds ? cfg.probe.intervalSeconds * 1000 : 3600_000,
  concurrency: cfg.probe?.concurrency ?? 2,
  missThreshold: cfg.probe?.missThreshold ?? 3,
});
await probe.load();

// 可观测性 + 并发闸门
metrics = new Metrics({
  logCapacity: cfg.observability?.logCapacity ?? 500,
  latencyWindow: cfg.observability?.latencyWindow ?? 500,
});
gate = new Gate({
  globalMax: cfg.limits?.globalConcurrency ?? 8,
  perModelMax: cfg.limits?.perModelConcurrency ?? 2,
  maxQueue: cfg.limits?.maxQueue ?? 8,
  maxWaitMs: cfg.limits?.maxWaitMs ?? 30_000,
});

console.log("OpenGate 启动中…");
console.log("  插件 lib :", plugin.libDir);
console.log("  UA       :", plugin.opencodeUserAgent());
console.log("  上游     :", plugin.ZEN_BASE_URL);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  // 可观测性：记录每个请求的耗时/状态/用量
  const reqStart = metrics.begin();
  const reqId = "req_" + randomBytes(6).toString("hex");
  const clientIp = (req.headers["x-forwarded-for"]?.split(",")[0] ?? req.socket?.remoteAddress ?? "").trim();
  let recorded = false;
  const finish = (extra = {}) => {
    if (recorded) return;
    recorded = true;
    metrics.end();
    // 端点处理器把细节挂在 res._ogDetail 上（model/usage/attempts/effort）
    metrics.record({
      id: reqId, endpoint: path, status: res.statusCode,
      durationMs: Date.now() - reqStart, clientIp,
      ...(res._ogDetail ?? {}),
      ...extra,
    });
  };
  res.on("finish", () => finish());
  res.on("close", () => finish());

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    });
    return res.end();
  }

  // 免鉴权：健康检查、指标、统计（本机运维用）
  if (path === "/healthz") {
    const p = plugin;
    let snap = {};
    if (cfg.upstream === "delegate") {
      try {
        const known = await delegateCatalog(cfg);
        snap = { total: known.length, exposed: known.filter((m) => m.available !== false).length };
      } catch {}
    } else {
      try { snap = (await getCatalog(cfg)).snapshot(); } catch {}
    }
    return sendJSON(res, 200, {
      status: "ok",
      version: VERSION,
      uptimeSeconds: metrics.snapshot().uptimeSeconds,
      upstream: cfg.upstream === "delegate" ? "delegate:opencode-serve" : p.ZEN_BASE_URL,
      pluginLib: p.libDir,
      catalog: snap,
      models: (await listModels(cfg)).length,
      availability: probe?.snapshot() ?? { enabled: false },
      limits: gate?.snapshot() ?? null,
    });
  }

  if (path === "/metrics") {
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
    return res.end(metrics.prometheus());
  }

  // 状态面板（免鉴权；只监听本机时无风险）
  if ((path === "/" || path === "/dashboard") && req.method === "GET") {
    const p = plugin;
    const ids = await listModels(cfg);
    const capsArr = await cachedEffortsBatch(ids, cfg);
    const caps = {};
    ids.forEach((id, i) => { caps[id] = capsArr[i]; });
    const html = renderDashboard({
      stats: metrics.snapshot(),
      models: ids,
      caps,
      availability: probe?.snapshot() ?? { enabled: false },
      limits: gate?.snapshot() ?? null,
      logs: metrics.queryLogs({ limit: 50 }),
      version: VERSION,
      cfg: { listen: cfg.listen, upstream: p.ZEN_BASE_URL },
    });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  if (path === "/v1/stats" && req.method === "GET") {
    return sendJSON(res, 200, {
      ...metrics.snapshot(),
      limits: gate?.snapshot() ?? null,
      availability: probe?.snapshot() ?? { enabled: false },
    });
  }

  if (path === "/v1/logs" && req.method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
    const model = url.searchParams.get("model");
    const failedOnly = url.searchParams.get("failed") === "1";
    const logs = metrics.queryLogs({ limit, model, failedOnly });
    return sendJSON(res, 200, { object: "list", count: logs.length, data: logs });
  }

  if (!isAuthorized(req, cfg)) {
    const isAnthropic = path.startsWith("/v1/messages");
    return isAnthropic
      ? anthropicError(res, 401, "无效的 API Key", "authentication_error")
      : openAIError(res, 401, "无效的 API Key", "authentication_error");
  }

  if (path === "/v1/models" && req.method === "GET") {
    const ids = await listModels(cfg);
    // 并发取能力（原来是 for+await 串行，7 个模型要等 7 次）
    const caps = await cachedEffortsBatch(ids, cfg);
    const data = ids.map((id, i) => ({
      id, object: "model", created: 0, owned_by: "opencode-zen",
      // 非标准字段，但 OpenAI/Anthropic 客户端都会忽略多余字段
      reasoning: caps[i].reasoning,
      reasoning_efforts: caps[i].efforts,
    }));
    return sendJSON(res, 200, { object: "list", data });
  }

  // 纯能力查询（便于客户端做下拉框）—— 必须排在单模型路由之前
  if (path === "/v1/models/capabilities" && req.method === "GET") {
    const ids = await listModels(cfg);
    const caps = await cachedEffortsBatch(ids, cfg);
    const out = {};
    ids.forEach((id, i) => { out[id] = caps[i]; });
    return sendJSON(res, 200, { object: "list", data: out });
  }

  // 单模型查询（OpenAI 标准端点）
  const modelMatch = path.match(/^\/v1\/models\/([^/]+)$/);
  if (modelMatch && req.method === "GET") {
    const id = decodeURIComponent(modelMatch[1]);
    const ids = await listModels(cfg);
    if (!ids.includes(id)) return openAIError(res, 404, `模型不存在或不可用: ${id}`, "invalid_request_error", "model_not_found");
    const cap = await cachedEfforts(id, cfg);
    return sendJSON(res, 200, {
      id, object: "model", created: 0, owned_by: "opencode-zen",
      reasoning: cap.reasoning, reasoning_efforts: cap.efforts,
    });
  }

  // 手动触发一轮可用性探测（耗时较长，返回当前已知状态）
  if (path === "/v1/availability" && req.method === "GET") {
    return sendJSON(res, 200, probe?.snapshot() ?? { enabled: false });
  }
  if (path === "/v1/availability/probe" && req.method === "POST") {
    if (!probe?.enabled) return openAIError(res, 400, "可用性探测已在 config.json 中禁用");
    if (probe.running) return sendJSON(res, 202, { started: false, reason: "已有一轮探测在进行", state: probe.snapshot() });
    const candidates = await probeCandidates();
    probe.runOnce(candidates).catch((e) => console.error("[probe] 手动失败:", e?.message ?? e));
    return sendJSON(res, 202, { started: true, candidates: candidates.length });
  }

  if (path === "/v1/chat/completions" && req.method === "POST") {
    let body;
    try { body = await readBody(req); }
    catch (e) { return openAIError(res, 400, `请求体解析失败: ${e.message}`); }
    try {
      await handleOpenAI(req, res, cfg, body);
    } catch (err) {
      console.error("[/v1/chat/completions]", err);
      if (!res.headersSent) openAIError(res, err?.status ?? 502, String(err?.message ?? err), err?.code === "QUEUE_FULL" ? "rate_limit_error" : "upstream_error");
      else res.end();
    }
    return;
  }

  if (path === "/v1/messages" && req.method === "POST") {
    let body;
    try { body = await readBody(req); }
    catch (e) { return anthropicError(res, 400, `请求体解析失败: ${e.message}`); }
    try {
      await handleAnthropic(req, res, cfg, body);
    } catch (err) {
      console.error("[/v1/messages]", err);
      if (!res.headersSent) anthropicError(res, err?.status ?? 502, String(err?.message ?? err), err?.code === "QUEUE_FULL" ? "rate_limit_error" : "api_error");
      else res.end();
    }
    return;
  }

  if (path === "/v1/responses" && req.method === "POST") {
    let body;
    try { body = await readBody(req); }
    catch (e) { return openAIError(res, 400, `请求体解析失败: ${e.message}`); }
    try {
      await handleResponses(req, res, cfg, body);
    } catch (err) {
      console.error("[/v1/responses]", err);
      if (!res.headersSent) openAIError(res, err?.status ?? 502, String(err?.message ?? err), err?.code === "QUEUE_FULL" ? "rate_limit_error" : "upstream_error");
      else res.end();
    }
    return;
  }

  openAIError(res, 404, `未知路径: ${path}`);
});

const [host, portStr] = cfg.listen.split(":");
server.listen(Number(portStr), host, () => {
  console.log(`\n  ✅ 网关已就绪  http://${cfg.listen}`);
  console.log(`     OpenAI Chat : POST http://${cfg.listen}/v1/chat/completions`);
  console.log(`     OpenAI Resp : POST http://${cfg.listen}/v1/responses`);
  console.log(`     Anthropic   : POST http://${cfg.listen}/v1/messages`);
  console.log(`     模型列表    : GET  http://${cfg.listen}/v1/models`);
  console.log(`     健康检查    : GET  http://${cfg.listen}/healthz`);
  console.log(`     运行统计    : GET  http://${cfg.listen}/v1/stats`);
  console.log(`     请求日志    : GET  http://${cfg.listen}/v1/logs`);
  console.log(`     指标导出    : GET  http://${cfg.listen}/metrics`);
  console.log(`\n     API Key   : ${cfg.apiKey}`);
  console.log(`     默认模型  : ${cfg.defaultModel}`);
  console.log(`     并发上限  : ${gate.global.max} 全局 / ${gate.perModel.maxPerKey} 每模型`);
  console.log(`     可用性探测: ${probe.enabled ? `开启（每 ${(probe.intervalMs / 1000 / 60).toFixed(0)} 分钟）` : "关闭"}\n`);

  // 服务器起来后再启动探测，避免启动阶段抢带宽
  probe.start(probeCandidates);

  // 预热 catalog：否则在元数据就绪前，/v1/models 会短暂地不暴露思考强度档位。
  // 用 warm() 而不是等第一次请求 —— 那会把等待转嫁给第一个客户端。
  // 委托模式走真实 opencode 的 catalog，完全不碰插件（外部用户没有那个插件）。
  (cfg.upstream === "delegate"
    ? delegateCatalog(cfg).then((known) => {
        console.log(`[catalog] 委托模式已就绪: ${known.length} 个模型`);
        capCache.clear();
      })
    : getCatalog(cfg).then(async (c) => {
        if (typeof c.warm === "function") await c.warm();
        // 元数据就绪后丢掉启动期算出的空能力，避免客户端还看到旧结果
        capCache.clear();
        let snap = {};
        try { snap = c.snapshot() ?? {}; } catch {}
        console.log(`[catalog] 已就绪: ${JSON.stringify(snap)}`);
      })
  ).catch((e) => console.error("[catalog] 预热失败:", e?.message ?? e));

  // 周期刷新模型清单：上游会上新/下架模型（实测 mimo 上线后旧列表里没有）。
  // 委托模式拉 opencode 的 catalog；直连模式由插件的 catalog 自带周期刷新。
  // refreshSeconds <=0 关闭。刷新成功后清能力缓存，让 /v1/models 立即反映新档位。
  if (cfg.upstream === "delegate") {
    const refreshMs = Math.max(0, Number(cfg.refreshSeconds ?? 300)) * 1000;
    if (refreshMs > 0) {
      let refreshing = false;
      let lastIds = null;
      const timer = setInterval(() => {
        if (refreshing || shuttingDown) return;
        refreshing = true;
        delegateCatalog(cfg, { forceRefresh: true })
          .then(async (known) => {
            capCache.clear();
            // 只在清单真的变化时才刷日志（防刷屏），变化明细直接可见
            const ids = known.map((m) => m.id).sort().join(",");
            if (lastIds === null) {
              console.log(`[catalog] 周期刷新基线: ${known.length} 个模型`);
            } else if (ids !== lastIds) {
              const prev = new Set(lastIds.split(","));
              const cur = new Set(ids.split(","));
              const added = [...cur].filter((x) => !prev.has(x));
              const removed = [...prev].filter((x) => !cur.has(x));
              console.log(`[catalog] 模型清单变化: +${added.length ? added.join(",") : "无"}  -${removed.length ? removed.join(",") : "无"}  （现共 ${known.length} 个）`);
            } else {
              console.log(`[catalog] 周期刷新: 无变化 (${known.length} 个)`);
            }
            lastIds = ids;
          })
          .catch((e) => console.error("[catalog] 周期刷新失败:", e?.message ?? e))
          .finally(() => { refreshing = false; });
      }, refreshMs);
      timer.unref?.();
    }
  }
});

// 优雅关闭：先停止接受新连接，等在途请求跑完（最多 10 秒）
let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const active = metrics.snapshot().active;
    console.log(`\n收到 ${sig}，正在关闭…${active > 0 ? `（等待 ${active} 个在途请求）` : ""}`);
    probe.stop();
    // 关掉委托的 opencode 子进程，否则 orphan 会一直占内存
    delegateRt?.stop().catch(() => {});
    server.close(() => process.exit(0));
    // 兜底：10 秒还没跑完就强退
    setTimeout(() => {
      console.log("  等待超时，强制退出");
      process.exit(0);
    }, 10_000).unref();
  });
}
