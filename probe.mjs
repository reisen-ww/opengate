/**
 * probe.mjs — 模型可用性探测
 *
 * 背景：上游 /v1/models 返回的是"在售列表"，不等于"能调通"。
 * 实测 cat-jam-free 长期在售但返回 403 Endpoint unavailable。
 * 本模块定期实调一次，只有真出字的模型才进入 /v1/models。
 *
 * 成本声明：每次探测都是一次真实上游请求，会消耗免费额度。
 * 因此：
 *   - 只探测候选集（上游在售的 free 模型 ∩ 不在 blocklist）
 *   - 间隔可配，默认 1 小时
 *   - 探测内容极短（单字提示）
 *   - 结果落盘，重启后沿用，避免每次启动都全量轰炸
 *
 * 判定规则（实测校准，见 classify）：
 *   200 + 真出字                        → alive
 *   403/404/401                         → dead（含 cat-jam-free 的 403 Endpoint unavailable）
 *   400 + ModelProtocolUnsupported 等   → dead
 *   429 / 5xx / 超时 / 网络异常          → inconclusive（限流不代表模型坏了）
 *   403 + FreeTierError                 → gated（上游整体关闸，全局事件）
 *
 * 三重防误杀：
 *   1. 判 dead 前复查一次，两次不一致就降级为 inconclusive
 *   2. inconclusive 不改变已有状态
 *   3. 连续 missThreshold 轮都 inconclusive 才隐藏（不是判死），避免"一直挂着不可用的模型"
 *
 * 血的教训（2026-10-15）：上游关闭免费层后，7 个模型同时返回 403 FreeTierError。
 * 当时把 FreeTierError 归入 inconclusive 并累计 miss，3 轮后 `filter()` 把**整个列表清空** ——
 * 网关对外变成"零模型"，而且看起来像是我方故障。
 * 根因是把**全局门禁**当成了**单模型故障**。现在单列 gated 状态：保留在列表、不计 miss、
 * 不隐藏；上游一旦恢复，下一轮自动回到 alive。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const STATE_DIR = join(homedir(), ".opencode-gate");
const STATE_PATH = join(STATE_DIR, "availability.json");

/** 从上游错误体里抽出最有信息量的短标签。
 *
 *  上游形如 {"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}
 *  内层 type 常是笼统的 "server_error"，真正的原因是 message 里的
 *  "Endpoint is unavailable" / "Model is unavailable" 等。
 *  所以顺序是：**message 里的特征词 → 内层 type → HTTP 码**。 */
export function shortReason(status, bodyText) {
  const t = String(bodyText ?? "");
  // 1) message 里的具体原因（最有信息量）
  for (const kw of [
    "Endpoint is unavailable", "Model is unavailable", "not available in your country",
    "ModelProtocolUnsupported", "ModelDeprecated", "free tier can only be used",
    "rate limit", "rate_limit", "temporarily",
  ]) {
    if (t.includes(kw)) return kw.slice(0, 48);
  }
  // 2) 内层 error.type（如 RegionError / FreeTierError）
  const inner = t.match(/"error"\s*:\s*\{[^}]*?"type"\s*:\s*"([^"]+)"/);
  if (inner && inner[1] !== "server_error") return inner[1].slice(0, 48);
  // 3) 退化为 HTTP 码
  return `HTTP ${status}`;
}

/** 判断上游响应属于"存活 / 已死 / 说不准"。
 *
 *  关键教训（实测）：
 *    cat-jam-free        → 403 "Endpoint is unavailable"
 *    ling-3.1-flash-free → 429 "Endpoint is unavailable"
 *  同样的文案，状态码不同，含义完全不同。**状态码比文案权威**，
 *  所以先用状态码分流，文案只用于覆盖少数例外。 */
function classify(status, bodyText) {
  if (status === 200) return "alive";
  const t = String(bodyText ?? "");

  // 例外 1：门禁（FreeTierError / "free tier can only be used"）。
  // 这是**全局性**事件：上游一改策略，所有模型会同时返回它。
  // 曾经把它当 inconclusive 并累计 miss，结果 3 轮后把整个模型列表清空 ——
  // 一次上游改动导致网关"零模型"。现在单列为 gated：保留在列表，不计 miss。
  if (/FreeTierError/i.test(t) || /free tier can only be used/i.test(t)) return "gated";

  // 例外 2：限流。共享池被占满不代表模型坏了。
  if (status === 429 || /rate.?limit/i.test(t)) return "inconclusive";

  // 例外 3：网络/上游抖动，判断不了。
  if (status === 0 || status >= 500) return "inconclusive";

  // 明确的拒绝：这个模型对我不可用。
  if (status === 401 || status === 403 || status === 404) return "dead";

  if (status === 400) {
    // 400 但文案说"暂时"，可能是抖动
    if (/temporarily|try again/i.test(t)) return "inconclusive";
    return "dead";
  }
  return "inconclusive";
}

export class AvailabilityProbe {
  /**
   * @param {object} opts
   * @param {function} opts.probeOne  async (modelId) => { status, bodyText }
   * @param {number}  [opts.intervalMs]  探测周期，默认 1 小时
   * @param {number}  [opts.concurrency] 并发数，默认 2（别打太猛）
   * @param {boolean} [opts.enabled]
   */
  constructor(opts) {
    this.probeOne = opts.probeOne;
    this.intervalMs = opts.intervalMs ?? 3600_000;
    this.concurrency = opts.concurrency ?? 2;
    this.enabled = opts.enabled !== false;
    /** 连续 inconclusive 多少轮后从列表隐藏。默认 3 轮（约 3 小时）。 */
    this.missThreshold = opts.missThreshold ?? 3;
    /** @type {Map<string, {state:"alive"|"dead"|"inconclusive", at:number, note:string, misses?:number}>} */
    this.state = new Map();
    this.lastRun = 0;
    this.running = false;
    this.timer = null;
    this.onUpdate = opts.onUpdate;
  }

  async load() {
    try {
      if (!existsSync(STATE_PATH)) return;
      const raw = JSON.parse(await readFile(STATE_PATH, "utf8"));
      for (const [id, v] of Object.entries(raw.models ?? {})) this.state.set(id, v);
      this.lastRun = raw.lastRun ?? 0;
    } catch (e) {
      console.error("[probe] 读取状态失败（忽略）:", e?.message ?? e);
    }
  }

  async save() {
    try {
      await mkdir(dirname(STATE_PATH), { recursive: true });
      await writeFile(STATE_PATH, JSON.stringify({
        lastRun: this.lastRun,
        models: Object.fromEntries(this.state),
      }, null, 2), "utf8");
    } catch (e) {
      console.error("[probe] 写入状态失败:", e?.message ?? e);
    }
  }

  /** 过滤：只保留"确认可用"和"还没结论"的模型。
   *
   *  - 没探测过      → 放行（首次启动不至于空白，探测后修正）
   *  - alive         → 放行
   *  - dead          → 剔除
   *  - gated         → **放行**（上游整体关闸是全局事件，不该据此清空列表）
   *  - inconclusive 且连续 misses < 阈值 → 放行（可能只是限流，别误杀）
   *  - inconclusive 且连续 misses ≥ 阈值 → 剔除（长期打不通，不该继续挂着）
   */
  filter(ids) {
    if (!this.enabled) return ids;
    const threshold = this.missThreshold;
    return ids.filter((id) => {
      const s = this.state.get(id);
      if (!s) return true;
      if (s.state === "alive") return true;
      if (s.state === "dead") return false;
      if (s.state === "gated") return true;
      return (s.misses ?? 0) < threshold;
    });
  }

  statusOf(id) {
    return this.state.get(id) ?? null;
  }

  /** 跑一轮探测 */
  async runOnce(candidates) {
    if (!this.enabled || this.running) return;
    this.running = true;
    const t0 = Date.now();
    console.log(`[probe] 开始探测 ${candidates.length} 个候选模型（并发 ${this.concurrency}）`);

    const queue = [...candidates];
    const results = [];
    const worker = async () => {
      while (queue.length > 0) {
        const id = queue.shift();
        if (!id) break;
        const prev = this.state.get(id);
        try {
          let { status, bodyText } = await this.probeOne(id);
          let verdict = classify(status, bodyText);

          // 判定 dead 时复查一次：共享池限流/抖动会造成假死，误杀代价比多打一个请求高
          if (verdict === "dead") {
            await new Promise((r) => setTimeout(r, 1500));
            const second = await this.probeOne(id);
            const v2 = classify(second.status, second.bodyText);
            if (v2 !== "dead") {
              // 两次结论不一致 → 视为不确定，保留原状态
              verdict = "inconclusive";
              status = second.status;
              bodyText = second.bodyText;
            }
          }

          if (verdict === "alive") {
            const changed = prev?.state !== "alive";
            this.state.set(id, { state: "alive", at: Date.now(), note: `HTTP ${status}`, misses: 0 });
            results.push(`✅ ${id}`);
            if (changed) console.log(`[probe] ✅ ${id} 可用`);
          } else if (verdict === "dead") {
            const note = shortReason(status, bodyText);
            this.state.set(id, { state: "dead", at: Date.now(), note });
            results.push(`❌ ${id} (${note})`);
            if (prev?.state !== "dead") console.log(`[probe] ❌ ${id} 不可用: ${note}`);
          } else if (verdict === "gated") {
            // 上游整体关闸：记录但不计 miss、不隐藏。恢复后下一轮自动回 alive。
            const note = shortReason(status, bodyText);
            this.state.set(id, { state: "gated", at: Date.now(), note, misses: 0 });
            results.push(`🔒 ${id} (门禁: ${note})`);
            if (prev?.state !== "gated") console.log(`[probe] 🔒 ${id} 被上游门禁拦截: ${note}`);
          } else {
            // inconclusive：累计 miss 次数，达到阈值后从列表隐藏（但不是判死）
            const misses = (prev?.misses ?? 0) + 1;
            const note = shortReason(status, bodyText);
            this.state.set(id, { state: "inconclusive", at: Date.now(), note, misses });
            const hidden = misses >= this.missThreshold;
            results.push(`❔ ${id} (不确定 ${misses}/${this.missThreshold}${hidden ? "，已隐藏" : ""})`);
            if (hidden && (prev?.misses ?? 0) < this.missThreshold) {
              console.log(`[probe] 🚫 ${id} 连续 ${misses} 轮打不通，已从列表隐藏: ${note}`);
            }
          }
        } catch (e) {
          results.push(`❔ ${id} (异常: ${String(e.message).slice(0, 50)})`);
        }
      }
    };
    await Promise.all(Array.from({ length: this.concurrency }, worker));

    this.lastRun = Date.now();
    await this.save();
    const ms = Date.now() - t0;
    const alive = [...this.state.values()].filter((v) => v.state === "alive").length;
    const dead = [...this.state.values()].filter((v) => v.state === "dead").length;
    const gated = [...this.state.values()].filter((v) => v.state === "gated").length;
    const tail = gated > 0 ? `，门禁 ${gated}（上游整体拒绝，非模型故障）` : "";
    console.log(`[probe] 完成，用时 ${(ms / 1000).toFixed(1)}s — 可用 ${alive}，不可用 ${dead}${tail}`);
    this.running = false;
    this.onUpdate?.();
  }

  start(getCandidates) {
    if (!this.enabled) {
      console.log("[probe] 可用性探测已禁用");
      return;
    }
    // getCandidates 可以是同步数组或返回数组的 Promise，统一 await
    const tick = async (tag) => {
      try {
        const list = await getCandidates();
        if (!Array.isArray(list) || list.length === 0) {
          console.log(`[probe] ${tag}：候选集为空，跳过`);
          return;
        }
        await this.runOnce(list);
      } catch (e) {
        console.error(`[probe] ${tag}失败:`, e?.message ?? e);
      }
    };
    // 启动后延迟 20 秒再首次探测，避免和 catalog 首刷抢带宽
    setTimeout(() => tick("首轮"), 20_000).unref?.();
    this.timer = setInterval(() => tick("周期"), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  snapshot() {
    const models = Object.fromEntries(this.state);
    return {
      enabled: this.enabled,
      missThreshold: this.missThreshold,
      lastRun: this.lastRun ? new Date(this.lastRun).toISOString() : null,
      alive: Object.values(models).filter((v) => v.state === "alive").length,
      dead: Object.values(models).filter((v) => v.state === "dead").length,
      gated: Object.values(models).filter((v) => v.state === "gated").length,
      uncertain: Object.values(models).filter((v) => v.state === "inconclusive").length,
      hidden: Object.values(models).filter((v) => v.state === "inconclusive" && (v.misses ?? 0) >= this.missThreshold).length,
      models,
    };
  }
}

export { STATE_PATH, classify };
