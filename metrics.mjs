/**
 * metrics.mjs — 可观测性：请求日志 + 用量统计 + Prometheus 导出
 *
 * 为什么需要：网关出问题时，"哪个模型、什么错误、多慢、多少 token"
 * 必须能查。对标 LiteLLM 的 /metrics 与 new-api 的日志页。
 *
 * 设计取舍：
 *  - 日志放内存环形缓冲（默认 500 条），**不落盘** —— 网关是本地工具，
 *    不该在用户磁盘上无限增长。要看历史就开 debug.logToFile。
 *  - 统计用固定桶计数器，不做时间序列存储（那是 Prometheus 的活）。
 *  - 零依赖，手写 Prometheus 文本格式。
 */

/** 环形缓冲：固定容量，写满覆盖最旧的。 */
class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.items = [];
    this.head = 0;      // 下一个写入位置
    this.total = 0;     // 累计写入总数（用于统计，不受容量影响）
  }
  push(item) {
    if (this.items.length < this.capacity) {
      this.items.push(item);
    } else {
      this.items[this.head] = item;
    }
    this.head = (this.head + 1) % this.capacity;
    this.total++;
  }
  /** 按时间正序返回（最旧 → 最新）。 */
  list(limit = this.capacity, filter = null) {
    const out = [];
    const n = this.items.length;
    for (let i = 0; i < n; i++) {
      // head 指向下一个写入位；当缓冲已满，最旧的在 head
      const idx = n < this.capacity ? i : (this.head + i) % n;
      const it = this.items[idx];
      if (it && (!filter || filter(it))) out.push(it);
    }
    return out.slice(-limit);
  }
  clear() { this.items = []; this.head = 0; }
}

/** 百分位：对已排序数组取 p 分位。 */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export class Metrics {
  constructor({ logCapacity = 500, latencyWindow = 500 } = {}) {
    this.startedAt = Date.now();
    this.logs = new RingBuffer(logCapacity);
    this.latencyWindow = latencyWindow;
    this.latencies = [];          // 最近 N 次耗时（毫秒），用于算 P50/P95/P99

    // 计数：key = `${model}|${endpoint}|${status}`
    this.counters = new Map();
    // token 累计：key = model
    this.tokens = new Map();
    // 活跃请求
    this.active = 0;
    this.peakActive = 0;
    // 全局成功/失败计数（含管理类 GET）
    this.okCount = 0;
    this.failCount = 0;
    // 按模型聚合
    this.byModel = new Map();
  }

  begin() {
    this.active++;
    if (this.active > this.peakActive) this.peakActive = this.active;
    return Date.now();
  }

  end() { this.active = Math.max(0, this.active - 1); }

  /**
   * 记录一次请求。
   * @param {object} r
   *   r.id, r.endpoint, r.model, r.status (HTTP 码或 "error"),
   *   r.durationMs, r.usage {prompt_tokens, completion_tokens},
   *   r.stream, r.attempts, r.effort {requested, applied, downgraded},
   *   r.error, r.clientIp
   */
  record(r) {
    const entry = {
      t: new Date().toISOString(),
      id: r.id,
      endpoint: r.endpoint,
      model: r.model ?? null,
      status: r.status,
      durationMs: r.durationMs,
      stream: !!r.stream,
      attempts: r.attempts ?? 1,
      promptTokens: r.usage?.prompt_tokens ?? null,
      completionTokens: r.usage?.completion_tokens ?? null,
      error: r.error ?? null,
      effortRequested: r.effort?.requested ?? null,
      effortApplied: r.effort?.applied ?? null,
      effortDowngraded: r.effort?.downgraded ?? false,
      clientIp: r.clientIp ?? null,
    };
    this.logs.push(entry);

    // 计数
    const key = `${r.model ?? "-"}|${r.endpoint}|${r.status}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);

    // 全局成功/失败：所有请求都算（含管理类 GET），
    // 否则面板会出现"总请求 9 / 成功 1"这种自相矛盾的数字。
    if (typeof r.status === "number" && r.status >= 200 && r.status < 400) this.okCount++;
    else this.failCount++;

    // 推理请求才有 model：管理类 GET（/v1/models 等）不计入模型统计和延迟窗口，
    // 否则 1ms 的列表请求会把 P50 拉到毫无意义的值。
    if (!r.model) return;

    // token
    if (r.usage) {
      const cur = this.tokens.get(r.model) ?? { prompt: 0, completion: 0, requests: 0 };
      cur.prompt += r.usage.prompt_tokens ?? 0;
      cur.completion += r.usage.completion_tokens ?? 0;
      cur.requests++;
      this.tokens.set(r.model, cur);
    }

    // 按模型聚合
    const m = this.byModel.get(r.model) ?? {
      requests: 0, ok: 0, failed: 0, totalMs: 0, lastUsed: null,
      downgrades: 0, prompt: 0, completion: 0,
    };
    m.requests++;
    if (typeof r.status === "number" && r.status >= 200 && r.status < 400) m.ok++; else m.failed++;
    m.totalMs += r.durationMs;
    m.lastUsed = entry.t;
    if (r.effort?.downgraded) m.downgrades++;
    m.prompt += r.usage?.prompt_tokens ?? 0;
    m.completion += r.usage?.completion_tokens ?? 0;
    this.byModel.set(r.model, m);

    // 耗时窗口
    if (typeof r.durationMs === "number") {
      this.latencies.push(r.durationMs);
      if (this.latencies.length > this.latencyWindow) this.latencies.shift();
    }
  }

  /** 汇总快照（给 /v1/stats 和面板用）。 */
  snapshot() {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    let prompt = 0, completion = 0;
    for (const m of this.byModel.values()) {
      prompt += m.prompt; completion += m.completion;
    }
    const models = {};
    for (const [id, m] of this.byModel) {
      models[id] = {
        requests: m.requests,
        ok: m.ok,
        failed: m.failed,
        avgMs: m.requests > 0 ? Math.round(m.totalMs / m.requests) : 0,
        downgrades: m.downgrades,
        promptTokens: m.prompt,
        completionTokens: m.completion,
        lastUsed: m.lastUsed,
      };
    }
    return {
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      startedAt: new Date(this.startedAt).toISOString(),
      requests: { total: this.logs.total, ok: this.okCount, failed: this.failCount },
      active: this.active,
      peakActive: this.peakActive,
      latencyMs: {
        samples: sorted.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: sorted.length ? sorted[sorted.length - 1] : 0,
      },
      tokens: { prompt, completion, total: prompt + completion },
      models,
    };
  }

  /** Prometheus 文本格式（零依赖手写）。 */
  prometheus() {
    const s = this.snapshot();
    const L = [];
    const num = (v) => (Number.isFinite(v) ? v : 0);

    L.push("# HELP opengate_uptime_seconds 网关运行时长");
    L.push("# TYPE opengate_uptime_seconds gauge");
    L.push(`opengate_uptime_seconds ${s.uptimeSeconds}`);

    L.push("# HELP opengate_requests_total 请求总数");
    L.push("# TYPE opengate_requests_total counter");
    L.push(`opengate_requests_total{result="ok"} ${s.requests.ok}`);
    L.push(`opengate_requests_total{result="failed"} ${s.requests.failed}`);

    L.push("# HELP opengate_active_requests 当前进行中的请求");
    L.push("# TYPE opengate_active_requests gauge");
    L.push(`opengate_active_requests ${s.active}`);

    L.push("# HELP opengate_request_duration_ms 请求耗时分位");
    L.push("# TYPE opengate_request_duration_ms gauge");
    for (const q of ["p50", "p95", "p99", "max"]) {
      L.push(`opengate_request_duration_ms{quantile="${q}"} ${num(s.latencyMs[q])}`);
    }

    L.push("# HELP opengate_tokens_total token 累计");
    L.push("# TYPE opengate_tokens_total counter");
    L.push(`opengate_tokens_total{kind="prompt"} ${s.tokens.prompt}`);
    L.push(`opengate_tokens_total{kind="completion"} ${s.tokens.completion}`);

    L.push("# HELP opengate_model_requests_total 按模型的请求数");
    L.push("# TYPE opengate_model_requests_total counter");
    for (const [id, m] of Object.entries(s.models)) {
      const label = id.replace(/"/g, "");
      L.push(`opengate_model_requests_total{model="${label}",result="ok"} ${m.ok}`);
      L.push(`opengate_model_requests_total{model="${label}",result="failed"} ${m.failed}`);
    }

    L.push("# HELP opengate_model_duration_ms_avg 按模型的平均耗时");
    L.push("# TYPE opengate_model_duration_ms_avg gauge");
    for (const [id, m] of Object.entries(s.models)) {
      L.push(`opengate_model_duration_ms_avg{model="${id.replace(/"/g, "")}"} ${m.avgMs}`);
    }

    L.push("# HELP opengate_effort_downgrades_total 思考强度被裁剪的次数");
    L.push("# TYPE opengate_effort_downgrades_total counter");
    for (const [id, m] of Object.entries(s.models)) {
      L.push(`opengate_effort_downgrades_total{model="${id.replace(/"/g, "")}"} ${m.downgrades}`);
    }

    return L.join("\n") + "\n";
  }

  /** 查询日志：支持按 model / status / 数量过滤。 */
  queryLogs({ limit = 100, model = null, failedOnly = false } = {}) {
    const filter = (it) => {
      if (model && it.model !== model) return false;
      if (failedOnly && !(typeof it.status === "number" && it.status >= 400)) return false;
      return true;
    };
    return this.logs.list(limit, filter);
  }
}
