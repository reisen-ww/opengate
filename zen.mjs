/**
 * zen.mjs — 上游适配层
 *
 * 核心原则：**不抄算法，直接 import opencode2dsh 插件的 lib/**。
 * 上游的 "免费通道" 门禁历史上变过至少 4 次（2026-09-16 UA 门、09-18 补 body 门、
 * 10-09 补 session 门、10-13 补时间戳门）。任何抄一份的实现都会在下次变更时腐烂。
 * 这里只做两件事：
 *   1. 定位并加载插件 lib 的 catalog / messages chunk（导出名被 minify 成单字母）
 *   2. 把它们的输出拼成一次合法的上游请求
 *
 * 由此得到的性质：`dsh plugin update @opencode2dsh/dsh-plugin` + 重启网关，
 * 门禁变更自动跟上，网关代码零改动。
 */
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

/** 默认插件位置：DSH desktop profile 的 node_modules。可用 OC2DSH_LIB 覆盖。 */
const DEFAULT_LIB_CANDIDATES = [
  process.env.OC2DSH_LIB,
  join(homedir(), ".dsh/profiles/desktop/node_modules/@opencode2dsh/dsh-plugin/lib"),
  join(homedir(), ".dsh/profiles/web/node_modules/@opencode2dsh/dsh-plugin/lib"),
].filter(Boolean);

async function resolveLibDir() {
  for (const dir of DEFAULT_LIB_CANDIDATES) {
    if (!existsSync(dir)) continue;
    const files = await readdir(dir);
    if (files.some((f) => f.startsWith("catalog-")) && files.some((f) => f.startsWith("messages-"))) {
      return dir;
    }
  }
  throw new Error(
    "找不到 opencode2dsh 插件 lib/。请确认已安装该插件，或设置环境变量 OC2DSH_LIB 指向其 lib 目录。\n" +
      "候选路径：\n" + DEFAULT_LIB_CANDIDATES.map((c) => "  " + c).join("\n")
  );
}

/**
 * 加载插件 chunk。
 *
 * 为什么按前缀找而不是写死文件名：lib/ 里带着构建 hash（catalog-DdufXPqf.js），
 * 插件升级后 hash 会变，写死就会碎。
 *
 * 为什么用单字母导出名：插件用 tsdown 打包并 minify，chunk 的 export 语句是
 * `export { ... deriveRequestIDs as d, disguiseHeaders as f, ... }`。
 * 这里刻意保留字母 + 注释映射，暴露真实语义名，避免调用点到处是单字母。
 */
let _mod = null;
export async function loadPlugin() {
  if (_mod) return _mod;
  const lib = await resolveLibDir();
  const files = await readdir(lib);
  const pick = (prefix) => {
    const f = files.find((x) => x.startsWith(prefix) && x.endsWith(".js"));
    if (!f) throw new Error(`插件 lib 缺少 ${prefix}* chunk（目录：${lib}）`);
    return join(lib, f);
  };

  const cat = await import(pathToFileURL(pick("catalog-")).href);
  const msg = await import(pathToFileURL(pick("messages-")).href);

  _mod = {
    libDir: lib,
    // --- catalog-* 导出映射（见该 chunk 末尾 export 语句）---
    canonicalSessionID: cat.u, // 生成合规 ses_ id（倒置时间戳）
    disguiseHeaders: cat.f, // 伪装头全集
    opencodeUserAgent: cat.p, // CLI 同形 UA
    ZEN_BASE_URL: cat.r, // https://opencode.ai/zen
    FREE_LANE_BLOCKLIST: cat.t, // 免费通道黑名单（上游侧永久不可用）
    randomID: cat.m,
    stableID: cat.h,
    isFreeModel: cat.c,
    decodeModelsDev: cat.a,
    fetchZenModels: cat.s,
    ModelCatalog: cat.n,
    defaultCachePath: cat.o,
    // --- messages-* 导出映射 ---
    ensureFreeLaneShape: msg.r, // 补 bash/read 工具，满足 agent-shape 门
    isResponsesModel: msg.c, // muse-spark-* 走 /v1/responses
    apiForModel: msg.s,
  };
  return _mod;
}

/** 模型目录：带磁盘缓存的免费模型列表，供 /v1/models 使用。 */
let _catalog = null;
export async function getCatalog(cfg) {
  if (_catalog) return _catalog;
  const p = await loadPlugin();
  const cachePath = join(homedir(), ".opencode-gate", "catalog-cache.json");
  await mkdir(dirname(cachePath), { recursive: true });
  _catalog = new p.ModelCatalog({
    refreshSeconds: cfg.refreshSeconds ?? 300,
    cachePath,
  });
  // start() 内部会做首轮刷新 + 空目录快速重试，然后转周期刷新。
  _catalog.start().catch((err) => {
    console.error("[catalog] 刷新失败（将沿用缓存）:", err?.message ?? err);
  });
  return _catalog;
}

/**
 * 上游 `reasoning_effort` 的合法取值（插件 index.js:280-293 实测校准）。
 * 传其它值上游直接 400；`none` 是唯一能阻止"永远思考"的拼写；
 * **字段省略 = 保持 provider 默认（也就是继续思考）**。
 */
export const EFFORT_WIRE_VALUES = ["minimal", "low", "medium", "high", "xhigh", "max", "none"];

/** 插件的默认阶梯：模型元数据没声明 effortValues 时用这套。 */
export const DEFAULT_EFFORT_LADDER = ["off", "minimal", "low", "medium", "high"];

/**
 * 查一个模型**实际支持**的思考强度。
 *
 * 返回 { reasoning: bool, efforts: string[] }，efforts 是归一化后的 id 列表
 * （含 `off`）。这是"暴露明白"的关键 —— 客户端据此才知道 2.6f 不能开 max。
 *
 * 规则复刻插件 reasoningEfforts()：
 *  - 非推理模型 → reasoning:false，不暴露任何档位
 *  - 声明了 effortValues → 用声明的（这才是上游认可的拼写）
 *  - 没声明 → 用默认阶梯（不含 xhigh/max）
 */
export async function modelEfforts(model) {
  const p = await loadPlugin();
  const catalog = await getCatalog({});
  let cap = null;
  try { cap = catalog.reasoningCapability(model); } catch { cap = null; }

  if (!cap?.reasoning) return { reasoning: false, efforts: [] };

  const declared = [];
  for (const v of cap.effortValues ?? []) {
    const level = v === "none" ? "off" : v;
    if (!declared.includes(level)) declared.push(level);
  }
  const efforts = declared.length > 0 ? declared : [...DEFAULT_EFFORT_LADDER];

  // 排序对齐插件阶梯，保证客户端展示顺序稳定
  const order = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  efforts.sort((a, b) => order.indexOf(a) - order.indexOf(b));

  return { reasoning: true, efforts };
}

/**
 * 把客户端给的思考强度**裁剪**到模型真正支持的档位。
 *
 * 这是"2.6f 开 max 空转"的根因修复：客户端不知道模型能力，
 * 传了 max 上去，上游要么 400 要么空转。这里就近降级到最强的合法档位。
 *
 * 返回 { wire, requested, applied, downgraded }：
 *  - wire: 实际发给上游的 reasoning_effort 值（undefined = 不传该字段）
 *  - downgraded: 是否发生了降级（要告知客户端）
 */
export async function resolveEffort(model, requested) {
  const { reasoning, efforts } = await modelEfforts(model);

  // 非推理模型：不传 effort（传了反而可能 400）
  if (!reasoning) {
    return { wire: undefined, requested, applied: undefined, downgraded: false, supported: [] };
  }

  // 客户端没指定：不传，保持上游默认
  if (requested === undefined || requested === null || requested === "") {
    return { wire: undefined, requested, applied: undefined, downgraded: false, supported: efforts };
  }

  let id = String(requested).toLowerCase().trim();
  // 常见别名归一
  if (id === "none" || id === "off" || id === "disabled") id = "off";
  if (id === "min" || id === "minimum") id = "minimal";
  if (id === "med" || id === "middle") id = "medium";

  // 完全支持 → 原样（off 要转成 wire 的 none）
  if (efforts.includes(id)) {
    return {
      wire: id === "off" ? "none" : id,
      requested, applied: id, downgraded: false, supported: efforts,
    };
  }

  // 不支持 → 就近降级到不超过请求强度的最强合法档位
  const order = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const wantIdx = order.indexOf(id);
  const supported = efforts.filter((e) => order.indexOf(e) >= 0);

  let pick;
  if (wantIdx < 0) {
    // 无法识别的值：用支持里最强的（保守：宁可强也别弱）
    pick = supported[supported.length - 1] ?? "off";
  } else {
    // 取 ≤ 请求强度的最大者；若没有（请求比最低档还低）则取最低档
    const le = supported.filter((e) => order.indexOf(e) <= wantIdx);
    pick = le.length > 0 ? le[le.length - 1] : (supported[0] ?? "off");
  }

  return {
    wire: pick === "off" ? "none" : pick,
    requested, applied: pick, downgraded: true, supported: efforts,
  };
}

/**
 * 组装一次上游请求。
 *
 * 三道门（全部实测确认，缺一即 403 FreeTierError）：
 *  1. session header 必须是 `ses_` + 倒置时间戳12hex + base62 14位
 *  2. body 必须 `stream: true`
 *  3. body 必须带 `bash` + `read` 两个工具（由 ensureFreeLaneShape 补齐）
 */
export async function buildUpstreamRequest({ model, messages, tools, temperature, maxTokens, topP, conversationSeed, reasoningEffort }) {
  const p = await loadPlugin();

  // 用会话种子派生稳定 session（同一会话的后续轮次复用同一 id，保住上游缓存）
  const seed = conversationSeed || JSON.stringify(messages?.[0]?.content ?? model);
  const session = p.canonicalSessionID(seed);

  const body = {
    model,
    stream: true, // 门 2：上游硬要求，非流式一律 403
    messages,
  };
  if (typeof temperature === "number") body.temperature = temperature;
  if (typeof topP === "number") body.top_p = topP;
  if (typeof maxTokens === "number") body.max_tokens = maxTokens;
  if (Array.isArray(tools) && tools.length > 0) body.tools = tools;

  // 思考强度：先裁剪到模型真实支持的档位，再写 wire 字段。
  // 注意：不传该字段 == 保持上游默认（继续思考），这与传 "none" 是两回事。
  if (reasoningEffort !== undefined && reasoningEffort !== null && reasoningEffort !== "") {
    const r = await resolveEffort(model, reasoningEffort);
    if (r.wire !== undefined) body.reasoning_effort = r.wire;
  }

  // 门 3：补齐 agent-shape 工具。无 tools 时会附带 tool_choice:none，
  // 防止模型真的去调用这两个占位工具。
  const patched = p.ensureFreeLaneShape(body) ?? body;
  patched.stream = true;

  const headers = {
    ...p.disguiseHeaders({
      session,
      request: p.randomID("req", 16),
      project: p.stableID("prj", "opencode2dsh:default-project"),
      parentSession: "",
    }),
    authorization: "Bearer public",
    "content-type": "application/json",
    accept: "text/event-stream",
  };

  const responsesApi = p.isResponsesModel(model);
  const url = responsesApi
    ? `${p.ZEN_BASE_URL}/v1/responses`
    : `${p.ZEN_BASE_URL}/v1/chat/completions`;

  return { url, headers, body: patched, session, responsesApi };
}

/**
 * 发起上游请求并返回原始 Response（流式）。
 * 带重试：上游匿名池是共享资源，429 / "Endpoint is unavailable" 很常见。
 */
export async function fetchUpstream(req, retryCfg = {}) {
  const maxAttempts = retryCfg.maxAttempts ?? 4;
  const baseDelay = retryCfg.baseDelayMs ?? 800;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(req.body),
      });

      // 成功：交给调用方处理流
      if (res.ok) return res;

      const text = await res.text();
      lastErr = new Error(`上游 HTTP ${res.status}: ${text.slice(0, 400)}`);

      // 明确不可重试的：请求本身有问题
      if (res.status === 400 || res.status === 401 || res.status === 404) {
        lastErr.retryable = false;
        throw lastErr;
      }
      // 403 FreeTierError 说明门禁算法变了 —— 重试无用，必须升级插件
      if (res.status === 403 && /FreeTierError|free tier/i.test(text)) {
        lastErr.retryable = false;
        lastErr.freeTierGate = true;
        throw lastErr;
      }
      // 429 / 403 Endpoint unavailable / 5xx → 退避重试
      if (attempt < maxAttempts) {
        const delay = baseDelay * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
        console.error(`[upstream] 第 ${attempt} 次失败（${res.status}），${delay}ms 后重试`);
        await new Promise((r) => setTimeout(r, delay));
        // 每次重试换一个新 request id（session 保持不变以保住缓存）
        req.headers["x-opencode-request"] = req.headers["x-opencode-request"].replace(/[0-9a-f]{32}$/, () =>
          Array.from({ length: 16 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("")
        );
        continue;
      }
      throw lastErr;
    } catch (err) {
      if (err.retryable === false) throw err;
      lastErr = err;
      if (attempt < maxAttempts) {
        const delay = baseDelay * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error("上游请求失败");
}

/** SSE 行解析器：把上游字节流切成 data: 事件的 JSON 对象。 */
export async function* iterateSSE(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          yield JSON.parse(payload);
        } catch {
          /* 忽略无法解析的注释/心跳行 */
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

export function seedOf(messages) {
  for (const m of messages ?? []) {
    if (m?.role !== "user") continue;
    const enc = JSON.stringify(m.content ?? null);
    if (enc && enc !== "null") return enc;
  }
  return "";
}

export function hashKey(...parts) {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}
