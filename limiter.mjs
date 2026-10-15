/**
 * limiter.mjs — 并发闸门 + 重试预算
 *
 * 为什么需要：上游是**匿名共享池**，同一出口 IP 高频并发会被限流，
 * 表现就是 429 / "Endpoint is unavailable"。我们自己打自己是最蠢的失败模式。
 *
 * 对标：LiteLLM 的 router 并发控制、new-api 的渠道限流。
 *
 * 实现取舍：
 *  - 手写信号量（30 行），不引依赖。
 *  - **队列有上限**：超了就立刻 429 而不是无限排队 —— 排队越久客户端越可能
 *    已经放弃，白白占着上游配额。
 *  - 可选「每模型独占 1 并发」：同模型并发打上游最容易触发限流。
 */

export class Semaphore {
  /** @param {number} max 最大并发；<=0 视为不限流 */
  constructor(max) {
    this.max = max > 0 ? max : Infinity;
    this.active = 0;
    this.queue = [];
  }

  get pending() { return this.queue.length; }
  get available() { return this.max === Infinity ? Infinity : Math.max(0, this.max - this.active); }

  /** 尝试立刻获取，拿不到就返回 null（不排队）。 */
  tryAcquire() {
    if (this.active < this.max) {
      this.active++;
      return () => this._release();
    }
    return null;
  }

  /** 排队获取；队列满或等待超时则抛错。 */
  acquire({ maxQueue = 100, maxWaitMs = 60_000 } = {}) {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(() => this._release());
    }
    if (this.queue.length >= maxQueue) {
      const e = new Error("网关繁忙：等待队列已满，请稍后重试");
      e.code = "QUEUE_FULL";
      e.status = 429;
      return Promise.reject(e);
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, timer: null };
      // 等待超时：客户端往往早就放弃了，无限排队只是白占上游配额。
      if (maxWaitMs > 0) {
        waiter.timer = setTimeout(() => {
          const i = this.queue.indexOf(waiter);
          if (i >= 0) this.queue.splice(i, 1);
          const e = new Error(`网关繁忙：排队超过 ${Math.round(maxWaitMs / 1000)} 秒未获得执行槽位`);
          e.code = "QUEUE_TIMEOUT";
          e.status = 429;
          reject(e);
        }, maxWaitMs);
        waiter.timer.unref?.();
      }
      waiter.resolve = (release) => {
        if (waiter.timer) clearTimeout(waiter.timer);
        resolve(release);
      };
      this.queue.push(waiter);
    });
  }

  _release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next.resolve(() => this._release());
    }
  }

  snapshot() {
    return {
      max: this.max === Infinity ? null : this.max,
      active: this.active,
      queued: this.queue.length,
    };
  }
}

/**
 * 每模型一个信号量：防止对同一个模型并发猛打。
 * 上游对同一模型的并发似乎共享更窄的配额。
 */
export class PerKeySemaphore {
  constructor(maxPerKey) {
    this.maxPerKey = maxPerKey > 0 ? maxPerKey : Infinity;
    this.map = new Map();
  }
  _get(key) {
    let s = this.map.get(key);
    if (!s) { s = new Semaphore(this.maxPerKey); this.map.set(key, s); }
    return s;
  }
  acquire(key, opts) { return this._get(key).acquire(opts); }
  snapshot() {
    const out = {};
    for (const [k, s] of this.map) {
      if (s.active > 0 || s.queue.length > 0) out[k] = s.snapshot();
    }
    return out;
  }
}

/**
 * 全局并发控制门面。
 * 全局闸门先过，再过每模型闸门，避免同模型自己挤自己。
 */
export class Gate {
  constructor({ globalMax = 8, perModelMax = 2, maxQueue = 100, maxWaitMs = 60_000 } = {}) {
    this.global = new Semaphore(globalMax);
    this.perModel = new PerKeySemaphore(perModelMax);
    this.maxQueue = maxQueue;
    this.maxWaitMs = maxWaitMs;
  }

  /** 返回 release 函数。抛错时表示队列满或等待超时（429）。 */
  async enter(model) {
    const opts = { maxQueue: this.maxQueue, maxWaitMs: this.maxWaitMs };
    const relGlobal = await this.global.acquire(opts);
    try {
      const relModel = await this.perModel.acquire(model, opts);
      return () => { relModel(); relGlobal(); };
    } catch (e) {
      relGlobal();
      throw e;
    }
  }

  snapshot() {
    return {
      global: this.global.snapshot(),
      perModel: this.perModel.snapshot(),
      maxWaitMs: this.maxWaitMs,
    };
  }
}
