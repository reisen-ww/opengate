/**
 * OpenGate 委托后端：把请求交给真实的 opencode 进程处理。
 *
 * 为什么必须这样做（2026-10-15 实测，已穷举证明）：
 *   OpenCode Zen 免费层有凭据门禁：请求必须携带 auth.json 里的
 *   `oc_sk_…` 凭据，否则上游返回
 *   "OpenCode's free tier can only be used from within OpenCode"。
 *   注意这**不是** TLS 指纹门禁 —— 指纹、permission、payload、--pure
 *   全部 A/B 证伪。唯一能过的是真正的 opencode 二进制 + 真凭据。
 *   本模块复用社区项目 dsh-opencode-xdbridge（MIT）的 vendor/ 层驱动它。
 *
 * 内存控制（本模块的核心增值）：
 *   vendor 原版常驻 300-500MB 且从不归还。这里额外做两件事：
 *     1. 启动时注入 GOMEMLIMIT / GOGC，约束 Go 堆上限
 *     2. 空闲后周期性调用 EmptyWorkingSet，把物理内存换出到 40MB 量级
 *   实测：419MB → 38MB。
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";

import { findRuntime, startBackend } from "./vendor/runtime.js";
import { Backend } from "./vendor/backend.js";
import { BridgeCatalog } from "./vendor/catalog.js";
import { prepare } from "./vendor/protocol.js";

/** 本文件所在目录 —— 用于定位随仓库分发的 bin/opencode.exe。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

const DATA_SUBDIR = "runtime-data";

/** 内存约束：Go 堆软上限 + 更激进的 GC 频率。 */
const GO_ENV = {
  GOMEMLIMIT: process.env.OPENGATE_GOMEMLIMIT ?? "96MiB",
  GOGC: process.env.OPENGATE_GOGC ?? "30",
};

/** 真实 opencode 安装的 auth.json 候选位置。 */
function authCandidates() {
  const out = [];
  if (process.env.OPENGATE_AUTH_JSON) out.push(process.env.OPENGATE_AUTH_JSON);
  if (process.env.OPENCODE_AUTH_JSON) out.push(process.env.OPENCODE_AUTH_JSON);
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  if (process.env.XDG_DATA_HOME) out.push(path.join(process.env.XDG_DATA_HOME, "opencode", "auth.json"));
  out.push(path.join(home, ".local", "share", "opencode", "auth.json"));
  out.push(path.join(home, ".local", "share", "opencode", "auth.jsonc"));
  return out.filter(Boolean);
}

/**
 * 把宿主机上真实 opencode 的凭据复制进隔离 runtime。
 *
 * 隔离 runtime 用独立 XDG_DATA_HOME，所以它看不到用户的 auth.json，
 * 而 Zen 免费层凭据就存在那里。只搬运 `opencode` 这一个 provider 的条目，
 * 其他 provider 的 key 一律不落地，避免把无关密钥写进工作区。
 */
function seedAuth(dataDir, log) {
  // startBackend 把 XDG_DATA_HOME 设成 <dataDir>/opencode/data，
  // opencode 就在其下的 opencode/auth.json 找凭据。
  const target = path.join(dataDir, "opencode", "data", "opencode", "auth.json");
  if (existsSync(target)) return "present";

  const source = authCandidates().find((p) => existsSync(p));
  if (!source) {
    log("[delegate] 未找到 opencode auth.json，Zen 免费层会返回 403");
    return "missing";
  }

  try {
    const raw = JSON.parse(readFileSync(source, "utf8"));
    const zen = raw?.opencode;
    if (!zen) {
      log(`[delegate] ${source} 中没有 opencode 凭据，Zen 免费层会返回 403`);
      return "missing";
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ opencode: zen }), { mode: 0o600 });
    log(`[delegate] 已注入 Zen 凭据 (${source})`);
    return "seeded";
  } catch (error) {
    log(`[delegate] 读取 ${source} 失败: ${error.message}`);
    return "error";
  }
}

/**
 * 释放进程的物理工作集。
 *
 * Windows 上 Go 运行时不会主动把页还给系统（它只做标记），所以
 * PrivateMemorySize64 看着很吓人，WorkingSet64 才是真实占用。
 * EmptyWorkingSet 把可换出的页标记为可回收，实测 419MB → 38MB。
 * 非 Windows 直接跳过。
 */
let emptyWorkingSet = null;
async function loadTrimmer() {
  if (emptyWorkingSet !== null) return emptyWorkingSet;
  if (process.platform !== "win32") {
    emptyWorkingSet = () => false;
    return emptyWorkingSet;
  }
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    // 优先用 ffi 类库；没有就退回 PowerShell 调用（零依赖但慢）
    const koffi = require("koffi");
    const psapi = koffi.load("psapi.dll");
    const fn = psapi.func("bool EmptyWorkingSet(void* hProcess)");
    const kernel32 = koffi.load("kernel32.dll");
    const open = kernel32.func("void* OpenProcess(uint32, bool, uint32)");
    const close = kernel32.func("bool CloseHandle(void*)");
    emptyWorkingSet = (pid) => {
      const h = open(0x0100 | 0x0400, false, pid); // PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION
      if (!h) return false;
      try { return fn(h); } finally { close(h); }
    };
  } catch {
    // 无 koffi：用 PowerShell 兜底（每次约 100ms，可接受）
    const { execFile } = await import("node:child_process");
    emptyWorkingSet = (pid) => {
      execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        `$s=Add-Type -Namespace W -Name M -MemberDefinition '[DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr h);' -PassThru;` +
        `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($p){$s::EmptyWorkingSet($p.Handle)|Out-Null}`,
      ], { windowsHide: true }, () => {});
      return true;
    };
  }
  return emptyWorkingSet;
}

export class DelegateRuntime {
  #dataDir;
  #log;
  #catalog;
  #backend = null;
  #runtime = null;
  #starting = null;
  #trimmer = null;
  #trimmerTimer = null;
  #childPid = null;
  /** 流式增量订阅表：complete() 注册，结束后注销。 */
  #deltaTaps = new Set();
  /** partID → "text"|"reasoning"。delta 事件不带 part 类型，靠 part.updated 事件学习。 */
  #partTypes = new Map();
  /** partID → 信封剥离状态机（每个 text part 一个）。 */
  #stripStates = new Map();

  /**
   * 信封感知的流式剥离器。
   *
   * 为什么需要：vendor 让模型用 StructuredOutput 返回
   * `{"content":"答案","calls":[]}` 信封，最终结果由 vendor 解析剥离；
   * 但事件流里的 text part 增量是**原始信封字面量**，直接转发会把
   * `{"content":"` 前缀和 `"calls":[]}` 尾巴漏给客户端。
   *
   * 这里用一个小状态机流式剥离：识别信封头部后只放行 JSON 字符串
   * 字面量内部的内容（处理 \uXXXX、\\" 等转义）；不符合信封形状的
   * 头部（模型直接说人话时）原样放行。按 partID 各自维护状态，
   * 并发请求互不串台。
   */
  #stripEnvelope(partID, delta) {
    let st = this.#stripStates.get(partID);
    if (!st) {
      st = { buf: "", mode: "probing", esc: false, hex: 0, hexVal: 0, done: false };
      // 状态表内存护栏：part 结束即删（part.updated 有 time.end 时），
      // 超限兜底删最老
      if (this.#stripStates.size > 200) this.#stripStates.delete(this.#stripStates.keys().next().value);
      this.#stripStates.set(partID, st);
    }
    if (st.done) {
      // 信封已收完（closing quote 已过）：吞掉剩余尾巴（", "calls":[...]}）
      return "";
    }

    if (st.mode === "probing") {
      st.buf += delta;
      // 等到能判断是不是 {"content":" 开头
      const HEAD = '{"content":"';
      if (st.buf.length < HEAD.length) {
        // 已经能确定不是信封（逐字符前缀失配）→ 整段原样放行
        for (let i = 0; i < st.buf.length; i++) {
          if (st.buf[i] !== HEAD[i]) { st.mode = "plain"; st.buf = ""; return delta; }
        }
        return ""; // 还在等待更多字节
      }
      if (st.buf.startsWith(HEAD)) {
        st.mode = "instr"; st.buf = ""; return ""; // 进入字符串字面量，头部吞掉
      }
      st.mode = "plain"; st.buf = "";
      return delta;
    }

    if (st.mode === "plain") return delta;

    // mode === "instr"：在 JSON 字符串字面量内部，处理转义
    let out = "";
    for (const ch of delta) {
      if (st.esc) {
        if (st.hex > 0) {
          st.hexVal = st.hexVal * 16 + Number.parseInt(ch, 16);
          if (++st.hex === 4) { out += String.fromCharCode(st.hexVal); st.esc = false; st.hex = 0; st.hexVal = 0; }
        } else if (ch === "u") { st.hex = 1; st.hexVal = 0; }
        else { out += { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" }[ch] ?? ch; st.esc = false; }
      } else if (ch === "\\") { st.esc = true; }
      else if (ch === '"') { st.done = true; break; } // 信封 content 字符串结束
      else { out += ch; }
    }
    return out;
  }

  /** 清理已结束 part 的剥离状态。 */
  #gcStripState(wrapper) {
    const ev = wrapper?.payload ?? wrapper;
    if (ev?.type !== "message.part.updated") return;
    const part = ev.properties?.part;
    if (part?.id && part.time?.end && this.#stripStates.has(part.id)) this.#stripStates.delete(part.id);
  }

  /**
   * @param {object} options
   * @param {string} options.dataDir 数据目录（存放 opencode 二进制与隔离配置）
   * @param {(msg: string) => void} [options.log]
   */
  constructor({ dataDir, log = console.error }) {
    this.#dataDir = path.join(dataDir, DATA_SUBDIR);
    this.#log = log;
    this.#catalog = new BridgeCatalog();
  }

  get catalog() { return this.#catalog; }
  get backend() { return this.#backend; }
  get ready() { return this.#backend !== null; }

  /** 启动（幂等）。并发调用共享同一次启动。 */
  async start() {
    if (this.#backend) return this;
    if (this.#starting) return this.#starting;
    this.#starting = this.#doStart().finally(() => { this.#starting = null; });
    return this.#starting;
  }

  async #doStart() {
    // 定位二进制。优先级：
    //   1. 仓库固化的 bin/ —— 直接就地执行，不走 findRuntime（那会再拷一份 172MB）
    //   2. 环境变量指定的现成安装（开发用）
    //   3. findRuntime 的回退链：managed 目录 → 用户全局安装 → 官方下载
    const pinned = [
      process.env.OPENGATE_OPENCODE_BINARY,
      path.join(HERE, "bin", "opencode.exe"),
      path.join(HERE, "bin", "opencode"),
    ].find((p) => p && existsSync(p));

    let binary;
    if (pinned) {
      binary = pinned;
    } else {
      const candidates = [
        process.env.OPENCODE_BINARY_PATH,
        path.join(process.env.APPDATA ?? "", "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"),
      ].filter((p) => p && existsSync(p));
      binary = await findRuntime(this.#dataDir, (m) => this.#log(`[delegate] ${m}`), { candidates });
    }
    this.#log(`[delegate] 二进制: ${binary}`);

    // 注入 Zen 凭据 —— 这是免费层门禁的钥匙，缺了它所有请求都会 403。
    const authState = seedAuth(this.#dataDir, this.#log);

    this.#runtime = await startBackend(binary, this.#dataDir, process.stderr, GO_ENV);
    this.#backend = this.#runtime.backend;
    this.#childPid = this.#runtime.child?.pid ?? null;

    // 挂增量探针：vendor 的 handleEvent 只用事件做进度/工具跟踪，把文本增量丢了。
    // 在它前面接一层，把 message.part.delta 转给流式订阅者（见 onTapDelta）。
    const origHandleEvent = this.#backend.handleEvent.bind(this.#backend);
    this.#backend.handleEvent = (wrapper) => {
      this.#learnPartType(wrapper);
      this.#gcStripState(wrapper);
      this.#emitDelta(wrapper);
      origHandleEvent(wrapper);
    };

    this.#log(`[delegate] opencode 已就绪 pid=${this.#childPid} version=${this.#runtime.version} auth=${authState}`);

    // 启动内存回收定时器
    await this.#startTrimmer();

    return this;
  }

  async #startTrimmer() {
    if (this.#trimmerTimer || !this.#childPid) return;
    this.#trimmer = await loadTrimmer();
    const intervalMs = Number(process.env.OPENGATE_TRIM_INTERVAL_MS ?? 60_000);
    this.#trimmerTimer = setInterval(() => {
      try { this.#trimmer(this.#childPid); } catch { /* 进程可能已退出 */ }
    }, intervalMs);
    this.#trimmerTimer.unref?.();
    // 立刻回收一次：冷启动后堆里全是解析配置的垃圾
    try { this.#trimmer(this.#childPid); } catch { /* ignore */ }
  }

  /** 拉取免费模型清单。 */
  async refresh() {
    await this.start();
    const models = await this.#backend.models();
    this.#catalog.replace(models);
    return models.length;
  }

  /**
   * 注册流式增量订阅。返回注销函数。
   * 回调收到 { type: "text"|"reasoning", text, sessionID }。
   */
  onTapDelta(fn) {
    this.#deltaTaps.add(fn);
    return () => this.#deltaTaps.delete(fn);
  }

  /** 从 part.updated 事件学习 partID 的类型（delta 事件只给 partID 不给类型）。 */
  #learnPartType(wrapper) {
    const ev = wrapper?.payload ?? wrapper;
    if (ev?.type !== "message.part.updated") return;
    const part = ev.properties?.part;
    if (part?.id && (part.type === "text" || part.type === "reasoning")) {
      if (this.#partTypes.size > 500) this.#partTypes.delete(this.#partTypes.keys().next().value);
      this.#partTypes.set(part.id, part.type);
    }
  }

  /** 把事件流的文本增量剥离信封后分发给订阅者。 */
  #emitDelta(wrapper) {
    if (!this.#deltaTaps.size) return;
    const ev = wrapper?.payload ?? wrapper;
    if (ev?.type !== "message.part.delta") return;
    const p = ev.properties ?? {};
    const delta = p.delta;
    if (!delta) return;
    // 类型判定：field="thinking" 直接算 reasoning；否则查 partID 学习表，缺省 text
    const type = p.field === "thinking"
      ? "reasoning"
      : (this.#partTypes.get(p.partID) ?? "text");
    // 信封剥离只作用于 text part（reasoning 是裸文本）
    const clean = type === "text" ? this.#stripEnvelope(p.partID, delta) : delta;
    if (!clean) return;
    for (const fn of this.#deltaTaps) {
      try { fn({ type, text: clean, sessionID: p.sessionID }); } catch { /* 订阅者异常不阻断其他 */ }
    }
  }

  /**
   * 执行一次补全。
   *
   * @param {object} body OpenAI 兼容请求体
   * @param {AbortSignal} signal
   * @returns {Promise<object>} { result, streamStart }
   */
  async complete(body, signal) {
    await this.start();
    // prepare() 负责把 OpenAI 请求翻译成 opencode 的信封协议，
    // 并用 catalog.all()（含不可用模型）做校验，避免历史记录里的模型
    // 一旦被标记不可用就再也无法重试。
    const request = prepare(body, this.#catalog.all());
    const streamStart = body.stream ? {} : null;
    const result = await this.#backend.complete(request, signal, {});
    return { request, result, streamStart };
  }

  /** 停止并释放资源。 */
  async stop() {
    if (this.#trimmerTimer) { clearInterval(this.#trimmerTimer); this.#trimmerTimer = null; }
    const rt = this.#runtime;
    this.#runtime = null;
    this.#backend = null;
    this.#childPid = null;
    await rt?.stop().catch(() => {});
  }
}
